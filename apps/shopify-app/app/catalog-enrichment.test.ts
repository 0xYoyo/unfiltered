import type { PrismaClient } from "@prisma/client";
import type {
  CostRecorder,
  LlmClient,
  StructuredCompletionRequest,
} from "@unfiltered/engine";
import {
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
  VISION_GARMENT_LENGTHS,
  VISION_MATERIAL_APPEARANCES,
  VISION_NECKLINES,
  VISION_PATTERNS,
  VISION_SLEEVE_LENGTHS,
} from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import type { ProductAttributes, VisionAttributes } from "./catalog/enrich.server";
import {
  buildEnrichmentPrompt,
  buildVisionPrompt,
  ENRICHMENT_SCHEMA,
  ENRICHMENT_VERSION,
  enrichCatalog,
  formatVisionReport,
  mergeAttributes,
  parseEnrichment,
  parseVisionAttributes,
  primaryColorFromTitle,
  resolvePrimaryColor,
  textAttributesFromStored,
  VISION_SCHEMA,
  visionAttributesFromStored,
} from "./catalog/enrich.server";
import { mapProductNode } from "./catalog/mapping.server";
import { productNode } from "./catalog/mapping.test";
import { createTestDb } from "./testing/helpers.server";

// Enrichment tests run against the embedded PGlite DB with recorded fixture
// responses only — no LLM network call anywhere in the default run (AC-5).
// Live enrichment lives in enrichment-live.test.ts behind LIVE_LLM_TESTS=1.

const SHOP = "test-shop.myshopify.com";

/** Recorded fixture completion, as the schema-constrained model answers. */
const recordedAttributes = (
  overrides: Partial<ProductAttributes> = {},
): ProductAttributes => ({
  category: "dress",
  colors: ["black"],
  primaryColor: "black",
  occasions: ["evening"],
  fit: "regular",
  styleTags: ["elegant"],
  seasons: ["summer"],
  ...overrides,
});

/** A title with no colourway designator, for parse tests. */
const PLAIN = { title: "Evening dress" };

/**
 * Fixture-backed LlmClient stub: answers each call from `respond`, records
 * every request, and — like the real adapter contract — meters each call
 * through the given CostRecorder before the response is interpreted.
 */
