import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import { recordingKeyFromRequest } from "./replay.server";
import {
  CONSTRUCTOR_GROUPS,
  CONSTRUCTOR_SET_MINIMUMS,
  CONTAMINATION_TERMS,
  contaminationViolations,
  findViolations,
  loadCatalog,
  loadConstructorGoldens,
  loadContaminationCases,
  loadVisionGoldens,
  runIndexEval,
  sparseGaps,
  VISION_FIXTURES_DIR,
  VISION_IMAGE_MAX_BYTES,
  type ContaminationCase,
  type Golden,
  type IndexEvalResult,
} from "./harness.server";
import { assertEngineSourceExecution } from "./source-guard.server";

// Same source-execution guard as regenerate-live.test.ts (YOY-52 run-6): an
// offline eval scored against dist-resolved engine logic is as misleading as
// a live one, and the check is free.
assertEngineSourceExecution();

// The sparse-catalog index eval (YOY-27, YOY-122): one deterministic offline
// indexing run over recorded fixtures — enrichment, the vision pass, product
// vectors — scored on what the vision pass put in the index. Runs inside
// default `npm test` with zero network calls.

describe("eval fixtures (AC-1)", () => {
  it("ships the sparse catalog at the specified size, in both languages", () => {
    const catalog = loadCatalog();

    expect(catalog).toHaveLength(92);

    // Deliberately sparse: descriptions are one-liners or empty, tags minimal.
    for (const product of catalog) {
      expect(product.description.length).toBeLessThanOrEqual(80);
      expect(product.tags.length).toBeLessThanOrEqual(2);
    }

    // Both languages present.
    const hebrew = /[\u0590-\u05FF]/;
    expect(catalog.some((product) => hebrew.test(product.title))).toBe(true);
    expect(catalog.some((product) => !hebrew.test(product.title))).toBe(true);
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

  it("keys a vision recording by title AND images, and every titled product is unique (YOY-125 AC-14)", () => {
    // Before AC-14 the key was the bare title, so two products with the same
    // title and different photos shared one recorded answer — the second
    // silently scored on the first product's image. The builder hit exactly
    // that collision regenerating the PR #128 fixtures.
    const promptOf = (title: string) => `Title: ${title}\nDescribe ONLY the item being sold.`;
    const image = (bytes: string) => ({
      mimeType: "image/jpeg",
      data: new TextEncoder().encode(bytes),
    });
    const first = { prompt: promptOf("Wrap Dress"), images: [image("photo-a")] };
    const second = { prompt: promptOf("Wrap Dress"), images: [image("photo-b")] };
    expect(recordingKeyFromRequest(first)).not.toBe(recordingKeyFromRequest(second));
    // Both still carry the title, so a fixture file stays readable.
    expect(recordingKeyFromRequest(first)).toContain("Wrap Dress");
    // Order matters: the same two photos swapped are a different request.
    expect(
      recordingKeyFromRequest({
        prompt: promptOf("Wrap Dress"),
        images: [image("photo-a"), image("photo-b")],
      }),
    ).not.toBe(
      recordingKeyFromRequest({
        prompt: promptOf("Wrap Dress"),
        images: [image("photo-b"), image("photo-a")],
      }),
    );
    // A text-only request keys by the title alone, exactly as before.
    expect(recordingKeyFromRequest({ prompt: promptOf("Wrap Dress") })).toBe("Wrap Dress");

    // Belt and braces for the regeneration flow: a duplicate title in the
    // committed catalog fails here, before any live spend.
    const titles = withImages.map((product) => product.title);
    expect(new Set(titles).size, titles.join(", ")).toBe(titles.length);
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

  it("ships ≥ 6 sparse goldens, unique ids apart from the Constructor set, each expecting products with images", () => {
    const goldens = loadVisionGoldens();
    expect(goldens.length).toBeGreaterThanOrEqual(6);
    const otherIds = new Set(loadConstructorGoldens().map((golden) => golden.id));
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

describe("sparse-golden scoring (YOY-122 AC-2)", () => {
  const catalog = loadCatalog();
  const product = catalog[0]!;
  const products = new Map(catalog.map((entry) => [entry.productId, entry]));
  const golden: Golden = {
    id: "sparse-probe",
    language: "en",
    query: "gold heels",
    hardConstraints: {
      category: "shoes",
      priceMin: null,
      priceMax: null,
      colorsInclude: ["gold"],
      colorsExclude: [],
      occasion: null,
      availabilityRequired: false,
    },
    expectedProductIds: [product.productId],
  };
  const enrich = (colors: string[], category: string | null = "shoes") =>
    new Map([[product.productId, { category, colors, occasions: [], primaryColor: colors[0] ?? null }]]);

  it("satisfies a golden when the indexed product states the asked colour in an admitted category", () => {
    expect(sparseGaps(golden, product.productId, products, enrich(["gold"]))).toEqual([]);
  });

  it("counts an unstated colour as a gap, unlike the unknown-passes violation rule", () => {
    expect(findViolations(golden, product.productId, products, enrich([]))).toEqual([]);
    expect(sparseGaps(golden, product.productId, products, enrich([]))).toEqual([
      `${product.productId}: no colour stated`,
    ]);
    expect(sparseGaps(golden, product.productId, products, enrich(["black"]))).toHaveLength(1);
    expect(sparseGaps(golden, product.productId, products, enrich(["gold"], null))).toHaveLength(1);
  });
});

describe("index eval run (YOY-122)", () => {
  let result: IndexEvalResult;

  beforeAll(async () => {
    result = await runIndexEval(await createTestDb());
  }, 120_000);

  it("scores every contamination case on the vision answer with zero violations (AC-1)", () => {
    expect(result.contaminationCases).toBe(loadContaminationCases().length);
    expect(result.contaminationCases).toBeGreaterThanOrEqual(6);
    expect(result.contaminationViolations, result.contaminationViolations.join("; ")).toEqual([]);
  });

  it("indexes ≥ 80 % of the sparse-product goldens with the facts only the images supply (AC-2)", () => {
    expect(result.perSparse.length).toBe(loadVisionGoldens().length);
    const misses = result.perSparse
      .filter((score) => score.satisfied.length === 0)
      .map((score) => `${score.golden.id} (${score.gaps.join("; ")})`);
    expect(result.sparseHitRate, `misses: ${misses.join(", ")}`).toBeGreaterThanOrEqual(0.8);
  });

  it("reports the vision pass as one-time indexing cost on its own line (AC-3)", () => {
    expect(result.visionProducts).toBeGreaterThanOrEqual(6);
    expect(result.visionCostUsd).toBeGreaterThan(0);
    expect(result.oneTimeCostUsd).toBeGreaterThan(result.visionCostUsd);
  });
});
