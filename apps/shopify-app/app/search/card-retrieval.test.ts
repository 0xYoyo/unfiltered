import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  CARD_SECTION_OVERSCAN,
  cardSectionsPerProduct,
  FAMILY_OVERSCAN,
  queryCardIndex,
} from "./card-retrieval.server";

// The card index query (YOY-144 AC-3 to AC-7) on the embedded PGlite DB.
// Vectors are written directly, so every distance is known: the cosine
// distance from [1, y, 0] to the query [1, 0, 0] rises monotonically with y.

const SHOP = "test-shop.myshopify.com";
const DIMENSION = 3;
const QUERY = [1, 0, 0];
const vec = (y: number): string => `[1,${y},0]`;

async function seedProduct(
  db: PrismaClient,
  productId: string,
  overrides: Partial<{
    shopDomain: string;
    familyKey: string;
    status: string;
    publishedAt: Date | null;
    available: boolean;
    priceMin: number;
  }> = {},
): Promise<void> {
  await db.catalogProduct.create({
    data: {
      shopDomain: overrides.shopDomain ?? SHOP,
      productId,
      title: productId,
      description: "",
      tags: [],
      vendor: "V",
      productType: "",
      priceMin: overrides.priceMin ?? 10,
      priceMax: overrides.priceMin ?? 10,
      currencyCode: "USD",
      available: overrides.available ?? true,
      status: overrides.status ?? "ACTIVE",
      publishedAt: overrides.publishedAt === undefined ? new Date() : overrides.publishedAt,
      familyKey: overrides.familyKey ?? "",
      imageAltTexts: [],
      sourceUpdatedAt: new Date(),
      contentHash: `hash-${productId}`,
    },
  });
}

