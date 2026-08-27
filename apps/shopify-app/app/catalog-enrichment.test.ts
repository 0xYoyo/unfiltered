import type { PrismaClient } from "@prisma/client";
import type {
  CostRecorder,
  LlmClient,
  StructuredCompletionRequest,
} from "@unfiltered/engine";
import {
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
} from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import type { ProductAttributes } from "./catalog/enrich.server";
import {
  buildEnrichmentPrompt,
  ENRICHMENT_SCHEMA,
  ENRICHMENT_VERSION,
  enrichCatalog,
  parseEnrichment,
  primaryColorFromTitle,
  resolvePrimaryColor,
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
