import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { constraintsFromIntent } from "@unfiltered/engine";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  CONSTRUCTOR_GROUPS,
  CONSTRUCTOR_SET_MINIMUMS,
  CONTAMINATION_TERMS,
  computeConstructorBar,
  contaminationViolations,
  findViolations,
  goldenHit,
  loadBaselineHits,
  loadCatalog,
  loadConstructorFloor,
  loadConstructorGoldens,
  loadContaminationCases,
  loadGoldens,
  loadRefinementGoldens,
  loadVisionGoldens,
  refinementViolations,
  runEval,
  VISION_FIXTURES_DIR,
  VISION_IMAGE_MAX_BYTES,
  type ContaminationCase,
  type EvalRunResult,
  type Golden,
  type QueryScore,
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

    expect(catalog).toHaveLength(92);
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
      ...loadConstructorGoldens().map((golden) => golden.query),
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
      attributesExclude: [],
      attributesInclude: [],
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
      attributesExclude: [],
      attributesInclude: [],
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
      attributesExclude: [],
      attributesInclude: [],
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

describe("Constructor-bar fixtures (YOY-118 AC-1)", () => {
  it("ships ≥ 24 goldens, ≥ 12 per language, ≥ 8 per group, each with expectations, constraints, and a mustNot list", () => {
    const goldens = loadConstructorGoldens();
    const catalog = loadCatalog();
    const ids = new Set(catalog.map((product) => product.productId));

    expect(goldens.length).toBeGreaterThanOrEqual(CONSTRUCTOR_SET_MINIMUMS.total);
    for (const language of ["en", "he"] as const) {
      expect(
        goldens.filter((golden) => golden.language === language).length,
        language,
      ).toBeGreaterThanOrEqual(CONSTRUCTOR_SET_MINIMUMS.perLanguage);
    }
    for (const group of CONSTRUCTOR_GROUPS) {
      expect(
        goldens.filter((golden) => golden.group === group).length,
        group,
      ).toBeGreaterThanOrEqual(CONSTRUCTOR_SET_MINIMUMS.perGroup);
    }
    for (const golden of goldens) {
      expect(golden.expectedProductIds.length, golden.id).toBeGreaterThan(0);
      expect(Array.isArray(golden.mustNotProductIds), golden.id).toBe(true);
      expect(golden.hardConstraints, golden.id).toBeDefined();
      for (const id of [...golden.expectedProductIds, ...golden.mustNotProductIds]) {
        expect(ids.has(id), `${golden.id} names unknown product ${id}`).toBe(true);
      }
      // A product cannot be both expected and forbidden.
      for (const id of golden.mustNotProductIds) {
        expect(golden.expectedProductIds, golden.id).not.toContain(id);
      }
    }
    // The set's ids never collide with the main goldens: recordings and
    // ledger rows are keyed by them.
    const mainIds = new Set(loadGoldens().map((golden) => golden.id));
    for (const golden of goldens) {
      expect(mainIds.has(golden.id), golden.id).toBe(false);
    }
  });

  it("ships the catalog products the set needs: bridal vs guest dresses, sleeveless vs long-sleeve tops, multi-material items (AC-2)", () => {
    const titles = new Map(loadCatalog().map((product) => [product.productId, product.title]));
    expect(titles.get("p67")).toMatch(/wedding dress/i);
    expect(titles.get("p68")).toContain("שמלת כלה");
    expect(titles.get("p69")).toMatch(/guest/i);
    expect(titles.get("p71")).toMatch(/sleeveless/i);
    expect(titles.get("p72")).toMatch(/long-sleeve/i);
    expect(titles.get("p73")).toContain("ללא שרוולים");
    expect(titles.get("p76")).toMatch(/blend/i);
  });

  it("commits the floor as whole numbers: hit rate percent, mustNot count, mustNot-clean percent (AC-3)", () => {
    const floor = loadConstructorFloor();
    for (const percent of [floor.overallHitRatePercent, floor.mustNotCleanRatePercent]) {
      expect(Number.isInteger(percent)).toBe(true);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
    expect(Number.isInteger(floor.mustNotViolationsMax)).toBe(true);
    expect(floor.mustNotViolationsMax).toBeGreaterThanOrEqual(0);
  });

  it("computes the bar per group, per language, and overall, separating mustNot from hard-constraint violations", () => {
    const golden = (id: string, language: "en" | "he", group: (typeof CONSTRUCTOR_GROUPS)[number]) => ({
      id,
      language,
      group,
      query: id,
      expectedProductIds: ["p01"],
      mustNotProductIds: [],
      hardConstraints: {
        category: null,
        priceMin: null,
        priceMax: null,
        colorsInclude: [],
        colorsExclude: [],
        attributesExclude: [],
        attributesInclude: [],
        occasion: null,
        availabilityRequired: false,
      },
    });
    const score = (
      overrides: Partial<QueryScore> & { golden: QueryScore["golden"] },
    ): QueryScore => ({
      route: "ai",
      routeReason: "model",
      intent: null,
      intentTier: "lite",
      hits: [],
      closeMatches: [],
      closeMatchesRelaxed: [],
      firstExpectedRank: 1,
      zeroHitSatisfied: null,
      violations: [],
      mustNotViolations: [],
      costUsd: 0,
      ...overrides,
    });
    const bar = computeConstructorBar(
      [
        score({ golden: golden("a", "en", "negation") }),
        score({ golden: golden("b", "he", "negation"), firstExpectedRank: null }),
        score({
          golden: golden("c", "en", "priceCap"),
          violations: ["p02: price 450 > cap 100", "p03: must not appear"],
          mustNotViolations: ["p03: must not appear"],
          intentTier: "accuracy",
        }),
        score({ golden: golden("d", "he", "occasionVsCategory"), route: "classic", routeReason: "short-query", intentTier: null }),
      ],
      [
        { searchId: "a", costUsd: 0.001 },
        { searchId: "c", costUsd: 0.002 },
        { searchId: "g01", costUsd: 5 }, // a main golden's row: not this bar's
        { searchId: null, costUsd: 5 }, // indexing: not per-search
      ],
    );
    expect(bar.overall).toEqual({ hits: 3, total: 4, rate: 0.75 });
    expect(bar.byGroup.negation.rate).toBe(0.5);
    expect(bar.byGroup.negation.byLanguage.he.rate).toBe(0);
    expect(bar.byGroup.priceCap.byLanguage.en).toEqual({ hits: 1, total: 1, rate: 1 });
    expect(bar.byLanguage.en).toEqual({ hits: 2, total: 2, rate: 1 });
    expect(bar.byLanguage.he.rate).toBe(0.5);
    expect(bar.mustNotViolationCount).toBe(1);
    expect(bar.mustNotCleanRate).toEqual({ hits: 3, total: 4, rate: 0.75 });
    expect(bar.hardConstraintViolationCount).toBe(1);
    // One of three AI-routed goldens escalated; the classic one is not counted.
    expect(bar.escalationRate).toBeCloseTo(1 / 3);
    expect(bar.aiSearchCount).toBe(3);
    expect(bar.costPer1000Usd).toBeCloseTo((0.003 / 3) * 1000);
  });
});

describe("vision fixtures (YOY-122 AC-1, AC-2)", () => {
  const catalog = loadCatalog();
  const byId = new Map(catalog.map((product) => [product.productId, product]));
  const withImages = catalog.filter((product) => (product.images ?? []).length > 0);

  it("ships ≥ 6 contamination cases, each on a catalog product with images, with a sold category and colours and ≥ 1 other item", () => {
    const cases = loadContaminationCases();
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(new Set(cases.map((kase) => kase.productId)).size).toBe(cases.length);
    for (const kase of cases) {
      const product = byId.get(kase.productId);
      expect(product, kase.productId).toBeDefined();
      expect((product!.images ?? []).length, kase.productId).toBeGreaterThan(0);
      expect(kase.sold.categories.length, kase.productId).toBeGreaterThan(0);
      expect(kase.sold.colors.length, kase.productId).toBeGreaterThan(0);
      expect(kase.otherItems.length, kase.productId).toBeGreaterThan(0);
    }
  });

  it("every fixture image exists, is ≤ 200 KB, and is listed with a licence in SOURCES.md", () => {
    const sources = readFileSync(join(VISION_FIXTURES_DIR, "SOURCES.md"), "utf8");
    const files = new Set(withImages.flatMap((product) => product.images ?? []));
    expect(files.size).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const path = join(VISION_FIXTURES_DIR, file);
      expect(existsSync(path), file).toBe(true);
      expect(statSync(path).size, `${file} exceeds ${VISION_IMAGE_MAX_BYTES} bytes`).toBeLessThanOrEqual(
        VISION_IMAGE_MAX_BYTES,
      );
      const row = sources.split("\n").find((line) => line.includes(`\`${file}\``));
      expect(row, `${file} has no SOURCES.md row`).toBeDefined();
      expect(row, `${file} row carries no licence`).toMatch(/CC0|CC BY|Public domain/);
    }
  });

  it("ships ≥ 6 text-sparse products with images: title of ≤ 5 words, no description", () => {
    const sparse = withImages.filter(
      (product) => product.description === "" && product.title.trim().split(/\s+/).length <= 5,
    );
    expect(sparse.length).toBeGreaterThanOrEqual(6);
  });

  it("ships ≥ 6 sparse goldens, unique ids apart from the other sets, each expecting products with images", () => {
    const goldens = loadVisionGoldens();
    expect(goldens.length).toBeGreaterThanOrEqual(6);
    const otherIds = new Set([...loadGoldens(), ...loadConstructorGoldens()].map((golden) => golden.id));
    expect(new Set(goldens.map((golden) => golden.id)).size).toBe(goldens.length);
    for (const golden of goldens) {
      expect(otherIds.has(golden.id), golden.id).toBe(false);
      expect(golden.expectedProductIds.length, golden.id).toBeGreaterThan(0);
      for (const id of golden.expectedProductIds) {
        expect((byId.get(id)?.images ?? []).length, `${golden.id} expects ${id} without images`).toBeGreaterThan(0);
      }
    }
    expect(goldens.some((golden) => golden.language === "he")).toBe(true);
  });
});

