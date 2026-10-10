import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import {
  createFindStep,
  DEFAULT_FIND_SET_SIZE,
  findSetSizeFromEnv,
  mergeFindOrder,
  STRONG_TITLE_SCORE,
} from "./find.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
} from "./orchestrator.server";
import { serializeProxySearchResponse } from "./proxy.server";

// The find step and server-side pages (YOY-145) on the embedded
// PGlite database: the real card-index query and the real pg_trgm store,
// a fake embedding client whose every query lands on [1, 0, 0]. A card
// vector [1, y, 0] is farther from the query the larger y is, so vector
// order is set by `y` alone.

const SHOP = "engine-v2-shop.myshopify.com";
const DIMENSION = 3;

interface Product {
  productId: string;
  title: string;
  /** Card-vector distance knob; no card vector when absent. */
  y?: number;
  familyKey?: string;
  available?: boolean;
  priceMin?: number;
  status?: string;
  publishedAt?: Date | null;
}

async function seed(db: PrismaClient, products: Product[]): Promise<void> {
  for (const product of products) {
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: product.productId,
        title: product.title,
        description: "",
        tags: [],
        vendor: "fixture",
        productType: "",
        priceMin: product.priceMin ?? 100,
        priceMax: product.priceMin ?? 100,
        currencyCode: "USD",
        available: product.available ?? true,
        status: product.status ?? "ACTIVE",
        publishedAt: product.publishedAt === undefined ? new Date() : product.publishedAt,
        familyKey: product.familyKey ?? "",
        imageAltTexts: [],
        sourceUpdatedAt: new Date(),
        contentHash: `hash-${product.productId}`,
      },
    });
    if (product.y !== undefined) {
      await db.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, 'prose', 'h', $4::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
        randomUUID(),
        SHOP,
        product.productId,
        `[1,${product.y},0]`,
      );
    }
  }
}

/** A fake embedding port counting its calls; `fail` makes every call reject. */
function fakeEmbeddings(options: { fail?: boolean } = {}): EmbeddingClient & { calls: number } {
  const client = {
    dimension: DIMENSION,
    calls: 0,
    async embed(request: { texts: string[] }) {
      client.calls += 1;
      if (options.fail === true) {
        throw new Error("embedding backend unavailable");
      }
      return request.texts.map(() => [1, 0, 0]);
    },
  };
  return client;
}

describe("the find step's merge order (AC-2)", () => {
  it("leads with strong title matches, then vector order, then the remaining keyword matches", () => {
    const merged = mergeFindOrder(
      ["v1", "v2", "k-weak"],
      [
        { productId: "k-strong", score: STRONG_TITLE_SCORE },
        { productId: "k-weak", score: 0.5 },
        { productId: "k-beyond", score: 0.4 },
        { productId: "v2", score: 0.95 },
      ],
    );
    // v2 is a strong title match, so it leads alongside k-strong in keyword
    // order; k-weak keeps its vector place; k-beyond follows the find set.
    expect(merged).toEqual(["k-strong", "v2", "v1", "k-weak", "k-beyond"]);
  });

  it("is the keyword order alone when the vector half has nothing", () => {
    expect(
      mergeFindOrder([], [
        { productId: "a", score: 0.5 },
        { productId: "b", score: 0.95 },
      ]),
    ).toEqual(["b", "a"]);
  });
});

describe("FIND_SET_SIZE (AC-1)", () => {
  it("defaults to 150 and rejects a malformed value", () => {
    expect(findSetSizeFromEnv({})).toBe(DEFAULT_FIND_SET_SIZE);
    expect(DEFAULT_FIND_SET_SIZE).toBe(150);
    expect(findSetSizeFromEnv({ FIND_SET_SIZE: "40" })).toBe(40);
    expect(() => findSetSizeFromEnv({ FIND_SET_SIZE: "0" })).toThrow(/FIND_SET_SIZE/);
    expect(() => findSetSizeFromEnv({ FIND_SET_SIZE: "1.5" })).toThrow(/FIND_SET_SIZE/);
  });
});

