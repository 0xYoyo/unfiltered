import { describe, expect, it } from "vitest";

import { computeCostUsd, getModelPrice } from "./pricing.server";

// AC-2: cost comes from the committed price table; unknown models fail
// loudly instead of metering $0.
describe("AI price table", () => {
  it("exposes paid-tier prices for known models", () => {
    const price = getModelPrice("gemini-3.5-flash-lite");
    expect(price.inputUsdPerMTok).toBeGreaterThan(0);
    expect(price.outputUsdPerMTok).toBeGreaterThan(0);
  });

  it("computes cost in USD from per-1M-token rates", () => {
    // 1M input tokens at $0.30/MTok + 1M output tokens at $2.50/MTok.
    expect(computeCostUsd("gemini-3.5-flash-lite", 1_000_000, 1_000_000)).toBeCloseTo(
      2.8,
      10,
    );
    // 1000 in / 500 out: (1000*0.30 + 500*2.50) / 1e6.
    expect(computeCostUsd("gemini-3.5-flash-lite", 1000, 500)).toBeCloseTo(
      0.00155,
      10,
    );
  });

  it("prices gemini-3.6-flash at the rate in force through 2026-12-31 (YOY-116 AC-8)", () => {
    // $1.50 / $7.50 is the 2027 price; metering it today over-charges 2×.
    expect(getModelPrice("gemini-3.6-flash")).toMatchObject({
      inputUsdPerMTok: 0.75,
      outputUsdPerMTok: 3.75,
    });
    expect(getModelPrice("gemini-3.5-flash-lite")).toMatchObject({
      inputUsdPerMTok: 0.3,
      outputUsdPerMTok: 2.5,
    });
    // 1000 in / 500 out on the accuracy tier: (1000*0.75 + 500*3.75) / 1e6.
    expect(computeCostUsd("gemini-3.6-flash", 1000, 500)).toBeCloseTo(0.002625, 10);
  });

  it("charges nothing for output on embedding models priced input-only", () => {
    expect(computeCostUsd("gemini-embedding-001", 1_000_000, 0)).toBeCloseTo(
      0.15,
      10,
    );
  });

  it("throws on a model ID missing from the table", () => {
    expect(() => computeCostUsd("made-up-model", 10, 10)).toThrow(
      /made-up-model.*ai-prices\.json/,
    );
    expect(() => getModelPrice("made-up-model")).toThrow();
  });
});
