/**
 * The judge comparison's local measures (YOY-152 AC-7): per judge, the
 * judge stage's median latency, its cost per 1,000 uncached searches read
 * from the run's own ledger, and stability — the same five searches run
 * five times, the share of products whose verdict was identical in every
 * run. The per-language score is the hidden run's (score.yml); these are
 * the columns a score run does not print.
 *
 * Runs the public half over the seed fixture on a scratch database, Engine
 * v2, through the production orchestrator — `JUDGE_PROVIDER` picks the
 * judge exactly as it does in production. Prints aggregates only, never a
 * query. Live and paid: about $0.10 per judge.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { PrismaClient } from "@prisma/client";
import { JUDGE_PROVIDERS, type JudgeProvider } from "@unfiltered/engine";

import type { ScoreSetEntry } from "../score/set.server";
import type { SearchOrchestrator } from "./orchestrator.server";

/** The searches the stability measure repeats, and how many times (AC-7). */
export const STABILITY_SEARCHES = 5;
export const STABILITY_RUNS = 5;

/** The median of a list of numbers; null when it is empty. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Stability (AC-7): over the runs of one search — each a map of product id
 * to verdict — the products judged in every run, and how many of them got
 * the same verdict every time. A product missing from a run counts as not
 * identical.
 */
export function stabilityCounts(runs: ReadonlyArray<ReadonlyMap<string, string>>): {
  identical: number;
  products: number;
} {
  const products = new Set(runs.flatMap((run) => [...run.keys()]));
  let identical = 0;
  for (const product of products) {
    const verdicts = runs.map((run) => run.get(product));
    if (verdicts.every((verdict) => verdict !== undefined && verdict === verdicts[0])) {
      identical += 1;
    }
  }
  return { identical, products: products.size };
}

/** Page-1 verdicts the judge step logged for one search, by product. */
async function loggedVerdicts(db: PrismaClient, searchId: string): Promise<Map<string, string>> {
  const rows = await db.judgeVerdict.findMany({
    where: { searchId, page: 1, cached: false },
    select: { productId: true, verdict: true },
  });
  return new Map(rows.map((row) => [row.productId, row.verdict]));
}

export async function judgeCompareCommand(
  argv: readonly string[],
  out: (text: string) => void = (text) => process.stdout.write(`${text}\n`),
): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { judge: { type: "string" } } });
  const judge = values.judge as JudgeProvider | undefined;
  if (judge === undefined || !(JUDGE_PROVIDERS as readonly string[]).includes(judge)) {
    out(`usage: judge-compare.mts --judge ${JUDGE_PROVIDERS.join("|")}`);
    return 2;
  }
  // The orchestrator reads these at construction, like production; the
  // deadline is the score run's, so a slow answer is measured, not cut.
  process.env.JUDGE_PROVIDER = judge;
  process.env.JUDGE_DEADLINE_MS ??= "4000";

  const { DEFAULT_FIXTURE_PATH, DEFAULT_PUBLIC_SET_PATH, readFixtureFile, RUNNER_CALL_TIMEOUT_MS } =
    await import("../score/cli.server");
  const { importScoreFixture } = await import("../score/fixture.server");
  const { createTestDb } = await import("../testing/helpers.server");
  const { createPrismaCostRecorder, createQueuedCostRecorder } = await import("../ai/cost-recorder.server");
  const { createProxySearchOrchestrator } = await import("./proxy.server");
  const { runPlaygroundSearch } = await import("./playground-search.server");

  const set = JSON.parse(readFileSync(DEFAULT_PUBLIC_SET_PATH, "utf8")) as ScoreSetEntry[];
  const fixture = readFixtureFile(DEFAULT_FIXTURE_PATH);
  const db = await createTestDb();
  try {
    await importScoreFixture(db, fixture);
    const ledger = createQueuedCostRecorder(createPrismaCostRecorder(db));
    const orchestrator: SearchOrchestrator = createProxySearchOrchestrator(db, {
      costRecorder: ledger,
      requestTimeoutMs: RUNNER_CALL_TIMEOUT_MS,
    });
    const search = (query: string) =>
      runPlaygroundSearch(orchestrator, { query, storeKey: fixture.storeKey, limit: 24 });

    // Latency and cost: every public search once, each page uncached.
    const judgeMs: number[] = [];
    const outcomes = new Map<string, number>();
    for (const entry of set) {
      const { response } = await search(entry.query);
      outcomes.set(response.routeReason, (outcomes.get(response.routeReason) ?? 0) + 1);
      if (response.routeReason === "judged" && response.stages.judge !== undefined) {
        judgeMs.push(response.stages.judge);
      }
    }
    await ledger.flush();
    const judgeCalls = await db.aiCall.aggregate({
      where: { operation: "judge" },
      _sum: { costUsd: true },
      _count: true,
    });
    const judgedSearches = outcomes.get("judged") ?? 0;
    const judgeUsd = judgeCalls._sum.costUsd ?? 0;

    // Stability: the first five searches, five times each, the answer cache
    // emptied before every run so each is a fresh judge call.
    let identical = 0;
    let products = 0;
    for (const entry of set.slice(0, STABILITY_SEARCHES)) {
      const runs: Map<string, string>[] = [];
      for (let run = 0; run < STABILITY_RUNS; run += 1) {
        await db.judgeAnswer.deleteMany({});
        const { response } = await search(entry.query);
        runs.push(await loggedVerdicts(db, response.searchId));
      }
      const counts = stabilityCounts(runs);
      identical += counts.identical;
      products += counts.products;
    }

    const median = medianOf(judgeMs);
    out(`judge ${judge}`);
    out(`searches ${set.length}, outcomes ${[...outcomes].map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
    out(`judge stage median ${median === null ? "—" : `${Math.round(median)} ms`} over ${judgeMs.length} judged searches`);
    out(
      `judge cost $${judgeUsd.toFixed(4)} over ${judgeCalls._count} calls, ` +
        `$${judgedSearches === 0 ? "—" : ((judgeUsd / judgedSearches) * 1000).toFixed(3)} per 1,000 uncached searches`,
    );
    out(
      `stability ${identical}/${products} identical verdicts over ${STABILITY_SEARCHES} searches × ${STABILITY_RUNS} runs` +
        (products === 0 ? "" : ` (${((identical / products) * 100).toFixed(1)} %)`),
    );
    return 0;
  } finally {
    await db.$disconnect();
  }
}
