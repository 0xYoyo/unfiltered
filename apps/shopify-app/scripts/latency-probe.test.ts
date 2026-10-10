import { describe, expect, it } from "vitest";

import { normalizeReuseQuery } from "../app/search/events.server";
import { SEARCH_STAGES } from "../app/search/stages";
import {
  distinctQueryText,
  evaluateAssertions,
  exitCode,
  formatBreaches,
  formatJudgeSummary,
  formatSampleLine,
  formatSummary,
  loadQueries,
  parseArgs,
  probeSearchParams,
  percentile,
  ProbeUsageError,
  summarize,
  summarizeJudge,
  UNDER_ONE_SECOND_MS,
  visibleQueryText,
  type ProbeSample,
} from "./latency-probe.mjs";

// The probe's measurement math and exit semantics (YOY-114 AC-3): the
// percentile is nearest-rank exactly as docs/LATENCY.md states it, and the
// `--assert-*` flags fail the run on any breach. No network: the request
// loop itself is exercised only against the live deployment.

describe("nearest-rank percentile", () => {
  it("takes the value at rank ⌈p/100 · n⌉ on n=20, without interpolation", () => {
    // 20 distinct latencies, shuffled so sorting is exercised.
    const values = [
      340, 120, 980, 210, 455, 300, 670, 150, 800, 260, 390, 175, 520, 230,
      1400, 610, 285, 725, 190, 415,
    ];
    const sorted = [...values].sort((a, b) => a - b);
    // p50 → rank 10 → the 10th smallest; p95 → rank 19 → the 19th smallest.
    expect(percentile(values, 50)).toBe(sorted[9]);
    expect(percentile(values, 50)).toBe(340);
    expect(percentile(values, 95)).toBe(sorted[18]);
    expect(percentile(values, 95)).toBe(980);
    // p100 is the maximum, and every reported value is one that happened.
    expect(percentile(values, 100)).toBe(1400);
    expect(values).toContain(percentile(values, 95));
  });

  it("rounds the rank up, so a fractional rank never reads below its neighbour", () => {
    // n=3: p50 → ⌈1.5⌉ = 2 → the median; p95 → ⌈2.85⌉ = 3 → the max.
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([30, 10, 20], 95)).toBe(30);
    // n=1: every percentile is the one sample.
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
  });

  it("refuses an empty sample and an out-of-range p", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

function sample(overrides: Partial<ProbeSample>): ProbeSample {
  return {
    set: "ai-en",
    query: "q",
    searchId: "s",
    route: "ai",
    routeReason: "find-only",
    degraded: false,
    limited: null,
    latencyMs: 1000,
    stages: { find: 600, compose: 4, hydrate: 10 },
    extractionInTime: null,
    extractionCached: null,
    judgeCalls: null,
    ...overrides,
  };
}

describe("set summaries", () => {
  it("reports n, p50, p95, degraded/limited counts, routes, and the mean per stage", () => {
    const samples = [
      sample({ latencyMs: 900 }),
      sample({ latencyMs: 1100, routeReason: "judge-cached", stages: { find: 400, compose: 2, hydrate: 10, judgeRows: 5 } }),
      sample({ latencyMs: 300, degraded: true, stages: { find: 900, hydrate: 5 } }),
      sample({ latencyMs: 250, route: "classic", degraded: true, limited: "ip", stages: { classic: 20, hydrate: 5 } }),
    ];
    const summary = summarize("ai-en", samples);
    expect(summary).not.toBeNull();
    expect(summary!.n).toBe(4);
    expect(summary!.p50).toBe(300);
    expect(summary!.p95).toBe(1100);
    expect(summary!.degraded).toBe(2);
    expect(summary!.limited).toBe(1);
    expect(summary!.routes).toEqual({ ai: 3, classic: 1 });
    // Means are over the samples that ran the stage, in pipeline order —
    // the orchestrator's own `SEARCH_STAGES` (YOY-125 AC-1), so the probe's
    // key order cannot drift from a stage added there. `judge` is a real
    // stage no sample ran here, so it is absent, not zero.
    expect(Object.keys(summary!.meanStages)).toEqual(
      SEARCH_STAGES.filter((stage) => samples.some((s) => s.stages[stage] !== undefined)),
    );
    expect(Object.keys(summary!.meanStages)).toEqual([
      "find",
      "compose",
      "classic",
      "hydrate",
      "judgeRows",
    ]);
    expect(SEARCH_STAGES).toContain("judge");
    expect(summary!.meanStages.judge).toBeUndefined();
    expect(summary!.meanStages.find).toBe(Math.round((600 + 400 + 900) / 3));
    expect(summary!.meanStages.classic).toBe(20);
    expect(summary!.underOneSecond).toBe(0.75);
    expect(formatSummary(summary!)).toContain(
      "p50=300 ms p95=1100 ms under-1s=75% degraded=2 limited=1 routes:",
    );
  });

  it("reports the share of v2 samples composed without the extraction (YOY-149 AC-4)", () => {
    const summary = summarize("ai-en", [
      sample({ extractionInTime: true, extractionCached: true }),
      sample({ extractionInTime: false, extractionCached: false }),
      sample({ extractionInTime: true, extractionCached: false }),
      sample({ extractionInTime: true, extractionCached: false }),
      sample({}),
    ])!;
    expect(summary.withoutExtraction).toBe(0.25);
    expect(summary.extractionCached).toBe(0.25);
    expect(formatSummary(summary)).toContain(" no-extraction=25% extraction-cached=25%");
    const v1 = summarize("ai-en", [sample({})])!;
    expect(v1.withoutExtraction).toBeNull();
    expect(formatSummary(v1)).not.toContain("no-extraction");
  });

  it("counts a search as under 1 s only below 1,000 ms (YOY-141 AC-9)", () => {
    const summary = summarize("classic", [
      sample({ set: "classic", latencyMs: 999 }),
      sample({ set: "classic", latencyMs: 1000 }),
      sample({ set: "classic", latencyMs: 1001 }),
    ])!;
    expect(UNDER_ONE_SECOND_MS).toBe(1000);
    expect(summary.underOneSecond).toBeCloseTo(1 / 3);
    expect(formatSummary(summary)).toContain("under-1s=33%");
  });

  it("is null for an empty set rather than a fake zero", () => {
    expect(summarize("classic", [])).toBeNull();
  });
});

describe("the judge stage over every set (YOY-154 AC-8)", () => {
  it("reports the judge stage's p50/p95 and how each search's judge step ended", () => {
    const judged = (judge: number, routeReason = "judged") =>
      sample({ routeReason, stages: { find: 300, compose: 20, judge } });
    const samples = [
      judged(400),
      judged(500),
      judged(600, "judge-cached"),
      judged(1500, "judge-timeout"),
      judged(900, "judge-error"),
      sample({ set: "classic", route: "classic", routeReason: "keyword", stages: { classic: 20 } }),
    ];
    const summary = summarizeJudge(samples)!;
    expect(summary.n).toBe(5);
    expect(summary.p50).toBe(600);
    expect(summary.p95).toBe(1500);
    expect(summary.outcomes).toEqual({
      judged: 2,
      "judge-cached": 1,
      "judge-timeout": 1,
      "judge-error": 1,
    });
    // The failure share is over every search of the run, judged or not.
    expect(summary.errorShare).toBeCloseTo(1 / 6);
    expect(formatJudgeSummary(summary)).toBe(
      "[judge, all sets] n=5 p50=600 ms p95=1500 ms judge-error=16.7% outcomes: judged=2 judge-cached=1 judge-timeout=1 judge-error=1",
    );
  });

  it("names the judge outcome and the searchId on every sample line", () => {
    expect(
      formatSampleLine(sample({ searchId: "abc-123", routeReason: "judge-timeout", latencyMs: 2100 }), 2, 5, "linen dress"),
    ).toBe('ai-en run 2/5 2100 ms ai judge-timeout abc-123 "linen dress"');
    // A route that never reached the judge prints no outcome, still the searchId.
    expect(formatSampleLine(sample({ searchId: "s-9", routeReason: "find-only" }), 1, 5, "q")).toBe(
      'ai-en run 1/5 1000 ms ai s-9 "q"',
    );
  });

  it("splits the judge stage: judgeRows, and each search's slowest and median single call (YOY-159 AC-1)", () => {
    const split = (judgeRows: number, judge: number, slowestMs: number, medianMs: number, open = false, routeReason = "judged") =>
      sample({ routeReason, stages: { find: 300, judgeRows, judge }, judgeCalls: { slowestMs, medianMs, open } });
    const samples = [
      split(20, 700, 690, 300),
      split(30, 900, 880, 320),
      split(25, 1500, 1500, 1500, true, "judge-timeout"),
      sample({ routeReason: "judge-cached", stages: { find: 300, judgeRows: 15, judge: 0 } }),
    ];
    const summary = summarizeJudge(samples)!;
    expect(summary.rows).toEqual({ p50: 20, p95: 30 });
    expect(summary.slowestCall).toEqual({ p50: 880, p95: 1500 });
    expect(summary.medianCall).toEqual({ p50: 320, p95: 1500 });
    expect(summary.openCalls).toBe(1);
    expect(formatJudgeSummary(summary)).toBe(
      "[judge, all sets] n=4 p50=700 ms p95=1500 ms judge-error=0% outcomes: judged=2 judge-cached=1 judge-timeout=1 judge-error=0" +
        " | judgeRows p50=20 ms p95=30 ms | slowest call p50=880 ms p95=1500 ms | median call p50=320 ms p95=1500 ms" +
        " (served before every call settled: 1)",
    );
    expect(formatSampleLine(samples[0]!, 1, 5, "q")).toBe(
      'ai-en run 1/5 1000 ms ai judged rows=20 ms calls slowest=690 ms median=300 ms s "q"',
    );
    // A search served on a deadline miss shows its call times as lower bounds.
    expect(formatSampleLine(samples[2]!, 1, 5, "q")).toBe(
      'ai-en run 1/5 1000 ms ai judge-timeout rows=25 ms calls slowest=≥1500 ms median=≥1500 ms s "q"',
    );
  });

  it("is null when no sample ran the judge — a run with no judge reports no judge line", () => {
    expect(summarizeJudge([sample({})])).toBeNull();
  });
});

describe("assertions and exit code", () => {
  const classic = summarize("classic", [sample({ set: "classic", route: "classic", latencyMs: 480 }), sample({ set: "classic", route: "classic", latencyMs: 520 })])!;
  const aiEn = summarize("ai-en", [sample({ latencyMs: 1500 }), sample({ latencyMs: 3000 })])!;
  const aiHe = summarize("ai-he", [sample({ set: "ai-he", latencyMs: 2200 }), sample({ set: "ai-he", latencyMs: 3400 })])!;

  it("exits 0 with no flags set, whatever the numbers", () => {
    const breaches = evaluateAssertions([classic, aiEn, aiHe], {
      assertClassicP95: null,
      assertAiP50: null,
      assertAiP95: null,
    });
    expect(breaches).toEqual([]);
    expect(exitCode(breaches, 0)).toBe(0);
    expect(formatBreaches(breaches)).toBe("assertions: all bars met");
  });

  it("classic p95 ≤ bar passes; above it breaches (the bar is inclusive)", () => {
    expect(evaluateAssertions([classic], { assertClassicP95: 520, assertAiP50: null, assertAiP95: null })).toEqual([]);
    const breaches = evaluateAssertions([classic], { assertClassicP95: 500, assertAiP50: null, assertAiP95: null });
    expect(breaches).toEqual([{ set: "classic", metric: "p95", actual: 520, limit: 500 }]);
    expect(exitCode(breaches, 0)).toBe(1);
  });

  it("AI p50/p95 must be strictly below the bar, per language and combined", () => {
    // `--assert-ai-p50 1` (How to verify 4) breaches every AI set.
    const tiny = evaluateAssertions([classic, aiEn, aiHe], { assertClassicP95: null, assertAiP50: 1, assertAiP95: null });
    expect(tiny.map((breach) => breach.set)).toEqual(["ai-en", "ai-he"]);
    expect(exitCode(tiny, 0)).toBe(1);

    // EN meets p50 < 2000 but HE (p50 = 2200) does not: the bar is missed.
    const perLanguage = evaluateAssertions([aiEn, aiHe], { assertClassicP95: null, assertAiP50: 2000, assertAiP95: 3500 });
    expect(perLanguage).toEqual([{ set: "ai-he", metric: "p50", actual: 2200, limit: 2000 }]);

    // Equal to the bar is a breach on the AI side (strict <).
    expect(evaluateAssertions([aiEn], { assertClassicP95: null, assertAiP50: 1500, assertAiP95: null })).toHaveLength(1);
    expect(formatBreaches(perLanguage)).toContain("ai-he p50=2200 ms >= 2000 ms");
  });

  it("a failed request fails the run even with every bar met", () => {
    expect(exitCode([], 1)).toBe(1);
  });
});

describe("arguments", () => {
  it("parses the documented flags with their defaults", () => {
    expect(parseArgs(["--url", "https://x.example/"])).toEqual({
      url: "https://x.example",
      catalog: null,
      runs: 20,
      sets: ["classic", "ai-en", "ai-he"],
      assertClassicP95: null,
      assertAiP50: null,
      assertAiP95: null,
      aiPerMinute: 10,
    });
    expect(
      parseArgs([
        "--url", "https://x.example", "--catalog", "demo", "--runs", "5",
        "--set", "classic", "--assert-classic-p95", "500",
        "--assert-ai-p50", "2000", "--assert-ai-p95", "3500", "--ai-per-minute", "8",
      ]),
    ).toMatchObject({ catalog: "demo", runs: 5, sets: ["classic"], assertClassicP95: 500, assertAiP50: 2000, assertAiP95: 3500, aiPerMinute: 8 });
  });

  it("rejects a missing url, an unknown set, an unknown flag, and a bad count", () => {
    expect(() => parseArgs([])).toThrow(ProbeUsageError);
    expect(() => parseArgs(["--url", "u", "--set", "ai"])).toThrow(ProbeUsageError);
    expect(() => parseArgs(["--url", "u", "--verbose", "1"])).toThrow(ProbeUsageError);
    expect(() => parseArgs(["--url", "u", "--runs", "0"])).toThrow(ProbeUsageError);
    expect(() => parseArgs(["--url", "u", "--runs"])).toThrow(ProbeUsageError);
  });

  it("sends the query, a fresh session and the catalog when given — never an engine (YOY-155 AC-3)", () => {
    expect(() => parseArgs(["--url", "u", "--engine", "v2"])).toThrow(ProbeUsageError);
    const plain = probeSearchParams(parseArgs(["--url", "u"]), "linen dress");
    expect(plain.has("engine")).toBe(false);
    expect(plain.has("catalog")).toBe(false);
    expect(plain.get("query")).toBe("linen dress");
    expect(probeSearchParams(parseArgs(["--url", "u", "--catalog", "demo"]), "q").get("catalog")).toBe("demo");
  });
});

describe("the committed query set", () => {
  it("holds five queries per set — classic, EN AI, HE AI", () => {
    const queries = loadQueries();
    expect(Object.keys(queries).sort()).toEqual(["ai-en", "ai-he", "classic"]);
    for (const set of ["classic", "ai-en", "ai-he"] as const) {
      expect(queries[set]).toHaveLength(5);
      expect(new Set(queries[set]).size).toBe(5);
    }
    for (const query of queries["ai-he"]) {
      expect(query).toMatch(/[֐-׿]/);
    }
  });
});

describe("distinct query text per run (YOY-64 AC-6)", () => {
  // Exact-query intent reuse (AC-4) would answer runs 2..N of the same text
  // from the stored intent with zero LLM calls and mask the AI bar; each
  // (invocation, run) pair gets its own reuse key while the visible text
  // stays the committed query.
  const invocation = [0x12, 0x34, 0xab, 0xcd];

  it("is a distinct reuse key per run and per invocation, never the base text", () => {
    const base = "summer dress, not black";
    const keys = new Set<string>();
    for (let run = 1; run <= 20; run += 1) {
      keys.add(normalizeReuseQuery(distinctQueryText(base, invocation, run)));
      keys.add(normalizeReuseQuery(distinctQueryText(base, [0x12, 0x34, 0xab, 0xce], run)));
    }
    expect(keys.size).toBe(40);
    expect(keys.has(normalizeReuseQuery(base))).toBe(false);
  });

  it("keeps the shopper-visible text — and every committed token — exactly the committed query", () => {
    for (const base of ["summer dress, not black", "מעיל חם לחורף עד 600", "warm coat for winter under 600"]) {
      const varied = distinctQueryText(base, invocation, 7);
      expect(visibleQueryText(varied)).toBe(base);
      // The marker is one extra whitespace-delimited token holding no
      // letter, digit, or whitespace: the committed tokens are untouched.
      const tokens = normalizeReuseQuery(varied).split(" ");
      expect(tokens.slice(0, -1)).toEqual(normalizeReuseQuery(base).split(" "));
      expect(tokens.at(-1)).toMatch(/^(?:\u200B|\u200C|\u200D|\u2060)+$/u);
      expect(tokens.at(-1)).not.toMatch(/[\p{L}\p{N}\s]/u);
    }
  });
});
