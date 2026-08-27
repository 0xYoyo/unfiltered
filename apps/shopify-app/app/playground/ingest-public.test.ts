import type { PrismaClient } from "@prisma/client";
import type {
  EmbeddingClient,
  EmbeddingRequest,
  LlmClient,
  StructuredCompletionRequest,
} from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import type { ImageFetch } from "../catalog/images.server";
import { mapProductNode } from "../catalog/mapping.server";
import { productNode } from "../catalog/mapping.test";
import type { FakeRoute } from "../testing/fake-store.server";
import { createFakeStore } from "../testing/fake-store.server";
import { createTestDb } from "../testing/helpers.server";
import type { CatalogSource, SourceProduct } from "./catalog-source.server";
import {
  FIXTURE_INGESTABLE_IDS,
  FIXTURE_META,
  FIXTURE_ORIGIN,
  FIXTURE_PAGE_1,
  FIXTURE_PAGE_2,
} from "./fixtures/shopify-public-products";
import {
  deletePublicCatalog,
  ingestPublicCatalog,
  isValidCatalogSlug,
  mapSourceProduct,
  playgroundStoreKey,
} from "./ingest-public.server";
import { createPoliteFetch } from "./polite-fetch.server";
import {
  createShopifyPublicSource,
  PRODUCTS_JSON_PAGE_SIZE,
} from "./shopify-public-source.server";

// Generic public-catalog pipeline (YOY-88 AC-1/AC-3/AC-7) on the embedded
// PGlite DB with fixture feed pages, a fixture LLM, and fixture vectors —
// zero network, zero AI calls, and the AiCall ledger proves it.

const OTHER_SHOP = "other-shop.myshopify.com";
const DIMENSION = 3;

/** Fixture LLM: deterministic attributes, metered like the real adapter. */
function llmStub(db: PrismaClient) {
  const calls: StructuredCompletionRequest[] = [];
  const recorder = createPrismaCostRecorder(db);
  const llm: LlmClient = {
    async completeStructured(request) {
      calls.push(request);
      await recorder.record({
        provider: "google",
        modelId: "gemini-3.5-flash-lite",
        operation: request.operation,
        inputTokens: 100,
        outputTokens: 20,
        storeId: request.storeId,
      });
      return {
        category: "dress",
        colors: ["black"],
        primaryColor: "black",
        occasions: ["evening"],
        fit: "regular",
        styleTags: ["elegant"],
        seasons: ["summer"],
      };
    },
  };
  return { llm, calls };
}

/** Fixture embeddings: char-code vectors, metered like the real adapter. */
function embeddingStub(db: PrismaClient) {
  const calls: EmbeddingRequest[] = [];
  const recorder = createPrismaCostRecorder(db);
  const embeddings: EmbeddingClient = {
    dimension: DIMENSION,
    async embed(request) {
      calls.push(request);
      await recorder.record({
        provider: "google",
        modelId: "gemini-embedding-001",
        operation: request.operation ?? "embedding",
        inputTokens: 10 * request.texts.length,
        outputTokens: 0,
        storeId: request.storeId,
      });
      return request.texts.map((text) =>
        Array.from({ length: DIMENSION }, (_, axis) => {
          let value = 1;
          for (const char of text) {
            value = (value * 31 + char.charCodeAt(0) * (axis + 1)) % 997;
          }
          return value / 997 + 0.001;
        }),
      );
    },
  };
  return { embeddings, calls };
}

const page = (n: number) => `/products.json?limit=${PRODUCTS_JSON_PAGE_SIZE}&page=${n}`;

function fixtureSource(pages: unknown[][] = [FIXTURE_PAGE_1, FIXTURE_PAGE_2]) {
  const routes: Record<string, FakeRoute> = { "/robots.txt": "", "/meta.json": FIXTURE_META };
  pages.forEach((products, index) => {
    routes[page(index + 1)] = { products };
  });
  routes[page(pages.length + 1)] = { products: [] };
  const store = createFakeStore(routes);
  return {
    store,
    source: createShopifyPublicSource({
      storeUrl: FIXTURE_ORIGIN,
      fetch: createPoliteFetch({ contactUrl: "https://playground.example", fetch: store.fetch }),
    }),
  };
}

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.aiCall.deleteMany();
  await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
  await db.productEnrichment.deleteMany();
  await db.productImage.deleteMany();
  await db.catalogProduct.deleteMany();
  await db.playgroundCatalog.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

