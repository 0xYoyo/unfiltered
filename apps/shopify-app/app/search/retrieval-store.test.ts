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
    attributesExclude: [],
    attributesInclude: [],
    occasion: undefined,
    availableOnly: false,
  };
}

interface SeedProduct {
  productId: string;
  vector: number[];
  shopDomain?: string;
  /** Snapshot text the attribute filter reads (YOY-133); defaults to the id / none. */
  title?: string;
  tags?: string[];
  description?: string;
  priceMin?: number;
  priceMax?: number;
  available?: boolean;
  /** Shopify product status; defaults to ACTIVE like the schema. */
  status?: string;
  /** Online Store publication; null seeds an unpublished row (YOY-67 AC-4). */
  publishedAt?: Date | null;
  /** Product-family key (YOY-117); "" (the default) is its own family. */
  familyKey?: string;
  /** null seeds no enrichment row (an unenriched product). */
  enrichment?: {
    category?: string | null;
    colors?: string[];
    /** Displayed colour (YOY-110); defaults to the first of `colors`. */
    primaryColor?: string | null;
    occasions?: string[];
    /** Enrichment evidence the attribute filter reads (YOY-133). */
    styleTags?: string[];
    fit?: string | null;
  } | null;
}

async function seed(db: PrismaClient, products: SeedProduct[]): Promise<void> {
  for (const product of products) {
    const shopDomain = product.shopDomain ?? SHOP;
    await db.catalogProduct.create({
      data: {
        shopDomain,
        productId: product.productId,
        title: product.title ?? product.productId,
        description: product.description ?? "",
        tags: product.tags ?? [],
        vendor: "fixture",
        productType: "",
        priceMin: product.priceMin ?? 100,
        priceMax: product.priceMax ?? product.priceMin ?? 100,
        currencyCode: "ILS",
        available: product.available ?? true,
        status: product.status ?? "ACTIVE",
        publishedAt: product.publishedAt,
        familyKey: product.familyKey ?? "",
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
          // Default primary colour = the first stated colour, mirroring the
          // enrichment fallback rule (YOY-110); pass `primaryColor` to seed a
          // colourway product whose displayed colour differs, or null for an
          // unknown one.
          primaryColor:
            product.enrichment.primaryColor === undefined
              ? (product.enrichment.colors?.[0] ?? null)
              : product.enrichment.primaryColor,
          fit: product.enrichment.fit ?? null,
          styleTags: product.enrichment.styleTags ?? [],
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

/** The storefront's own shape: no limit at all — the full ranked set. */
async function allQueryIds(
  db: PrismaClient,
  constraints: RetrievalConstraints,
  vector = [1, 0, 0],
): Promise<string[]> {
  const hits = await createPgVectorRetrievalStore(db).query({
    storeId: SHOP,
    constraints,
    vector,
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
      attributesExclude: [],
      attributesInclude: [],
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
      attributesExclude: [],
      attributesInclude: [],
    });
    expect(ids).toEqual(["unenriched"]);
  });

  it("excludes by the PRIMARY colour only: a colourway product is not its other colours (YOY-110 AC-3, AC-4)", async () => {
    await seed(db, [
      // The live F-1 shape: a pink dress that also comes in black and navy.
      {
        productId: "mesh-pink",
        vector: [1, 0, 0],
        enrichment: { category: "dress", colors: ["pink", "black", "navy"], primaryColor: "pink" },
      },
      // Primary colour IS the excluded colour, at perfect similarity.
      {
        productId: "tie-black",
        vector: [1, 0, 0],
        enrichment: { category: "dress", colors: ["black"], primaryColor: "black" },
      },
      // Stated colours but no primary colour: unknown passes.
      {
        productId: "no-primary",
        vector: [0.6, 0.8, 0],
        enrichment: { category: "dress", colors: ["black"], primaryColor: null },
      },
    ]);

    const ids = await queryIds(db, {
      ...noConstraints(),
      colorsExclude: ["Black"],
      attributesExclude: [],
      attributesInclude: [],
    });
    expect(ids).toEqual(["mesh-pink", "no-primary"]);
    expect(ids).not.toContain("tie-black");
  });

  it("a close-match shaped query — every constraint relaxed but the exclusion — never returns a black-primary product (YOY-111 AC-3)", async () => {
    await seed(db, [
      // Nearest vector, primary colour black: excluded on every ladder rung.
      {
        productId: "black-primary",
        vector: [1, 0, 0],
        enrichment: { category: "dress", colors: ["black"], primaryColor: "black" },
      },
      {
        productId: "pink-colourway",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "dress", colors: ["pink", "black"], primaryColor: "pink" },
      },
      { productId: "unknown-primary", vector: [0.8, 0.2, 0], enrichment: { colors: [], primaryColor: null } },
    ]);
    // The ladder's last rung: only colorsExclude left.
    const ids = await queryIds(db, { ...noConstraints(), colorsExclude: ["black"] });
    expect(ids).toEqual(["pink-colourway", "unknown-primary"]);
    expect(ids).not.toContain("black-primary");
  });

  it("colorsInclude still reads every colourway, unchanged (YOY-110 NG-1)", async () => {
    await seed(db, [
      {
        productId: "mesh-pink",
        vector: [1, 0, 0],
        enrichment: { colors: ["pink", "black", "navy"], primaryColor: "pink" },
      },
      { productId: "red-one", vector: [0.9, 0.1, 0], enrichment: { colors: ["red"] } },
    ]);
    expect(
      await queryIds(db, { ...noConstraints(), colorsInclude: ["black"] }),
    ).toEqual(["mesh-pink"]);
  });

  it("under an exclusion-only colour constraint, colorUnknown means the primary colour is unknown (YOY-110 AC-3)", async () => {
    await seed(db, [
      // Colours stated but no primary colour: passes on leniency, flagged,
      // tiered below the evidence-backed hit despite the nearer vector.
      {
        productId: "stated-no-primary",
        vector: [1, 0, 0],
        enrichment: { colors: ["black"], primaryColor: null },
      },
      {
        productId: "known-pink",
        vector: [0.6, 0.8, 0],
        enrichment: { colors: ["pink", "black"], primaryColor: "pink" },
      },
    ]);
    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: SHOP,
      constraints: { ...noConstraints(), colorsExclude: ["black"] },
      vector: [1, 0, 0],
      limit: 10,
    });
    expect(hits.map((hit) => hit.productId)).toEqual(["known-pink", "stated-no-primary"]);
    expect(hits.map((hit) => hit.colorUnknown)).toEqual([false, true]);
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

describe("one hit per product family (YOY-117 AC-2)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
  });

  const FAMILY = "eval|rib knit top|tops";
  const seedFamily = (db: PrismaClient) =>
    seed(db, [
      // Three colourways of one top; the black one is the nearest vector.
      { productId: "rib-black", vector: [1, 0, 0], familyKey: FAMILY, enrichment: { category: "top", colors: ["black"], primaryColor: "black" } },
      { productId: "rib-navy", vector: [0.9, 0.1, 0], familyKey: FAMILY, enrichment: { category: "top", colors: ["navy"], primaryColor: "navy" } },
      { productId: "rib-pink", vector: [0.8, 0.2, 0], familyKey: FAMILY, enrichment: { category: "top", colors: ["pink"], primaryColor: "pink" } },
      // A different product, further away: never hidden by the family.
      { productId: "linen-tee", vector: [0.7, 0.3, 0], familyKey: "eval|linen tee|tops", enrichment: { category: "top", colors: ["white"], primaryColor: "white" } },
      // Two pre-YOY-117 rows with an empty key: each its own family.
      { productId: "legacy-a", vector: [0.6, 0.4, 0], enrichment: { category: "top", colors: [] } },
      { productId: "legacy-b", vector: [0.5, 0.5, 0], enrichment: { category: "top", colors: [] } },
    ]);

  it("returns the best-ranked member once when the query names no colour", async () => {
    await seedFamily(db);
    const ids = await allQueryIds(db, noConstraints());
    expect(ids).toEqual(["rib-black", "linen-tee", "legacy-a", "legacy-b"]);
  });

  it("returns the member whose primary colour matches colorsInclude, ranked at the family's place", async () => {
    await seedFamily(db);
    const ids = await allQueryIds(db, { ...noConstraints(), colorsInclude: ["pink"] });
    // The pink member represents the family; the other colourways fail the
    // inclusion outright; the unknown-colour legacy rows pass on leniency
    // and tier below.
    expect(ids).toEqual(["rib-pink", "legacy-a", "legacy-b"]);
  });

  it("applies the limit AFTER the collapse, so a page counts families", async () => {
    await seedFamily(db);
    const ids = await queryIds(db, noConstraints());
    expect(ids).toEqual(["rib-black", "linen-tee", "legacy-a", "legacy-b"]);
    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: SHOP,
      constraints: noConstraints(),
      vector: [1, 0, 0],
      limit: 2,
    });
    expect(hits.map((hit) => hit.productId)).toEqual(["rib-black", "linen-tee"]);
  });

  it("keeps the result shape: productId, distance, and the colour flag only", async () => {
    await seedFamily(db);
    const [hit] = await createPgVectorRetrievalStore(db).query({
      storeId: SHOP,
      constraints: { ...noConstraints(), colorsInclude: ["pink"] },
      vector: [1, 0, 0],
      limit: 1,
    });
    expect(Object.keys(hit!).sort()).toEqual(["colorUnknown", "distance", "productId"]);
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
        attributesExclude: [],
        attributesInclude: [],
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
      attributesExclude: [],
      attributesInclude: [],
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

describe("the full match set, uncapped (YOY-107 AC-2)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
    // More than the retired 10-result default; vectors fan out along the
    // query direction so the ranking order is unambiguous.
    await seed(
      db,
      Array.from({ length: 25 }, (_, index) => ({
        productId: `p-${String(index).padStart(2, "0")}`,
        vector: [1, index / 100, 0],
      })),
    );
  });

  it("returns every constrained match when the request carries no limit", async () => {
    const ids = await allQueryIds(db, noConstraints());
    expect(ids).toHaveLength(25);
  });

  it("an explicit limit is the top of the same ranking, not a different one", async () => {
    const full = await allQueryIds(db, noConstraints());
    const capped = await queryIds(db, noConstraints());
    expect(capped).toHaveLength(10);
    expect(capped).toEqual(full.slice(0, 10));
  });

  it("rejects a non-positive explicit limit as before", async () => {
    await expect(
      createPgVectorRetrievalStore(db).query({
        storeId: SHOP,
        constraints: noConstraints(),
        vector: [1, 0, 0],
        limit: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("negated attributes are hard exclusions; category-like attributes hard inclusions (YOY-133 AC-2)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
    // Every product sits at the same, perfect similarity so only the
    // attribute predicate decides membership.
    const v = [1, 0, 0];
    await seed(db, [
      // Evidence of "wool" in three places, one per product.
      { productId: "wool-title", vector: v, title: "Wool Winter Coat", enrichment: { category: "coat" } },
      { productId: "wool-tag", vector: v, title: "Winter Coat", tags: ["wool"], enrichment: { category: "coat" } },
      { productId: "wool-styletag", vector: v, title: "Winter Coat", enrichment: { category: "coat", styleTags: ["wool", "warm"] } },
      { productId: "wool-fit", vector: v, title: "Winter Coat", enrichment: { category: "coat", fit: "woolen" } },
      // Hebrew evidence, an attached preposition included (מצמר = of wool).
      { productId: "wool-hebrew", vector: v, title: "מעיל צמר אפור", enrichment: { category: "coat" } },
      { productId: "wool-hebrew-prefixed", vector: v, title: "מעיל חורף", description: "עשוי מצמר", enrichment: { category: "coat" } },
      // A NEGATED mention is not evidence: "without wool", "wool-free".
      { productId: "no-wool-hebrew", vector: v, title: "מעיל פוך ניילון", description: "מעיל פוך קל מניילון, ללא צמר.", enrichment: { category: "coat", styleTags: ["puffer"] } },
      { productId: "wool-free", vector: v, title: "Wool-free Puffer Coat", enrichment: { category: "coat" } },
      // No evidence at all: passes (unknown passes), enriched or not.
      { productId: "plain-coat", vector: v, title: "Puffer Coat", enrichment: { category: "coat" } },
      // Off the shared axis so it ranks first for its own query vector below.
      { productId: "unenriched-coat", vector: [0, 1, 0], title: "Camel Overcoat", enrichment: null },
      // Sleeves: "sleeveless" is NOT "sleeves"; "long sleeve" is.
      { productId: "sleeveless", vector: v, title: "Sleeveless Linen Tank Top", tags: ["sleeveless"], enrichment: { category: "top", styleTags: ["sleeveless"], fit: "sleeveless" } },
      { productId: "no-sleeves-hebrew", vector: v, title: "גופייה ללא שרוולים", description: "גופייה קלילה ללא שרוולים.", enrichment: { category: "top" } },
      { productId: "long-sleeve", vector: v, title: "Long-Sleeve Cotton Top", enrichment: { category: "top", styleTags: ["long sleeve"] } },
      { productId: "long-sleeve-hebrew", vector: v, title: "חולצה עם שרוולים ארוכים", enrichment: { category: "top", styleTags: [] } },
      // Bridal (category-like): evidence in a styleTag, an EN tag, a HE tag.
      { productId: "bridal-styletag", vector: v, title: "Ivory Lace Gown", enrichment: { category: "dress", styleTags: ["lace", "bridal"] } },
      { productId: "bridal-hebrew", vector: v, title: "שמלת כלה שנהב", tags: ["כלה"], enrichment: { category: "dress" } },
      { productId: "guest-dress", vector: v, title: "Sage Guest Midi Dress", description: "Flowy sage midi for a wedding guest.", enrichment: { category: "dress", occasions: ["wedding"] } },
      // An unlisted word filters on its own forms.
      { productId: "polyester", vector: v, title: "Polyester Shell", enrichment: { category: "jacket", styleTags: ["polyesters"] } },
    ]);
  });

  const exclude = (...words: string[]): RetrievalConstraints => ({
    ...noConstraints(),
    attributesExclude: words,
  });

  it("excludes a product whose title, tags, styleTags, or fit carry the negated word — EN and HE, attached preposition included", async () => {
    const ids = await queryIds(db, { ...exclude("wool"), category: "coat" });
    expect(ids).not.toContain("wool-title");
    expect(ids).not.toContain("wool-tag");
    expect(ids).not.toContain("wool-styletag");
    expect(ids).not.toContain("wool-fit");
    expect(ids).not.toContain("wool-hebrew");
    expect(ids).not.toContain("wool-hebrew-prefixed");
  });

  it("passes a product with no evidence of the word — enriched or not — and one whose only mention is negated", async () => {
    const ids = await queryIds(db, { ...exclude("wool"), category: "coat" });
    expect(ids).toContain("plain-coat");
    expect(ids).toContain("no-wool-hebrew");
    expect(ids).toContain("wool-free");
    // No category constraint: the unenriched product passes too.
    expect((await queryIds(db, exclude("wool"), [0, 1, 0]))[0]).toBe("unenriched-coat");
  });

  it('"sleeveless" is not excluded by "sleeves"; "long sleeve" and "שרוולים" are', async () => {
    const ids = await queryIds(db, { ...exclude("sleeves"), category: "top" });
    expect(ids.sort()).toEqual(["no-sleeves-hebrew", "sleeveless"]);
  });

  it("folds the model's word onto the lexicon: 'sleeve' and 'woollen' filter as 'sleeves' and 'wool'", async () => {
    expect((await queryIds(db, { ...exclude("sleeve"), category: "top" })).sort()).toEqual([
      "no-sleeves-hebrew",
      "sleeveless",
    ]);
    const coats = await queryIds(db, { ...exclude("woollen"), category: "coat" });
    expect(coats).not.toContain("wool-title");
    expect(coats).toContain("plain-coat");
  });

  it("an unlisted word filters on its own singular and plural forms", async () => {
    expect(await queryIds(db, exclude("polyester"))).not.toContain("polyester");
    expect(await queryIds(db, exclude("polyesters"))).not.toContain("polyester");
    // ...and matches as a whole word only.
    expect(await queryIds(db, exclude("poly"))).toContain("polyester");
  });

  it("a category-like inclusion is evidence-required: bridal gowns only, EN and HE evidence alike", async () => {
    const ids = await queryIds(db, {
      ...noConstraints(),
      category: "dress",
      attributesInclude: ["bridal"],
    });
    expect(ids.sort()).toEqual(["bridal-hebrew", "bridal-styletag"]);
  });

  it("the guest's query excludes bridal and keeps the guest dress; a word with no term applies no filter", async () => {
    expect(
      (await queryIds(db, { ...exclude("bridal"), category: "dress" })).sort(),
    ).toEqual(["guest-dress"]);
    // An empty / multi-word value cannot become a term and is skipped, not
    // applied as a filter that matches nothing.
    expect(
      (await queryIds(db, { ...exclude("", "long sleeve"), category: "dress" })).sort(),
    ).toEqual(["bridal-hebrew", "bridal-styletag", "guest-dress"]);
  });

  it("several negations combine: every one must be clear", async () => {
    const ids = await queryIds(db, { ...exclude("wool", "sleeves") });
    expect(ids).not.toContain("wool-title");
    expect(ids).not.toContain("long-sleeve");
    expect(ids).toContain("plain-coat");
    expect(ids).toContain("sleeveless");
  });
});
