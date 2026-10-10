import type { PrismaClient } from "@prisma/client";
import type { CostRecorder, EmbeddingClient } from "@unfiltered/engine";
import { beforeEach, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { createTestDb } from "../testing/helpers.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import { createFindStep, type FindStep } from "./find.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
} from "./orchestrator.server";

// Orchestrator tests (YOY-45): the keyword paths (keystroke preview, the
// client-timeout rescue), card hydration and searchId threading, over the
// embedded PGlite database and the real pg_trgm store — zero network calls.
// The find path's ranking, paging and judging live in engine-v2.test.ts,
// judge.test.ts, wishes.test.ts and refinement.test.ts.

const SHOP = "orchestrator-shop.myshopify.com";

interface SeedProduct {
  productId: string;
  title: string;
  handle?: string;
  url?: string | null;
  featuredImageUrl?: string | null;
  priceMin?: number;
  priceMax?: number;
  available?: boolean;
}

async function seed(db: PrismaClient, products: SeedProduct[]): Promise<void> {
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
        priceMax: product.priceMax ?? product.priceMin ?? 100,
        currencyCode: "ILS",
        available: product.available ?? true,
        imageAltTexts: [],
        handle: product.handle ?? `${product.productId}-handle`,
        url:
          product.url === undefined
            ? `https://${SHOP}/products/${product.handle ?? `${product.productId}-handle`}`
            : product.url,
        featuredImageUrl:
          product.featuredImageUrl === undefined
            ? `https://cdn.example.com/${product.productId}.jpg`
            : product.featuredImageUrl,
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: `hash-${product.productId}`,
      },
    });
  }
}

/** A fake embedding port metering each call; every query lands on [1, 0, 0]. */
function fakeEmbeddings(costRecorder?: CostRecorder): EmbeddingClient & { calls: number } {
  const client = {
    dimension: 3,
    calls: 0,
    async embed(request: { texts: string[]; storeId?: string; searchId?: string }) {
      client.calls += 1;
      await costRecorder?.record({
        provider: "google",
        modelId: "gemini-embedding-001",
        operation: "embedding",
        inputTokens: 5,
        outputTokens: 0,
        storeId: request.storeId,
        searchId: request.searchId,
      });
      return request.texts.map(() => [1, 0, 0]);
    },
  };
  return client;
}

/** An orchestrator over the real stores; `find` replaces the real find step. */
function buildOrchestrator(
  db: PrismaClient,
  options: { embeddings?: EmbeddingClient; find?: FindStep } = {},
): SearchOrchestrator {
  const classicStore = createPgTrgmClassicStore(db);
  return createSearchOrchestrator({
    db,
    classicStore,
    find:
      options.find ??
      createFindStep({ db, embeddings: options.embeddings ?? fakeEmbeddings(), classicStore }),
  });
}

describe("keystroke preview (YOY-68 AC-1)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("serves classic-only results with full cards, zero model calls and nothing degraded", async () => {
    await seed(db, [
      {
        productId: "gown-1",
        title: "elegant summer wedding gown",
        handle: "gown-1",
        featuredImageUrl: "https://cdn.example.com/gown-1.jpg",
        priceMin: 250,
        priceMax: 300,
      },
    ]);
    const embeddings = fakeEmbeddings();
    const response = await buildOrchestrator(db, { embeddings }).runSearch({
      query: "elegant summer wedding gown",
      shopDomain: SHOP,
      preview: true,
    });

    expect(response).toMatchObject({
      route: "classic",
      routeReason: "preview",
      degraded: false,
      chips: [],
    });
    expect(response.searchId).not.toBe("");
    expect(response.hits).toEqual([
      {
        productId: "gown-1",
        title: "elegant summer wedding gown",
        url: `https://${SHOP}/products/gown-1`,
        imageUrl: "https://cdn.example.com/gown-1.jpg",
        priceMin: 250,
        priceMax: 300,
        currencyCode: "ILS",
        available: true,
      },
    ]);
    expect(embeddings.calls).toBe(0);
    expect(await db.aiCall.count()).toBe(0);
  });

  it("serves a null featured image as a null imageUrl", async () => {
    await seed(db, [{ productId: "no-image", title: "nike 90", featuredImageUrl: null }]);
    const response = await buildOrchestrator(db).runSearch({
      query: "nike 90",
      shopDomain: SHOP,
      preview: true,
    });
    expect(response.hits[0]!.imageUrl).toBeNull();
  });

  it("stays empty and model-free on zero keyword hits", async () => {
    const embeddings = fakeEmbeddings();
    const response = await buildOrchestrator(db, { embeddings }).runSearch({
      query: "סנובורד כחול",
      shopDomain: SHOP,
      preview: true,
    });
    expect(response).toMatchObject({ route: "classic", routeReason: "preview", hits: [] });
    expect(embeddings.calls).toBe(0);
  });
});