function llmStub(
  respond: (request: StructuredCompletionRequest, call: number) => unknown,
  costRecorder?: CostRecorder,
) {
  const calls: StructuredCompletionRequest[] = [];
  const llm: LlmClient = {
    async completeStructured(request) {
      calls.push(request);
      await costRecorder?.record({
        provider: "google",
        modelId: "gemini-3.5-flash-lite",
        operation: request.operation,
        inputTokens: 100,
        outputTokens: 50,
        storeId: request.storeId,
      });
      const response = respond(request, calls.length);
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };
  return { llm, calls };
}

// Fixture catalog per the issue's test expectations: a plain product, a
// Hebrew-language product, and an empty-description product.
const fixtureNodes = () => [
  productNode({ id: "gid://shopify/Product/1" }),
  productNode({
    id: "gid://shopify/Product/2",
    title: "שמלת ערב שחורה",
    description: null,
    tags: ["שמלה", "ערב"],
  }),
  productNode({
    id: "gid://shopify/Product/3",
    title: "Plain tee",
    description: "",
    productType: "T-Shirt",
  }),
];

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.productEnrichment.deleteMany();
  await db.productImage.deleteMany();
  await db.catalogProduct.deleteMany();
  for (const node of fixtureNodes()) {
    await db.catalogProduct.create({
      data: { shopDomain: SHOP, ...mapProductNode(node) },
    });
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe("parseEnrichment", () => {
  it("accepts a schema-valid record and rejects shape violations", () => {
    expect(parseEnrichment(recordedAttributes(), PLAIN)).toEqual(recordedAttributes());
    expect(parseEnrichment(null, PLAIN)).toBeNull();
    expect(parseEnrichment("dress", PLAIN)).toBeNull();
    expect(parseEnrichment({ ...recordedAttributes(), category: 7 }, PLAIN)).toBeNull();
    expect(parseEnrichment({ ...recordedAttributes(), colors: "black" }, PLAIN)).toBeNull();
    expect(parseEnrichment({ ...recordedAttributes(), seasons: [1] }, PLAIN)).toBeNull();
    const missingFit: Partial<ProductAttributes> = recordedAttributes();
    delete missingFit.fit;
    expect(parseEnrichment(missingFit, PLAIN)).toBeNull();
    // primaryColor is part of the schema (YOY-110): a missing or non-string
    // answer is a shape violation like any other.
    const missingPrimary: Partial<ProductAttributes> = recordedAttributes();
    delete missingPrimary.primaryColor;
    expect(parseEnrichment(missingPrimary, PLAIN)).toBeNull();
    expect(parseEnrichment({ ...recordedAttributes(), primaryColor: null }, PLAIN)).toBeNull();
  });

  it("normalizes category and occasions into the canonical taxonomy (YOY-31 AC-4)", () => {
    // Plural and synonym answers — the live-regeneration failure mode —
    // converge onto canonical tokens instead of landing as free text.
    expect(
      parseEnrichment(recordedAttributes({ category: "Dresses" }), PLAIN)?.category,
    ).toBe("dress");
    expect(
      parseEnrichment(recordedAttributes({ category: "outerwear" }), PLAIN)?.category,
    ).toBe("coat");
    expect(
      parseEnrichment(recordedAttributes({ category: "accessory" }), PLAIN)?.category,
    ).toBe("accessories");
    expect(
      parseEnrichment(
        recordedAttributes({ occasions: ["party", "gala", "office"] }),
        PLAIN,
      )?.occasions,
    ).toEqual(["evening", "work"]);
    // Unmappable values become "other" — the enrichment site's contract.
    expect(
      parseEnrichment(recordedAttributes({ category: "widget" }), PLAIN)?.category,
    ).toBe("other");
    expect(
      parseEnrichment(recordedAttributes({ occasions: ["brunch" ] }), PLAIN)?.occasions,
    ).toEqual(["other"]);
  });
});

describe("primary colour rule (YOY-110 AC-1)", () => {
  const colours = ["pink", "black", "navy"];

  it("reads the title's colourway designator in all four shapes", () => {
    expect(primaryColorFromTitle("Mesh Over Dress in Pink", colours)).toBe("pink");
    expect(primaryColorFromTitle("Mesh Over Dress - Navy", colours)).toBe("navy");
    expect(primaryColorFromTitle("Mesh Over Dress – Navy", colours)).toBe("navy");
    expect(primaryColorFromTitle("Mesh Over Dress / Black", colours)).toBe("black");
    expect(primaryColorFromTitle("Mesh Over Dress (Black)", colours)).toBe("black");
    // Case-insensitive; a modifier does not hide the colour.
    expect(primaryColorFromTitle("Mesh Over Dress in DUSTY PINK", colours)).toBe("pink");
  });

  it("resolves a multi-colour designator in reading order, not colors order (YOY-125 AC-8)", () => {
    // Which colour wins must not depend on how the model happened to order
    // its `colors` array: the designator names pink first, so it is a pink
    // dress under either ordering.
    expect(primaryColorFromTitle("Dress in Pink and Black", ["black", "pink"])).toBe("pink");
    expect(primaryColorFromTitle("Dress in Pink and Black", ["pink", "black"])).toBe("pink");
    expect(primaryColorFromTitle("Dress in Black and Pink", ["pink", "black"])).toBe("black");
    // A slash-joined designator is captured at all now, and reads the same
    // way: before AC-8 the `/` was excluded from every capture, so this
    // title matched no shape and fell through to the model's answer.
    expect(primaryColorFromTitle("Tee - Black/White", ["white", "black"])).toBe("black");
    expect(primaryColorFromTitle("Tee - White/Black", ["black", "white"])).toBe("white");
    expect(primaryColorFromTitle("Tee (Black/White)", ["white", "black"])).toBe("black");
    // A modifier in front of the first colour still does not hide it.
    expect(primaryColorFromTitle("Dress in Dusty Pink and Black", ["black", "pink"])).toBe(
      "pink",
    );
  });

  it("ignores a designator that names no stated colour", () => {
    // "in Linen" is a fabric; "Cabin Socks" contains "in" inside a word.
    expect(primaryColorFromTitle("Shirt Dress in Linen", ["white"])).toBeNull();
    expect(primaryColorFromTitle("Cabin Socks", ["red"])).toBeNull();
    expect(primaryColorFromTitle("Plain Tee", [])).toBeNull();
  });

  it("falls back in order: designator, then the model's stated answer, then the first stated colour, then null", () => {
    // (a) the designator wins over the model's answer.
    expect(resolvePrimaryColor("Mesh Over Dress in Pink", colours, "black")).toBe("pink");
    // (b) no designator: the model's answer stands when it is a stated colour.
    expect(resolvePrimaryColor("Mesh Over Dress", colours, "Navy")).toBe("navy");
    // An answer the text never states is never accepted — first stated colour.
    expect(resolvePrimaryColor("Mesh Over Dress", colours, "red")).toBe("pink");
    expect(resolvePrimaryColor("Mesh Over Dress", colours, "")).toBe("pink");
    // No colours at all: null.
    expect(resolvePrimaryColor("Plain Tee", [], "")).toBeNull();
    expect(resolvePrimaryColor("Plain Tee", [], "black")).toBeNull();
  });

  it("parseEnrichment re-validates the model's primaryColor against the title", () => {
    const answered = recordedAttributes({ colors: ["Pink", "Black"], primaryColor: "black" });
    expect(
      parseEnrichment(answered, { title: "Mesh Over Dress in Pink" })?.primaryColor,
    ).toBe("pink");
    // "" (no colour stated) maps to null; `colors` is stored unchanged.
    const colourless = parseEnrichment(
      recordedAttributes({ colors: [], primaryColor: "" }),
      PLAIN,
    );
    expect(colourless?.primaryColor).toBeNull();
    expect(colourless?.colors).toEqual([]);
    expect(
      parseEnrichment(answered, { title: "Mesh Over Dress" })?.colors,
    ).toEqual(["Pink", "Black"]);
  });

  it("the prompt states the rule and the schema requires the field", () => {
    const prompt = buildEnrichmentPrompt({
      productId: "p",
      title: "Mesh Over Dress in Pink",
      description: "",
      tags: [],
      productType: "Dresses",
      imageAltTexts: [],
      contentHash: "h",
    });
    expect(prompt).toContain("primaryColor");
    expect(prompt).toContain("colorway designator");
    expect(prompt).toContain("reading order");
    expect(ENRICHMENT_SCHEMA.required).toContain("primaryColor");
  });

  it("persists primaryColor on the enrichment row", async () => {
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        ...mapProductNode(
          productNode({
            id: "gid://shopify/Product/4",
            title: "Mesh Over Dress in Pink",
            description: "Also in black and navy.",
          }),
        ),
      },
    });
    const { llm } = llmStub((request) =>
      request.prompt.includes("Mesh Over Dress in Pink")
        ? recordedAttributes({ colors: ["pink", "black", "navy"], primaryColor: "pink" })
        : recordedAttributes(),
    );
    await enrichCatalog({ db, shopDomain: SHOP, llm });
    const row = await db.productEnrichment.findUniqueOrThrow({
      where: {
        shopDomain_productId: { shopDomain: SHOP, productId: "gid://shopify/Product/4" },
      },
    });
    expect(row.primaryColor).toBe("pink");
    expect(row.colors).toEqual(["pink", "black", "navy"]);
    expect(row.enrichmentVersion).toBe(ENRICHMENT_VERSION);
  });
});

