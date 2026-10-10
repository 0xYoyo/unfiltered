import type { PrismaClient } from "@prisma/client";
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
  /** Product-family key (YOY-117); "" (the default) is its own family. */
  familyKey?: string;
  shopDomain?: string;
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
        familyKey: product.familyKey ?? "",
        imageAltTexts: product.imageAltTexts ?? [],
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: `hash-${product.productId}`,
      },
    });
  }
}

async function searchIds(
  db: PrismaClient,
  request: {
    query?: string;
    shopDomain?: string;
    limit?: number;
  },
): Promise<string[]> {
  const result = await createPgTrgmClassicStore(db).search({
    storeId: request.shopDomain ?? SHOP,
    query: request.query,
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

describe("one hit per product family (YOY-117 AC-2)", () => {
  let db: PrismaClient;
  const FAMILY = "eval|rib knit top|tops";

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db, [
      { productId: "rib-black", title: "Rib Knit Top in Black", familyKey: FAMILY },
      { productId: "rib-navy", title: "Rib Knit Top in Navy", familyKey: FAMILY },
      { productId: "rib-pink", title: "Rib Knit Top in Pink", familyKey: FAMILY },
      { productId: "knit-dress", title: "Rib Knit Dress", familyKey: "eval|rib knit dress|dresses" },
      // Empty keys: own families, never collapsed together.
      { productId: "legacy-a", title: "Knit Scarf" },
      { productId: "legacy-b", title: "Knit Beanie" },
    ]);
  });

  it("keyword mode returns one member per family — the best-ranked", async () => {
    const ids = await searchIds(db, { query: "rib knit top" });
    const family = ids.filter((id) => id.startsWith("rib-"));
    expect(family).toHaveLength(1);
    expect(ids).toContain("knit-dress");
  });

  it("a search with no query text collapses too, counts families in a limited page, and keeps empty keys apart", async () => {
    const all = await searchIds(db, {});
    expect(all.filter((id) => id.startsWith("rib-"))).toHaveLength(1);
    expect(all).toContain("legacy-a");
    expect(all).toContain("legacy-b");
    // With no query text the order is by productId, so the family's
    // representative (its best-ranked member, "rib-black") is the fourth
    // family: a page of four holds it exactly once and no sibling.
    const page = await searchIds(db, { limit: 4 });
    expect(page).toEqual(["knit-dress", "legacy-a", "legacy-b", "rib-black"]);
  });

  it("keeps the card shape on every hit", async () => {
    const result = await createPgTrgmClassicStore(db).search({
      storeId: SHOP,
      query: "rib knit top",
    });
    expect(Object.keys(result.hits[0]!).sort()).toEqual(["card", "productId", "score"]);
    expect(Object.keys(result.hits[0]!.card).sort()).toEqual(
      ["available", "currencyCode", "imageUrl", "priceMax", "priceMin", "title", "url"],
    );
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
    await searchIds(db, {});
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

  it("returns every product of the store when the request carries neither query nor limit", async () => {
    const ids = await searchIds(db, {});
    expect(ids).toHaveLength(25);
  });

  it("still honors an explicit limit, and its page is the top of the same ranking", async () => {
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
  /**
   * Bounded wait for the query events of the statements just run: Prisma
   * emits them asynchronously after the promise resolves, and on a loaded
   * CI runner a single setTimeout(0) was not always enough (PR #115's gate
   * flaked on it). Waits until at least `min` events arrived or 2 s passed
   * — the deadline guards against a hang, and the assertion that follows
   * still requires exactly one statement.
   */
  const drained = async (min: number): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (statements.length < min && Date.now() < deadline) {
      await new Promise<void>((done) => setTimeout(done, 5));
    }
    await settle();
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
      },
    ]);
  });

  it("a trigram search is exactly one statement — no transaction, no set_config round trip", async () => {
    await startCounting();
    await createPgTrgmClassicStore(db).search({ storeId: SHOP, query: "nkie air max" });
    await drained(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("set_config('pg_trgm.word_similarity_threshold', '0.3', true)");
    expect(statements[0]).toContain("<%");
    expect(statements.some((sql) => /^\s*(BEGIN|COMMIT)/i.test(sql))).toBe(false);
  });

  it("a search with no query text is exactly one statement too", async () => {
    await startCounting();
    await createPgTrgmClassicStore(db).search({ storeId: SHOP });
    await drained(1);
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
    await drained(1);
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