describe("contamination scoring (YOY-122 AC-1)", () => {
  const kase: ContaminationCase = {
    productId: "px",
    sold: { item: "grey hoodie", categories: ["top"], colors: ["grey", "black"] },
    otherItems: [
      { item: "black jeans", colors: ["black"] },
      { item: "white sneakers", colors: ["white"] },
      { item: "silver necklace", colors: ["silver"] },
    ],
  };
  const answer = (overrides: Partial<Parameters<typeof contaminationViolations>[1] & object> = {}) => ({
    category: "top",
    colors: ["grey", "black"],
    primaryColor: "grey",
    occasions: [],
    fit: "relaxed",
    styleTags: ["casual", "streetwear"],
    sleeveLength: "long",
    neckline: "hooded",
    garmentLength: "hip",
    pattern: "solid",
    materialAppearance: "fleece",
    ...overrides,
  });

  it("passes a clean answer: sold category, sold colours only (shared colours included), no footwear/jewellery/bag tag", () => {
    expect(contaminationViolations(kase, answer())).toEqual([]);
    // gray and grey are one colour; black is shared with the jeans, so it is not foreign.
    expect(contaminationViolations(kase, answer({ colors: ["Gray"], primaryColor: "gray" }))).toEqual([]);
  });

  it("flags the other items' category, their unique colours, and their terms in styleTags; a missing answer is a violation", () => {
    expect(contaminationViolations(kase, answer({ category: "sneakers" }))).toEqual([
      expect.stringContaining("category \"sneakers\" is not the sold item's"),
    ]);
    expect(contaminationViolations(kase, answer({ colors: ["grey", "white"] }))).toEqual([
      expect.stringContaining("colour \"white\" belongs to the white sneakers"),
    ]);
    expect(contaminationViolations(kase, answer({ primaryColor: "silver" }))).toEqual([
      expect.stringContaining("colour \"silver\" belongs to the silver necklace"),
    ]);
    expect(contaminationViolations(kase, answer({ styleTags: ["casual", "white sneakers"] }))).toEqual([
      expect.stringContaining("styleTag \"white sneakers\" names sneakers"),
    ]);
    expect(contaminationViolations(kase, answer({ styleTags: ["Necklace"] }))).toHaveLength(1);
    expect(contaminationViolations(kase, null)).toEqual(["px: no vision answer recorded"]);
    for (const term of ["sneakers", "heels", "necklace", "handbag", "watch"]) {
      expect(CONTAMINATION_TERMS).toContain(term);
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
      attributesExclude: [],
      attributesInclude: [],
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
      attributesExclude: [],
      attributesInclude: [],
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
        attributesExclude: score.golden.hardConstraints.attributesExclude ?? [],
        attributesInclude: score.golden.hardConstraints.attributesInclude ?? [],
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

  it("clears the Constructor bar: 0 hard-constraint violations, mustNot leak no worse than the committed floor, overall hit rate ≥ the committed floor (YOY-118 AC-3)", () => {
    const bar = result.constructorBar;
    const floor = loadConstructorFloor();
    expect(result.perConstructor.length).toBe(loadConstructorGoldens().length);
    // mustNot (amended AC-3): the floor records the measured leak and the
    // harness holds the line there — never more appearances, never fewer
    // clean goldens. YOY-133 made negated attributes hard exclusions and
    // routed purpose phrases AI: the floor is 0 / 100 %.
    const mustNot = result.perConstructor.flatMap((score) => score.mustNotViolations);
    expect(
      mustNot.length,
      `mustNot violations ${mustNot.length} > committed ${floor.mustNotViolationsMax}: ${mustNot.join("; ")}`,
    ).toBeLessThanOrEqual(floor.mustNotViolationsMax);
    expect(bar.mustNotViolationCount).toBe(mustNot.length);
    const leaking = result.perConstructor
      .filter((score) => score.mustNotViolations.length > 0)
      .map((score) => score.golden.id);
    expect(
      Math.floor(bar.mustNotCleanRate.rate * 100),
      `mustNot-clean ${(bar.mustNotCleanRate.rate * 100).toFixed(1)} % below the committed ${floor.mustNotCleanRatePercent} %; leaking: ${leaking.join(", ")}`,
    ).toBeGreaterThanOrEqual(floor.mustNotCleanRatePercent);
    const hard = result.perConstructor.flatMap((score) =>
      score.violations.filter((violation) => !score.mustNotViolations.includes(violation)),
    );
    expect(hard, `hard-constraint violations: ${hard.join("; ")}`).toEqual([]);
    expect(bar.hardConstraintViolationCount).toBe(0);
    const misses = result.perConstructor
      .filter((score) => !goldenHit(score))
      .map((score) => score.golden.id);
    expect(
      Math.floor(bar.overall.rate * 100),
      `overall ${(bar.overall.rate * 100).toFixed(1)} % below the committed floor ${floor.overallHitRatePercent} %; misses: ${misses.join(", ")}`,
    ).toBeGreaterThanOrEqual(floor.overallHitRatePercent);
    // Every golden in the set ran end to end: a route, and a tier on the AI path.
    for (const score of result.perConstructor) {
      expect(score.route, score.golden.id).toMatch(/^(ai|classic)$/);
      if (score.route === "ai") {
        expect(score.intentTier, score.golden.id).toMatch(/^(lite|accuracy)$/);
      }
    }
    // The set's spend is its own line, never blended into the main bar.
    expect(result.blendedAiSearchCount).toBe(
      result.perQuery.filter((score) => score.route === "ai").length,
    );
  });

  it("scores every contamination case on the vision answer with zero violations (YOY-122 AC-1)", () => {
    expect(result.contaminationCases).toBe(loadContaminationCases().length);
    expect(result.contaminationCases).toBeGreaterThanOrEqual(6);
    expect(result.contaminationViolations, result.contaminationViolations.join("; ")).toEqual([]);
  });

  it("hits ≥ 80 % of the sparse-product goldens — attributes only the images supply (YOY-122 AC-2)", () => {
    expect(result.perSparse.length).toBe(loadVisionGoldens().length);
    const misses = result.perSparse.filter((score) => !goldenHit(score)).map((score) => score.golden.id);
    expect(result.sparseHitRate, `misses: ${misses.join(", ")}`).toBeGreaterThanOrEqual(0.8);
    // Every sparse golden ran end to end on the AI path: a tier answered it.
    for (const score of result.perSparse) {
      expect(score.route, score.golden.id).toBe("ai");
      expect(score.intentTier, score.golden.id).toMatch(/^(lite|accuracy)$/);
    }
    // Hard constraints hold on this set too.
    expect(result.perSparse.flatMap((score) => score.violations)).toEqual([]);
  });

  it("reports the vision pass as one-time indexing cost on its own line, outside the per-search blend (YOY-122 AC-3)", () => {
    expect(result.visionProducts).toBeGreaterThanOrEqual(6);
    expect(result.visionCostUsd).toBeGreaterThan(0);
    expect(result.oneTimeCostUsd).toBeGreaterThanOrEqual(result.visionCostUsd);
    // The sparse set's searches are not in the blended denominator.
    expect(result.blendedAiSearchCount).toBe(
      result.perQuery.filter((score) => score.route === "ai").length,
    );
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

  it("takes exactly the committed route on every golden of every set (YOY-133 AC-4)", () => {
    // The purpose-phrase heuristic moved co09 classic → ai; every other
    // route must be byte-identical to the baseline, and every golden that
    // runs must have a committed route.
    const baseline = loadBaselineHits();
    const drift: string[] = [];
    for (const score of [...result.perQuery, ...result.perConstructor, ...result.perSparse]) {
      const expected = baseline.routes[score.golden.id];
      expect(expected, `${score.golden.id} has no committed route`).toBeDefined();
      if (score.route !== expected) {
        drift.push(`${score.golden.id}: ${expected} → ${score.route} (${score.routeReason})`);
      }
    }
    expect(drift, `route drift: ${drift.join("; ")}`).toEqual([]);
    const co09 = result.perConstructor.find((score) => score.golden.id === "co09")!;
    expect(co09.route).toBe("ai");
    expect(co09.routeReason).toBe("purpose-phrase");
    expect(co09.costUsd).toBeGreaterThan(0);
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