describe("ENRICHMENT_SCHEMA pins the canonical enums (YOY-31 AC-2, AC-7)", () => {
  const property = (name: string) =>
    (ENRICHMENT_SCHEMA.properties as Record<string, Record<string, unknown>>)[
      name
    ]!;

  it("rejects out-of-set category and occasion values", () => {
    const categoryEnum = property("category").enum as string[];
    const occasionEnum = (
      property("occasions").items as Record<string, unknown>
    ).enum as string[];
    // Any conforming validator — Gemini's responseSchema included — must
    // reject values outside these token lists, so a free-text answer takes
    // the retry/failed path instead of landing in the store.
    expect(categoryEnum).toEqual([...CANONICAL_CATEGORIES]);
    expect(occasionEnum).toEqual([...CANONICAL_OCCASIONS]);
    for (const outOfSet of ["dresses", "gown", "שמלה", ""]) {
      expect(categoryEnum).not.toContain(outOfSet);
    }
    for (const outOfSet of ["party", "gala", "office", ""]) {
      expect(occasionEnum).not.toContain(outOfSet);
    }
  });
});

describe("colors are extracted, never invented (YOY-35 AC-4)", () => {
  it("prompts that colors absent from the product text must not be invented", () => {
    const prompt = buildEnrichmentPrompt({
      productId: "p",
      title: "Plain tee",
      description: "",
      tags: [],
      productType: "T-Shirt",
      imageAltTexts: [],
      contentHash: "h",
    });
    expect(prompt).toContain("Never invent");
    expect(prompt).toContain("colors must be []");
  });

  it("persists an empty colors array for a color-free product", async () => {
    // Recorded fixture shape for color-free text: the schema-constrained
    // model answers colors [] — and [] is stored, not padded.
    const { llm } = llmStub((request) =>
      request.prompt.includes("Plain tee")
        ? recordedAttributes({ colors: [] })
        : recordedAttributes(),
    );

    const result = await enrichCatalog({ db, shopDomain: SHOP, llm });

    expect(result).toEqual({ enriched: 3, cached: 0, failed: 0 });
    const row = await db.productEnrichment.findUniqueOrThrow({
      where: {
        shopDomain_productId: {
          shopDomain: SHOP,
          productId: "gid://shopify/Product/3",
        },
      },
    });
    expect(row.status).toBe("enriched");
    expect(row.colors).toEqual([]);
  });
});

describe("catalog enrichment", () => {
  it("enriches every product — Hebrew and empty-description included — and persists the records", async () => {
    const { llm, calls } = llmStub(() => recordedAttributes());

    const result = await enrichCatalog({ db, shopDomain: SHOP, llm });

    expect(result).toEqual({ enriched: 3, cached: 0, failed: 0 });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.schema).toBe(ENRICHMENT_SCHEMA);
      expect(call.operation).toBe("enrichment");
      expect(call.storeId).toBe(SHOP);
    }
    // Prompts carry the issue-specified source fields, in whatever language.
    expect(calls[1]?.prompt).toContain("שמלת ערב שחורה");
    expect(calls[2]?.prompt).toContain("Product type: T-Shirt");

    const rows = await db.productEnrichment.findMany({
      orderBy: { productId: "asc" },
    });
    expect(rows).toHaveLength(3);
    const snapshots = await db.catalogProduct.findMany({
      orderBy: { productId: "asc" },
    });
    rows.forEach((row, index) => {
      expect(row.status).toBe("enriched");
      expect(row.contentHash).toBe(snapshots[index]!.contentHash);
      expect(row.category).toBe("dress");
      expect(row.seasons).toEqual(["summer"]);
    });
  });

  it("retries invalid output once, then marks the product failed without blocking the batch", async () => {
    const { llm, calls } = llmStub((request) =>
      request.prompt.includes("Plain tee")
        ? { category: 42 }
        : recordedAttributes(),
    );

    const result = await enrichCatalog({ db, shopDomain: SHOP, llm });

    expect(result).toEqual({ enriched: 2, cached: 0, failed: 1 });
    // Two products enrich in one call each; the invalid one is retried once.
    expect(calls).toHaveLength(4);

    const failed = await db.productEnrichment.findUniqueOrThrow({
      where: {
        shopDomain_productId: {
          shopDomain: SHOP,
          productId: "gid://shopify/Product/3",
        },
      },
    });
    expect(failed.status).toBe("failed");
    expect(failed.category).toBeNull();
    expect(failed.styleTags).toEqual([]);
  });

  it("recovers when the retry answers with valid output", async () => {
    const { llm, calls } = llmStub((_request, call) =>
      call === 1 ? new Error("gemini answered garbage") : recordedAttributes(),
    );

    const result = await enrichCatalog({ db, shopDomain: SHOP, llm });

    expect(result).toEqual({ enriched: 3, cached: 0, failed: 0 });
    expect(calls).toHaveLength(4);
  });

  it("caches by content hash: an unchanged catalog re-runs with zero LLM calls", async () => {
    await enrichCatalog({ db, shopDomain: SHOP, llm: llmStub(() => recordedAttributes()).llm });

    const { llm, calls } = llmStub(() => recordedAttributes());
    const rerun = await enrichCatalog({ db, shopDomain: SHOP, llm });

    expect(rerun).toEqual({ enriched: 0, cached: 3, failed: 0 });
    expect(calls).toHaveLength(0);
    // Every row carries the version it was written at (YOY-110 AC-2).
    const rows = await db.productEnrichment.findMany();
    expect(rows.map((row) => row.enrichmentVersion)).toEqual(
      rows.map(() => ENRICHMENT_VERSION),
    );
  });

  it("re-enriches a row written at an older version even when its content is unchanged (YOY-110 AC-2)", async () => {
    await enrichCatalog({ db, shopDomain: SHOP, llm: llmStub(() => recordedAttributes()).llm });
    // Simulate rows from before a rule change: same content hash, older
    // version — including 0, the backfill value for pre-versioning rows.
    await db.productEnrichment.update({
      where: {
        shopDomain_productId: { shopDomain: SHOP, productId: "gid://shopify/Product/1" },
      },
      data: { enrichmentVersion: ENRICHMENT_VERSION - 1, primaryColor: null },
    });
    await db.productEnrichment.update({
      where: {
        shopDomain_productId: { shopDomain: SHOP, productId: "gid://shopify/Product/3" },
      },
      data: { enrichmentVersion: 0 },
    });

    const { llm, calls } = llmStub(() => recordedAttributes());
    const rerun = await enrichCatalog({ db, shopDomain: SHOP, llm });

    // Exactly the stale rows re-enrich; the current-version row is cached.
    expect(rerun).toEqual({ enriched: 2, cached: 1, failed: 0 });
    expect(calls).toHaveLength(2);
    const rows = await db.productEnrichment.findMany({ orderBy: { productId: "asc" } });
    for (const row of rows) {
      expect(row.enrichmentVersion).toBe(ENRICHMENT_VERSION);
      expect(row.primaryColor).toBe("black");
    }
    // And the catalog is fully cached again at the current version.
    const again = llmStub(() => recordedAttributes());
    expect(await enrichCatalog({ db, shopDomain: SHOP, llm: again.llm })).toEqual({
      enriched: 0,
      cached: 3,
      failed: 0,
    });
    expect(again.calls).toHaveLength(0);
  });

  it("keeps a failed product cached until its content changes", async () => {
    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => ({ not: "an attribute record" })).llm,
    });

    // Unchanged content: the failed rows are not retried (AC-3's zero calls).
    const unchanged = llmStub(() => recordedAttributes());
    expect(await enrichCatalog({ db, shopDomain: SHOP, llm: unchanged.llm })).toEqual({
      enriched: 0,
      cached: 3,
      failed: 0,
    });
    expect(unchanged.calls).toHaveLength(0);

    // A content change re-enriches exactly that product.
    const retitled = mapProductNode(
      productNode({ id: "gid://shopify/Product/1", title: "Renamed dress" }),
    );
    await db.catalogProduct.update({
      where: {
        shopDomain_productId: {
          shopDomain: SHOP,
          productId: "gid://shopify/Product/1",
        },
      },
      data: retitled,
    });
    const changed = llmStub(() => recordedAttributes());
    expect(await enrichCatalog({ db, shopDomain: SHOP, llm: changed.llm })).toEqual({
      enriched: 1,
      cached: 2,
      failed: 0,
    });
    expect(changed.calls).toHaveLength(1);
    const row = await db.productEnrichment.findUniqueOrThrow({
      where: {
        shopDomain_productId: {
          shopDomain: SHOP,
          productId: "gid://shopify/Product/1",
        },
      },
    });
    expect(row.status).toBe("enriched");
    expect(row.contentHash).toBe(retitled.contentHash);
  });

  it("lands one enrichment ledger row per LLM call through a metered client", async () => {
    await db.aiCall.deleteMany();
    const { llm } = llmStub(
      (request) =>
        request.prompt.includes("Plain tee")
          ? { category: 42 }
          : recordedAttributes(),
      createPrismaCostRecorder(db),
    );

    await enrichCatalog({ db, shopDomain: SHOP, llm });

    const rows = await db.aiCall.findMany({ where: { operation: "enrichment" } });
    // 2 clean enrichments + 2 attempts for the failing product: every call is
    // metered, including the ones whose output was rejected (AC-4).
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.shopDomain).toBe(SHOP);
      expect(row.costUsd).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Vision enrichment (YOY-121): the anchored vision pass, its merge with the
// text answer, and the image-hash key it re-analyses on. Recorded fixture
// responses only — no model call anywhere in the default run.
// ---------------------------------------------------------------------------

/** Recorded vision answer, as the schema-constrained model returns it. */
const recordedVision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: "dress",
  colors: ["navy", "white"],
  primaryColor: "navy",
  occasions: ["evening"],
  fit: "slim",
  styleTags: ["elegant", "feminine"],
  sleeveLength: "long",
  neckline: "v-neck",
  garmentLength: "midi",
  pattern: "floral",
  materialAppearance: "silk",
  ...overrides,
});