async function cardVector(db: PrismaClient, productId: string, section: string, y: number, shopDomain = SHOP) {
  await db.$executeRawUnsafe(
    `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
     VALUES ($1, $2, $3, $4, 'h', $5::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
    randomUUID(),
    shopDomain,
    productId,
    section,
    vec(y),
  );
}

async function rawVector(db: PrismaClient, productId: string, y: number, shopDomain = SHOP) {
  await db.$executeRawUnsafe(
    `INSERT INTO "ProductEmbedding" ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
     VALUES ($1, $2, $3, 'h', $4::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
    randomUUID(),
    shopDomain,
    productId,
    vec(y),
  );
}

describe("the card index query", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
    await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
    await db.catalogProduct.deleteMany();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const query = (limit = 10) => queryCardIndex({ db, shopDomain: SHOP, vector: QUERY, limit });

  it("ranks each product by its best section, prose or any language's asks (AC-3)", async () => {
    // a: prose far, Hebrew asks nearest of all. b: every section middling.
    await seedProduct(db, "a");
    await seedProduct(db, "b");
    await cardVector(db, "a", "prose", 2.0);
    await cardVector(db, "a", "asks:en", 1.5);
    await cardVector(db, "a", "asks:he", 0.1);
    await cardVector(db, "b", "prose", 0.4);
    await cardVector(db, "b", "asks:en", 0.5);
    await cardVector(db, "b", "asks:he", 0.6);

    const hits = await query();
    expect(hits.map((hit) => hit.productId)).toEqual(["a", "b"]);
    const nearestA = (await db.$queryRawUnsafe<Array<{ d: number }>>(
      `SELECT ('${vec(0.1)}'::vector(3) <=> '[1,0,0]'::vector(3))::float8 AS d`,
    ))[0]!.d;
    expect(hits[0]!.distance).toBeCloseTo(nearestA, 10);
  });

  it("finds a product with no card through its raw-text vector, on the same distance scale (AC-4)", async () => {
    await seedProduct(db, "carded-near");
    await seedProduct(db, "uncarded");
    await seedProduct(db, "carded-far");
    await cardVector(db, "carded-near", "prose", 0.1);
    await rawVector(db, "uncarded", 0.3);
    await cardVector(db, "carded-far", "prose", 0.6);
    // A carded product's raw-text row never speaks for it, even when nearer.
    await rawVector(db, "carded-far", 0.0);

    const hits = await query();
    expect(hits.map((hit) => hit.productId)).toEqual(["carded-near", "uncarded", "carded-far"]);
  });

  it("collapses by product, then by family: five colourways × three vectors are one result (AC-5)", async () => {
    for (let colourway = 0; colourway < 5; colourway += 1) {
      const id = `dress-${colourway}`;
      await seedProduct(db, id, { familyKey: "dress-family" });
      await cardVector(db, id, "prose", 0.1 + colourway * 0.01);
      await cardVector(db, id, "asks:en", 0.2 + colourway * 0.01);
      await cardVector(db, id, "asks:he", 0.3 + colourway * 0.01);
    }
    await seedProduct(db, "skirt");
    await cardVector(db, "skirt", "prose", 0.5);

    const hits = await query();
    expect(hits.map((hit) => hit.productId)).toEqual(["dress-0", "skirt"]);
  });

  it("counts families, not vectors or colourways, against the limit (AC-5)", async () => {
    for (let index = 0; index < 4; index += 1) {
      for (let colourway = 0; colourway < 3; colourway += 1) {
        const id = `f${index}-c${colourway}`;
        await seedProduct(db, id, { familyKey: `family-${index}` });
        await cardVector(db, id, "prose", index * 0.1 + colourway * 0.01);
        await cardVector(db, id, "asks:en", index * 0.1 + colourway * 0.01 + 0.001);
      }
    }
    expect((await query(3)).map((hit) => hit.productId)).toEqual(["f0-c0", "f1-c0", "f2-c0"]);
  });

  it("sizes the card scan to the sections a product stores, so five ask languages still fill the limit (YOY-157 AC-9)", async () => {
    const languages = ["en", "he", "ar", "ru", "fr"];
    const sections = ["prose", ...languages.map((language) => `asks:${language}`)];
    expect(cardSectionsPerProduct(languages)).toBe(6);
    expect(cardSectionsPerProduct(["en"])).toBe(CARD_SECTION_OVERSCAN);
    // Three families of FAMILY_OVERSCAN colourways each, every section near
    // the query: family 0's vectors alone are limit * FAMILY_OVERSCAN * 3
    // rows, the old fixed window, so the old bound saw one family only.
    const limit = 2;
    for (let family = 0; family < 3; family += 1) {
      for (let colourway = 0; colourway < FAMILY_OVERSCAN; colourway += 1) {
        const id = `f${family}-c${colourway}`;
        await seedProduct(db, id, { familyKey: `family-${family}` });
        for (const [index, section] of sections.entries()) {
          await cardVector(db, id, section, family * 0.1 + colourway * 0.001 + index * 0.0001);
        }
      }
    }
    const hits = await queryCardIndex({ db, shopDomain: SHOP, vector: QUERY, limit, askLanguages: languages });
    expect(hits.map((hit) => hit.productId)).toEqual(["f0-c0", "f1-c0"]);
    const oldBound = await queryCardIndex({ db, shopDomain: SHOP, vector: QUERY, limit, askLanguages: ["en", "he"] });
    expect(oldBound.map((hit) => hit.productId)).toEqual(["f0-c0"]);
  });

  it("filters only on store, ACTIVE and published — never on stock, price or anything else (AC-7)", async () => {
    await seedProduct(db, "active");
    await seedProduct(db, "out-of-stock", { available: false });
    await seedProduct(db, "pricey", { priceMin: 99_999 });
    await seedProduct(db, "draft", { status: "DRAFT" });
    await seedProduct(db, "unpublished", { publishedAt: null });
    await seedProduct(db, "elsewhere", { shopDomain: "other-shop.myshopify.com" });
    await seedProduct(db, "draft-raw", { status: "ARCHIVED" });
    for (const [index, id] of ["active", "out-of-stock", "pricey", "draft", "unpublished"].entries()) {
      await cardVector(db, id, "prose", index * 0.1);
    }
    await cardVector(db, "elsewhere", "prose", 0.0, "other-shop.myshopify.com");
    await rawVector(db, "draft-raw", 0.0);

    expect((await query()).map((hit) => hit.productId)).toEqual(["active", "out-of-stock", "pricey"]);
  });

  it("refuses a malformed limit or vector", async () => {
    await expect(queryCardIndex({ db, shopDomain: SHOP, vector: QUERY, limit: 0 })).rejects.toThrow(RangeError);
    await expect(queryCardIndex({ db, shopDomain: SHOP, vector: [] })).rejects.toThrow(RangeError);
  });
});

/**
 * Multi-tenant recall with three vectors per product (AC-6) — the YOY-105
 * fixture, card-shaped. Every large-tenant vector is nearer to the query
 * than every small-tenant vector, so a non-iterative index scan spends its
 * whole candidate budget on the large tenant. Each product's best section
 * rotates between prose, asks:en and asks:he, and its other two sections
 * sit farther than every small-tenant best, so the expected top ten is the
 * small tenant's first ten products in order.
 *
 * Product i's sections are [1, y_i, z_k]: y ranks the products and z (0 for
 * the best section, then `offset`, then twice it) moves the other sections
 * away. Putting all three sections on the one y line instead makes a
 * degenerate 3-D HNSW graph — 7,200 near-collinear large-tenant points in
 * three overlapping bands — that no scan setting crosses (an iterative scan
 * with max_scan_tuples 1,000,000 and ef_search 400 still returned nothing);
 * real embeddings never take that shape.
 */