const embeddingRows = (storeKey: string) =>
  db.$queryRawUnsafe<Array<{ productId: string }>>(
    `SELECT "productId" FROM "ProductEmbedding" WHERE "shopDomain" = $1 ORDER BY "productId"`,
    storeKey,
  );

/**
 * Offline image bytes (YOY-120): deterministic bytes per URL, and a log of
 * every image request so a re-run can prove it fetched nothing.
 */
function imageStub() {
  const calls: string[] = [];
  const fetchImage: ImageFetch = async (url) => {
    calls.push(url);
    return new Response(new TextEncoder().encode(`bytes:${url}`));
  };
  return { fetchImage, calls };
}

async function runDemo(source: CatalogSource, maxProducts = 2000) {
  const { llm, calls: llmCalls } = llmStub(db);
  const { embeddings, calls: embedCalls } = embeddingStub(db);
  const images = imageStub();
  const result = await ingestPublicCatalog({
    db,
    slug: "demo",
    name: "Demo Store",
    source,
    sourceUrl: FIXTURE_ORIGIN,
    maxProducts,
    llm,
    embeddings,
    imageFetch: images.fetchImage,
  });
  return { result, llmCalls, embedCalls, imageCalls: images.calls };
}

describe("slug and store key (AC-1)", () => {
  it("accepts [a-z0-9-]{1,40} and derives playground:<slug>", () => {
    expect(isValidCatalogSlug("demo-store-1")).toBe(true);
    expect(isValidCatalogSlug("Demo")).toBe(false);
    expect(isValidCatalogSlug("a".repeat(41))).toBe(false);
    expect(isValidCatalogSlug("")).toBe(false);
    expect(playgroundStoreKey("demo")).toBe("playground:demo");
    expect(() => playgroundStoreKey("Bad Slug")).toThrow(/invalid playground catalog slug/);
  });
});

describe("mapping (AC-3)", () => {
  it("maps a source product to a snapshot row with the shared content hash", () => {
    const now = new Date("2026-08-17T12:00:00Z");
    const product: SourceProduct = {
      sourceId: "42",
      title: "T",
      description: "D",
      tags: ["b", "a"],
      vendor: "V",
      productType: "P",
      priceMin: 1,
      priceMax: 2,
      currencyCode: "ILS",
      available: true,
      imageAltTexts: ["x"],
      imageUrl: "https://img",
      imageUrls: ["https://img", "https://img2", "https://img3", "https://img4", "https://img5"],
      url: "https://store/products/t",
      sourceUpdatedAt: null,
    };
    const row = mapSourceProduct(product, now);
    // Image URLs ride beside the row (YOY-120), never on it.
    expect(row).not.toHaveProperty("imageUrls");
    expect(row).toMatchObject({
      productId: "42",
      handle: "",
      featuredImageUrl: "https://img",
      url: "https://store/products/t",
      publishedAt: now,
      sourceUpdatedAt: now,
    });
    // Same searchable content as a Shopify node → same hash: enrichment and
    // embedding caching are keyed identically for both ingestion paths.
    const shopifyRow = mapProductNode(
      productNode({
        id: "42",
        title: "T",
        description: "D",
        tags: ["b", "a"],
        vendor: "V",
        productType: "P",
        priceRangeV2: {
          minVariantPrice: { amount: "1", currencyCode: "ILS" },
          maxVariantPrice: { amount: "2", currencyCode: "ILS" },
        },
        variants: { nodes: [{ availableForSale: true }] },
        images: { nodes: [{ altText: "x" }] },
      }),
    );
    expect(row.contentHash).toBe(shopifyRow.contentHash);
  });
});

