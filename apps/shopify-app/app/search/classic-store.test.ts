import type { PrismaClient } from "@prisma/client";
import type { RetrievalConstraints } from "@unfiltered/engine";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  buildClassicSearchSql,
  createPgTrgmClassicStore,
  SEARCH_TEXT,
} from "./classic-store.server";

// Classic-store tests run against the embedded PGlite database with the
// committed migrations applied — the pg_trgm extension, the
// catalog_search_text function, and the trigram index all come from the
// migration itself, so these tests also prove the migration loads under the
// PGlite splitter (single-semicolon statements).

const SHOP = "classic-shop.myshopify.com";

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
  title: string;
  tags?: string[];
  vendor?: string;
  productType?: string;
  imageAltTexts?: string[];
  priceMin?: number;
  priceMax?: number;
  available?: boolean;
  /** Shopify product status; defaults to ACTIVE like the schema. */
  status?: string;
  /** Online Store publication; null seeds an unpublished row (YOY-67 AC-4). */
  publishedAt?: Date | null;
  shopDomain?: string;
  /** undefined seeds no enrichment row (an unenriched product). */
  enrichment?: {
    category?: string | null;
    colors?: string[];
    occasions?: string[];
  };
}

async function seed(db: PrismaClient, products: SeedProduct[]): Promise<void> {
  for (const product of products) {
    const shopDomain = product.shopDomain ?? SHOP;
    await db.catalogProduct.create({
      data: {
        shopDomain,
        productId: product.productId,
        title: product.title,
        description: "",
        tags: product.tags ?? [],
        vendor: product.vendor ?? "fixture",
        productType: product.productType ?? "",
        priceMin: product.priceMin ?? 100,
        priceMax: product.priceMax ?? product.priceMin ?? 100,
        currencyCode: "ILS",
        available: product.available ?? true,
        status: product.status ?? "ACTIVE",
        publishedAt: product.publishedAt,
        imageAltTexts: product.imageAltTexts ?? [],
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: `hash-${product.productId}`,
      },
    });
    if (product.enrichment !== undefined) {
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
  }
}

async function searchIds(
  db: PrismaClient,
  request: {
    query?: string;
    constraints?: RetrievalConstraints;
    shopDomain?: string;
    limit?: number;
  },
): Promise<string[]> {
  const result = await createPgTrgmClassicStore(db).search({
    storeId: request.shopDomain ?? SHOP,
    query: request.query,
    constraints: request.constraints,
    // Forwarded verbatim, absence included: no limit is the full match set
    // (YOY-107), which is what the storefront asks for.
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });
  return result.hits.map((hit) => hit.productId);
}

describe("typo-tolerant keyword search (AC-2, AC-3)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db, [
      { productId: "nike", title: "Nike Air Max 90", productType: "Sneakers" },
      { productId: "aurora", title: "Aurora Maxi Dress", productType: "Dresses" },
      { productId: "linen", title: "Linen Beach Dress", productType: "Dresses" },
      { productId: "he-evening", title: "שמלת ערב שחורה", productType: "Dresses" },
      { productId: "he-summer", title: "שמלת קיץ פרחונית", productType: "Dresses" },
      { productId: "other-shop", title: "Nike Air Max 90", shopDomain: "other.myshopify.com" },
    ]);
  });

  it("ranks the exact-title product first and never leaks other shops", async () => {
    const ids = await searchIds(db, { query: "nike air max 90" });
    expect(ids[0]).toBe("nike");
    expect(ids).not.toContain("other-shop");
  });

  it("tolerates an English typo one or two edits off (AC-3)", async () => {
    const ids = await searchIds(db, { query: "nkie air max" });
    expect(ids.slice(0, 5)).toContain("nike");
  });

  it("tolerates a Hebrew typo (AC-3)", async () => {
    const ids = await searchIds(db, { query: "שמלת ערבב" });
    expect(ids.slice(0, 5)).toContain("he-evening");
  });

  it("matches Hebrew exactly and ranks the intended product first", async () => {
    const ids = await searchIds(db, { query: "שמלת ערב" });
    expect(ids[0]).toBe("he-evening");
  });

  it("searches tags, vendor, productType, and imageAltTexts, not only titles", async () => {
    await seed(db, [
      {
        productId: "tagged",
        title: "פריט",
        tags: ["velvet-crush"],
        imageAltTexts: ["model wearing crimson gown"],
      },
    ]);
    expect(await searchIds(db, { query: "velvet-crush" })).toContain("tagged");
    expect(await searchIds(db, { query: "crimson gown" })).toContain("tagged");
  });

  it("ranks title matches above tag/alt-text-only matches, typos included (YOY-52 AC-13)", async () => {
    await seed(db, [
      { productId: "board-1", title: "Powder Snowboard", productType: "Boards" },
      { productId: "board-2", title: "Snowboard Deluxe", productType: "Boards" },
      {
        // The live-run shape: a non-board matching only through secondary
        // fields must never outrank an actual board.
        productId: "gift-card",
        title: "Gift Card",
        tags: ["snowboard", "snowboard-gift"],
        imageAltTexts: ["snowboard gift card art"],
      },
    ]);

    for (const query of ["snowboard", "snowbaord"]) {
      const ids = await searchIds(db, { query });
      expect(ids, query).toContain("gift-card"); // still findable…
      const giftRank = ids.indexOf("gift-card");
      for (const board of ["board-1", "board-2"]) {
        expect(ids, query).toContain(board);
        expect(ids.indexOf(board), `${query}: ${board} vs gift-card`).toBeLessThan(
          giftRank,
        );
      }
    }
  });

  it("never serves a non-active product row, even at an exact title match (YOY-61 AC-3)", async () => {
    await seed(db, [
      {
        productId: "archived-nike",
        title: "Nike Air Max 90 Archived",
        status: "ARCHIVED",
      },
      { productId: "draft-nike", title: "Nike Air Max 90 Draft", status: "DRAFT" },
    ]);

    const ids = await searchIds(db, { query: "nike air max 90" });
    expect(ids).toContain("nike");
    expect(ids).not.toContain("archived-nike");
    expect(ids).not.toContain("draft-nike");
  });

  it("never serves an unpublished product row, even at an exact title match (YOY-67 AC-4)", async () => {
    await seed(db, [
      {
        productId: "unpublished-nike",
        title: "Nike Air Max 90 Unpublished",
        publishedAt: null,
      },
    ]);

    const ids = await searchIds(db, { query: "nike air max 90" });
    expect(ids).toContain("nike");
    expect(ids).not.toContain("unpublished-nike");
  });

  it("scores hits in (0, 1], most relevant first", async () => {
    const result = await createPgTrgmClassicStore(db).search({
      storeId: SHOP,
      query: "aurora maxi dress",
    });
    expect(result.hits[0]!.productId).toBe("aurora");
    for (const hit of result.hits) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    const scores = result.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("constraint-only mode mirrors pgvector predicate semantics (AC-4)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db, [
      {
        productId: "cheap-dress",
        title: "Budget Dress",
        priceMin: 100,
        priceMax: 150,
        enrichment: { category: "dress", colors: ["red"], occasions: ["wedding"] },
      },
      {
        productId: "pricey-dress",
        title: "Couture Dress",
        priceMin: 900,
        priceMax: 1200,
        enrichment: { category: "dress", colors: ["black"], occasions: ["evening"] },
      },
      {
        productId: "sneaker",
        title: "Court Sneaker",
        enrichment: { category: "sneakers", colors: [], occasions: [] },
      },
      {
        productId: "unknown-attrs",
        title: "Mystery Piece",
        enrichment: { category: null, colors: [], occasions: [] },
      },
      { productId: "unenriched", title: "Raw Import" },
      { productId: "sold-out", title: "Gone Dress", available: false },
    ]);
  });

  it("price cap compares against priceMin", async () => {
    const ids = await searchIds(db, {
      constraints: { ...noConstraints(), priceMax: 400 },
    });
    expect(ids).not.toContain("pricey-dress");
    expect(ids).toContain("cheap-dress");
  });

  it("availability filters to available products", async () => {
    const ids = await searchIds(db, {
      constraints: { ...noConstraints(), availableOnly: true },
    });
    expect(ids).not.toContain("sold-out");
  });

  it("category is evidence-required and expands through category groups", async () => {
    // Parent constraint admits group members: shoes → sneakers.
    const shoes = await searchIds(db, {
      constraints: { ...noConstraints(), category: "shoes" },
    });
    expect(shoes).toEqual(["sneaker"]);
    // Evidence-required: null-category and unenriched products are excluded.
    const dresses = await searchIds(db, {
      constraints: { ...noConstraints(), category: "dress" },
    });
    expect(dresses).not.toContain("unknown-attrs");
    expect(dresses).not.toContain("unenriched");
  });

  it("unknown enrichment passes positive occasion and color constraints", async () => {
    const wedding = await searchIds(db, {
      constraints: { ...noConstraints(), occasion: "wedding" },
    });
    expect(wedding).toContain("cheap-dress");
    expect(wedding).toContain("unknown-attrs");
    expect(wedding).toContain("unenriched");
    expect(wedding).not.toContain("pricey-dress");

    const red = await searchIds(db, {
      constraints: { ...noConstraints(), colorsInclude: ["red"] },
    });
    expect(red).toContain("cheap-dress");
    expect(red).toContain("unknown-attrs");
    expect(red).not.toContain("pricey-dress");
  });

  it("color exclusion drops stated matches and keeps unknowns", async () => {
    const ids = await searchIds(db, {
      constraints: { ...noConstraints(), colorsExclude: ["black"] },
    });
    expect(ids).not.toContain("pricey-dress");
    expect(ids).toContain("unknown-attrs");
    expect(ids).toContain("unenriched");
  });

  it("tiers unknown-color hits below known matches and flags them (YOY-67 AC-5)", async () => {
    await seed(db, [
      {
        productId: "cs-known-blue",
        title: "Constraint Fixture Known",
        enrichment: { colors: ["blue"] },
      },
      {
        productId: "cs-unknown-a",
        title: "Constraint Fixture Unknown A",
        enrichment: { colors: [] },
      },
    ]);

    const result = await createPgTrgmClassicStore(db).search({
      storeId: SHOP,
      constraints: {
        category: undefined,
        priceMin: undefined,
        priceMax: undefined,
        colorsInclude: ["blue"],
        colorsExclude: [],
        occasion: undefined,
        availableOnly: false,
      },
      limit: 50,
    });

    const ids = result.hits.map((hit) => hit.productId);
    // productId order alone would put cs-known-blue after unenriched seeds
    // from other tests; the color tier overrides it: every known match
    // before every unknown-passes hit, each tier ordered by productId.
    const knownIndex = ids.indexOf("cs-known-blue");
    const unknownIndex = ids.indexOf("cs-unknown-a");
    expect(knownIndex).toBeGreaterThanOrEqual(0);
    expect(unknownIndex).toBeGreaterThanOrEqual(0);
    expect(knownIndex).toBeLessThan(unknownIndex);
    const byId = new Map(result.hits.map((hit) => [hit.productId, hit]));
    expect(byId.get("cs-known-blue")!.colorUnknown).toBe(false);
    expect(byId.get("cs-unknown-a")!.colorUnknown).toBe(true);
  });

  it("tiers and flags unknowns under an exclusion-only color constraint too (YOY-67 AC-5 fix round 1)", async () => {
    await seed(db, [
      {
        productId: "cs-excl-known-red",
        title: "Exclusion Fixture Known",
        enrichment: { colors: ["red"] },
      },
      {
        productId: "cs-excl-unknown",
        title: "Exclusion Fixture Unknown",
        enrichment: { colors: [] },
      },
    ]);

    const result = await createPgTrgmClassicStore(db).search({
      storeId: SHOP,
      constraints: {
        category: undefined,
        priceMin: undefined,
        priceMax: undefined,
        colorsInclude: [],
        colorsExclude: ["black"],
        occasion: undefined,
        availableOnly: false,
      },
      limit: 50,
    });

    const ids = result.hits.map((hit) => hit.productId);
    const knownIndex = ids.indexOf("cs-excl-known-red");
    const unknownIndex = ids.indexOf("cs-excl-unknown");
    expect(knownIndex).toBeGreaterThanOrEqual(0);
    expect(unknownIndex).toBeGreaterThanOrEqual(0);
    expect(knownIndex).toBeLessThan(unknownIndex);
    const byId = new Map(result.hits.map((hit) => [hit.productId, hit]));
    expect(byId.get("cs-excl-known-red")!.colorUnknown).toBe(false);
    expect(byId.get("cs-excl-unknown")!.colorUnknown).toBe(true);
  });

  it("scores every constraint-only hit 0, ordered deterministically", async () => {
    const result = await createPgTrgmClassicStore(db).search({
      storeId: SHOP,
      constraints: noConstraints(),
    });
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.score).toBe(0);
    }
    const ids = result.hits.map((hit) => hit.productId);
    expect(ids).toEqual([...ids].sort());
  });

  it("combines query text with constraints as filters, not preferences", async () => {
    const ids = await searchIds(db, {
      query: "dress",
      constraints: { ...noConstraints(), priceMax: 400 },
    });
    expect(ids).toContain("cheap-dress");
    expect(ids).not.toContain("pricey-dress");
  });
});

