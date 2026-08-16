import type { PrismaClient } from "@prisma/client";
import {
  createIntentExtractor,
  createQueryClassifier,
  createRetriever,
  type CostRecorder,
  type EmbeddingClient,
  type LlmClient,
  type RetrievalStore,
  type StructuredCompletionRequest,
} from "@unfiltered/engine";
import { beforeEach, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { createTestDb } from "../testing/helpers.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
} from "./orchestrator.server";
import { createPgVectorRetrievalStore } from "./retrieval-store.server";

// Orchestrator tests (YOY-45): real engine pieces (classifier, extractor,
// retriever) over fake LLM/embedding clients and the embedded PGlite
// database, so every fallback edge is exercised through the same code paths
// production takes — zero network calls.

const SHOP = "orchestrator-shop.myshopify.com";

/** A query the routing heuristics cannot settle, so the model decides. */
const AI_QUERY = "elegant dress for a summer wedding";

/** The intent the fake model extracts for AI_QUERY. */
const DRESS_INTENT = {
  category: "dress",
  priceMin: null,
  priceMax: null,
  currency: null,
  colorsInclude: [],
  colorsExclude: [],
  occasion: "wedding",
  size: null,
  availabilityRequired: false,
  softAttributes: ["elegant", "summer"],
};

interface SeedProduct {
  productId: string;
  title: string;
  handle?: string;
  featuredImageUrl?: string | null;
  vector?: number[];
  priceMin?: number;
  priceMax?: number;
  available?: boolean;
  enrichment?: {
    category?: string | null;
    colors?: string[];
    occasions?: string[];
  } | null;
}

