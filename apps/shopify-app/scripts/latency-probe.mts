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
 * Every set reports its under-1-s share and the share of its submitted
 * searches composed without the wish extraction (`no-extraction`). A last line
 * gives the judge stage over every set (YOY-154 AC-8): its p50/p95 and how
 * many searches ended `judged`, `judge-cached`, `judge-timeout` or
 * `judge-error` — and the split (YOY-159 AC-1): the `judgeRows` stage (the
 * step's database work) and each search's slowest and median single judge
 * call, lower bounds on a search served before every call settled. Each
 * sample line carries its own rows and call times.
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
}

const DEFAULT_RUNS = 20;

/**
 * Four zero-width format characters used as base-4 digits of an invisible
 * per-request marker (YOY-64 AC-6). None is whitespace to `\s` or to
 * `String.prototype.trim`, none is a letter or a digit, so the exact-query
 * cache key (`normalizeReuseQuery`: trim, collapse whitespace, case-fold)
 * keeps the marker. The marker is invisible, not absent: nothing on the
 * server strips it, so the query embedding, the wish extraction and the
 * judge receive the committed query plus the marker as-is (see
 * `distinctQueryText`). U+FEFF is deliberately absent: `trim()` removes it.
 */
const INVISIBLE_DIGITS = ["\u200B", "\u200C", "\u200D", "\u2060"] as const;

/**
 * The committed query with an invisible marker unique to this probe
 * invocation and run appended. The judge's answer cache (YOY-148) and the
 * extraction cache (YOY-149 AC-18) answer a repeated query with no model
 * call, so a probe that sent the same text `--runs` times would measure the
 * caches from run 2 on and mask the AI bar; with a distinct text per
 * (invocation, run) every AI sample pays the full path. Classic queries are
 * keyword-only and are sent unchanged.
 *
 * What the marker reaches (YOY-125 AC-5): the orchestrator passes the raw
 * query to the embedding, the wish extraction and the judge, so each
 * receives the committed query plus one trailing space and 24 zero-width
 * characters — a few extra input tokens per call. Only `visibleQueryText`
 * strips it, and only for reporting (the per-run log line); the cache keys
 * treat it as text. The AI bars are therefore measured on
 * committed-query-plus-marker, not on the byte-identical shopper query.
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
  /**
   * Whether the wish extraction answered in time (YOY-149 AC-4); null when
   * the response was not served by Engine v2's find path.
   */
  extractionInTime: boolean | null;
  /** Whether the extraction cache answered (YOY-149 AC-18); null where `extractionInTime` is. */
  extractionCached: boolean | null;
  /**
   * The judge call's slowest and median single provider call as the page
   * was served (YOY-159 AC-1); lower bounds when `open`. Null when no judge
   * call started.
   */
  judgeCalls: ProbeJudgeCalls | null;
}

/** `details.judge.calls` of a playground response (YOY-159 AC-1). */
export interface ProbeJudgeCalls {
  slowestMs: number;
  medianMs: number;
  open: boolean;
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
  /**
   * Share of Engine v2 samples composed without the wish extraction, 0–1
   * (YOY-149 AC-4); null when no sample reported it.
   */
  withoutExtraction: number | null;
  /** Share of Engine v2 samples the extraction cache answered, 0–1 (YOY-149 AC-18); null when none reported. */
  extractionCached: number | null;
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
    withoutExtraction: shareWithoutExtraction(samples),
    extractionCached: shareOf(samples, (sample) => sample.extractionCached),
    routes,
    meanStages,
  };
}

function shareWithoutExtraction(samples: readonly ProbeSample[]): number | null {
  const inTime = shareOf(samples, (sample) => sample.extractionInTime);
  return inTime === null ? null : 1 - inTime;
}

/** The share of samples whose flag is true, among those that reported it; null when none did. */
function shareOf(
  samples: readonly ProbeSample[],
  flag: (sample: ProbeSample) => boolean | null,
): number | null {
  const reported = samples.filter((sample) => flag(sample) !== null);
  return reported.length === 0
    ? null
    : reported.filter((sample) => flag(sample) === true).length / reported.length;
}

/** The routeReasons the judge step ends a search with (judge-step.server.ts `JudgeOutcome`). */
export const JUDGE_OUTCOMES = ["judged", "judge-cached", "judge-timeout", "judge-error"] as const;

export interface JudgeSummary {
  /** Samples whose response timed the judge stage. */
  n: number;
  /** Nearest-rank percentiles of the server's `judge` stage ms (YOY-154 AC-8). */
  p50: number;
  p95: number;
  /** Samples per judge outcome, over every sample whatever its stages. */
  outcomes: Record<(typeof JUDGE_OUTCOMES)[number], number>;
  /** Share of all samples served `judge-error`, 0–1. */
  errorShare: number;
  /** p50/p95 of the `judgeRows` stage — the step's database work (YOY-159 AC-1); null when none reported it. */
  rows: Spread | null;
  /** p50/p95 of each search's slowest and median single call (YOY-159 AC-1); null when no call started. */
  slowestCall: Spread | null;
  medianCall: Spread | null;
  /** Samples served before every call settled: their call times are lower bounds. */
  openCalls: number;
}