describe("zero AI calls and index usage (AC-1, AC-5)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db, [
      { productId: "nike", title: "Nike Air Max 90", productType: "Sneakers" },
      { productId: "aurora", title: "Aurora Maxi Dress", productType: "Dresses" },
    ]);
  });

  it("a classic search writes no AiCall rows (AC-5)", async () => {
    await searchIds(db, { query: "nkie air max" });
    await searchIds(db, { constraints: { ...noConstraints(), priceMax: 400 } });
    expect(await db.aiCall.count()).toBe(0);
  });

  it("the trigram index serves the classic search predicate (AC-1)", async () => {
    // The trigram predicate exactly as every classic search emits it. The
    // fixture table is tiny, so the planner is steered off the always-cheaper
    // scans that hide which index the predicate would use at scale.
    await db.$queryRawUnsafe(`SET enable_seqscan = off`);
    try {
      const plan = (
        await db.$queryRawUnsafe<Array<Record<string, string>>>(
          `EXPLAIN SELECT p."productId" FROM "CatalogProduct" p WHERE $1 <% ${SEARCH_TEXT}`,
          "nike air max 90",
        )
      )
        .map((row) => Object.values(row).join(" "))
        .join("\n");
      expect(plan).toContain("CatalogProduct_search_text_trgm_idx");
    } finally {
      await db.$queryRawUnsafe(`RESET enable_seqscan`);
    }
  });
});