async function seed(db: PrismaClient, products: SeedProduct[]): Promise<void> {
  for (const [index, product] of products.entries()) {
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
        featuredImageUrl:
          product.featuredImageUrl === undefined
            ? `https://cdn.example.com/${product.productId}.jpg`
            : product.featuredImageUrl,
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: `hash-${product.productId}`,
      },
    });
    if (product.enrichment !== null && product.enrichment !== undefined) {
      await db.productEnrichment.create({
        data: {
          shopDomain: SHOP,
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
    if (product.vector !== undefined) {
      await db.$executeRawUnsafe(
        `INSERT INTO "ProductEmbedding"
           ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::vector(${product.vector.length}), CURRENT_TIMESTAMP)`,
        `embedding-${index}-${product.productId}`,
        SHOP,
        product.productId,
        `hash-${product.productId}`,
        `[${product.vector.join(",")}]`,
      );
    }
  }
}

/** Fake LLM port: classification and intent answers (or failures) per test. */
function fakeLlm(handlers: {
  classification?: (request: StructuredCompletionRequest) => unknown;
  intent?: (request: StructuredCompletionRequest) => unknown;
  costRecorder?: CostRecorder;
}): LlmClient {
  return {
    async completeStructured(request) {
      await handlers.costRecorder?.record({
        provider: "google",
        modelId:
          request.operation === "intent"
            ? "gemini-3.6-flash"
            : "gemini-3.5-flash-lite",
        operation: request.operation,
        inputTokens: 10,
        outputTokens: 5,
        storeId: request.storeId,
        searchId: request.searchId,
      });
      const handler =
        request.operation === "classification"
          ? handlers.classification
          : handlers.intent;
      if (handler === undefined) {
        throw new Error(`unexpected ${request.operation} call`);
      }
      return handler(request);
    },
  };
}

function fakeEmbeddings(options?: {
  fail?: boolean;
  costRecorder?: CostRecorder;
}): EmbeddingClient {
  return {
    dimension: 3,
    async embed(request) {
      if (options?.fail) {
        throw new Error("embedding backend unavailable");
      }
      await options?.costRecorder?.record({
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
}

/** Assemble an orchestrator from real engine pieces over the given fakes. */
function buildOrchestrator(
  db: PrismaClient,
  options: {
    llm: LlmClient;
    embeddings?: EmbeddingClient;
    retrievalStore?: RetrievalStore;
  },
): SearchOrchestrator {
  return createSearchOrchestrator({
    db,
    classifier: createQueryClassifier({ llm: options.llm, timeoutMs: 500 }),
    extractor: createIntentExtractor({ llm: options.llm }),
    retriever: createRetriever({
      embeddings: options.embeddings ?? fakeEmbeddings(),
      store: options.retrievalStore ?? createPgVectorRetrievalStore(db),
    }),
    classicStore: createPgTrgmClassicStore(db),
  });
}

describe("routing and the single response shape (AC-1, AC-2, AC-3)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("serves a heuristic classic route from the keyword engine with full cards and no chips", async () => {
    await seed(db, [
      {
        productId: "sneaker-90",
        title: "nike 90",
        handle: "nike-90",
        featuredImageUrl: "https://cdn.example.com/nike-90.jpg",
        priceMin: 250,
        priceMax: 300,
      },
    ]);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({}), // heuristics settle; any LLM call would throw
    });

    const response = await orchestrator.runSearch({
      query: "nike 90",
      shopDomain: SHOP,
    });

    expect(response.route).toBe("classic");
    expect(response.routeReason).toBe("sku-pattern");
    expect(response.degraded).toBe(false);
    expect(response.chips).toEqual([]);
    expect(response.closeMatches).toEqual([]);
    expect(response.intent).toBeNull();
    expect(response.searchId).not.toBe("");
    expect(response.hits).toEqual([
      {
        productId: "sneaker-90",
        title: "nike 90",
        handle: "nike-90",
        imageUrl: "https://cdn.example.com/nike-90.jpg",
        priceMin: 250,
        priceMax: 300,
        currencyCode: "ILS",
        available: true,
        colorUnknown: false,
      },
    ]);
  });

  it("runs an AI-routed query through intent → retrieval and returns ranked cards with chips", async () => {
    await seed(db, [
      {
        productId: "silk-gown",
        title: "silk gown",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "dress", occasions: ["wedding"] },
      },
      {
        productId: "linen-dress",
        title: "linen dress",
        vector: [0.5, 0.5, 0],
        enrichment: { category: "dress", occasions: ["wedding"] },
      },
    ]);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
      }),
    });

    const response = await orchestrator.runSearch({
      query: AI_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.routeReason).toBe("model");
    expect(response.degraded).toBe(false);
    expect(response.hits.map((hit) => hit.productId)).toEqual([
      "silk-gown",
      "linen-dress",
    ]);
    expect(response.hits[0]!.imageUrl).toBe(
      "https://cdn.example.com/silk-gown.jpg",
    );
    expect(response.chips).toEqual([
      { field: "category", value: "dress" },
      { field: "occasion", value: "wedding" },
    ]);
    expect(response.intent).not.toBeNull();
    expect(response.closeMatches).toEqual([]);
  });

  it("hydrates a null featured image as a null imageUrl", async () => {
    await seed(db, [
      { productId: "no-image", title: "nike 90", featuredImageUrl: null },
    ]);
    const orchestrator = buildOrchestrator(db, { llm: fakeLlm({}) });

    const response = await orchestrator.runSearch({
      query: "nike 90",
      shopDomain: SHOP,
    });

    expect(response.hits[0]!.imageUrl).toBeNull();
  });
});