/** The parsed form of `recordedVision()`. */
const parsedVision = (overrides: Partial<VisionAttributes> = {}): VisionAttributes => ({
  category: "dress",
  colors: ["navy", "white"],
  primaryColor: "navy",
  occasions: ["evening"],
  fit: "slim",
  styleTags: ["elegant", "feminine"],
  sleeveLength: "long",
  neckline: "v-neck",
  garmentLength: "midi",
  pattern: "floral",
  materialAppearance: "silk",
  ...overrides,
});

/** Byte fixture per image URL: the bytes ARE the URL, served with a content type. */
function imageServer(types: Record<string, string> = {}) {
  const fetched: string[] = [];
  const fetchImage = async (url: string): Promise<Response> => {
    fetched.push(url);
    if (url.includes("/missing/")) {
      return new Response("nope", { status: 404 });
    }
    return new Response(new TextEncoder().encode(url), {
      status: 200,
      headers: { "content-type": types[url] ?? "image/jpeg" },
    });
  };
  return { fetchImage, fetched };
}

async function seedImages(productId: string, urls: string[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const [position, url] of urls.entries()) {
    const contentHash = `hash-${url.replace(/[^a-z0-9]/gi, "")}`;
    hashes.push(contentHash);
    await db.productImage.upsert({
      where: { shopDomain_productId_position: { shopDomain: SHOP, productId, position } },
      create: { shopDomain: SHOP, productId, position, url, contentHash, fetchedAt: new Date() },
      update: { url, contentHash, duplicateUrls: [] },
    });
  }
  await db.productImage.deleteMany({
    where: { shopDomain: SHOP, productId, position: { gte: urls.length } },
  });
  return hashes;
}

const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";
const P3 = "gid://shopify/Product/3";

const enrichmentRow = (productId: string) =>
  db.productEnrichment.findUniqueOrThrow({
    where: { shopDomain_productId: { shopDomain: SHOP, productId } },
  });

