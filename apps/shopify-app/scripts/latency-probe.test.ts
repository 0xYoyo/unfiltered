import { describe, expect, it } from "vitest";

import { normalizeReuseQuery } from "../app/search/events.server";
import {
  distinctQueryText,
  evaluateAssertions,
  exitCode,
  formatBreaches,
  formatSummary,
  loadQueries,
  parseArgs,
  percentile,
  ProbeUsageError,
  summarize,
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
    routeReason: "model",
    degraded: false,
    limited: null,
    latencyMs: 1000,
    stages: { classify: 40, intent: 600, embed: 100, retrieve: 200, hydrate: 10 },
    ...overrides,
  };
}

describe("set summaries", () => {
  it("reports n, p50, p95, degraded/limited counts, routes, and the mean per stage", () => {
    const summary = summarize("ai-en", [
      sample({ latencyMs: 900 }),
      sample({ latencyMs: 1100, routeReason: "intent-reuse", stages: { classify: 20, intent: 400, embed: 50, retrieve: 100, hydrate: 10 } }),
      sample({ latencyMs: 300, route: "classic", degraded: true, stages: { classify: 30, intent: 900, classic: 20, hydrate: 5 } }),
      sample({ latencyMs: 250, route: "classic", degraded: true, limited: "ip", stages: { classic: 20, hydrate: 5 } }),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!.n).toBe(4);
    expect(summary!.p50).toBe(300);
    expect(summary!.p95).toBe(1100);
    expect(summary!.degraded).toBe(2);
    expect(summary!.limited).toBe(1);
    expect(summary!.reused).toBe(1);
    expect(summary!.routes).toEqual({ ai: 2, classic: 2 });
    // Means are over the samples that ran the stage, in pipeline order.
    expect(Object.keys(summary!.meanStages)).toEqual([
      "classify",
      "intent",
      "embed",
      "retrieve",
      "classic",
      "hydrate",
    ]);
    expect(summary!.meanStages.intent).toBe(Math.round((600 + 400 + 900) / 3));
    expect(summary!.meanStages.classic).toBe(20);
    expect(formatSummary(summary!)).toContain("p50=300 ms p95=1100 ms degraded=2 limited=1 reused=1");
  });

  it("is null for an empty set rather than a fake zero", () => {
    expect(summarize("classic", [])).toBeNull();
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

  it("keeps the shopper-visible text — and every classifier token — exactly the committed query", () => {
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