describe("silent fallback ladder (AC-4)", () => {
  let db: PrismaClient;

  beforeEach(async () => {
    db = await createTestDb();
    // The classic keyword floor every failure lands on.
    await seed(db, [
      { productId: "fallback-dress", title: AI_QUERY },
    ]);
  });

  /** Every AC-4 failure must resolve to exactly this response. */
  async function expectDegradedClassic(
    orchestrator: SearchOrchestrator,
  ): Promise<void> {
    const response = await orchestrator.runSearch({
      query: AI_QUERY,
      shopDomain: SHOP,
    });
    expect(response.route).toBe("classic");
    expect(response.degraded).toBe(true);
    expect(response.chips).toEqual([]);
    expect(response.closeMatches).toEqual([]);
    expect(response.hits.map((hit) => hit.productId)).toEqual([
      "fallback-dress",
    ]);
  }

  it("classifier failure → classic results, degraded, no chips", async () => {
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => {
          throw new Error("classifier backend down");
        },
      }),
    });
    await expectDegradedClassic(orchestrator);
  });

  it("intent LLM error → classic results, degraded, no chips", async () => {
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => {
          throw new Error("intent backend timed out");
        },
      }),
    });
    await expectDegradedClassic(orchestrator);
  });

  it("IntentExtractionError (schema violation twice) → classic results, degraded", async () => {
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => ({ not: "an intent" }),
      }),
    });
    await expectDegradedClassic(orchestrator);
  });

  it("embedding failure → classic results, degraded, no chips", async () => {
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
      }),
      embeddings: fakeEmbeddings({ fail: true }),
    });
    await expectDegradedClassic(orchestrator);
  });

  it("retrieval store error → classic results, degraded, no chips", async () => {
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
      }),
      retrievalStore: {
        async query() {
          throw new Error("vector store unreachable");
        },
      },
    });
    await expectDegradedClassic(orchestrator);
  });
});

describe("constraint-only fallback keeps the chips (AC-5)", () => {
  it("EmptyQueryTextError → constraint-only classic results WITH chips, not degraded", async () => {
    const db = await createTestDb();
    await seed(db, [
      {
        productId: "affordable-ivory",
        title: "plain fixture",
        priceMin: 200,
        enrichment: { colors: ["ivory"] },
      },
      {
        productId: "black-one",
        title: "plain fixture",
        priceMin: 200,
        enrichment: { colors: ["black"] },
      },
      {
        productId: "too-pricey",
        title: "plain fixture",
        priceMin: 900,
        enrichment: { colors: ["ivory"] },
      },
    ]);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        // "not black under ₪400": constraints only, nothing to embed.
        intent: () => ({
          ...DRESS_INTENT,
          category: null,
          occasion: null,
          colorsExclude: ["black"],
          priceMax: 400,
          softAttributes: [],
        }),
      }),
    });

    const response = await orchestrator.runSearch({
      query: "לא שחור מתחת ל-400 שקל בבקשה תודה",
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.degraded).toBe(false);
    expect(response.hits.map((hit) => hit.productId)).toEqual([
      "affordable-ivory",
    ]);
    expect(response.chips).toEqual([
      { field: "priceMax", value: "400" },
      { field: "colorsExclude", value: "black" },
    ]);
    expect(response.closeMatches).toEqual([]);
  });
});

describe("AI zero-hits keep chips and offer close matches (AC-6)", () => {
  it("returns chips, empty hits, and classic close matches on the raw query", async () => {
    const db = await createTestDb();
    await seed(db, [
      // Keyword-matches the raw query, but its enrichment category fails the
      // intent's hard "dress" constraint, so retrieval returns nothing.
      {
        productId: "wedding-coat",
        title: AI_QUERY,
        vector: [1, 0, 0],
        enrichment: { category: "coat", occasions: ["wedding"] },
      },
    ]);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
      }),
    });

    const response = await orchestrator.runSearch({
      query: AI_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.degraded).toBe(false);
    expect(response.hits).toEqual([]);
    expect(response.chips).toEqual([
      { field: "category", value: "dress" },
      { field: "occasion", value: "wedding" },
    ]);
    expect(response.closeMatches.map((hit) => hit.productId)).toEqual([
      "wedding-coat",
    ]);
  });
});