describe("vision prompt and schema (YOY-121 AC-2)", () => {
  it("anchors the prompt on the sold item and carries title, type, and text", () => {
    const prompt = buildVisionPrompt({
      productId: "p",
      title: "Mesh Over Dress in Pink",
      description: "Gold straps.",
      tags: ["party"],
      productType: "Dresses",
      imageAltTexts: [],
      contentHash: "h",
    });
    expect(prompt).toContain("Describe ONLY the item being sold");
    expect(prompt).toContain("ignore other garments, footwear, and\njewelry worn by models");
    expect(prompt).toContain("trust the\nimages");
    expect(prompt).toContain("Title: Mesh Over Dress in Pink");
    expect(prompt).toContain("Product type: Dresses");
    expect(prompt).toContain("Text: Gold straps.");
    expect(prompt).toContain("Tags: party");
    // Sparse text is stated as such, never as an empty line the model
    // might read as a value.
    expect(
      buildVisionPrompt({
        productId: "p",
        title: "Tee",
        description: "",
        tags: [],
        productType: "",
        imageAltTexts: [],
        contentHash: "h",
      }),
    ).toContain("Product type: (none)\nText: (none)\nTags: (none)");
  });

  it("pins every enum to the committed vocabularies and requires every field", () => {
    const property = (name: string) =>
      (VISION_SCHEMA.properties as Record<string, Record<string, unknown>>)[name]!;
    expect(property("category").enum).toEqual([...CANONICAL_CATEGORIES]);
    expect((property("occasions").items as Record<string, unknown>).enum).toEqual([
      ...CANONICAL_OCCASIONS,
    ]);
    expect(property("sleeveLength").enum).toEqual([...VISION_SLEEVE_LENGTHS]);
    expect(property("neckline").enum).toEqual([...VISION_NECKLINES]);
    expect(property("garmentLength").enum).toEqual([...VISION_GARMENT_LENGTHS]);
    expect(property("pattern").enum).toEqual([...VISION_PATTERNS]);
    expect(property("materialAppearance").enum).toEqual([...VISION_MATERIAL_APPEARANCES]);
    expect(VISION_SCHEMA.required).toEqual([
      "category",
      "colors",
      "primaryColor",
      "occasions",
      "fit",
      "styleTags",
      "sleeveLength",
      "neckline",
      "garmentLength",
      "pattern",
      "materialAppearance",
    ]);
    // Seasons are a text claim, never a visual one.
    expect(VISION_SCHEMA.properties).not.toHaveProperty("seasons");
  });

  it("parseVisionAttributes normalizes into the vocabularies and rejects shape violations", () => {
    expect(parseVisionAttributes(recordedVision())).toEqual(parsedVision());
    // Category/occasion synonyms fold like the text answer; vision-only
    // fields fold into their vocabularies; not-applicable becomes null.
    expect(
      parseVisionAttributes(
        recordedVision({
          category: "Gowns",
          occasions: ["party", "gala"],
          sleeveLength: "NOT-APPLICABLE",
          neckline: "not-applicable",
          garmentLength: "Midi",
          pattern: "paisley",
          materialAppearance: " Leather ",
        }),
      ),
    ).toEqual(
      parsedVision({
        category: "dress",
        occasions: ["evening"],
        sleeveLength: null,
        neckline: null,
        garmentLength: "midi",
        pattern: null,
        materialAppearance: "leather",
      }),
    );
    // primaryColor: the answer when it is an answered colour, else the
    // first colour, else null; colours lowercased and de-duplicated.
    expect(
      parseVisionAttributes(recordedVision({ colors: ["Navy", "navy", "White"], primaryColor: "white" })),
    ).toMatchObject({ colors: ["navy", "white"], primaryColor: "white" });
    expect(
      parseVisionAttributes(recordedVision({ colors: ["red"], primaryColor: "" })),
    ).toMatchObject({ colors: ["red"], primaryColor: "red" });
    expect(parseVisionAttributes(recordedVision({ colors: [], primaryColor: "" }))).toMatchObject({
      colors: [],
      primaryColor: null,
    });
    expect(parseVisionAttributes(null)).toBeNull();
    expect(parseVisionAttributes(recordedVision({ sleeveLength: 3 }))).toBeNull();
    expect(parseVisionAttributes(recordedVision({ colors: "navy" }))).toBeNull();
    const missing = recordedVision();
    delete missing.materialAppearance;
    expect(parseVisionAttributes(missing)).toBeNull();
  });
});

describe("merge rules (YOY-121 AC-3)", () => {
  it("text wins on the factual fields when present; vision fills nulls and empties", () => {
    const text = recordedAttributes({
      category: "top",
      colors: ["black"],
      primaryColor: "black",
      occasions: ["work"],
      fit: "regular",
      styleTags: ["elegant", "smart"],
      seasons: ["winter"],
    });
    expect(mergeAttributes(text, parsedVision())).toEqual({
      category: "top",
      colors: ["black"],
      primaryColor: "black",
      occasions: ["work"],
      fit: "regular",
      // The union, text first, de-duplicated.
      styleTags: ["elegant", "smart", "feminine"],
      seasons: ["winter"],
      sleeveLength: "long",
      neckline: "v-neck",
      garmentLength: "midi",
      pattern: "floral",
      materialAppearance: "silk",
    });
  });

  it("fills category, colours, primary colour, occasions, and fit from vision when the text gave none", () => {
    const sparse = recordedAttributes({
      category: "other",
      colors: [],
      primaryColor: null,
      occasions: [],
      fit: "",
      styleTags: [],
      seasons: [],
    });
    expect(mergeAttributes(sparse, parsedVision())).toMatchObject({
      category: "dress",
      colors: ["navy", "white"],
      primaryColor: "navy",
      occasions: ["evening"],
      fit: "slim",
      styleTags: ["elegant", "feminine"],
      seasons: [],
    });
    // primaryColor follows colors: text colours present ⇒ text primary,
    // even when vision disagrees.
    expect(
      mergeAttributes(
        recordedAttributes({ colors: ["gold"], primaryColor: "gold" }),
        parsedVision({ colors: ["brown"], primaryColor: "brown" }),
      ),
    ).toMatchObject({ colors: ["gold"], primaryColor: "gold" });
    // A vision category of "other" cannot replace a real text category,
    // and two "other"s stay "other".
    expect(
      mergeAttributes(recordedAttributes({ category: "top" }), parsedVision({ category: "other" }))
        ?.category,
    ).toBe("top");
    expect(
      mergeAttributes(recordedAttributes({ category: "other" }), parsedVision({ category: "other" }))
        ?.category,
    ).toBe("other");
  });

  it("is text-only without vision, vision-only without text, and null with neither", () => {
    expect(mergeAttributes(recordedAttributes(), null)).toEqual({
      ...recordedAttributes(),
      sleeveLength: null,
      neckline: null,
      garmentLength: null,
      pattern: null,
      materialAppearance: null,
    });
    expect(mergeAttributes(null, parsedVision())).toEqual({
      ...parsedVision(),
      seasons: [],
    });
    expect(mergeAttributes(null, null)).toBeNull();
  });
});

