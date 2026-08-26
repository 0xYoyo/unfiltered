/**
 * The M5 latency probe (YOY-114 AC-3): the one repeatable way to produce
 * the p50/p95 the milestone bars are stated in. It drives the deployed
 * playground's `GET /api/playground/search` with the committed query set
 * (`latency-probe-queries.json`: 5 classic, 5 EN AI, 5 HE AI), reading the
 * SERVER-SIDE `details.latencyMs` and `details.stages` of every response —
 * network time is not the engine's, so it is never in the number.
 *
 * Method, verbatim in docs/LATENCY.md: one discarded warm-up request first,
 * then sequential runs — every query of the set, `--runs` times — each with
 * a fresh `sessionId`; nearest-rank percentiles per set; EN and HE AI
 * reported separately and combined. The AI sets are paced under the
 * playground's per-IP AI throttle (10 per sliding minute): a throttled
 * request is served classic and `limited`, which would measure the guard
 * rather than the pipeline. Any `degraded` or `limited` response is counted
 * and reported, never silently folded into the percentiles' story.
 *
 * Usage, from apps/shopify-app:
 *
 *   npx tsx scripts/latency-probe.mts --url https://<service>.onrender.com \
 *     [--catalog <slug>] [--runs 20] [--set classic|ai-en|ai-he|all] \
 *     [--assert-classic-p95 500] [--assert-ai-p50 2000] [--assert-ai-p95 3500] \
 *     [--ai-per-minute 10]
 *
 * Exit 1 on any asserted breach or any failed request; exit 0 otherwise.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROBE_SETS = ["classic", "ai-en", "ai-he"] as const;
export type ProbeSet = (typeof PROBE_SETS)[number];

/** Pipeline stages in the orchestrator's order (SEARCH_STAGES). */
export const STAGE_ORDER = [
  "classify",
  "intent",
  "embed",
  "retrieve",
  "classic",
  "hydrate",
  "closeMatches",
] as const;

export interface ProbeArgs {
  url: string;
  catalog: string | null;
  runs: number;
  sets: ProbeSet[];
  assertClassicP95: number | null;
  assertAiP50: number | null;
  assertAiP95: number | null;
  /** Ceiling on AI-set requests per sliding minute; the playground's is 10. */
  aiPerMinute: number;
}

const DEFAULT_RUNS = 20;
const DEFAULT_AI_PER_MINUTE = 10;
const THROTTLE_WINDOW_MS = 60_000;
/** Slack past the window so a request never lands on its exact edge. */
const THROTTLE_MARGIN_MS = 1_000;

export class ProbeUsageError extends Error {}