describe("zero-hit close matches fall back to relaxed vector retrieval (YOY-52 AC-16)", () => {
  /** The live-run shape: a Hebrew query against an EN catalog. */
  const HEBREW_QUERY = "שמלת כלה ורודה אלגנטית";
  const PINK_DRESS_INTENT = {
    ...DRESS_INTENT,
    colorsInclude: ["pink"],
    softAttributes: ["elegant"],
  };

  /** Embedding client that counts embed() calls, answering a fixed vector. */
  function countingEmbeddings() {
    let calls = 0;
    const embeddings: EmbeddingClient = {
      dimension: 3,
      async embed(request) {
        calls += 1;
        return request.texts.map(() => [1, 0, 0]);
      },
    };
    return { embeddings, embedCalls: () => calls };
  }

  it("serves category-relaxed close matches when keyword backfill is empty, with no extra embedding call", async () => {
    const db = await createTestDb();
    await seed(db, [
      // Both dresses state a non-pink color, so the colorsInclude constraint
      // excludes them from primary hits; the Hebrew query matches no EN text,
      // so classic keyword backfill is empty too.
      {
        productId: "black-gown",
        title: "Black Evening Gown",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "dress", colors: ["black"], occasions: ["wedding"] },
      },
      {
        productId: "ivory-dress",
        title: "Ivory Maxi Dress",
        vector: [0.8, 0.2, 0],
        enrichment: { category: "dress", colors: ["ivory"], occasions: [] },
      },
      // Same-shop non-dress with an embedding: category relaxation must
      // still respect the category, so this never appears at rung one.
      {
        productId: "wool-coat",
        title: "Wool Winter Coat",
        vector: [1, 0, 0],
        enrichment: { category: "coat", colors: [], occasions: [] },
      },
    ]);
    const counting = countingEmbeddings();
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => PINK_DRESS_INTENT,
      }),
      embeddings: counting.embeddings,
    });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.degraded).toBe(false);
    expect(response.hits).toEqual([]);
    expect(response.chips.length).toBeGreaterThan(0);
    // Close matches came from vector retrieval with only the category kept:
    // nearest dress first, the coat excluded.
    expect(response.closeMatches.map((hit) => hit.productId)).toEqual([
      "black-gown",
      "ivory-dress",
    ]);
    // The relaxed re-query reused the cached query embedding.
    expect(counting.embedCalls()).toBe(1);
  });

  it("falls to fully unconstrained retrieval when the category itself matches nothing", async () => {
    const db = await createTestDb();
    await seed(db, [
      // No dress anywhere: rung one (category kept) finds nothing, rung two
      // (unconstrained embedding-nearest) rescues with what exists.
      {
        productId: "wool-coat",
        title: "Wool Winter Coat",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "coat", colors: [], occasions: [] },
      },
    ]);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => PINK_DRESS_INTENT,
      }),
    });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
    });

    expect(response.hits).toEqual([]);
    expect(response.closeMatches.map((hit) => hit.productId)).toEqual([
      "wool-coat",
    ]);
  });

  it("leaves close matches empty — not degraded — when even relaxed retrieval finds nothing", async () => {
    const db = await createTestDb();
    // Empty catalog: nothing to rescue with; the zero-hit contract holds.
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => PINK_DRESS_INTENT,
      }),
    });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.degraded).toBe(false);
    expect(response.hits).toEqual([]);
    expect(response.closeMatches).toEqual([]);
  });
});