describe("the client-timeout rescue (YOY-96 AC-9)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(
      db,
      Array.from({ length: 30 }, (_, index) => ({
        productId: `d-${String(index).padStart(2, "0")}`,
        title: `Dress ${index}`,
      })),
    );
  });

  it("serves classic keyword results, degraded, with zero model calls", async () => {
    const embeddings = fakeEmbeddings();
    const response = await buildOrchestrator(db, { embeddings }).runSearch({
      query: "dress",
      shopDomain: SHOP,
      forceClassic: true,
      forceClassicReason: "client-timeout-rescue",
    });
    expect(response).toMatchObject({
      route: "classic",
      routeReason: "client-timeout-rescue",
      degraded: true,
      chips: [],
    });
    // The full match set when no limit is set (YOY-107).
    expect(response.hits).toHaveLength(30);
    expect(response.page).toBeUndefined();
    expect(embeddings.calls).toBe(0);
  });

  it("pages by slicing its full result (YOY-145 AC-5)", async () => {
    const orchestrator = buildOrchestrator(db);
    const rescue = { forceClassic: true, forceClassicReason: "client-timeout-rescue" } as const;
    const full = await orchestrator.runSearch({ query: "dress", shopDomain: SHOP, ...rescue });
    const page2 = await orchestrator.runSearch({
      query: "dress",
      shopDomain: SHOP,
      ...rescue,
      // The playground's own cap is dropped for a page: the slice reads the full set.
      limit: 24,
      paging: { page: 2, pageSize: 10 },
    });
    expect(page2).toMatchObject({ page: 2, totalCount: 30 });
    expect(page2.hits.map((hit) => hit.productId)).toEqual(
      full.hits.slice(10, 20).map((hit) => hit.productId),
    );
  });

  it("still honours an explicit limit when unpaged", async () => {
    const response = await buildOrchestrator(db).runSearch({
      query: "dress",
      shopDomain: SHOP,
      forceClassic: true,
      forceClassicReason: "client-timeout-rescue",
      limit: 5,
    });
    expect(response.hits).toHaveLength(5);
  });
});

describe("card hydration publication guard (YOY-72 AC-4)", () => {
  it("excludes non-active and unpublished rows even when the find step hands their ids back", async () => {
    const db = await createTestDb();
    await seed(db, [
      { productId: "published-dress", title: "published dress" },
      { productId: "unpublished-dress", title: "unpublished dress" },
      { productId: "draft-dress", title: "draft dress" },
    ]);
    // Inject the guarded states directly: the real stores never return
    // these rows, so the injection stands in for any future unguarded
    // source handing hydration a bad id.
    await db.catalogProduct.updateMany({
      where: { shopDomain: SHOP, productId: "unpublished-dress" },
      data: { publishedAt: null },
    });
    await db.catalogProduct.updateMany({
      where: { shopDomain: SHOP, productId: "draft-dress" },
      data: { status: "DRAFT" },
    });
    const find: FindStep = {
      find: () =>
        Promise.resolve({
          productIds: ["unpublished-dress", "draft-dress", "published-dress"],
          findSetCount: 3,
          degraded: false,
        }),
    };

    const response = await buildOrchestrator(db, { find }).runSearch({
      query: "dress",
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.hits.map((hit) => hit.productId)).toEqual(["published-dress"]);
  });
});

describe("searchId threading (AC-7)", () => {
  it("threads one generated searchId through every AiCall row of a search", async () => {
    const db = await createTestDb();
    await seed(db, [{ productId: "silk-gown", title: "silk gown" }]);
    const embeddings = fakeEmbeddings(createPrismaCostRecorder(db));

    const response = await buildOrchestrator(db, { embeddings }).runSearch({
      query: "an elegant dress for a summer wedding",
      shopDomain: SHOP,
    });

    const rows = await db.aiCall.findMany();
    expect(rows.map((row) => row.operation)).toEqual(["embedding"]);
    expect(response.searchId).not.toBe("");
    for (const row of rows) {
      expect(row.searchId).toBe(response.searchId);
    }
  });

  it("uses a caller-supplied searchId verbatim", async () => {
    const db = await createTestDb();
    const orchestrator = buildOrchestrator(db);
    for (const request of [
      { query: "nike 90", shopDomain: SHOP, searchId: "caller-search-1" },
      { query: "nike 90", shopDomain: SHOP, searchId: "caller-search-1", preview: true },
    ]) {
      expect((await orchestrator.runSearch(request)).searchId).toBe("caller-search-1");
    }
  });
});

describe("per-stage timing on the keyword paths (YOY-114 AC-1)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db, [{ productId: "sneaker-90", title: "nike 90" }]);
  });

  /** Run one search; every stage is whole, non-negative, and within the wall time. */
  async function timed(
    orchestrator: SearchOrchestrator,
    request: Parameters<SearchOrchestrator["runSearch"]>[0],
  ) {
    const startedAt = performance.now();
    const response = await orchestrator.runSearch(request);
    const wallMs = performance.now() - startedAt;
    for (const ms of Object.values(response.stages)) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(Math.ceil(wallMs));
    }
    return response;
  }

  it("a preview and a rescue ran classic only — no hydrate: the cards ride the one statement (YOY-115 AC-3)", async () => {
    const orchestrator = buildOrchestrator(db);
    const preview = await timed(orchestrator, { query: "nike 90", shopDomain: SHOP, preview: true });
    expect(Object.keys(preview.stages)).toEqual(["classic"]);
    const rescue = await timed(orchestrator, {
      query: "nike 90",
      shopDomain: SHOP,
      forceClassic: true,
      forceClassicReason: "client-timeout-rescue",
    });
    expect(Object.keys(rescue.stages)).toEqual(["classic"]);
    expect(rescue.hits[0]).toMatchObject({ productId: "sneaker-90", title: "nike 90" });
  });

  it("a classic store that returns bare hits still hydrates, with the publication guard (YOY-115 AC-1 fallback)", async () => {
    const classicStore = createPgTrgmClassicStore(db);
    const orchestrator = createSearchOrchestrator({
      db,
      classicStore: {
        async search() {
          return { hits: [{ productId: "sneaker-90", score: 1 }] };
        },
      },
      find: createFindStep({ db, embeddings: fakeEmbeddings(), classicStore }),
    });
    const response = await timed(orchestrator, { query: "nike 90", shopDomain: SHOP, preview: true });
    expect(Object.keys(response.stages)).toEqual(["classic", "hydrate"]);
    expect(response.hits[0]).toMatchObject({ productId: "sneaker-90", title: "nike 90" });
  });
});
