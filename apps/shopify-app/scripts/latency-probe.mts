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
 *     [--ai-per-minute 10] [--engine v1|v2]
 *
 * `--engine` (YOY-147 AC-13) is sent to the playground API as its `engine`
 * parameter, so the probe can time Engine v2 — the find step and the judge —
 * on a deployment whose `ENGINE_V2` is off. Absent, no parameter is sent and
 * the deployment's default engine answers.
 *
 * Exit 1 on any asserted breach or any failed request; exit 0 otherwise.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// The stage list is the orchestrator's own (`SEARCH_STAGES`), never a copy:
// a stage added there reaches `mean per stage` without touching the probe
// (YOY-125 AC-1). `stages.ts` has no `.server` suffix and no runtime
// imports, so `tsx` loads it as the other scripts load app modules.
import { SEARCH_STAGES } from "../app/search/stages";

export const PROBE_SETS = ["classic", "ai-en", "ai-he"] as const;
export type ProbeSet = (typeof PROBE_SETS)[number];

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
  /** The playground's `engine` parameter (YOY-147 AC-13); null sends none. */
  engine: "v1" | "v2" | null;
}

const DEFAULT_RUNS = 20;

/**
 * Four zero-width format characters used as base-4 digits of an invisible
 * per-request marker (YOY-64 AC-6). None is whitespace to `\s` or to
 * `String.prototype.trim`, none is a letter or a digit, so the exact-query
 * reuse key (`normalizeReuseQuery`: trim, collapse whitespace, case-fold)
 * and the classifier's token rules both keep the marker. The marker is
 * invisible, not absent: nothing on the server strips it, so the classifier
 * and the intent model receive the committed query plus the marker as-is
 * (see `distinctQueryText`). U+FEFF is deliberately absent: `trim()`
 * removes it.
 */
const INVISIBLE_DIGITS = ["\u200B", "\u200C", "\u200D", "\u2060"] as const;

/**
 * The committed query with an invisible marker unique to this probe
 * invocation and run appended. Exact-query intent reuse (YOY-64 AC-4)
 * answers a repeated query from its stored intent with zero LLM calls, so a
 * probe that sent the same text `--runs` times would measure the cache from
 * run 2 on and mask the AI bar; with a distinct text per (invocation, run)
 * every AI sample pays the full path. Classic queries never store an intent
 * and are sent unchanged.
 *
 * What the marker reaches (YOY-125 AC-5): the orchestrator passes the raw
 * query to the LLM classifier and to the intent extractor, so both models
 * receive the committed query plus one trailing space and 24 zero-width
 * characters — roughly 6 extra input tokens per call, no retrieval change.
 * Only `visibleQueryText` strips it, and only for reporting (the per-run
 * log line); the reuse key treats it as text. The AI bars are therefore
 * measured on committed-query-plus-marker, not on the byte-identical
 * shopper query.
 */
export function distinctQueryText(
  query: string,
  invocation: readonly number[],
  run: number,
): string {
  const bytes = [...invocation, run & 0xff, (run >> 8) & 0xff];
  const marker = bytes
    .map((byte) =>
      [3, 2, 1, 0]
        .map((shift) => INVISIBLE_DIGITS[(byte >> (shift * 2)) & 3])
        .join(""),
    )
    .join("");
  return `${query} ${marker}`;
}

/** The committed text of a probed query: the marker stripped. */
export function visibleQueryText(query: string): string {
  return query.replace(/(?:\u200B|\u200C|\u200D|\u2060)/gu, "").trimEnd();
}
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
    "engine",
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
  const engine = values.get("engine") ?? null;
  if (engine !== null && engine !== "v1" && engine !== "v2") {
    throw new ProbeUsageError(`--engine must be v1 or v2, got ${engine}`);
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
    engine,
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
  /**
   * Whether the wish extraction answered in time (YOY-149 AC-4); null when
   * the response was not served by Engine v2's find path.
   */
  extractionInTime: boolean | null;
}