describe("classic zero hits escalate once into the AI path (YOY-67 AC-3)", () => {
  /** The live-run row f9b8d67c shape: the MODEL routes a Hebrew query
   * classic; trigram has nothing on an EN-only catalog. */
  const HEBREW_QUERY = "סנובורד כחול";
  const BLUE_DRESS_INTENT = {
    ...DRESS_INTENT,
    occasion: null,
    colorsInclude: ["blue"],
    softAttributes: [],
  };

  const seedBlueDress = (db: PrismaClient) =>
    seed(db, [
      {
        productId: "blue-dress",
        title: "The Blue Dress",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "dress", colors: ["blue"] },
      },
    ]);

  it("model-decided classic with zero keyword hits serves AI hits under reason classic-zero-hit", async () => {
    const db = await createTestDb();
    await seedBlueDress(db);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "classic" }),
        intent: () => BLUE_DRESS_INTENT,
      }),
    });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.routeReason).toBe("classic-zero-hit");
    expect(response.degraded).toBe(false);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["blue-dress"]);
    expect(response.chips).toEqual([
      { field: "category", value: "dress" },
      { field: "colorsInclude", value: "blue" },
    ]);
  });

  it("heuristic classic with zero keyword hits escalates the same way", async () => {
    const db = await createTestDb();
    await seedBlueDress(db);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        // Heuristics settle "vintage board" (short-query): no classification
        // call happens, so only the escalation's intent handler is needed.
        intent: () => BLUE_DRESS_INTENT,
      }),
    });

    const response = await orchestrator.runSearch({
      query: "vintage board",
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.routeReason).toBe("classic-zero-hit");
    expect(response.hits.map((hit) => hit.productId)).toEqual(["blue-dress"]);
  });

  it("does not escalate when classic finds hits", async () => {
    const db = await createTestDb();
    await seed(db, [{ productId: "sneaker-90", title: "nike 90" }]);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({}), // any LLM call would throw
    });

    const response = await orchestrator.runSearch({
      query: "nike 90",
      shopDomain: SHOP,
    });

    expect(response.route).toBe("classic");
    expect(response.routeReason).toBe("sku-pattern");
    expect(response.hits).toHaveLength(1);
  });

  it("does not escalate a throttled response: forced classic stays LLM-free", async () => {
    const db = await createTestDb();
    // Empty catalog: zero classic hits, yet no escalation may happen — the
    // fake would throw on any LLM call.
    const orchestrator = buildOrchestrator(db, { llm: fakeLlm({}) });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
      forceClassic: true,
    });

    expect(response.route).toBe("classic");
    expect(response.routeReason).toBe("throttled");
    expect(response.degraded).toBe(true);
    expect(response.hits).toEqual([]);
  });

  it("does not escalate a degraded classic response: a failing model is not asked to rescue its own zero hits", async () => {
    const db = await createTestDb();
    // Empty catalog: zero classic hits. The classifier failed (model-error),
    // so the response is already degraded — and a degraded classic must
    // never escalate, even though the intent handler stands ready to answer.
    let intentCalls = 0;
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => {
          throw new Error("classifier down");
        },
        intent: () => {
          intentCalls += 1;
          return DRESS_INTENT;
        },
      }),
    });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("classic");
    expect(response.routeReason).toBe("model-error");
    expect(response.degraded).toBe(true);
    expect(response.hits).toEqual([]);
    expect(intentCalls).toBe(0);
  });

  it("degrades back to the empty classic response when the escalation's intent call fails", async () => {
    const db = await createTestDb();
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "classic" }),
        intent: () => {
          throw new Error("extractor down");
        },
      }),
    });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("classic");
    expect(response.routeReason).toBe("classic-zero-hit");
    expect(response.degraded).toBe(true);
    expect(response.hits).toEqual([]);
    expect(response.chips).toEqual([]);
  });

  it("an escalation landing on AI zero hits keeps chips and close matches without re-escalating", async () => {
    const db = await createTestDb();
    await seed(db, [
      // Vector-near but fails the blue constraint: primary hits stay empty,
      // and the relaxed ladder rescues it as a close match.
      {
        productId: "red-dress",
        title: "The Red Dress",
        vector: [0.8, 0.2, 0],
        enrichment: { category: "dress", colors: ["red"] },
      },
    ]);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "classic" }),
        intent: () => BLUE_DRESS_INTENT,
      }),
    });

    const response = await orchestrator.runSearch({
      query: HEBREW_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.routeReason).toBe("classic-zero-hit");
    expect(response.degraded).toBe(false);
    expect(response.hits).toEqual([]);
    expect(response.chips.length).toBeGreaterThan(0);
    expect(response.closeMatches.map((hit) => hit.productId)).toEqual([
      "red-dress",
    ]);
  });
});