/** Parse `--flag value` pairs; unknown flags and bad numbers are errors. */
export function parseArgs(argv: readonly string[]): ProbeArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      throw new ProbeUsageError(`unexpected argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ProbeUsageError(`${token} needs a value`);
    }
    values.set(token.slice(2), value);
    index += 1;
  }
  const known = new Set([
    "url",
    "catalog",
    "runs",
    "set",
    "assert-classic-p95",
    "assert-ai-p50",
    "assert-ai-p95",
    "ai-per-minute",
  ]);
  for (const flag of values.keys()) {
    if (!known.has(flag)) {
      throw new ProbeUsageError(`unknown flag: --${flag}`);
    }
  }
  const url = values.get("url");
  if (url === undefined) {
    throw new ProbeUsageError("--url <base> is required");
  }
  const positive = (flag: string, fallback: number): number => {
    const raw = values.get(flag);
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ProbeUsageError(`--${flag} must be a positive integer, got ${raw}`);
    }
    return parsed;
  };
  const optionalMs = (flag: string): number | null => {
    const raw = values.get(flag);
    if (raw === undefined) {
      return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ProbeUsageError(`--${flag} must be a non-negative number, got ${raw}`);
    }
    return parsed;
  };
  const set = values.get("set") ?? "all";
  if (set !== "all" && !PROBE_SETS.includes(set as ProbeSet)) {
    throw new ProbeUsageError(
      `--set must be one of ${[...PROBE_SETS, "all"].join("|")}, got ${set}`,
    );
  }
  return {
    url: url.replace(/\/+$/, ""),
    catalog: values.get("catalog") ?? null,
    runs: positive("runs", DEFAULT_RUNS),
    sets: set === "all" ? [...PROBE_SETS] : [set as ProbeSet],
    assertClassicP95: optionalMs("assert-classic-p95"),
    assertAiP50: optionalMs("assert-ai-p50"),
    assertAiP95: optionalMs("assert-ai-p95"),
    aiPerMinute: positive("ai-per-minute", DEFAULT_AI_PER_MINUTE),
  };
}

/**
 * Nearest-rank percentile (docs/LATENCY.md): sort ascending, take the value
 * at rank ⌈p/100 · n⌉ (1-based). No interpolation — the reported number is
 * always a latency that actually happened. Empty input has no percentile.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new RangeError("percentile of an empty sample");
  }
  if (p <= 0 || p > 100) {
    throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1]!;
}

/** One measured response. */
export interface ProbeSample {
  set: ProbeSet;
  query: string;
  searchId: string;
  route: string;
  routeReason: string;
  degraded: boolean;
  limited: string | null;
  latencyMs: number;
  stages: Record<string, number>;
}

export interface SetSummary {
  set: ProbeSet | "ai-combined";
  n: number;
  p50: number;
  p95: number;
  degraded: number;
  limited: number;
  routes: Record<string, number>;
  /** Mean ms per stage over the samples that ran it; absent when none did. */
  meanStages: Record<string, number>;
}

export function summarize(
  set: SetSummary["set"],
  samples: readonly ProbeSample[],
): SetSummary | null {
  if (samples.length === 0) {
    return null;
  }
  const latencies = samples.map((sample) => sample.latencyMs);
  const routes: Record<string, number> = {};
  for (const sample of samples) {
    routes[sample.route] = (routes[sample.route] ?? 0) + 1;
  }
  const meanStages: Record<string, number> = {};
  for (const stage of STAGE_ORDER) {
    const ran = samples.filter((sample) => sample.stages[stage] !== undefined);
    if (ran.length > 0) {
      const total = ran.reduce((sum, sample) => sum + sample.stages[stage]!, 0);
      meanStages[stage] = Math.round(total / ran.length);
    }
  }
  return {
    set,
    n: samples.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    degraded: samples.filter((sample) => sample.degraded).length,
    limited: samples.filter((sample) => sample.limited !== null).length,
    routes,
    meanStages,
  };
}

export interface Breach {
  set: SetSummary["set"];
  metric: "p50" | "p95";
  actual: number;
  limit: number;
}

/**
 * The bars, applied where they belong: classic p95 to the classic set; the
 * AI p50/p95 to EN, to HE, and to the two combined — a bar met on average
 * but missed in one language is missed.
 */
export function evaluateAssertions(
  summaries: readonly SetSummary[],
  args: Pick<ProbeArgs, "assertClassicP95" | "assertAiP50" | "assertAiP95">,
): Breach[] {
  const breaches: Breach[] = [];
  for (const summary of summaries) {
    if (summary.set === "classic") {
      if (args.assertClassicP95 !== null && summary.p95 > args.assertClassicP95) {
        breaches.push({ set: summary.set, metric: "p95", actual: summary.p95, limit: args.assertClassicP95 });
      }
      continue;
    }
    if (args.assertAiP50 !== null && summary.p50 >= args.assertAiP50) {
      breaches.push({ set: summary.set, metric: "p50", actual: summary.p50, limit: args.assertAiP50 });
    }
    if (args.assertAiP95 !== null && summary.p95 >= args.assertAiP95) {
      breaches.push({ set: summary.set, metric: "p95", actual: summary.p95, limit: args.assertAiP95 });
    }
  }
  return breaches;
}

/** Exit status: 1 on any breach or any failed request, else 0. */
export function exitCode(breaches: readonly Breach[], failures: number): 0 | 1 {
  return breaches.length > 0 || failures > 0 ? 1 : 0;
}

export function formatSummary(summary: SetSummary): string {
  const routes = Object.entries(summary.routes)
    .map(([route, count]) => `${route}=${count}`)
    .join(" ");
  const stages = STAGE_ORDER.flatMap((stage) =>
    summary.meanStages[stage] === undefined
      ? []
      : [`${stage} ${summary.meanStages[stage]} ms`],
  ).join(" · ");
  return [
    `[${summary.set}] n=${summary.n} p50=${summary.p50} ms p95=${summary.p95} ms` +
      ` degraded=${summary.degraded} limited=${summary.limited} routes: ${routes}`,
    `  mean per stage: ${stages === "" ? "(none)" : stages}`,
  ].join("\n");
}

export function formatBreaches(breaches: readonly Breach[]): string {
  if (breaches.length === 0) {
    return "assertions: all bars met";
  }
  return [
    "assertions: BREACHED",
    ...breaches.map(
      (breach) =>
        `  ${breach.set} ${breach.metric}=${breach.actual} ms ` +
        `${breach.metric === "p95" && breach.set === "classic" ? ">" : ">="} ${breach.limit} ms`,
    ),
  ].join("\n");
}

export type ProbeQueries = Record<ProbeSet, string[]>;

export function loadQueries(): ProbeQueries {
  const path = fileURLToPath(new URL("./latency-probe-queries.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as ProbeQueries;
}

interface PlaygroundBody {
  searchId: string;
  route: string;
  degraded: boolean;
  details: {
    routeReason: string;
    latencyMs: number;
    limited: string | null;
    stages: Record<string, number>;
  };
}

/** One request against the playground API; throws on a non-200 answer. */
async function probeOnce(
  args: ProbeArgs,
  set: ProbeSet,
  query: string,
): Promise<ProbeSample> {
  const params = new URLSearchParams({
    query,
    sessionId: `probe-${crypto.randomUUID()}`,
  });
  if (args.catalog !== null) {
    params.set("catalog", args.catalog);
  }
  const response = await fetch(`${args.url}/api/playground/search?${params}`);
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} for ${set} "${query}"`);
  }
  const body = (await response.json()) as PlaygroundBody;
  return {
    set,
    query,
    searchId: body.searchId,
    route: body.route,
    routeReason: body.details.routeReason,
    degraded: body.degraded,
    limited: body.details.limited,
    latencyMs: body.details.latencyMs,
    stages: body.details.stages ?? {},
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keep the AI sets under the playground's per-IP throttle: before an AI-set
 * request, wait until fewer than `aiPerMinute` AI-set requests completed
 * within the last window. The throttle counts AI-decided searches at
 * response time, so completions are what is tracked.
 */
function createPacer(aiPerMinute: number) {
  const completions: number[] = [];
  return {
    async wait(): Promise<void> {
      for (;;) {
        const cutoff = Date.now() - THROTTLE_WINDOW_MS - THROTTLE_MARGIN_MS;
        while (completions.length > 0 && completions[0]! < cutoff) {
          completions.shift();
        }
        if (completions.length < aiPerMinute) {
          return;
        }
        await sleep(completions[0]! - cutoff + 50);
      }
    },
    record(): void {
      completions.push(Date.now());
    },
  };
}

export async function main(argv: readonly string[]): Promise<0 | 1> {
  const args = parseArgs(argv);
  const queries = loadQueries();
  const pacer = createPacer(args.aiPerMinute);
  const samples: ProbeSample[] = [];
  let failures = 0;

  // One discarded warm-up: the first request after an idle instance pays
  // for connection setup and cold caches that the method excludes.
  const warmSet = args.sets[0]!;
  try {
    if (warmSet !== "classic") {
      await pacer.wait();
    }
    const warm = await probeOnce(args, warmSet, queries[warmSet][0]!);
    if (warmSet !== "classic") {
      pacer.record();
    }
    console.log(`warm-up (discarded): ${warm.route} ${warm.latencyMs} ms`);
  } catch (error) {
    console.error(`warm-up failed: ${String(error)}`);
    return 1;
  }

  for (const set of args.sets) {
    const paced = set !== "classic";
    for (let run = 1; run <= args.runs; run += 1) {
      for (const query of queries[set]) {
        if (paced) {
          await pacer.wait();
        }
        try {
          const sample = await probeOnce(args, set, query);
          samples.push(sample);
          console.log(
            `${set} run ${run}/${args.runs} ${sample.latencyMs} ms ${sample.route}` +
              `${sample.degraded ? " degraded" : ""}${sample.limited !== null ? ` limited=${sample.limited}` : ""}` +
              ` "${query}"`,
          );
        } catch (error) {
          failures += 1;
          console.error(`${set} run ${run}/${args.runs} FAILED: ${String(error)}`);
        } finally {
          if (paced) {
            pacer.record();
          }
        }
      }
    }
  }

  const summaries = args.sets
    .map((set) => summarize(set, samples.filter((sample) => sample.set === set)))
    .filter((summary): summary is SetSummary => summary !== null);
  const aiSamples = samples.filter((sample) => sample.set !== "classic");
  if (args.sets.includes("ai-en") && args.sets.includes("ai-he")) {
    const combined = summarize("ai-combined", aiSamples);
    if (combined !== null) {
      summaries.push(combined);
    }
  }

  console.log("");
  console.log(`latency probe — ${args.url}${args.catalog === null ? "" : ` catalog=${args.catalog}`} runs=${args.runs}`);
  for (const summary of summaries) {
    console.log(formatSummary(summary));
  }
  if (failures > 0) {
    console.log(`failed requests: ${failures} (excluded from the percentiles)`);
  }
  const breaches = evaluateAssertions(summaries, args);
  const asserted =
    args.assertClassicP95 !== null ||
    args.assertAiP50 !== null ||
    args.assertAiP95 !== null;
  // "All bars met" must never print when no bar was asked for — a run
  // without --assert-* flags reports numbers, not a verdict.
  console.log(
    asserted
      ? formatBreaches(breaches)
      : "assertions: none requested (pass --assert-* to enforce the bars)",
  );
  return exitCode(breaches, failures);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof ProbeUsageError ? error.message : error);
      process.exitCode = 1;
    },
  );
}
