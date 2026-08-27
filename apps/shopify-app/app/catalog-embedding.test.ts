import type { PrismaClient } from "@prisma/client";
import type {
  CostRecorder,
  EmbeddingClient,
  EmbeddingRequest,
} from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import {
  DESCRIPTION_EXCERPT_CHARS,
  EmbeddingDimensionError,
  composeEmbeddingText,
  embedCatalog,
  similarProducts,
  visionAttributeTerms,
} from "./catalog/embed.server";
import { mapProductNode } from "./catalog/mapping.server";
import { productNode } from "./catalog/mapping.test";
import { createTestDb } from "./testing/helpers.server";

// Embedding tests run against the embedded PGlite DB with fixture vectors
// only — no embedding network call anywhere in the default run (AC-5). Live
// embedding lives in embedding-live.test.ts behind LIVE_LLM_TESTS=1.

const SHOP = "test-shop.myshopify.com";
const OTHER_SHOP = "other-shop.myshopify.com";
const DIMENSION = 3;

/**
 * Deterministic fixture vector for a text: derived from char codes only, so
 * the same composed text always maps to the same vector.
 */
function fixtureVector(text: string, dimension: number): number[] {
  return Array.from({ length: dimension }, (_, axis) => {
    let value = 1;
    for (const char of text) {
      value = (value * 31 + char.charCodeAt(0) * (axis + 1)) % 997;
    }
    return value / 997 + 0.001;
  });
}

/**
 * Fixture-backed EmbeddingClient stub: answers each batch from `respond`
 * (fixture vectors by default), records every request, and — like the real
 * adapter contract — meters each batch call through the given CostRecorder.
 */
function embeddingStub({
  dimension = DIMENSION,
  respond,
  costRecorder,
}: {
  dimension?: number;
  respond?: (text: string, index: number) => number[];
  costRecorder?: CostRecorder;
} = {}) {
  const calls: EmbeddingRequest[] = [];
  const client: EmbeddingClient = {
    dimension,
    async embed(request) {
      calls.push(request);
      await costRecorder?.record({
        provider: "google",
        modelId: "gemini-embedding-001",
        operation: request.operation ?? "embedding",
        inputTokens: Math.ceil(
          request.texts.reduce((sum, text) => sum + text.length, 0) / 4,
        ),
        outputTokens: 0,
        storeId: request.storeId,
      });
      return request.texts.map(
        (text, index) => respond?.(text, index) ?? fixtureVector(text, dimension),
      );
    },
  };
  return { client, calls };
}

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