describe("the find step on the database", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
    await db.catalogProduct.deleteMany();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const findStep = (embeddings: EmbeddingClient, findSetSize?: number) =>
    createFindStep({
      db,
      embeddings,
      classicStore: createPgTrgmClassicStore(db),
      ...(findSetSize !== undefined ? { findSetSize } : {}),
    });

  const find = (embeddings: EmbeddingClient, query: string, findSetSize?: number) =>
    findStep(embeddings, findSetSize).find({ shopDomain: SHOP, query, searchId: "s-1" });

  function orchestrator(embeddings: EmbeddingClient): SearchOrchestrator {
    return createSearchOrchestrator({
      db,
      classicStore: createPgTrgmClassicStore(db),
      find: findStep(embeddings),
    });
  }

  it("ranks an exact-title match first, ahead of every nearer vector hit", async () => {
    await seed(db, [
      { productId: "near-1", title: "Flowing Linen Shirt", y: 0.1 },
      { productId: "near-2", title: "Cotton Wrap Top", y: 0.2 },
      { productId: "aurora", title: "Aurora Midi Dress", y: 0.9 },
    ]);
    const embeddings = fakeEmbeddings();
    const result = await find(embeddings, "Aurora Midi Dress");
    expect(result.productIds[0]).toBe("aurora");
    expect(result.productIds).toEqual(["aurora", "near-1", "near-2"]);
    expect(result.degraded).toBe(false);
    // One vector for the raw sentence (AC-1).
    expect(embeddings.calls).toBe(1);
  });

  it("leads a descriptive query with the vector hits, keyword-only matches after the find set", async () => {
    await seed(db, [
      { productId: "v-near", title: "Silk Slip Gown", y: 0.1 },
      { productId: "v-mid", title: "Chiffon Maxi", y: 0.3 },
      { productId: "v-far", title: "Velvet Blazer", y: 0.8 },
      // A keyword match outside the two-product find set.
      { productId: "kw-only", title: "Evening Party Clutch" },
    ]);
    const result = await find(fakeEmbeddings(), "something for an evening party", 2);
    expect(result.productIds).toEqual(["v-near", "v-mid", "kw-only"]);
  });

  it("removes nothing but store, active and published: no stock, price or category filter (AC-3)", async () => {
    await seed(db, [
      // A stated wish (in stock, under a budget) never filters these out
      // of the find set; the find step keeps both.
      { productId: "sold-out", title: "Sold Out Dress", y: 0.1, available: false },
      { productId: "pricey", title: "Couture Dress", y: 0.2, priceMin: 99_999 },
      { productId: "draft", title: "Draft Dress", y: 0.05, status: "DRAFT" },
      { productId: "unpublished", title: "Hidden Dress", y: 0.06, publishedAt: null },
    ]);
    const result = await find(fakeEmbeddings(), "dress under 50 in stock");
    expect(result.productIds).toEqual(expect.arrayContaining(["sold-out", "pricey"]));
    expect(result.productIds).not.toContain("draft");
    expect(result.productIds).not.toContain("unpublished");
  });

  it("serves one colourway per family across the vector and keyword halves", async () => {
    await seed(db, [
      { productId: "rose-red", title: "Rose Dress Red", y: 0.1, familyKey: "rose" },
      // No card vector: found by keyword only, but its family is already in.
      { productId: "rose-blue", title: "Rose Dress Blue", familyKey: "rose" },
      { productId: "other", title: "Lily Skirt", y: 0.2 },
    ]);
    const result = await find(fakeEmbeddings(), "rose dress");
    expect(result.productIds.filter((id) => id.startsWith("rose-"))).toHaveLength(1);
    expect(result.productIds).toContain("other");
  });

  it("serves the keyword order, degraded, when the embedding call fails (AC-8)", async () => {
    await seed(db, [
      { productId: "near", title: "Plain Tee", y: 0.1 },
      { productId: "kw", title: "Wool Coat", y: 0.9 },
    ]);
    const result = await find(fakeEmbeddings({ fail: true }), "wool coat");
    // No vector half, no find set: every page is keyword order (YOY-147 AC-10).
    expect(result).toEqual({ productIds: ["kw"], findSetCount: 0, degraded: true });

    const response = await orchestrator(fakeEmbeddings({ fail: true })).runSearch({
      query: "wool coat",
      shopDomain: SHOP,
    });
    expect(response.degraded).toBe(true);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["kw"]);
    expect(serializeProxySearchResponse(response).results).toHaveLength(1);
  });

  it("pages on the server: page 2 starts where page 1 ended, totalCount stable (AC-4)", async () => {
    await seed(
      db,
      Array.from({ length: 30 }, (_, index) => ({
        productId: `p-${String(index).padStart(2, "0")}`,
        title: `Product ${index}`,
        y: index / 10,
      })),
    );
    const engine = orchestrator(fakeEmbeddings());
    const page1 = await engine.runSearch({
      query: "something",
      shopDomain: SHOP,
      paging: { page: 1, pageSize: 24 },
    });
    const page2 = await engine.runSearch({
      query: "something",
      shopDomain: SHOP,
      paging: { page: 2, pageSize: 24 },
    });
    expect(page1.hits).toHaveLength(24);
    expect(page2.hits).toHaveLength(6);
    expect(page1.hits.at(-1)!.productId).toBe("p-23");
    expect(page2.hits[0]!.productId).toBe("p-24");
    expect([page1.totalCount, page2.totalCount]).toEqual([30, 30]);
    expect([page1.page, page2.page]).toEqual([1, 2]);

    // No page parameters: the first page of 24.
    const unpaged = await engine.runSearch({ query: "something", shopDomain: SHOP });
    expect(unpaged.hits).toHaveLength(24);
    expect(unpaged).toMatchObject({ page: 1, totalCount: 30 });

    const body = serializeProxySearchResponse(page2);
    expect(body).toMatchObject({ page: 2, totalCount: 30 });
    expect(body.results).toHaveLength(6);
  });

  it("answers with no chips, no close matches and a find stage when no judge or extraction is wired (AC-7, AC-11)", async () => {
    await seed(db, [{ productId: "a", title: "Linen Shirt", y: 0.1 }]);
    const embeddings = fakeEmbeddings();
    const response = await orchestrator(embeddings).runSearch({
      query: "long sleeve linen",
      shopDomain: SHOP,
    });
    // No judge wired here: the page is served in find order. It still went
    // through find, so the route is ai (YOY-157 AC-23).
    expect(response).toMatchObject({
      route: "ai",
      routeReason: "find-only",
      chips: [],
      degraded: false,
      extractionInTime: false,
    });
    expect(response.stages.find).toBeGreaterThanOrEqual(0);
    // No judge, no extraction: the query vector is the only model call.
    expect(embeddings.calls).toBe(1);
    const body = serializeProxySearchResponse(response);
    expect(body.chips).toEqual([]);
    expect(body).not.toHaveProperty("closeMatches");
  });

  it("keeps keystroke previews free of embedding calls and untouched by paging (AC-9)", async () => {
    await seed(db, [{ productId: "a", title: "Wool Coat", y: 0.1 }]);
    const embeddings = fakeEmbeddings();
    const response = await orchestrator(embeddings).runSearch({
      query: "wool",
      shopDomain: SHOP,
      preview: true,
      paging: { page: 1, pageSize: 24 },
    });
    expect(response.routeReason).toBe("preview");
    expect(response.hits.map((hit) => hit.productId)).toEqual(["a"]);
    // The preview is untouched by paging too: no page keys.
    expect(response.page).toBeUndefined();
    expect(embeddings.calls).toBe(0);
  });
});