describe("small-tenant recall over three card vectors per product (AC-6)", () => {
  const SMALL = "small-tenant.myshopify.com";
  const LARGE = "large-tenant.myshopify.com";
  const SMALL_ROWS = 400;
  const LARGE_ROWS = 2_400;
  const TOP_K = 10;
  let db: PrismaClient;

  /**
   * Seed a tenant in two statements. `best`/`step` give product i its y;
   * `offset` is the z step that places its other two sections farther away.
   */
  async function seedTenant(shopDomain: string, prefix: string, count: number, best: number, step: number, offset: number) {
    await db.$executeRawUnsafe(
      `INSERT INTO "CatalogProduct"
         ("id", "shopDomain", "productId", "title", "description", "tags", "vendor", "productType",
          "priceMin", "priceMax", "currencyCode", "available", "status", "publishedAt", "imageAltTexts",
          "sourceUpdatedAt", "contentHash", "updatedAt")
       SELECT gen_random_uuid()::text, $1, $2 || lpad(i::text, 4, '0'), 't', '', '{}', 'fixture', '',
              100, 100, 'USD', true, 'ACTIVE', CURRENT_TIMESTAMP, '{}', CURRENT_TIMESTAMP, 'h', CURRENT_TIMESTAMP
       FROM generate_series(0, ${count - 1}) i`,
      shopDomain,
      prefix,
    );
    // Section s of product i: k = (s - i mod 3) mod 3, so the best section
    // (k = 0, z = 0) is section (i mod 3) and the others sit at z = k * offset.
    await db.$executeRawUnsafe(
      `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
       SELECT gen_random_uuid()::text, $1, $2 || lpad(i::text, 4, '0'), (ARRAY['prose','asks:en','asks:he'])[s + 1], 'h',
              ('[1,' || (${best} + i * ${step})::text || ',' || (((s - i % 3 + 3) % 3) * ${offset})::text || ']')::vector(${DIMENSION}),
              CURRENT_TIMESTAMP
       FROM generate_series(0, ${count - 1}) i, generate_series(0, 2) s`,
      shopDomain,
      prefix,
    );
  }

  beforeAll(async () => {
    db = await createTestDb();
    // Cosine distance to [1, 0, 0] rises with y² + z². Large: y 0.1–0.34,
    // z ≤ 0.1, so y² + z² ≤ 0.126 — under every small-tenant vector (≥ 0.25).
    await seedTenant(LARGE, "large-", LARGE_ROWS, 0.1, 0.0001, 0.05);
    // Small: bests y 0.5–0.899 (y² ≤ 0.81); the others have z ≥ 1, so
    // y² + z² ≥ 1.25 — never between two bests.
    await seedTenant(SMALL, "small-", SMALL_ROWS, 0.5, 0.001, 1.0);
    await db.$executeRawUnsafe(
      `CREATE INDEX "CardEmbedding_cosine_${DIMENSION}_idx" ON "CardEmbedding"
       USING hnsw ((("embedding")::vector(${DIMENSION})) vector_cosine_ops)`,
    );
    await db.$executeRawUnsafe(`ANALYZE`);
    // Force the HNSW index scan the production planner picks at real scale,
    // as the YOY-105 recall test does: without both knobs the planner sorts
    // the fixture-scale tenant exactly and the index is never exercised.
    await db.$executeRawUnsafe(`SET enable_seqscan = off`);
    await db.$executeRawUnsafe(`SET enable_sort = off`);
  }, 120_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("returns the small tenant its exact top ten", async () => {
    const hits = await queryCardIndex({ db, shopDomain: SMALL, vector: QUERY, limit: TOP_K });
    expect(hits.map((hit) => hit.productId)).toEqual(
      Array.from({ length: TOP_K }, (_, index) => `small-${String(index).padStart(4, "0")}`),
    );
    const distances = hits.map((hit) => hit.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("still serves the large tenant its own top ten", async () => {
    const hits = await queryCardIndex({ db, shopDomain: LARGE, vector: QUERY, limit: TOP_K });
    expect(hits.map((hit) => hit.productId)).toEqual(
      Array.from({ length: TOP_K }, (_, index) => `large-${String(index).padStart(4, "0")}`),
    );
  });
});
