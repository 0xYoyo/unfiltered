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
        shopDomain: request.shopDomain,
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
        shopDomain: request.shopDomain,
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