describe("card hydration publication guard (YOY-72 AC-4)", () => {
  it("excludes non-active and unpublished rows even when a store hands their ids back", async () => {
    const db = await createTestDb();
    await seed(db, [
      { productId: "published-dress", title: "published dress" },
      { productId: "unpublished-dress", title: "unpublished dress" },
      { productId: "draft-dress", title: "draft dress" },
    ]);
    // Inject the guarded states directly: production stores never return
    // these rows, so the injection stands in for any future unguarded
    // consumer handing hydration a bad id.
    await db.catalogProduct.updateMany({
      where: { shopDomain: SHOP, productId: "unpublished-dress" },
      data: { publishedAt: null },
    });
    await db.catalogProduct.updateMany({
      where: { shopDomain: SHOP, productId: "draft-dress" },
      data: { status: "DRAFT" },
    });

    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
      }),
      retrievalStore: {
        async query() {
          return [
            { productId: "unpublished-dress", distance: 0.1 },
            { productId: "draft-dress", distance: 0.2 },
            { productId: "published-dress", distance: 0.3 },
          ];
        },
      },
    });

    const response = await orchestrator.runSearch({
      query: AI_QUERY,
      shopDomain: SHOP,
    });

    expect(response.route).toBe("ai");
    expect(response.hits.map((hit) => hit.productId)).toEqual([
      "published-dress",
    ]);
  });
});

describe("keystroke preview (YOY-68 AC-1)", () => {
  it("serves classic-only results with zero LLM calls and nothing degraded", async () => {
    const db = await createTestDb();
    await seed(db, [
      { productId: "gown-1", title: "elegant summer wedding gown" },
    ]);
    // An AI-shaped query (long natural language, no SKU): without preview
    // the classifier would be asked — and this fake throws on any LLM call,
    // so passing proves none happened.
    const orchestrator = buildOrchestrator(db, { llm: fakeLlm({}) });

    const response = await orchestrator.runSearch({
      query: "elegant summer wedding gown",
      shopDomain: SHOP,
      preview: true,
    });

    expect(response.route).toBe("classic");
    expect(response.routeReason).toBe("preview");
    expect(response.degraded).toBe(false);
    expect(response.chips).toEqual([]);
    expect(response.closeMatches).toEqual([]);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["gown-1"]);
  });

  it("does not escalate a preview on zero classic hits: mid-keystroke emptiness stays LLM-free", async () => {
    const db = await createTestDb();
    // Empty catalog: zero classic hits, yet no zero-hit escalation may fire
    // — the fake would throw on any LLM call.
    const orchestrator = buildOrchestrator(db, { llm: fakeLlm({}) });

    const response = await orchestrator.runSearch({
      query: "סנובורד כחול",
      shopDomain: SHOP,
      preview: true,
    });

    expect(response.route).toBe("classic");
    expect(response.routeReason).toBe("preview");
    expect(response.degraded).toBe(false);
    expect(response.hits).toEqual([]);
  });
});

describe("searchId threading (AC-7)", () => {
  it("threads one generated searchId through every AiCall row of an AI search", async () => {
    const db = await createTestDb();
    await seed(db, [
      {
        productId: "silk-gown",
        title: "silk gown",
        vector: [0.9, 0.1, 0],
        enrichment: { category: "dress", occasions: ["wedding"] },
      },
    ]);
    const costRecorder = createPrismaCostRecorder(db);
    const orchestrator = buildOrchestrator(db, {
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
        costRecorder,
      }),
      embeddings: fakeEmbeddings({ costRecorder }),
    });

    const response = await orchestrator.runSearch({
      query: AI_QUERY,
      shopDomain: SHOP,
    });

    const rows = await db.aiCall.findMany();
    expect(rows.map((row) => row.operation).sort()).toEqual([
      "classification",
      "embedding",
      "intent",
    ]);
    expect(response.searchId).not.toBe("");
    for (const row of rows) {
      expect(row.searchId).toBe(response.searchId);
    }
  });

  it("uses a caller-supplied searchId verbatim", async () => {
    const db = await createTestDb();
    const orchestrator = buildOrchestrator(db, { llm: fakeLlm({}) });

    const response = await orchestrator.runSearch({
      query: "nike 90",
      shopDomain: SHOP,
      searchId: "caller-search-1",
    });

    expect(response.searchId).toBe("caller-search-1");
  });
});