describe("pipeline (AC-3, AC-7)", () => {
  it("creates the catalog under playground:<slug>, enriches, embeds, and registers it (verify step 2)", async () => {
    const { result, llmCalls, embedCalls } = await runDemo(fixtureSource().source);
    expect(result.storeKey).toBe("playground:demo");
    expect(result.ingest).toEqual({
      created: 3,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      skippedOverMax: 0,
      // Gift card (no price) and the untitled product.
      skippedInvalid: 2,
      // 7001 lists three images, 7003 one (YOY-120).
      images: { fetched: 4, unchanged: 0, failed: 0 },
    });
    expect(result.enrich).toEqual({ enriched: 3, cached: 0, failed: 0 });
    expect(result.embed).toEqual({ embedded: 3, cached: 0, deleted: 0 });
    expect(llmCalls).toHaveLength(3);
    expect(llmCalls.every((call) => call.storeId === "playground:demo")).toBe(true);
    expect(embedCalls.length).toBeGreaterThan(0);

    const rows = await db.catalogProduct.findMany({
      where: { shopDomain: "playground:demo" },
      orderBy: { productId: "asc" },
    });
    expect(rows.map((row) => row.productId)).toEqual(FIXTURE_INGESTABLE_IDS);
    for (const row of rows) {
      expect(row.status).toBe("ACTIVE");
      expect(row.publishedAt).not.toBeNull();
      expect(row.handle).toBe("");
      expect(row.url).toMatch(new RegExp(`^${FIXTURE_ORIGIN}/products/`));
    }
    expect(rows[0]).toMatchObject({
      title: "Black Evening Dress",
      priceMin: 599,
      priceMax: 649,
      currencyCode: "ILS",
      available: true,
      featuredImageUrl: `${FIXTURE_ORIGIN}/cdn/black-dress-front.jpg`,
      url: `${FIXTURE_ORIGIN}/products/black-evening-dress`,
      description: "An elegant black dress. Perfect for evenings & galas. Silk",
    });

    const registry = await db.playgroundCatalog.findUniqueOrThrow({ where: { slug: "demo" } });
    expect(registry).toMatchObject({
      name: "Demo Store",
      storeKey: "playground:demo",
      sourceUrl: FIXTURE_ORIGIN,
      sourceKind: "shopify-public",
      productCount: 3,
    });
    expect(registry.lastIngestedAt).not.toBeNull();
    // Every AI call of the run is metered under the catalog's tenant key.
    const ledger = await db.aiCall.findMany({ where: { shopDomain: "playground:demo" } });
    expect(ledger.length).toBe(llmCalls.length + embedCalls.length);
  });

  it("captures up to four images per product through the given fetcher, hashed, and re-uses them on a re-run (YOY-120 AC-1, AC-2)", async () => {
    const first = await runDemo(fixtureSource().source);
    // 7001 lists three images, 7003 one; the rest none.
    expect(first.result.ingest.images).toEqual({ fetched: 4, unchanged: 0, failed: 0 });
    expect(first.imageCalls).toHaveLength(4);
    const stored = await db.productImage.findMany({ where: { shopDomain: "playground:demo" }, orderBy: [{ productId: "asc" }, { position: "asc" }] });
    expect(stored.map((row) => [row.productId, row.position])).toEqual([["7001", 0], ["7001", 1], ["7001", 2], ["7003", 0]]);
    expect(stored[0]).toMatchObject({ url: `${FIXTURE_ORIGIN}/cdn/black-dress-front.jpg` });
    for (const row of stored) {
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }

    const second = await runDemo(fixtureSource().source);
    expect(second.result.ingest.images).toEqual({ fetched: 0, unchanged: 4, failed: 0 });
    expect(second.imageCalls).toEqual([]);
  });

  it("re-running over an unchanged source reports unchanged/cached and makes zero AI calls (verify step 3)", async () => {
    await runDemo(fixtureSource().source);
    const before = await db.aiCall.count();
    const { result, llmCalls, embedCalls } = await runDemo(fixtureSource().source);
    expect(result.ingest).toMatchObject({ created: 0, updated: 0, unchanged: 3, deleted: 0 });
    expect(result.enrich).toEqual({ enriched: 0, cached: 3, failed: 0 });
    expect(result.embed).toEqual({ embedded: 0, cached: 3, deleted: 0 });
    expect(llmCalls).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
    expect(await db.aiCall.count()).toBe(before);
    expect(
      (await db.playgroundCatalog.findUniqueOrThrow({ where: { slug: "demo" } })).productCount,
    ).toBe(3);
  });

  it("a product gone from the source is deleted with its enrichment and embedding rows; a changed one is updated and re-enriched (verify step 4)", async () => {
    await runDemo(fixtureSource().source);
    const changedDress = {
      ...FIXTURE_PAGE_1[0],
      title: "Black Evening Dress — new edition",
    };
    // Page 2 loses the sneaker (7003); the dress changes.
    const { result, llmCalls } = await runDemo(
      fixtureSource([[changedDress, FIXTURE_PAGE_1[1]], [FIXTURE_PAGE_2[1], FIXTURE_PAGE_2[2]]]).source,
    );
    expect(result.ingest).toMatchObject({ created: 0, updated: 1, unchanged: 1, deleted: 1 });
    expect(result.enrich).toEqual({ enriched: 1, cached: 1, failed: 0 });
    expect(llmCalls).toHaveLength(1);
    const ids = (
      await db.catalogProduct.findMany({ where: { shopDomain: "playground:demo" } })
    ).map((row) => row.productId);
    expect(ids.sort()).toEqual(["7001", "7002"]);
    expect(
      await db.productEnrichment.findMany({ where: { shopDomain: "playground:demo", productId: "7003" } }),
    ).toEqual([]);
    expect((await embeddingRows("playground:demo")).map((row) => row.productId)).toEqual([
      "7001",
      "7002",
    ]);
    expect(
      (await db.playgroundCatalog.findUniqueOrThrow({ where: { slug: "demo" } })).productCount,
    ).toBe(2);
  });

  it("refreshes a drifted display-only field without dirtying the hash or re-enriching", async () => {
    await runDemo(fixtureSource().source);
    const movedImage = {
      ...FIXTURE_PAGE_1[0],
      images: [{ src: `${FIXTURE_ORIGIN}/cdn/new-front.jpg`, alt: "Front view" }, ...FIXTURE_PAGE_1[0].images.slice(1)],
    };
    const { result, llmCalls } = await runDemo(
      fixtureSource([[movedImage, FIXTURE_PAGE_1[1]], FIXTURE_PAGE_2]).source,
    );
    expect(result.ingest).toMatchObject({ updated: 0, unchanged: 3 });
    expect(llmCalls).toHaveLength(0);
    const row = await db.catalogProduct.findUniqueOrThrow({
      where: { shopDomain_productId: { shopDomain: "playground:demo", productId: "7001" } },
    });
    expect(row.featuredImageUrl).toBe(`${FIXTURE_ORIGIN}/cdn/new-front.jpg`);
  });

  it("truncates at maxProducts and counts the overflow and the invalid products (AC-7)", async () => {
    // Fixture pages hold 5 products; --max 1 keeps only the first page's
    // first product and never fetches page 2.
    const { store, source } = fixtureSource();
    const { result } = await runDemo(source, 1);
    expect(result.ingest).toMatchObject({ created: 1, skippedOverMax: 1, skippedInvalid: 0 });
    expect(store.requests.map((r) => new URL(r.url).search)).not.toContain(
      `?limit=${PRODUCTS_JSON_PAGE_SIZE}&page=2`,
    );
    expect(await db.catalogProduct.count({ where: { shopDomain: "playground:demo" } })).toBe(1);
  });

  it("deletes one catalog's rows across all four tables and nothing else (verify step 7)", async () => {
    await runDemo(fixtureSource().source);
    // Another tenant's rows must survive untouched.
    await db.catalogProduct.create({
      data: { shopDomain: OTHER_SHOP, ...mapProductNode(productNode({ id: "gid://shopify/Product/9" })) },
    });
    await db.productEnrichment.create({
      data: {
        shopDomain: OTHER_SHOP,
        productId: "gid://shopify/Product/9",
        contentHash: "h",
        status: "failed",
      },
    });
    const otherRegistry = await db.playgroundCatalog.create({
      data: {
        slug: "other",
        name: "Other",
        storeKey: "playground:other",
        sourceUrl: "https://other.example",
        sourceKind: "shopify-public",
      },
    });

    const deleted = await deletePublicCatalog({ db, slug: "demo" });
    expect(deleted).toEqual({
      storeKey: "playground:demo",
      products: 3,
      enrichments: 3,
      embeddings: 3,
      images: 4,
      registry: 1,
    });
    expect(await db.catalogProduct.count({ where: { shopDomain: "playground:demo" } })).toBe(0);
    expect(await db.productEnrichment.count({ where: { shopDomain: "playground:demo" } })).toBe(0);
    expect(await embeddingRows("playground:demo")).toEqual([]);
    expect(await db.playgroundCatalog.findUnique({ where: { slug: "demo" } })).toBeNull();

    expect(await db.catalogProduct.count({ where: { shopDomain: OTHER_SHOP } })).toBe(1);
    expect(await db.productEnrichment.count({ where: { shopDomain: OTHER_SHOP } })).toBe(1);
    expect(await db.playgroundCatalog.findUnique({ where: { id: otherRegistry.id } })).not.toBeNull();
    // Image rows (YOY-120) go with the catalog; the other tenant's stay.
    expect(await db.productImage.count({ where: { shopDomain: "playground:demo" } })).toBe(0);

  });
});