async function storedEmbeddings(
  db: PrismaClient,
  shopDomain: string,
): Promise<Array<{ productId: string; contentHash: string; embedding: string }>> {
  return db.$queryRawUnsafe(
    `SELECT "productId", "contentHash", "embedding"::text AS embedding
     FROM "ProductEmbedding" WHERE "shopDomain" = $1 ORDER BY "productId" ASC`,
    shopDomain,
  );
}

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
  await db.productEnrichment.deleteMany();
  await db.catalogProduct.deleteMany();
  await db.aiCall.deleteMany();
  for (const node of fixtureNodes()) {
    await db.catalogProduct.create({
      data: { shopDomain: SHOP, ...mapProductNode(node) },
    });
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe("composeEmbeddingText", () => {
  const product = {
    productId: "gid://shopify/Product/1",
    title: "Black evening dress",
    description: "An elegant maxi dress.",
    tags: ["dress", "evening"],
    contentHash: "hash-1",
  };
  const attributes = {
    category: "dress",
    colors: ["black"],
    occasions: ["evening"],
    fit: "regular",
    styleTags: ["elegant"],
    seasons: ["summer"],
  };

  it("composes title, enriched attributes, description excerpt, and tags in fixed order", () => {
    expect(composeEmbeddingText(product, attributes)).toBe(
      [
        "Black evening dress",
        "dress",
        "regular",
        "black",
        "evening",
        "elegant",
        "summer",
        "An elegant maxi dress.",
        "dress",
        "evening",
      ].join("\n"),
    );
    // Deterministic: identical inputs always compose identical text.
    expect(composeEmbeddingText(product, attributes)).toBe(
      composeEmbeddingText(product, attributes),
    );
  });

  it("phrases the vision attributes after the text attributes (YOY-121 AC-4)", () => {
    const vision = {
      ...attributes,
      sleeveLength: "long",
      neckline: "v-neck",
      garmentLength: "midi",
      pattern: "floral",
      materialAppearance: "knit",
    };
    expect(visionAttributeTerms(vision)).toEqual([
      "long sleeves",
      "v-neck neckline",
      "midi length",
      "floral pattern",
      "knit",
    ]);
    expect(visionAttributeTerms({ ...attributes, sleeveLength: "sleeveless" })).toEqual([
      "sleeveless",
    ]);
    // Null (not applicable / never analysed) contributes nothing — the
    // composed text of a vision-less row is byte-for-byte what it was.
    expect(visionAttributeTerms({ ...attributes, pattern: null, neckline: null })).toEqual([]);
    expect(composeEmbeddingText(product, vision)).toBe(
      [
        "Black evening dress",
        "dress",
        "regular",
        "black",
        "evening",
        "elegant",
        "summer",
        "long sleeves",
        "v-neck neckline",
        "midi length",
        "floral pattern",
        "knit",
        "An elegant maxi dress.",
        "dress",
        "evening",
      ].join("\n"),
    );
    // A vision change moves the text, hence the freshness hash.
    expect(composeEmbeddingText(product, { ...vision, pattern: "stripe" })).not.toBe(
      composeEmbeddingText(product, vision),
    );
  });

  it("omits attributes without an enrichment record and drops empty parts", () => {
    expect(
      composeEmbeddingText({ ...product, description: "", tags: [] }, null),
    ).toBe("Black evening dress");
  });

  it("truncates the description to the excerpt length", () => {
    const long = "x".repeat(DESCRIPTION_EXCERPT_CHARS + 100);
    const text = composeEmbeddingText(
      { ...product, description: long, tags: [] },
      null,
    );
    expect(text).toBe(
      `Black evening dress\n${"x".repeat(DESCRIPTION_EXCERPT_CHARS)}`,
    );
  });
});

describe("catalog embedding", () => {
  it("embeds every product in one batched call and stores one vector per row", async () => {
    const { client, calls } = embeddingStub();

    const result = await embedCatalog({ db, shopDomain: SHOP, embeddings: client });

    expect(result).toEqual({ embedded: 3, cached: 0, deleted: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.texts).toHaveLength(3);
    expect(calls[0]!.storeId).toBe(SHOP);
    // The composed text reaches the port — Hebrew products included.
    expect(calls[0]!.texts[1]).toContain("שמלת ערב שחורה");

    const rows = await storedEmbeddings(db, SHOP);
    expect(rows).toHaveLength(3);
    const snapshots = await db.catalogProduct.findMany({
      orderBy: { productId: "asc" },
    });
    rows.forEach((row, index) => {
      // The stored key is the composed-text hash (YOY-29 AC-6), so it moves
      // when either the snapshot content or the enrichment state changes.
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.contentHash).not.toBe(snapshots[index]!.contentHash);
      expect(row.embedding).toMatch(/^\[/);
    });
  });

  it("folds enriched attributes into the embedded text", async () => {
    const snapshot = await db.catalogProduct.findFirstOrThrow({
      where: { shopDomain: SHOP, productId: "gid://shopify/Product/1" },
    });
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: snapshot.productId,
        contentHash: snapshot.contentHash,
        status: "enriched",
        category: "dress",
        colors: ["black"],
        occasions: ["evening"],
        fit: "regular",
        styleTags: ["elegant"],
        seasons: ["summer"],
      },
    });
    const { client, calls } = embeddingStub();

    await embedCatalog({ db, shopDomain: SHOP, embeddings: client });

    const embedded = calls[0]!.texts.find((text) =>
      text.startsWith(snapshot.title),
    );
    expect(embedded).toContain("dress");
    expect(embedded).toContain("elegant");
    // Products without a successful enrichment embed without attribute
    // lines: title, then tags, nothing in between (description is empty).
    expect(calls[0]!.texts.find((text) => text.startsWith("Plain tee"))).toBe(
      "Plain tee\ndress\nsummer",
    );
  });

  it("re-runs over an unchanged catalog with zero embedding calls", async () => {
    await embedCatalog({ db, shopDomain: SHOP, embeddings: embeddingStub().client });

    const rerun = embeddingStub();
    const result = await embedCatalog({
      db,
      shopDomain: SHOP,
      embeddings: rerun.client,
    });

    expect(result).toEqual({ embedded: 0, cached: 3, deleted: 0 });
    expect(rerun.calls).toHaveLength(0);
  });

  it("re-embeds only changed products and drops vectors of deleted products", async () => {
    await embedCatalog({ db, shopDomain: SHOP, embeddings: embeddingStub().client });

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
    await db.catalogProduct.delete({
      where: {
        shopDomain_productId: {
          shopDomain: SHOP,
          productId: "gid://shopify/Product/3",
        },
      },
    });

    const { client, calls } = embeddingStub();
    const result = await embedCatalog({ db, shopDomain: SHOP, embeddings: client });

    expect(result).toEqual({ embedded: 1, cached: 1, deleted: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.texts[0]).toContain("Renamed dress");

    const rows = await storedEmbeddings(db, SHOP);
    expect(rows.map((row) => row.productId)).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
    ]);
  });

  it("re-embeds exactly the product whose enrichment landed after embedding (YOY-29 AC-6)", async () => {
    await embedCatalog({ db, shopDomain: SHOP, embeddings: embeddingStub().client });

    const snapshot = await db.catalogProduct.findFirstOrThrow({
      where: { shopDomain: SHOP, productId: "gid://shopify/Product/1" },
    });
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: snapshot.productId,
        contentHash: snapshot.contentHash,
        status: "enriched",
        category: "dress",
        colors: ["black"],
        occasions: ["evening"],
        fit: "regular",
        styleTags: ["elegant"],
        seasons: ["summer"],
      },
    });

    const { client, calls } = embeddingStub();
    const result = await embedCatalog({ db, shopDomain: SHOP, embeddings: client });

    expect(result).toEqual({ embedded: 1, cached: 2, deleted: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.texts).toHaveLength(1);
    expect(calls[0]!.texts[0]).toContain("elegant");
    expect(calls[0]!.texts[0]).toContain("black");

    // Unchanged catalog + unchanged enrichment: nothing left to embed.
    const rerun = embeddingStub();
    const unchanged = await embedCatalog({
      db,
      shopDomain: SHOP,
      embeddings: rerun.client,
    });
    expect(unchanged).toEqual({ embedded: 0, cached: 3, deleted: 0 });
    expect(rerun.calls).toHaveLength(0);
  });

  it("re-embeds exactly the product whose vision attributes changed (YOY-121 AC-4)", async () => {
    const snapshots = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });
    for (const snapshot of snapshots) {
      await db.productEnrichment.create({
        data: {
          shopDomain: SHOP,
          productId: snapshot.productId,
          contentHash: snapshot.contentHash,
          status: "enriched",
          category: "dress",
          colors: [],
          occasions: [],
          fit: "",
          styleTags: [],
          seasons: [],
        },
      });
    }
    await embedCatalog({ db, shopDomain: SHOP, embeddings: embeddingStub().client });

    // The vision pass lands its attributes on one product only.
    await db.productEnrichment.update({
      where: {
        shopDomain_productId: { shopDomain: SHOP, productId: "gid://shopify/Product/2" },
      },
      data: { sleeveLength: "long", materialAppearance: "knit", visionStatus: "enriched" },
    });
    const rerun = embeddingStub();
    const result = await embedCatalog({ db, shopDomain: SHOP, embeddings: rerun.client });

    expect(result).toEqual({ embedded: 1, cached: 2, deleted: 0 });
    expect(rerun.calls).toHaveLength(1);
    expect(rerun.calls[0]!.texts).toEqual([
      expect.stringContaining("long sleeves\nknit"),
    ]);
    expect(rerun.calls[0]!.texts[0]).toContain("שמלת ערב שחורה");

    // Unchanged again: zero embedding calls.
    const again = embeddingStub();
    expect(await embedCatalog({ db, shopDomain: SHOP, embeddings: again.client })).toEqual({
      embedded: 0,
      cached: 3,
      deleted: 0,
    });
    expect(again.calls).toHaveLength(0);
  });

  it("lands one embedding ledger row per batched call through a metered client", async () => {
    const { client } = embeddingStub({
      costRecorder: createPrismaCostRecorder(db),
    });

    await embedCatalog({ db, shopDomain: SHOP, embeddings: client });

    const rows = await db.aiCall.findMany({ where: { operation: "embedding" } });
    // One batch of three texts is one metered call with batch token counts.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shopDomain).toBe(SHOP);
    expect(rows[0]!.inputTokens).toBeGreaterThan(0);
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
  });

  it("fails loudly when a returned vector disagrees with the configured dimension", async () => {
    const { client } = embeddingStub({
      dimension: 4,
      respond: () => [0.1, 0.2, 0.3],
    });

    await expect(
      embedCatalog({ db, shopDomain: SHOP, embeddings: client }),
    ).rejects.toThrow(EmbeddingDimensionError);
    expect(await storedEmbeddings(db, SHOP)).toHaveLength(0);
  });

  it("fails loudly when the query vector disagrees with stored dimensions", async () => {
    await embedCatalog({ db, shopDomain: SHOP, embeddings: embeddingStub().client });

    await expect(
      similarProducts({ db, shopDomain: SHOP, vector: [1, 0] }),
    ).rejects.toThrow();
  });
});