describe("the full match set, uncapped (YOY-107 AC-1)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    // Comfortably more than the retired 10-result default, so a surviving
    // cap anywhere on this path would show up as a short list.
    await seed(
      db,
      Array.from({ length: 25 }, (_, index) => ({
        productId: `dress-${String(index).padStart(2, "0")}`,
        title: `Aurora Dress ${index}`,
        productType: "Dresses",
      })),
    );
  });

  it("returns every keyword match when the request carries no limit", async () => {
    const ids = await searchIds(db, { query: "dress" });
    expect(ids).toHaveLength(25);
  });

  it("returns every constraint-only match when the request carries no limit", async () => {
    const ids = await searchIds(db, {
      constraints: { ...noConstraints(), priceMax: 1000 },
    });
    expect(ids).toHaveLength(25);
  });

  it("still honors an explicit limit, and its page is the top of the same ranking", async () => {
    // Close matches are the caller that still states a cap (AC-5).
    const capped = await searchIds(db, { query: "dress", limit: 10 });
    const full = await searchIds(db, { query: "dress" });
    expect(capped).toHaveLength(10);
    expect(capped).toEqual(full.slice(0, 10));
  });

  it("rejects a non-positive explicit limit as before", async () => {
    await expect(searchIds(db, { query: "dress", limit: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("one statement per classic search, cards included (YOY-115 AC-1)", () => {
  let db: PrismaClient;
  const statements: string[] = [];
  /** Prisma emits query events after the query resolves; drain them. */
  const settle = () => new Promise<void>((done) => setTimeout(done, 0));
  const startCounting = async (): Promise<void> => {
    await settle();
    statements.length = 0;
  };

  beforeAll(async () => {
    db = await createTestDb({ onQuery: (sql) => statements.push(sql) });
    await seed(db, [
      {
        productId: "nike",
        title: "Nike Air Max 90",
        productType: "Sneakers",
        priceMin: 250,
        priceMax: 300,
        available: false,
      },
      {
        productId: "aurora",
        title: "Aurora Maxi Dress",
        productType: "Dresses",
        enrichment: { colors: ["red"] },
      },
    ]);
  });

  it("a trigram search is exactly one statement — no transaction, no set_config round trip", async () => {
    await startCounting();
    await createPgTrgmClassicStore(db).search({ storeId: SHOP, query: "nkie air max" });
    await settle();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("set_config('pg_trgm.word_similarity_threshold', '0.3', true)");
    expect(statements[0]).toContain("<%");
    expect(statements.some((sql) => /^\s*(BEGIN|COMMIT)/i.test(sql))).toBe(false);
  });

  it("a constraint-only search is exactly one statement too", async () => {
    await startCounting();
    await createPgTrgmClassicStore(db).search({
      storeId: SHOP,
      constraints: { ...noConstraints(), priceMax: 400, colorsExclude: ["black"] },
    });
    await settle();
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("<%");
  });

  it("the statement applies the 0.30 threshold: a two-edit typo still matches", async () => {
    // Under pg_trgm's default 0.6 threshold this typo finds nothing; the
    // in-statement set_config is what makes the GIN scan see 0.3.
    expect(await searchIds(db, { query: "nkie air max" })).toEqual(["nike"]);
  });

  it("returns the card fields on every hit, read in the same statement", async () => {
    await startCounting();
    const result = await createPgTrgmClassicStore(db).search({ storeId: SHOP, query: "nike air max" });
    await settle();
    expect(statements).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      productId: "nike",
      card: {
        title: "Nike Air Max 90",
        url: null,
        imageUrl: null,
        priceMin: 250,
        priceMax: 300,
        currencyCode: "ILS",
        available: false,
      },
    });
    expect(Object.keys(result.hits[0]!.card).sort()).toEqual(
      ["available", "currencyCode", "imageUrl", "priceMax", "priceMin", "title", "url"].sort(),
    );
    expect(result.hits[0]).not.toHaveProperty("colorUnknown");
  });

  it("keeps colour-evidence tiering and the colorUnknown flag beside the card", async () => {
    const result = await createPgTrgmClassicStore(db).search({
      storeId: SHOP,
      constraints: { ...noConstraints(), colorsInclude: ["red"] },
    });
    expect(result.hits.map((hit) => [hit.productId, hit.colorUnknown])).toEqual([
      ["aurora", false],
      ["nike", true],
    ]);
    expect(result.hits[1]!.card.title).toBe("Nike Air Max 90");
  });

  it("the plan runs set_config before the search scan: the threshold row is the outer side of the join", async () => {
    // The whole point of the LATERAL form: the executor must produce the
    // set_config row before it scans CatalogProduct with `<%`, or the GIN
    // scan would read pg_trgm's default 0.6 threshold. The plan shows one
    // Nested Loop whose outer side is the threshold subquery and whose inner
    // side is the search — and the `<%` predicate lives on the inner side.
    const { sql, params } = buildClassicSearchSql({ storeId: SHOP, query: "nike air max 90" });
    const plan = (
      await db.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN ${sql}`, ...params)
    )
      .map((row) => Object.values(row).join(" "))
      .join("\n");
    expect(plan).toContain("Nested Loop");
    const thresholdAt = plan.indexOf("Subquery Scan on s");
    const searchAt = plan.indexOf('on "CatalogProduct" p');
    expect(thresholdAt).toBeGreaterThan(-1);
    expect(searchAt).toBeGreaterThan(thresholdAt);
    expect(plan.slice(searchAt)).toContain("<%");
    // Exactly one statement: the plan tree has one root.
    expect(plan.split("\n").filter((line) => !line.startsWith(" "))).toHaveLength(1);
  });
});
