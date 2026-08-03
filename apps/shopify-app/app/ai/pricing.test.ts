import { describe, expect, it } from "vitest";

import { computeCostUsd, getModelPrice } from "./pricing.server";

// AC-2: cost comes from the committed price table; unknown models fail
// loudly instead of metering $0.
describe("AI price table", () => {
  it("exposes paid-tier prices for known models", () => {
    const price = getModelPrice("gemini-2.5-flash");
    expect(price.inputUsdPerMTok).toBeGreaterThan(0);
    expect(price.outputUsdPerMTok).toBeGreaterThan(0);
  });

  it("computes cost in USD from per-1M-token rates", () => {
    // 1M input tokens at $0.30/MTok + 1M output tokens at $2.50/MTok.
    expect(computeCostUsd("gemini-2.5-flash", 1_000_000, 1_000_000)).toBeCloseTo(
      2.8,
      10,
    );
    // 1000 in / 500 out: (1000*0.30 + 500*2.50) / 1e6.
    expect(computeCostUsd("gemini-2.5-flash", 1000, 500)).toBeCloseTo(
      0.00155,
      10,
    );
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
