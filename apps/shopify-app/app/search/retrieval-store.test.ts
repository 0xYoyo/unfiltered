import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  createRetriever,
  type EmbeddingClient,
  type Intent,
  type RetrievalConstraints,
} from "@unfiltered/engine";
import { beforeEach, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import { createPgVectorRetrievalStore } from "./retrieval-store.server";

// Store-port tests run against the embedded PGlite database with fixture
// vectors — zero network calls (AC-6). Dimension 3 keeps the fixtures
// readable; the SQL casts through the query vector's dimension either way.

const SHOP = "shop-a.myshopify.com";

/** An unconstrained filter set to override per test. */
function noConstraints(): RetrievalConstraints {
  return {
    category: undefined,
    priceMin: undefined,
    priceMax: undefined,
    colorsInclude: [],
    colorsExclude: [],
    occasion: undefined,
    availableOnly: false,
  };
}

interface SeedProduct {
  productId: string;
  vector: number[];
  shopDomain?: string;
  priceMin?: number;
  priceMax?: number;
  available?: boolean;
  /** Shopify product status; defaults to ACTIVE like the schema. */
  status?: string;
  /** Online Store publication; null seeds an unpublished row (YOY-67 AC-4). */
  publishedAt?: Date | null;
  /** null seeds no enrichment row (an unenriched product). */
  enrichment?: {
    category?: string | null;
    colors?: string[];
    occasions?: string[];
  } | null;
}

async function seed(db: PrismaClient, products: SeedProduct[]): Promise<void> {
  for (const product of products) {
    const shopDomain = product.shopDomain ?? SHOP;
    await db.catalogProduct.create({
      data: {
        shopDomain,
        productId: product.productId,
        title: product.productId,
        description: "",
        tags: [],
        vendor: "fixture",
        productType: "",
        priceMin: product.priceMin ?? 100,
        priceMax: product.priceMax ?? product.priceMin ?? 100,
        currencyCode: "ILS",
        available: product.available ?? true,
        status: product.status ?? "ACTIVE",
        publishedAt: product.publishedAt,
        imageAltTexts: [],
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: `hash-${product.productId}`,
      },
    });
    if (product.enrichment !== null && product.enrichment !== undefined) {
      await db.productEnrichment.create({
        data: {
          shopDomain,
          productId: product.productId,
          contentHash: `hash-${product.productId}`,
          status: "enriched",
          category: product.enrichment.category ?? null,
          colors: product.enrichment.colors ?? [],
          occasions: product.enrichment.occasions ?? [],
          fit: null,
          styleTags: [],
          seasons: [],
        },
      });
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "ProductEmbedding"
         ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::vector(${product.vector.length}), CURRENT_TIMESTAMP)`,
      randomUUID(),
      shopDomain,
      product.productId,
      `hash-${product.productId}`,
      `[${product.vector.join(",")}]`,
    );
  }
}

async function queryIds(
  db: PrismaClient,
  constraints: RetrievalConstraints,
  vector = [1, 0, 0],
  shopDomain = SHOP,
): Promise<string[]> {
  const hits = await createPgVectorRetrievalStore(db).query({
    storeId: shopDomain,
    constraints,
    vector,
    limit: 10,
  });
  return hits.map((hit) => hit.productId);
}

describe("hard constraints are filters, never preferences (AC-2)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("never returns a product above the price cap, even at perfect similarity", async () => {
    await seed(db, [
      // Identical to the query vector — maximal similarity — but over budget.
      { productId: "pricey-dress", vector: [1, 0, 0], priceMin: 500, priceMax: 500 },
      { productId: "affordable-dress", vector: [0.6, 0.8, 0], priceMin: 250 },
    ]);

    const ids = await queryIds(db, { ...noConstraints(), priceMax: 400 });
    expect(ids).toEqual(["affordable-dress"]);
  });

  it("never returns a non-active product row, even at perfect similarity (YOY-61 AC-3)", async () => {
    await seed(db, [
      // Identical to the query vector — but archived/draft: must never serve.
      { productId: "archived", vector: [1, 0, 0], status: "ARCHIVED" },
      { productId: "draft", vector: [1, 0, 0], status: "DRAFT" },
      { productId: "active", vector: [0.6, 0.8, 0] },
    ]);

    const ids = await queryIds(db, noConstraints());
    expect(ids).toEqual(["active"]);
  });

  it("never returns an unpublished product row, even at perfect similarity (YOY-67 AC-4)", async () => {
    await seed(db, [
      // Identical to the query vector — but never published to the Online
      // Store: its storefront page 404s, so it must never serve, however
      // ACTIVE it is.
      { productId: "unpublished", vector: [1, 0, 0], publishedAt: null },
      { productId: "published", vector: [0.6, 0.8, 0] },
    ]);

    const ids = await queryIds(db, noConstraints());
    expect(ids).toEqual(["published"]);
  });

  it("respects a lower price bound the same way", async () => {
    await seed(db, [
      { productId: "cheap", vector: [1, 0, 0], priceMin: 20, priceMax: 20 },
      { productId: "premium", vector: [0.6, 0.8, 0], priceMin: 300, priceMax: 300 },
    ]);

    const ids = await queryIds(db, { ...noConstraints(), priceMin: 100 });
    expect(ids).toEqual(["premium"]);
  });

  it("never returns an excluded color, even at perfect similarity", async () => {
    await seed(db, [
      // The high-similarity black dress of the issue's verify step.
      {
        productId: "black-dress",
        vector: [1, 0, 0],
        enrichment: { category: "dress", colors: ["black"] },
      },
      {
        productId: "ivory-dress",
        vector: [0.6, 0.8, 0],
        enrichment: { category: "dress", colors: ["ivory"] },
      },
    ]);

    const ids = await queryIds(db, {
      ...noConstraints(),
      colorsExclude: ["Black"],
    });
    expect(ids).toEqual(["ivory-dress"]);
  });

  it("keeps a product with no enrichment row under a color exclusion (unknown, not violating)", async () => {
    await seed(db, [
      { productId: "unenriched", vector: [1, 0, 0], enrichment: null },
    ]);

    const ids = await queryIds(db, {
      ...noConstraints(),
      colorsExclude: ["black"],
    });
    expect(ids).toEqual(["unenriched"]);
  });

  it("still requires enrichment evidence for the category constraint", async () => {
    await seed(db, [
      { productId: "unenriched", vector: [1, 0, 0], enrichment: null },
      {
        productId: "red-dress",
        vector: [0.6, 0.8, 0],
        enrichment: { category: "dress", colors: ["red"] },
      },
      {
        productId: "red-coat",
        vector: [0, 1, 0],
        enrichment: { category: "coat", colors: ["red"] },
      },
    ]);

    expect(
      await queryIds(db, { ...noConstraints(), category: "Dress" }),
    ).toEqual(["red-dress"]);
  });

  it("filters occasion against the enrichment occasions", async () => {
    await seed(db, [
      {
        productId: "gala-gown",
        vector: [1, 0, 0],
        enrichment: { category: "dress", occasions: ["gala", "wedding"] },
      },
      {
        productId: "beach-dress",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "dress", occasions: ["beach"] },
      },
    ]);

    const ids = await queryIds(db, {
      ...noConstraints(),
      occasion: "Wedding",
    });
    expect(ids).toEqual(["gala-gown"]);
  });

  it("passes unknowns through positive occasion and color constraints; stated mismatches still exclude (YOY-35 AC-1)", async () => {
    await seed(db, [
      // Legitimately sparse enrichment: category known, occasions/colors not.
      {
        productId: "sparse-dress",
        vector: [1, 0, 0],
        enrichment: { category: "dress", colors: [], occasions: [] },
      },
      // No enrichment row at all — equally unknown.
      { productId: "unenriched", vector: [0.9, 0.1, 0], enrichment: null },
      // Stated and mismatched on both attributes — still excluded.
      {
        productId: "black-beach-dress",
        vector: [0.8, 0.2, 0],
        enrichment: {
          category: "dress",
          colors: ["black"],
          occasions: ["beach"],
        },
      },
      // Stated and matching — included, of course.
      {
        productId: "red-wedding-dress",
        vector: [0, 1, 0],
        enrichment: {
          category: "dress",
          colors: ["red"],
          occasions: ["wedding"],
        },
      },
    ]);

    const ids = await queryIds(db, {
      ...noConstraints(),
      colorsInclude: ["red"],
      occasion: "wedding",
    });
    // Unknowns still pass the filter (YOY-35 AC-1), but under a positive
    // color constraint the evidence-backed match ranks strictly above them
    // regardless of similarity (YOY-67 AC-5); unknowns keep their own
    // similarity order after it.
    expect(ids).toEqual(["red-wedding-dress", "sparse-dress", "unenriched"]);
  });

  it("tiers unknown-color hits below every known match and flags them (YOY-67 AC-5)", async () => {
    await seed(db, [
      // Nearest vector but no color evidence: passes on leniency, flagged,
      // and ranked below every evidence-backed match.
      {
        productId: "unknown-near",
        vector: [1, 0, 0],
        enrichment: { colors: [] },
      },
      { productId: "known-far", vector: [0, 1, 0], enrichment: { colors: ["blue"] } },
      { productId: "known-near", vector: [0.9, 0.1, 0], enrichment: { colors: ["blue"] } },
    ]);

    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: SHOP,
      constraints: { ...noConstraints(), colorsInclude: ["blue"] },
      vector: [1, 0, 0],
      limit: 10,
    });

    expect(hits.map((hit) => hit.productId)).toEqual([
      "known-near",
      "known-far",
      "unknown-near",
    ]);
    expect(hits.map((hit) => hit.colorUnknown)).toEqual([false, false, true]);

    // Without a positive color constraint, no flag and pure similarity order.
    const unconstrained = await createPgVectorRetrievalStore(db).query({
      storeId: SHOP,
      constraints: noConstraints(),
      vector: [1, 0, 0],
      limit: 10,
    });
    expect(unconstrained[0]!.productId).toBe("unknown-near");
    expect(unconstrained.every((hit) => hit.colorUnknown === undefined)).toBe(
      true,
    );
  });

  it("tiers and flags unknowns under an exclusion-only color constraint too (YOY-67 AC-5 fix round 1)", async () => {
    await seed(db, [
      // Nearest vector but no color evidence: passes the exclusion on
      // leniency (nothing proves the excluded color), flagged and tiered
      // below the evidence-backed hit — a "Not black ×" chip is a color
      // chip, so unknowns must not pose as first-class hits under it.
      {
        productId: "excl-unknown-near",
        vector: [1, 0, 0],
        enrichment: { colors: [] },
      },
      {
        productId: "excl-known-red",
        vector: [0.6, 0.8, 0],
        enrichment: { colors: ["red"] },
      },
    ]);

    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: SHOP,
      constraints: { ...noConstraints(), colorsExclude: ["black"] },
      vector: [1, 0, 0],
      limit: 10,
    });

    expect(hits.map((hit) => hit.productId)).toEqual([
      "excl-known-red",
      "excl-unknown-near",
    ]);
    expect(hits.map((hit) => hit.colorUnknown)).toEqual([false, true]);
  });

  it("expands a parent category constraint through the taxonomy groups; child constraints stay exact (YOY-35 AC-5)", async () => {
    await seed(db, [
      {
        productId: "white-sneakers",
        vector: [1, 0, 0],
        enrichment: { category: "sneakers", colors: ["white"] },
      },
      {
        productId: "leather-boots",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "boots" },
      },
      {
        productId: "pearl-necklace",
        vector: [0.8, 0.2, 0],
        enrichment: { category: "jewelry" },
      },
      {
        productId: "silk-dress",
        vector: [0.7, 0.3, 0],
        enrichment: { category: "dress" },
      },
    ]);

    // g07's shape: a "shoes" constraint admits the sneakers (and boots).
    expect(
      await queryIds(db, { ...noConstraints(), category: "shoes" }),
    ).toEqual(["white-sneakers", "leather-boots"]);
    // g20's shape: an "accessories" constraint admits jewelry.
    expect(
      await queryIds(db, { ...noConstraints(), category: "accessories" }),
    ).toEqual(["pearl-necklace"]);
    // A child constraint stays exact: sneakers means sneakers.
    expect(
      await queryIds(db, { ...noConstraints(), category: "sneakers" }),
    ).toEqual(["white-sneakers"]);
  });

  it("filters out unavailable products when availability is required", async () => {
    await seed(db, [
      { productId: "sold-out", vector: [1, 0, 0], available: false },
      { productId: "in-stock", vector: [0.6, 0.8, 0] },
    ]);

    const ids = await queryIds(db, { ...noConstraints(), availableOnly: true });
    expect(ids).toEqual(["in-stock"]);
  });
});

describe("similarity ranking (AC-3)", () => {
  it("ranks the filtered set by cosine distance to the query vector", async () => {
    const db = await createTestDb();
    await seed(db, [
      { productId: "far", vector: [0, 0, 1] },
      { productId: "near", vector: [0.9, 0.1, 0] },
      { productId: "middle", vector: [0.5, 0.5, 0] },
    ]);

    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: SHOP,
      constraints: noConstraints(),
      vector: [1, 0, 0],
      limit: 10,
    });

    expect(hits.map((hit) => hit.productId)).toEqual([
      "near",
      "middle",
      "far",
    ]);
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
    expect(hits[1]!.distance).toBeLessThan(hits[2]!.distance);
  });
});

describe("per-shop isolation (AC-4)", () => {
  it("returns only the queried shop's products for identical intents", async () => {
    const db = await createTestDb();
    await seed(db, [
      { productId: "a-dress", vector: [1, 0, 0], shopDomain: "shop-a.myshopify.com" },
      { productId: "b-dress", vector: [1, 0, 0], shopDomain: "shop-b.myshopify.com" },
    ]);

    expect(
      await queryIds(db, noConstraints(), [1, 0, 0], "shop-a.myshopify.com"),
    ).toEqual(["a-dress"]);
    expect(
      await queryIds(db, noConstraints(), [1, 0, 0], "shop-b.myshopify.com"),
    ).toEqual(["b-dress"]);
  });
});

describe("latency (AC-5)", () => {
  it("answers a filtered similarity query over the fixture catalog in <300ms", async () => {
    const db = await createTestDb();
    const catalog: SeedProduct[] = Array.from({ length: 60 }, (_, i) => {
      const angle = (i / 60) * Math.PI;
      return {
        productId: `product-${String(i).padStart(2, "0")}`,
        vector: [Math.cos(angle), Math.sin(angle), 0],
        priceMin: 50 + i * 10,
        priceMax: 50 + i * 10,
        enrichment: {
          category: i % 2 === 0 ? "dress" : "coat",
          colors: i % 3 === 0 ? ["black"] : ["red"],
          occasions: ["wedding"],
        },
      };
    });
    await seed(db, catalog);

    const store = createPgVectorRetrievalStore(db);
    const started = performance.now();
    const hits = await store.query({
      storeId: SHOP,
      constraints: {
        ...noConstraints(),
        priceMax: 500,
        colorsExclude: ["black"],
        availableOnly: true,
      },
      vector: [1, 0, 0],
      limit: 10,
    });
    const elapsed = performance.now() - started;

    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(300);
  });
});

describe("end to end through the engine API (AC-1)", () => {
  it("retrieves ranked, constraint-clean hits for an Intent via the ports", async () => {
    const db = await createTestDb();
    await seed(db, [
      {
        productId: "black-gown",
        vector: [1, 0, 0],
        enrichment: { category: "dress", colors: ["black"], occasions: ["wedding"] },
      },
      {
        productId: "ivory-gown",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "dress", colors: ["ivory"], occasions: ["wedding"] },
        priceMin: 350,
        priceMax: 350,
      },
    ]);

    const embeddings: EmbeddingClient = {
      dimension: 3,
      async embed(request) {
        return request.texts.map(() => [1, 0, 0]);
      },
    };
    const intent: Intent = {
      category: "dress",
      priceMin: undefined,
      priceMax: 400,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      size: undefined,
      availabilityRequired: true,
      softAttributes: ["elegant", "summer"],
    };

    const retriever = createRetriever({
      embeddings,
      store: createPgVectorRetrievalStore(db),
    });
    const result = await retriever.retrieve({
      intent,
      storeId: SHOP,
      searchId: "search-1",
    });

    expect(result.hits.map((hit) => hit.productId)).toEqual(["ivory-gown"]);
    expect(result.hits[0]!.score).toBeGreaterThan(0);
    expect(result.appliedConstraints).toContainEqual({
      field: "colorsExclude",
      value: "black",
    });
  });
});
