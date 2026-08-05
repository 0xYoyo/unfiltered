import { constraintsFromIntent } from "@unfiltered/engine";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  findViolations,
  loadCatalog,
  loadGoldens,
  runEval,
  type EvalRunResult,
  type Golden,
} from "./harness.server";

// The sparse-catalog quality harness (YOY-27): one deterministic offline eval
// run over recorded fixtures, asserted against the M2 pass bar. Runs inside
// default `npm test` — zero network calls (AC-2, NG-2).

describe("eval fixtures (AC-1)", () => {
  it("ships the sparse catalog and golden queries at the specified sizes", () => {
    const catalog = loadCatalog();
    const goldens = loadGoldens();

    expect(catalog).toHaveLength(60);
    expect(goldens).toHaveLength(20);

    // Deliberately sparse: descriptions are one-liners or empty, tags minimal.
    for (const product of catalog) {
      expect(product.description.length).toBeLessThanOrEqual(80);
      expect(product.tags.length).toBeLessThanOrEqual(2);
    }

    // Both languages present on both sides.
    const hebrew = /[֐-׿]/;
    expect(catalog.some((product) => hebrew.test(product.title))).toBe(true);
    expect(catalog.some((product) => !hebrew.test(product.title))).toBe(true);
    expect(goldens.filter((golden) => golden.language === "en").length).toBeGreaterThan(0);
    expect(goldens.filter((golden) => golden.language === "he").length).toBeGreaterThan(0);
    expect(goldens.filter((golden) => golden.language === "mixed").length).toBeGreaterThan(0);

    // Every golden names expected products that exist in the catalog.
    const ids = new Set(catalog.map((product) => product.productId));
    for (const golden of goldens) {
      expect(golden.expectedProductIds.length).toBeGreaterThan(0);
      for (const id of golden.expectedProductIds) {
        expect(ids.has(id), `${golden.id} expects unknown product ${id}`).toBe(true);
      }
    }
  });
});

describe("violation scoring covers occasion (YOY-29 AC-11)", () => {
  const catalog = loadCatalog();
  const product = catalog[0]!;
  const golden: Golden = {
    id: "occasion-probe",
    language: "en",
    query: "dress for a wedding",
    hardConstraints: {
      category: null,
      priceMin: null,
      priceMax: null,
      colorsInclude: [],
      colorsExclude: [],
      occasion: "wedding",
      availabilityRequired: false,
    },
    expectedProductIds: [product.productId],
  };
  const products = new Map(catalog.map((entry) => [entry.productId, entry]));

  it("flags a returned product whose enrichment occasion misses the constraint", () => {
    const enrichments = new Map([
      [
        product.productId,
        { category: null, colors: [], occasions: ["Casual"] },
      ],
    ]);

    const violations = findViolations(golden, product.productId, products, enrichments);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("wedding");
  });

  it("accepts a product whose occasions satisfy the constraint, case-insensitively", () => {
    const enrichments = new Map([
      [
        product.productId,
        { category: null, colors: [], occasions: ["Wedding", "party"] },
      ],
    ]);

    expect(
      findViolations(golden, product.productId, products, enrichments),
    ).toEqual([]);
  });
});

describe("eval run (AC-2, AC-3, AC-4, AC-6)", () => {
  let result: EvalRunResult;

  beforeAll(async () => {
    result = await runEval(await createTestDb());
  }, 120_000);

  it("keeps the goldens' documented constraints in sync with the recorded intents", () => {
    for (const score of result.perQuery) {
      expect(score.intent, `${score.golden.id} produced no intent`).not.toBeNull();
      const mapped = constraintsFromIntent(score.intent!);
      expect(mapped, score.golden.id).toEqual({
        category: score.golden.hardConstraints.category ?? undefined,
        priceMin: score.golden.hardConstraints.priceMin ?? undefined,
        priceMax: score.golden.hardConstraints.priceMax ?? undefined,
        colorsInclude: score.golden.hardConstraints.colorsInclude,
        colorsExclude: score.golden.hardConstraints.colorsExclude,
        occasion: score.golden.hardConstraints.occasion ?? undefined,
        availableOnly: score.golden.hardConstraints.availabilityRequired,
      });
    }
  });

  it("meets the pass bar: ≥80% of goldens hit an expected product in the top 10 (AC-3)", () => {
    const misses = result.perQuery
      .filter((score) => score.firstExpectedRank === null)
      .map((score) => score.golden.id);
    expect(result.hitRate, `misses: ${misses.join(", ")}`).toBeGreaterThanOrEqual(0.8);
  });

  it("returns zero hard-constraint violations in any query's top 10 (AC-3)", () => {
    const violations = result.perQuery.flatMap((score) => score.violations);
    expect(violations).toEqual([]);
  });

  it("keeps blended per-search cost within $2.00 per 1,000 AI searches (AC-4)", () => {
    expect(result.perSearchCostPer1000Usd).toBeGreaterThan(0);
    expect(result.perSearchCostPer1000Usd).toBeLessThanOrEqual(2.0);
  });

  it("reports the one-time indexing cost separately from per-search cost (AC-4)", () => {
    expect(result.oneTimeCostUsd).toBeGreaterThan(0);
  });
});
