import { constraintsFromIntent } from "@unfiltered/engine";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  findViolations,
  loadCatalog,
  loadGoldens,
  loadRefinementGoldens,
  refinementViolations,
  runEval,
  type EvalRunResult,
  type Golden,
} from "./harness.server";
import { assertEngineSourceExecution } from "./source-guard.server";

// Same source-execution guard as regenerate-live.test.ts (YOY-52 run-6): an
// offline eval scored against dist-resolved engine logic is as misleading as
// a live one, and the check is free.
assertEngineSourceExecution();

// The sparse-catalog quality harness (YOY-27): one deterministic offline eval
// run over recorded fixtures, asserted against the M2 pass bar. Runs inside
// default `npm test` — zero network calls (AC-2, NG-2).

describe("eval fixtures (AC-1)", () => {
  it("ships the sparse catalog and golden queries at the specified sizes", () => {
    const catalog = loadCatalog();
    const goldens = loadGoldens();

    expect(catalog).toHaveLength(61);
    expect(goldens).toHaveLength(31);

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

describe("refinement fixtures (YOY-42 AC-3)", () => {
  it("ships at least six refinement goldens across EN, HE, and mixed", () => {
    const refinements = loadRefinementGoldens();

    expect(refinements.length).toBeGreaterThanOrEqual(6);
    for (const language of ["en", "he", "mixed"] as const) {
      expect(
        refinements.filter((golden) => golden.language === language).length,
        language,
      ).toBeGreaterThan(0);
    }
    // Every golden states the three things a refinement case needs.
    for (const golden of refinements) {
      expect(golden.previousIntent, golden.id).toBeDefined();
      expect(golden.query.length, golden.id).toBeGreaterThan(0);
      expect(golden.expectedConstraints, golden.id).toBeDefined();
    }
  });

  it("keys every follow-up query uniquely, base goldens included", () => {
    // Replay recordings are keyed by the query line alone, so two goldens
    // sharing a query text would replay one another's recorded answer.
    const queries = [
      ...loadGoldens().map((golden) => golden.query),
      ...loadRefinementGoldens().map((golden) => golden.query),
    ];
    expect(new Set(queries).size).toBe(queries.length);
  });

  it("scores a constraint outcome against the golden, size included", () => {
    const golden = loadRefinementGoldens().find((entry) => entry.id === "r01")!;
    const merged = {
      category: "dress",
      priceMax: 250,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      availabilityRequired: false,
      softAttributes: ["elegant", "summer"],
    };

    expect(refinementViolations(golden, merged)).toEqual([]);
    // A dropped prior constraint and a wrong size both fail the golden.
    expect(
      refinementViolations(golden, { ...merged, occasion: undefined }),
    ).toHaveLength(1);
    expect(refinementViolations(golden, { ...merged, size: "M" })).toHaveLength(1);
  });

  it("scores comparative tightening as a strict inequality (YOY-52 AC-15)", () => {
    // r01 pins "cheaper" as expectedPriceMaxBelow: any priceMax strictly
    // under the previous bound passes; echoing it unchanged — the live-run
    // defect — or dropping it fails.
    const cheaper = loadRefinementGoldens().find((entry) => entry.id === "r01")!;
    const merged = {
      category: "dress",
      priceMax: 250,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      availabilityRequired: false,
      softAttributes: ["elegant", "summer"],
    };
    expect(cheaper.expectedPriceMaxBelow).toBe(400);
    expect(refinementViolations(cheaper, merged)).toEqual([]);
    expect(refinementViolations(cheaper, { ...merged, priceMax: 399 })).toEqual([]);
    expect(
      refinementViolations(cheaper, { ...merged, priceMax: 400 }),
    ).toHaveLength(1);
    expect(
      refinementViolations(cheaper, { ...merged, priceMax: undefined }),
    ).toHaveLength(1);

    // r09 pins "more expensive" over a cap-only previous intent: the floor
    // must rise strictly above the previous priceMax, which is cleared.
    const pricier = loadRefinementGoldens().find((entry) => entry.id === "r09")!;
    const raised = {
      category: "skirt",
      priceMin: 375,
      colorsInclude: [],
      colorsExclude: ["black"],
      availabilityRequired: false,
      softAttributes: ["למסיבה"],
    };
    expect(pricier.expectedPriceMinAbove).toBe(300);
    expect(refinementViolations(pricier, raised)).toEqual([]);
    expect(
      refinementViolations(pricier, { ...raised, priceMin: 300 }),
    ).toHaveLength(1);
    expect(
      refinementViolations(pricier, { ...raised, priceMin: undefined }),
    ).toHaveLength(1);
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

describe("violation scoring mirrors unknown-passes filtering (YOY-35 AC-2, AC-5)", () => {
  const catalog = loadCatalog();
  const product = catalog[0]!;
  const products = new Map(catalog.map((entry) => [entry.productId, entry]));
  const golden = (
    overrides: Partial<Golden["hardConstraints"]>,
  ): Golden => ({
    id: "mirror-probe",
    language: "en",
    query: "probe",
    hardConstraints: {
      category: null,
      priceMin: null,
      priceMax: null,
      colorsInclude: [],
      colorsExclude: [],
      occasion: null,
      availabilityRequired: false,
      ...overrides,
    },
    expectedProductIds: [product.productId],
  });
  const enrich = (
    enrichment: { category: string | null; colors: string[]; occasions: string[] },
  ) => new Map([[product.productId, enrichment]]);

  it("does not flag empty enrichment occasions or colors against positive constraints", () => {
    const sparse = enrich({ category: null, colors: [], occasions: [] });
    expect(
      findViolations(
        golden({ occasion: "wedding", colorsInclude: ["red"] }),
        product.productId,
        products,
        sparse,
      ),
    ).toEqual([]);
  });

  it("still flags stated-and-mismatched occasions and colors", () => {
    const stated = enrich({
      category: null,
      colors: ["black"],
      occasions: ["beach"],
    });
    const violations = findViolations(
      golden({ occasion: "wedding", colorsInclude: ["red"] }),
      product.productId,
      products,
      stated,
    );
    expect(violations).toHaveLength(2);
  });

  it("admits a category group's members for a parent constraint, exact for a child (AC-5)", () => {
    const sneakers = enrich({ category: "sneakers", colors: [], occasions: [] });
    const jewelry = enrich({ category: "jewelry", colors: [], occasions: [] });
    // g07's and g20's shapes: shoes admits sneakers; accessories admits jewelry.
    expect(
      findViolations(golden({ category: "shoes" }), product.productId, products, sneakers),
    ).toEqual([]);
    expect(
      findViolations(golden({ category: "accessories" }), product.productId, products, jewelry),
    ).toEqual([]);
    // A child constraint stays exact.
    const shoes = enrich({ category: "shoes", colors: [], occasions: [] });
    expect(
      findViolations(golden({ category: "sneakers" }), product.productId, products, shoes),
    ).toHaveLength(1);
    // A category constraint still requires evidence: null category violates.
    const unknown = enrich({ category: null, colors: [], occasions: [] });
    expect(
      findViolations(golden({ category: "dress" }), product.productId, products, unknown),
    ).toHaveLength(1);
  });
});

describe("eval run (AC-2, AC-3, AC-4, AC-6)", () => {
  let result: EvalRunResult;

  beforeAll(async () => {
    result = await runEval(await createTestDb());
  }, 120_000);

  it("keeps the goldens' documented constraints in sync with the recorded intents", () => {
    for (const score of result.perQuery) {
      if ((score.golden.expectedRoute ?? "ai") === "classic") {
        continue; // classic goldens extract no intent by design (YOY-41)
      }
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

  it("routes and scores the classic goldens through the keyword engine (YOY-41 AC-6)", () => {
    const classic = result.perQuery.filter(
      (score) => score.golden.expectedRoute === "classic",
    );
    // Six controls since YOY-67 AC-2: the three Hebrew short-query classic
    // goldens re-routed to the AI path — the Option B contract settles
    // cross-script queries at the model, never by length — leaving the
    // exact EN, EN typo, quoted-phrase, and SKU-like shapes.
    expect(classic.length).toBeGreaterThanOrEqual(6);
    expect(classic.some((score) => score.golden.language === "en")).toBe(true);
    expect(classic.some((score) => /\d/.test(score.golden.query))).toBe(true);
    for (const score of classic) {
      expect(score.route, score.golden.id).toBe("classic");
      expect(score.hits.length, score.golden.id).toBeGreaterThan(0);
      // The expected product must appear in the top 5 classic results.
      expect(score.firstExpectedRank, score.golden.id).not.toBeNull();
      expect(score.firstExpectedRank!, score.golden.id).toBeLessThanOrEqual(5);
      if (score.routeReason === "model") {
        // A model-decided classic golden (the hybrid ladder's same-language
        // attribute+noun shape, YOY-52) spends exactly its one
        // classification call — never intent or embedding spend.
        expect(score.costUsd, score.golden.id).toBeGreaterThan(0);
      } else {
        // A heuristic-settled classic search issues zero LLM/embedding
        // calls (AC-5).
        expect(score.costUsd, score.golden.id).toBe(0);
      }
    }
  });

  it("routes the Hebrew short-query goldens to the AI path (YOY-67 AC-2)", () => {
    // The documented consequence of the non-Latin heuristic guard: these
    // three settled classic by the short-query rule before; under the Option
    // B contract the model decides them, and cross-language routes ai. Their
    // classification recordings are synthesized until the run-8 live
    // regeneration replaces them.
    for (const id of ["gc05", "gc06", "gc08"]) {
      const score = result.perQuery.find((entry) => entry.golden.id === id);
      expect(score, `${id} did not run`).toBeDefined();
      expect(score!.route, id).toBe("ai");
      expect(score!.routeReason, id).toBe("model");
      // The full AI path spends real per-search money now.
      expect(score!.costUsd, id).toBeGreaterThan(0);
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

  it("merges follow-up queries into the previous intent (YOY-42 AC-2, AC-3)", () => {
    const score = (id: string) => {
      const found = result.perRefinement.find((entry) => entry.golden.id === id);
      expect(found, `refinement golden ${id} did not run`).toBeDefined();
      return found!;
    };

    // Comparative follow-up: price tightens, everything else survives.
    const cheaper = score("r01");
    expect(cheaper.intent!.category).toBe("dress");
    expect(cheaper.intent!.occasion).toBe("wedding");
    expect(cheaper.intent!.colorsExclude).toEqual(["black"]);
    expect(cheaper.intent!.priceMax).toBeLessThan(
      cheaper.golden.previousIntent.priceMax!,
    );

    // Additive Hebrew follow-up: constraints preserved, new soft attribute.
    const sleeveless = score("r02");
    expect(sleeveless.intent!.category).toBe("dress");
    expect(sleeveless.intent!.priceMax).toBe(400);
    expect(sleeveless.intent!.occasion).toBe("wedding");
    expect(sleeveless.intent!.softAttributes).toEqual(
      expect.arrayContaining(sleeveless.golden.previousIntent.softAttributes),
    );
    expect(sleeveless.intent!.softAttributes.length).toBeGreaterThan(
      sleeveless.golden.previousIntent.softAttributes.length,
    );

    // Topic change: nothing carries over from the previous intent.
    const fresh = score("r03");
    expect(fresh.intent!.category).toBe("sneakers");
    expect(fresh.intent!.occasion).toBeUndefined();
    expect(fresh.intent!.priceMax).toBeUndefined();
    expect(fresh.intent!.colorsExclude).toEqual([]);
    for (const attribute of fresh.golden.previousIntent.softAttributes) {
      expect(fresh.intent!.softAttributes).not.toContain(attribute);
    }

    // Every golden's documented soft attributes hold too.
    for (const entry of result.perRefinement) {
      expect(entry.intent!.softAttributes, entry.golden.id).toEqual(
        entry.golden.expectedSoftAttributes,
      );
    }
  });

  it("returns zero refinement constraint misses (YOY-42 AC-3)", () => {
    expect(
      result.perRefinement.flatMap((score) => score.violations),
    ).toEqual([]);
  });

  it("keeps blended per-search cost within $2.00 per 1,000 AI searches (AC-4)", () => {
    expect(result.perSearchCostPer1000Usd).toBeGreaterThan(0);
    expect(result.perSearchCostPer1000Usd).toBeLessThanOrEqual(2.0);
  });

  it("blends only full-path AI searches; refinement cost is its own line (YOY-52 AC-2)", () => {
    // The blended denominator counts exactly the goldens that ran the full
    // per-search path (classification, intent, query embedding, retrieval).
    expect(result.blendedAiSearchCount).toBe(
      result.perQuery.filter((score) => score.route === "ai").length,
    );
    // Intent-only refinement follow-ups are excluded from the blend and
    // reported separately — they cost real money, just not full-path money.
    expect(result.refinementCostPer1000Usd).toBeGreaterThan(0);
    expect(result.perRefinement.length).toBeGreaterThan(0);
  });

  it("reports the one-time indexing cost separately from per-search cost (AC-4)", () => {
    expect(result.oneTimeCostUsd).toBeGreaterThan(0);
  });
});