export interface SetSummary {
  set: ProbeSet | "ai-combined";
  n: number;
  p50: number;
  p95: number;
  /**
   * Share of samples answered in under 1,000 ms server-side, 0–1 (YOY-141
   * AC-9): the 90 % rule's "half of searches under 1 s", per set.
   */
  underOneSecond: number;
  degraded: number;
  limited: number;
  /** Responses served by exact-query intent reuse: a masked sample (AC-6). */
  reused: number;
  /**
   * Share of Engine v2 samples composed without the wish extraction, 0–1
   * (YOY-149 AC-4); null when no sample reported it.
   */
  withoutExtraction: number | null;
  routes: Record<string, number>;
  /** Mean ms per stage over the samples that ran it; absent when none did. */
  meanStages: Record<string, number>;
}

/** The "under 1 s" line of the 90 % rule (docs/PRD.md §3 Quality gate). */
export const UNDER_ONE_SECOND_MS = 1000;

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
  for (const stage of SEARCH_STAGES) {
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
    underOneSecond:
      latencies.filter((latency) => latency < UNDER_ONE_SECOND_MS).length / latencies.length,
    degraded: samples.filter((sample) => sample.degraded).length,
    limited: samples.filter((sample) => sample.limited !== null).length,
    reused: samples.filter((sample) => sample.routeReason === "intent-reuse").length,
    withoutExtraction: shareWithoutExtraction(samples),
    routes,
    meanStages,
  };
}

function shareWithoutExtraction(samples: readonly ProbeSample[]): number | null {
  const reported = samples.filter((sample) => sample.extractionInTime !== null);
  return reported.length === 0
    ? null
    : reported.filter((sample) => sample.extractionInTime === false).length / reported.length;
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
  const stages = SEARCH_STAGES.flatMap((stage) =>
    summary.meanStages[stage] === undefined
      ? []
      : [`${stage} ${summary.meanStages[stage]} ms`],
  ).join(" · ");
  return [
    `[${summary.set}] n=${summary.n} p50=${summary.p50} ms p95=${summary.p95} ms` +
      ` under-1s=${Math.round(summary.underOneSecond * 100)}%` +
      (summary.withoutExtraction === null
        ? ""
        : ` no-extraction=${Math.round(summary.withoutExtraction * 100)}%`) +
      ` degraded=${summary.degraded} limited=${summary.limited} reused=${summary.reused} routes: ${routes}`,
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
    extractionInTime?: boolean | null;
  };
}

/** The query string of one probe request: the catalog and engine when given. */
export function probeSearchParams(
  args: Pick<ProbeArgs, "catalog" | "engine">,
  query: string,
): URLSearchParams {
  const params = new URLSearchParams({
    query,
    sessionId: `probe-${crypto.randomUUID()}`,
  });
  if (args.catalog !== null) {
    params.set("catalog", args.catalog);
  }
  if (args.engine !== null) {
    params.set("engine", args.engine);
  }
  return params;
}

/** One request against the playground API; throws on a non-200 answer. */
async function probeOnce(
  args: ProbeArgs,
  set: ProbeSet,
  query: string,
): Promise<ProbeSample> {
  const params = probeSearchParams(args, query);
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
    extractionInTime: body.details.extractionInTime ?? null,
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
  // Four random bytes name this invocation in every AI query's marker, so
  // two probe runs inside one reuse window never answer each other.
  const invocation = [...crypto.getRandomValues(new Uint8Array(4))];

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
          const sample = await probeOnce(
            args,
            set,
            paced ? distinctQueryText(query, invocation, run) : query,
          );
          samples.push(sample);
          console.log(
            `${set} run ${run}/${args.runs} ${sample.latencyMs} ms ${sample.route}` +
              `${sample.degraded ? " degraded" : ""}${sample.limited !== null ? ` limited=${sample.limited}` : ""}` +
              `${sample.routeReason === "intent-reuse" ? " REUSED" : ""}` +
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
  console.log(`latency probe — ${args.url}${args.catalog === null ? "" : ` catalog=${args.catalog}`}${args.engine === null ? "" : ` engine=${args.engine}`} runs=${args.runs}`);
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