/** Nearest-rank p50/p95 of a measure over the samples that reported it. */
export interface Spread {
  p50: number;
  p95: number;
}

function spread(values: readonly (number | undefined)[]): Spread | null {
  const reported = values.filter((value): value is number => value !== undefined);
  return reported.length === 0
    ? null
    : { p50: percentile(reported, 50), p95: percentile(reported, 95) };
}

/**
 * The judge stage over every sample of the run (YOY-154 AC-8): its median
 * and 95th percentile as the server timed them, and how the step ended.
 * Null when no sample ran the judge — a classic-only run.
 */
export function summarizeJudge(samples: readonly ProbeSample[]): JudgeSummary | null {
  const timed = samples
    .map((sample) => sample.stages.judge)
    .filter((ms): ms is number => ms !== undefined);
  if (timed.length === 0) {
    return null;
  }
  const outcomes = Object.fromEntries(
    JUDGE_OUTCOMES.map((outcome) => [
      outcome,
      samples.filter((sample) => sample.routeReason === outcome).length,
    ]),
  ) as JudgeSummary["outcomes"];
  return {
    n: timed.length,
    p50: percentile(timed, 50),
    p95: percentile(timed, 95),
    outcomes,
    errorShare: outcomes["judge-error"] / samples.length,
    rows: spread(samples.map((sample) => sample.stages.judgeRows)),
    slowestCall: spread(samples.map((sample) => sample.judgeCalls?.slowestMs)),
    medianCall: spread(samples.map((sample) => sample.judgeCalls?.medianMs)),
    openCalls: samples.filter((sample) => sample.judgeCalls?.open === true).length,
  };
}

export function formatJudgeSummary(summary: JudgeSummary): string {
  const outcomes = JUDGE_OUTCOMES.map((outcome) => `${outcome}=${summary.outcomes[outcome]}`).join(" ");
  const part = (name: string, value: Spread | null) =>
    value === null ? "" : ` ${name} p50=${value.p50} ms p95=${value.p95} ms`;
  return (
    `[judge, all sets] n=${summary.n} p50=${summary.p50} ms p95=${summary.p95} ms` +
    ` judge-error=${Math.round(summary.errorShare * 1000) / 10}% outcomes: ${outcomes}` +
    // The split (YOY-159 AC-1): database work, then the call's slowest and
    // median single provider call per search.
    part("| judgeRows", summary.rows) +
    part("| slowest call", summary.slowestCall) +
    part("| median call", summary.medianCall) +
    (summary.slowestCall === null ? "" : ` (served before every call settled: ${summary.openCalls})`)
  );
}

/**
 * One sample's progress line: the set, the run, the server latency and
 * route, the judge's outcome where the judge ran (YOY-154 AC-8), and the
 * `searchId`, so every measured search can be read back from the database.
 */
export function formatSampleLine(
  sample: ProbeSample,
  run: number,
  runs: number,
  query: string,
): string {
  const judged = (JUDGE_OUTCOMES as readonly string[]).includes(sample.routeReason);
  const calls = sample.judgeCalls;
  // A call still running when the page was served ran at least this long.
  const atLeast = calls?.open === true ? "≥" : "";
  return (
    `${sample.set} run ${run}/${runs} ${sample.latencyMs} ms ${sample.route}` +
    `${sample.degraded ? " degraded" : ""}${sample.limited !== null ? ` limited=${sample.limited}` : ""}` +
    `${judged ? ` ${sample.routeReason}` : ""}` +
    `${sample.stages.judgeRows !== undefined ? ` rows=${sample.stages.judgeRows} ms` : ""}` +
    `${calls == null ? "" : ` calls slowest=${atLeast}${calls.slowestMs} ms median=${atLeast}${calls.medianMs} ms`}` +
    ` ${sample.searchId} "${query}"`
  );
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
      (summary.extractionCached === null
        ? ""
        : ` extraction-cached=${Math.round(summary.extractionCached * 100)}%`) +
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
    extractionInTime?: boolean | null;
    extractionCached?: boolean | null;
    judge?: { calls?: ProbeJudgeCalls | null } | null;
  };
}

/** The query string of one probe request: the catalog when given. */
export function probeSearchParams(
  args: Pick<ProbeArgs, "catalog">,
  query: string,
): URLSearchParams {
  const params = new URLSearchParams({
    query,
    sessionId: `probe-${crypto.randomUUID()}`,
  });
  if (args.catalog !== null) {
    params.set("catalog", args.catalog);
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
    extractionCached: body.details.extractionCached ?? null,
    judgeCalls: body.details.judge?.calls ?? null,
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
          console.log(formatSampleLine(sample, run, args.runs, query));
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
  const judge = summarizeJudge(samples);
  if (judge !== null) {
    console.log(formatJudgeSummary(judge));
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