describe("similarProducts", () => {
  beforeEach(async () => {
    // Controlled vectors: shop A's product 1 points along the first axis,
    // product 2 along the second. The other shop's only product carries a
    // vector identical to A's product 1 — the strongest possible leakage bait.
    const vectorByProduct: Record<string, Record<string, number[]>> = {
      [SHOP]: {
        "gid://shopify/Product/1": [1, 0, 0],
        "gid://shopify/Product/2": [0, 1, 0],
        "gid://shopify/Product/3": [0, 0.9, 0.1],
      },
      [OTHER_SHOP]: { "gid://shopify/Product/9": [1, 0, 0] },
    };
    await db.catalogProduct.create({
      data: {
        shopDomain: OTHER_SHOP,
        ...mapProductNode(productNode({ id: "gid://shopify/Product/9" })),
      },
    });
    for (const [shopDomain, vectors] of Object.entries(vectorByProduct)) {
      const products = await db.catalogProduct.findMany({
        where: { shopDomain },
        orderBy: { productId: "asc" },
      });
      const { client } = embeddingStub({
        respond: (_text, index) => vectors[products[index]!.productId]!,
      });
      await embedCatalog({ db, shopDomain, embeddings: client });
    }
  });

  it("returns nearest products ordered by cosine distance", async () => {
    const hits = await similarProducts({
      db,
      shopDomain: SHOP,
      vector: [0, 1, 0],
      limit: 2,
    });

    expect(hits.map((hit) => hit.productId)).toEqual([
      "gid://shopify/Product/2",
      "gid://shopify/Product/3",
    ]);
    expect(hits[0]!.distance).toBeCloseTo(0);
    expect(hits[1]!.distance).toBeGreaterThan(0);
  });

  it("never leaks another shop's products, even with identical vectors", async () => {
    const hits = await similarProducts({
      db,
      shopDomain: SHOP,
      vector: [1, 0, 0],
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.productId)).not.toContain(
      "gid://shopify/Product/9",
    );

    const otherHits = await similarProducts({
      db,
      shopDomain: OTHER_SHOP,
      vector: [1, 0, 0],
    });
    expect(otherHits.map((hit) => hit.productId)).toEqual([
      "gid://shopify/Product/9",
    ]);
  });
});