describe("vision pass in enrichCatalog (YOY-121 AC-2, AC-5, AC-6)", () => {
  it("analyses every product with images once, keyed on the image hashes, and merges the answer", async () => {
    const hashes1 = await seedImages(P1, ["https://cdn.example/p1-a.png", "https://cdn.example/p1-b.jpg"]);
    const hashes2 = await seedImages(P2, ["https://cdn.example/p2-a.webp"]);
    const server = imageServer({
      "https://cdn.example/p1-a.png": "image/png",
      "https://cdn.example/p2-a.webp": "image/webp; charset=binary",
    });
    // The recorded answer form: "" for no colour (parseEnrichment maps it to null).
    const text = llmStub(() => recordedAttributes({ colors: [], primaryColor: "", styleTags: ["smart"] }));
    const vision = llmStub(() => recordedVision());

    const result = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: text.llm,
      vision: { llm: vision.llm, fetchImage: server.fetchImage },
    });

    expect(result).toEqual({
      enriched: 3,
      cached: 0,
      failed: 0,
      vision: { analysed: 2, cached: 0, failed: 0, costUsd: 0 },
    });
    expect(formatVisionReport(result.vision!)).toBe(
      "vision: analysed 2, cached 0, failed 0, cost $0.000000",
    );
    // One call per product with images, all of its images inline, the
    // anchored prompt, operation "vision", temperature 0.
    expect(vision.calls).toHaveLength(2);
    const [call1, call2] = vision.calls;
    expect(call1!.operation).toBe("vision");
    expect(call1!.schema).toBe(VISION_SCHEMA);
    expect(call1!.temperature).toBe(0);
    expect(call1!.storeId).toBe(SHOP);
    expect(call1!.prompt).toContain("Describe ONLY the item being sold");
    expect(call1!.images!.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(new TextDecoder().decode(call1!.images![0]!.data)).toBe("https://cdn.example/p1-a.png");
    expect(call2!.images!.map((image) => image.mimeType)).toEqual(["image/webp"]);
    expect(call2!.prompt).toContain("שמלת ערב שחורה");
    // Text enrichment ran once per product, as before.
    expect(text.calls).toHaveLength(3);

    const row1 = await enrichmentRow(P1);
    expect(row1).toMatchObject({
      status: "enriched",
      enrichmentVersion: ENRICHMENT_VERSION,
      // Text wins where present (category, occasions, fit); vision fills
      // the colours the text lacked and brings the coverage fields.
      category: "dress",
      colors: ["navy", "white"],
      primaryColor: "navy",
      occasions: ["evening"],
      fit: "regular",
      styleTags: ["smart", "elegant", "feminine"],
      seasons: ["summer"],
      sleeveLength: "long",
      neckline: "v-neck",
      garmentLength: "midi",
      pattern: "floral",
      materialAppearance: "silk",
      visionStatus: "enriched",
      visionImageHashes: hashes1,
    });
    expect(row1.textAttributes).toEqual(
      recordedAttributes({ colors: [], primaryColor: null, styleTags: ["smart"] }),
    );
    expect(row1.visionAttributes).toEqual(parsedVision());
    expect((await enrichmentRow(P2)).visionImageHashes).toEqual(hashes2);
    // No images: no vision, the row is text-only.
    expect(await enrichmentRow(P3)).toMatchObject({
      status: "enriched",
      visionStatus: "none",
      visionImageHashes: [],
      visionAttributes: null,
      sleeveLength: null,
      materialAppearance: null,
    });
  });

  it("unchanged images make zero vision calls; one changed image makes exactly one (AC-5)", async () => {
    await seedImages(P1, ["https://cdn.example/p1-a.png", "https://cdn.example/p1-b.jpg"]);
    await seedImages(P2, ["https://cdn.example/p2-a.webp"]);
    const server = imageServer();
    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes()).llm,
      vision: { llm: llmStub(() => recordedVision()).llm, fetchImage: server.fetchImage },
    });
    expect(server.fetched).toHaveLength(3);

    // Re-run: everything cached, nothing fetched, nothing called.
    const rerunText = llmStub(() => recordedAttributes());
    const rerunVision = llmStub(() => recordedVision());
    const rerunServer = imageServer();
    expect(
      await enrichCatalog({
        db,
        shopDomain: SHOP,
        llm: rerunText.llm,
        vision: { llm: rerunVision.llm, fetchImage: rerunServer.fetchImage },
      }),
    ).toEqual({
      enriched: 0,
      cached: 3,
      failed: 0,
      vision: { analysed: 0, cached: 2, failed: 0, costUsd: 0 },
    });
    expect(rerunText.calls).toHaveLength(0);
    expect(rerunVision.calls).toHaveLength(0);
    expect(rerunServer.fetched).toHaveLength(0);

    // One image of product 1 changes (new bytes, hence a new hash).
    const changed = await seedImages(P1, ["https://cdn.example/p1-a.png", "https://cdn.example/p1-c.jpg"]);
    const thirdText = llmStub(() => recordedAttributes());
    const thirdVision = llmStub(() => recordedVision({ pattern: "stripe" }));
    const thirdServer = imageServer();
    expect(
      await enrichCatalog({
        db,
        shopDomain: SHOP,
        llm: thirdText.llm,
        vision: { llm: thirdVision.llm, fetchImage: thirdServer.fetchImage },
      }),
    ).toEqual({
      enriched: 0,
      cached: 3,
      failed: 0,
      vision: { analysed: 1, cached: 1, failed: 0, costUsd: 0 },
    });
    // Exactly one vision call, for that product, with both of its current
    // images; no text call — the content did not change.
    expect(thirdVision.calls).toHaveLength(1);
    expect(thirdVision.calls[0]!.prompt).toContain("Title: Linen summer dress");
    expect(thirdVision.calls[0]!.images).toHaveLength(2);
    expect(thirdText.calls).toHaveLength(0);
    expect(thirdServer.fetched).toEqual(["https://cdn.example/p1-a.png", "https://cdn.example/p1-c.jpg"]);
    expect(await enrichmentRow(P1)).toMatchObject({
      pattern: "stripe",
      visionImageHashes: changed,
      visionStatus: "enriched",
    });
    // The other product's vision answer is untouched.
    expect((await enrichmentRow(P2)).pattern).toBe("floral");
  });

  it('a text-sparse "Gold straps." product takes category and material from the images (How to verify 3)', async () => {
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        ...mapProductNode(
          productNode({ id: "gid://shopify/Product/4", title: "Strappy", description: "Gold straps." }),
        ),
      },
    });
    await seedImages("gid://shopify/Product/4", ["https://cdn.example/straps.jpg"]);
    const text = llmStub((request) =>
      request.prompt.includes("Gold straps.")
        ? recordedAttributes({
            category: "other",
            colors: ["gold"],
            primaryColor: "gold",
            occasions: [],
            fit: "",
            styleTags: [],
            seasons: [],
          })
        : recordedAttributes(),
    );
    const vision = llmStub(() =>
      recordedVision({
        category: "shoes",
        colors: ["gold"],
        primaryColor: "gold",
        occasions: ["evening"],
        fit: "",
        styleTags: ["strappy"],
        sleeveLength: "not-applicable",
        neckline: "not-applicable",
        garmentLength: "not-applicable",
        pattern: "solid",
        materialAppearance: "leather",
      }),
    );

    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: text.llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });

    expect(await enrichmentRow("gid://shopify/Product/4")).toMatchObject({
      category: "shoes",
      colors: ["gold"],
      primaryColor: "gold",
      occasions: ["evening"],
      styleTags: ["strappy"],
      sleeveLength: null,
      neckline: null,
      garmentLength: null,
      pattern: "solid",
      materialAppearance: "leather",
    });
  });

  it("two failed attempts mark visionStatus failed with the hashes recorded, without failing the run", async () => {
    const hashes = await seedImages(P1, ["https://cdn.example/p1-a.png"]);
    await seedImages(P2, ["https://cdn.example/p2-a.webp"]);
    const vision = llmStub((request, call) =>
      request.prompt.includes("Linen summer dress")
        ? call % 2 === 1
          ? new Error("upstream 503")
          : { category: "dress" }
        : recordedVision(),
    );

    const result = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes()).llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });

    expect(result).toEqual({
      enriched: 3,
      cached: 0,
      failed: 0,
      vision: { analysed: 2, cached: 0, failed: 1, costUsd: 0 },
    });
    // Product 1: two attempts (an error, then invalid output); product 2: one.
    expect(vision.calls).toHaveLength(3);
    const row = await enrichmentRow(P1);
    // The text answer stands on its own — the row is enriched, vision-less.
    expect(row).toMatchObject({
      status: "enriched",
      category: "dress",
      visionStatus: "failed",
      visionImageHashes: hashes,
      visionAttributes: null,
      sleeveLength: null,
    });
    // A model failure retries only when an image changes: the re-run makes
    // zero vision calls.
    const rerun = llmStub(() => recordedVision());
    expect(
      (
        await enrichCatalog({
          db,
          shopDomain: SHOP,
          llm: llmStub(() => recordedAttributes()).llm,
          vision: { llm: rerun.llm, fetchImage: imageServer().fetchImage },
        })
      ).vision,
    ).toEqual({ analysed: 0, cached: 2, failed: 0, costUsd: 0 });
    expect(rerun.calls).toHaveLength(0);
  });

  it("images that cannot be fetched make no call and leave the key untouched, so the next run retries", async () => {
    await seedImages(P1, ["https://cdn.example/missing/p1-a.png"]);
    const vision = llmStub(() => recordedVision());

    const result = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes()).llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });

    expect(result.vision).toEqual({ analysed: 0, cached: 0, failed: 1, costUsd: 0 });
    expect(vision.calls).toHaveLength(0);
    expect(await enrichmentRow(P1)).toMatchObject({
      status: "enriched",
      visionStatus: "failed",
      visionImageHashes: [],
    });

    // The CDN answers next time: analysed, over unchanged text.
    await seedImages(P1, ["https://cdn.example/p1-a.png"]);
    const text = llmStub(() => recordedAttributes());
    const again = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: text.llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });
    expect(again).toEqual({
      enriched: 0,
      cached: 3,
      failed: 0,
      vision: { analysed: 1, cached: 0, failed: 0, costUsd: 0 },
    });
    expect(text.calls).toHaveLength(0);
    expect(vision.calls).toHaveLength(1);
    expect((await enrichmentRow(P1)).visionStatus).toBe("enriched");
  });

  it("a text re-enrichment over unchanged images re-merges against the stored vision answer", async () => {
    await seedImages(P1, ["https://cdn.example/p1-a.png"]);
    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes({ category: "other", colors: [], primaryColor: "" })).llm,
      vision: { llm: llmStub(() => recordedVision()).llm, fetchImage: imageServer().fetchImage },
    });
    expect(await enrichmentRow(P1)).toMatchObject({ category: "dress", colors: ["navy", "white"] });

    // A rule change (older version) re-runs the text side only; the new
    // text answer names a category, and the colours still come from vision.
    await db.productEnrichment.update({
      where: { shopDomain_productId: { shopDomain: SHOP, productId: P1 } },
      data: { enrichmentVersion: ENRICHMENT_VERSION - 1 },
    });
    const text = llmStub(() => recordedAttributes({ category: "top", colors: [], primaryColor: "" }));
    const vision = llmStub(() => recordedVision({ category: "skirt" }));
    const result = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: text.llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });
    expect(result).toEqual({
      enriched: 1,
      cached: 2,
      failed: 0,
      vision: { analysed: 0, cached: 1, failed: 0, costUsd: 0 },
    });
    expect(text.calls).toHaveLength(1);
    expect(vision.calls).toHaveLength(0);
    expect(await enrichmentRow(P1)).toMatchObject({
      category: "top",
      colors: ["navy", "white"],
      primaryColor: "navy",
      sleeveLength: "long",
      visionStatus: "enriched",
    });
  });

  it("re-merges stored answers that carry nulls: a colourless text answer and a not-applicable coverage field survive a one-side re-run", async () => {
    // Stored answers are the PARSED form — null primaryColor, null
    // not-applicable fields — which the raw-shape parsers reject; the
    // stored readers map them back (found by the YOY-122 eval fixtures:
    // every pants product lost its vision answer on re-read).
    const trousers = parsedVision({
      category: "pants",
      colors: ["khaki"],
      primaryColor: "khaki",
      sleeveLength: null,
      neckline: null,
      garmentLength: null,
      pattern: "solid",
      materialAppearance: "cotton",
    });
    expect(visionAttributesFromStored(trousers as unknown as Parameters<typeof visionAttributesFromStored>[0])).toEqual(trousers);
    expect(visionAttributesFromStored(null)).toBeNull();
    expect(visionAttributesFromStored({ category: "pants" })).toBeNull();
    const colourless = recordedAttributes({ colors: [], primaryColor: null });
    expect(textAttributesFromStored(colourless as unknown as Parameters<typeof textAttributesFromStored>[0], PLAIN)).toEqual(colourless);
    expect(textAttributesFromStored(null, PLAIN)).toBeNull();

    // End to end: a colourless text answer and a trousers vision answer,
    // then a text-only re-run (version bump) — the vision fields survive.
    await seedImages(P3, ["https://cdn.example/p3-a.jpg"]);
    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub((request) =>
        request.prompt.includes("Plain tee")
          ? recordedAttributes({ category: "other", colors: [], primaryColor: "" })
          : recordedAttributes(),
      ).llm,
      vision: {
        llm: llmStub(() =>
          recordedVision({
            category: "pants",
            colors: ["khaki"],
            primaryColor: "khaki",
            sleeveLength: "not-applicable",
            neckline: "not-applicable",
            garmentLength: "not-applicable",
            pattern: "solid",
            materialAppearance: "cotton",
          }),
        ).llm,
        fetchImage: imageServer().fetchImage,
      },
    });
    expect(await enrichmentRow(P3)).toMatchObject({ category: "pants", primaryColor: "khaki", sleeveLength: null, materialAppearance: "cotton" });
    await db.productEnrichment.update({
      where: { shopDomain_productId: { shopDomain: SHOP, productId: P3 } },
      data: { enrichmentVersion: ENRICHMENT_VERSION - 1 },
    });
    const vision = llmStub(() => recordedVision());
    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes({ category: "other", colors: [], primaryColor: "" })).llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });
    expect(vision.calls).toHaveLength(0);
    expect(await enrichmentRow(P3)).toMatchObject({
      category: "pants",
      primaryColor: "khaki",
      materialAppearance: "cotton",
      visionStatus: "enriched",
    });
  });

  it("removing every image clears the vision answer without a call", async () => {
    await seedImages(P1, ["https://cdn.example/p1-a.png"]);
    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes()).llm,
      vision: { llm: llmStub(() => recordedVision()).llm, fetchImage: imageServer().fetchImage },
    });
    await seedImages(P1, []);
    const vision = llmStub(() => recordedVision());
    const result = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes()).llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });
    expect(result.vision).toEqual({ analysed: 0, cached: 0, failed: 0, costUsd: 0 });
    expect(vision.calls).toHaveLength(0);
    expect(await enrichmentRow(P1)).toMatchObject({
      visionStatus: "none",
      visionImageHashes: [],
      visionAttributes: null,
      sleeveLength: null,
      // Back to the text answer alone.
      colors: ["black"],
    });
  });

  it("without a vision pass, the result carries no vision counts and stored vision answers are kept", async () => {
    await seedImages(P1, ["https://cdn.example/p1-a.png"]);
    await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes()).llm,
      vision: { llm: llmStub(() => recordedVision()).llm, fetchImage: imageServer().fetchImage },
    });
    // Force a text re-run without the vision pass configured.
    await db.productEnrichment.update({
      where: { shopDomain_productId: { shopDomain: SHOP, productId: P1 } },
      data: { enrichmentVersion: 0 },
    });
    const result = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes({ category: "other" })).llm,
    });
    expect(result).toEqual({ enriched: 1, cached: 2, failed: 0 });
    expect(await enrichmentRow(P1)).toMatchObject({
      category: "dress",
      sleeveLength: "long",
      visionStatus: "enriched",
    });
  });

  it("meters every vision call under operation vision and reports the run's cost (AC-6)", async () => {
    await db.aiCall.deleteMany();
    await seedImages(P1, ["https://cdn.example/p1-a.png"]);
    await seedImages(P2, ["https://cdn.example/p2-a.webp"]);
    const recorder = createPrismaCostRecorder(db);
    const vision = llmStub(
      (request, call) =>
        request.prompt.includes("Linen summer dress") && call === 1
          ? { category: 42 }
          : recordedVision(),
      recorder,
    );

    const result = await enrichCatalog({
      db,
      shopDomain: SHOP,
      llm: llmStub(() => recordedAttributes(), recorder).llm,
      vision: { llm: vision.llm, fetchImage: imageServer().fetchImage },
    });

    // Three vision calls (one retried) — every one metered, including the
    // rejected output — and the report sums exactly those rows.
    const rows = await db.aiCall.findMany({ where: { operation: "vision" } });
    expect(rows).toHaveLength(3);
    const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
    expect(total).toBeGreaterThan(0);
    expect(result.vision).toEqual({ analysed: 2, cached: 0, failed: 0, costUsd: total });
    expect(await db.aiCall.count({ where: { operation: "enrichment" } })).toBe(3);
  });
});
