import { constraintsFromIntent } from "@unfiltered/engine";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  findViolations,
  goldenHit,
  loadBaselineHits,
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

    expect(catalog).toHaveLength(66);
    expect(goldens).toHaveLength(35);

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
      // A zero-hit golden (YOY-111 AC-5) expects no product by design.
      if (golden.zeroHit === undefined) {
        expect(golden.expectedProductIds.length, golden.id).toBeGreaterThan(0);
      } else {
        expect(golden.expectedProductIds, golden.id).toEqual([]);
      }
      for (const id of golden.expectedProductIds) {
        expect(ids.has(id), `${golden.id} expects unknown product ${id}`).toBe(true);
      }
      for (const id of golden.mustNotProductIds ?? []) {
        expect(ids.has(id), `${golden.id} forbids unknown product ${id}`).toBe(true);
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
        { category: null, colors: [], occasions: ["Casual"], primaryColor: null },
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
        { category: null, colors: [], occasions: ["Wedding", "party"], primaryColor: null },
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
    enrichment: {
      category: string | null;
      colors: string[];
      occasions: string[];
      primaryColor?: string | null;
    },
  ) =>
    new Map([
      [
        product.productId,
        // Like the store seeds: the first stated colour is the default primary.
        { primaryColor: enrichment.colors[0] ?? null, ...enrichment },
      ],
    ]);

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

  it("judges an excluded colour by the primary colour alone (YOY-110 AC-5)", () => {
    // p62's shape: displayed pink, also in black — not a "black" violation.
    const colourway = enrich({
      category: "dress",
      colors: ["pink", "black", "navy"],
      occasions: [],
      primaryColor: "pink",
    });
    expect(
      findViolations(golden({ colorsExclude: ["black"] }), product.productId, products, colourway),
    ).toEqual([]);
    // Primary colour IS the excluded colour: a violation, case-insensitively.
    const black = enrich({ category: "dress", colors: ["black"], occasions: [], primaryColor: "Black" });
    expect(
      findViolations(golden({ colorsExclude: ["black"] }), product.productId, products, black),
    ).toHaveLength(1);
    // Unknown primary colour passes, even with the colour among the colourways.
    const unknownPrimary = enrich({
      category: "dress",
      colors: ["black"],
      occasions: [],
      primaryColor: null,
    });
    expect(
      findViolations(golden({ colorsExclude: ["black"] }), product.productId, products, unknownPrimary),
    ).toEqual([]);
    // Inclusion still reads every colourway (NG-1).
    expect(
      findViolations(golden({ colorsInclude: ["black"] }), product.productId, products, colourway),
    ).toEqual([]);
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
    // B contract the model decides them, and cross-language routes ai. The
    // goldens carry expectedRoute "ai" as the contract; this pins the route
    // reason and per-search spend on top.
    for (const id of ["gc05", "gc06", "gc08"]) {
      const score = result.perQuery.find((entry) => entry.golden.id === id);
      expect(score, `${id} did not run`).toBeDefined();
      expect(score!.route, id).toBe("ai");
      expect(score!.routeReason, id).toBe("model");
      // The full AI path spends real per-search money now.
      expect(score!.costUsd, id).toBeGreaterThan(0);
    }
  });

  it("scores the zero-hit golden on the close-match ladder: empty hits, non-empty close matches, no black-primary product, budget relaxed first (YOY-111 AC-5)", () => {
    const score = result.perQuery.find((entry) => entry.golden.id === "g25")!;
    expect(score.golden.query).toBe("summer dress, not black, under 100");
    expect(score.route).toBe("ai");
    expect(score.hits).toEqual([]);
    expect(score.closeMatches.length).toBeGreaterThan(0);
    expect(score.closeMatchesRelaxed[0]).toBe("priceMax");
    expect(score.violations).toEqual([]);
    expect(score.zeroHitSatisfied).toBe(true);
    // The fixture's black-primary dress (p63) is never a close match.
    expect(score.closeMatches.map((card) => card.productId)).not.toContain("p63");
  });

  it("collapses a colourway family to the query-colour member on both routes: pink rib knit top → the pink member first, no sibling in the top 10; `black dress` still hits (YOY-117 AC-3)", () => {
    // g26 is what the live classifier makes of the bare query — a classic
    // route, where the title match picks the pink member; g27 adds a price
    // cap so the query escalates to the AI path, where `colorsInclude`
    // picks the representative inside the vector query.
    for (const [id, route] of [["g26", "classic"], ["g27", "ai"]] as const) {
      const score = result.perQuery.find((entry) => entry.golden.id === id)!;
      expect(score.route, id).toBe(route);
      expect(score.hits[0]?.productId, id).toBe("p64");
      const top = score.hits.slice(0, 10).map((card) => card.productId);
      expect(top, id).not.toContain("p65");
      expect(top, id).not.toContain("p66");
      expect(score.violations, id).toEqual([]);
    }
    // Families never hide a different product: the classic `black dress`
    // golden (g22) keeps its expected hits.
    const classic = result.perQuery.find((entry) => entry.golden.id === "g22")!;
    expect(classic.firstExpectedRank).not.toBeNull();
  });

  it("meets the pass bar: ≥80% of goldens hit an expected product in the top 10 (AC-3)", () => {
    const misses = result.perQuery
      .filter((score) => !goldenHit(score))
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

    // Every golden's documented soft attributes hold too. The documented
    // sets were pinned against the accuracy tier; under lite-first routing
    // (YOY-116) a lite-tier answer may phrase them differently — r03 answers
    // ["air max 90"], ["nike air max 90"], or nothing at all where the
    // accuracy tier said ["nike", "air max 90"] (measured live on YOY-64:
    // the pre-trim prompt returned [] for r03 in 4 of 6 samples, so a
    // non-empty requirement was a single-sample coin flip) — so a lite
    // answer is compared word by word: every word it produces must come
    // from the documented set (nothing invented, nothing foreign), while an
    // accuracy-tier answer still matches exactly. Soft attributes are
    // similarity hints; the hard-constraint misses above are the contract.
    for (const entry of result.perRefinement) {
      const produced = entry.intent!.softAttributes;
      const documented = entry.golden.expectedSoftAttributes;
      if (entry.intentTier === "accuracy") {
        expect(produced, entry.golden.id).toEqual(documented);
        continue;
      }
      const words = (attributes: string[]) =>
        attributes.flatMap((attribute) => attribute.toLowerCase().split(/\s+/));
      const documentedWords = new Set(words(documented));
      const foreign = words(produced).filter((word) => !documentedWords.has(word));
      expect(
        foreign,
        `${entry.golden.id}: lite soft attributes ${JSON.stringify(produced)} vs documented ${JSON.stringify(documented)}`,
      ).toEqual([]);
    }
  });

  it("returns zero refinement constraint misses (YOY-42 AC-3)", () => {
    expect(
      result.perRefinement.flatMap((score) => score.violations),
    ).toEqual([]);
  });

  it("keeps blended per-search cost within $0.60 per 1,000 AI searches (AC-4; YOY-116 AC-5 bar)", () => {
    expect(result.perSearchCostPer1000Usd).toBeGreaterThan(0);
    expect(result.perSearchCostPer1000Usd).toBeLessThanOrEqual(0.6);
  });

  it("regresses no golden and no refinement against the committed baseline (YOY-116 AC-5)", () => {
    const baseline = loadBaselineHits();
    const regressions: string[] = [];
    for (const score of result.perQuery) {
      if (baseline.goldens[score.golden.id] === true && !goldenHit(score)) {
        regressions.push(`${score.golden.id} hit at baseline, misses now`);
      }
    }
    for (const score of result.perRefinement) {
      if (baseline.refinements[score.golden.id] === true && score.violations.length > 0) {
        regressions.push(`${score.golden.id} clean at baseline, ${score.violations.length} miss(es) now`);
      }
    }
    expect(regressions, `regressions: ${regressions.join("; ")}`).toEqual([]);
    // The baseline covers every golden that runs, so a new golden cannot
    // slip in unbaselined.
    for (const score of result.perQuery) {
      expect(baseline.goldens, score.golden.id).toHaveProperty(score.golden.id);
    }
    for (const score of result.perRefinement) {
      expect(baseline.refinements, score.golden.id).toHaveProperty(score.golden.id);
    }
  });

  it("trimmed the intent prompt by at least 30 % of input tokens with the bars intact (YOY-64 AC-2)", () => {
    expect(result.intentInputTokens.before).toBeGreaterThan(0);
    expect(result.intentInputTokens.after).toBeGreaterThan(0);
    expect(
      result.intentInputTokens.reduction,
      `intent input tokens before ${result.intentInputTokens.before} / after ${result.intentInputTokens.after}`,
    ).toBeGreaterThanOrEqual(0.3);
  });

  it("reports the lite-first blend: a tier per AI golden, escalation rate, calls per tier (YOY-116 AC-5)", () => {
    for (const score of result.perQuery) {
      if (score.route === "ai") {
        expect(score.intentTier, score.golden.id).toMatch(/^(lite|accuracy)$/);
      } else {
        expect(score.intentTier, score.golden.id).toBeNull();
      }
    }
    for (const score of result.perRefinement) {
      expect(score.intentTier, score.golden.id).toMatch(/^(lite|accuracy)$/);
    }
    expect(result.escalationRate).toBeGreaterThanOrEqual(0);
    expect(result.escalationRate).toBeLessThanOrEqual(1);
    // Every AI golden spent at least one intent call; an escalated one two.
    const aiGoldens = result.perQuery.filter((score) => score.route === "ai").length;
    expect(result.intentCalls.lite + result.intentCalls.accuracy).toBeGreaterThanOrEqual(
      aiGoldens + result.perRefinement.length,
    );
    // The lite tier answers something: lite-first is not accuracy-only in
    // disguise.
    expect(result.intentCalls.lite).toBeGreaterThan(0);
    expect(result.escalationThreshold).toBeGreaterThan(0);
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
