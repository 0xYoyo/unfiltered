import { createHmac } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  createIntentExtractor,
  createQueryClassifier,
  createRetriever,
  type CostRecorder,
  type EmbeddingClient,
  type LlmClient,
  type StructuredCompletionRequest,
} from "@unfiltered/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route the whole app (shopify.server included) at a throwaway test DB.
vi.mock("./db.server", async () => {
  const { createTestDb } = await import("./testing/helpers.server");
  return { default: await createTestDb() };
});

// Replace only the production orchestrator factory (which needs
// GEMINI_API_KEY and the network); each test installs its own build over
// fake AI clients. Parsing and serialization stay the real implementations.
const orchestratorSeam = vi.hoisted(() => ({
  build: undefined as ((db: PrismaClient) => unknown) | undefined,
}));
vi.mock("./search/proxy.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./search/proxy.server")>();
  return {
    ...original,
    createProxySearchOrchestrator: (db: PrismaClient) => {
      if (orchestratorSeam.build === undefined) {
        throw new Error("test installed no orchestrator");
      }
      return orchestratorSeam.build(db);
    },
  };
});

import db from "./db.server";
import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import { action } from "./routes/apps.unfiltered.search";
import { createPgTrgmClassicStore } from "./search/classic-store.server";
import { createSearchOrchestrator } from "./search/orchestrator.server";
import { createPgVectorRetrievalStore } from "./search/retrieval-store.server";

// Route tests for the app-proxy search endpoint (YOY-46): signed requests
// built exactly the way Shopify signs proxy requests (HMAC-SHA256 over the
// sorted query params with the API secret), the real orchestrator over fake
// LLM/embedding clients, and the embedded PGlite database — zero network.

const SHOP = "proxy-shop.myshopify.com";

/** A query the routing heuristics cannot settle, so the model decides. */
const AI_QUERY = "elegant dress for a summer wedding";

/** The intent the fake model extracts for AI_QUERY (wire format). */
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

/** The exact top-level response keys of the contract (AC-3/AC-5). */
const CONTRACT_KEYS = [
  "chips",
  "degraded",
  "intent",
  "results",
  "route",
  "searchId",
];
const CONTRACT_KEYS_WITH_CLOSE_MATCHES = [...CONTRACT_KEYS, "closeMatches"]
  .slice()
  .sort();

/** The exact keys of one result card on the wire. */
const RESULT_KEYS = [
  "available",
  "currencyCode",
  "handle",
  "imageUrl",
  "priceMax",
  "priceMin",
  "productId",
  "title",
];

/**
 * Build a Request signed the way Shopify signs app proxy requests: the
 * signature is HMAC-SHA256 (hex) of the sorted `key=value` concatenation of
 * every query param except `signature`, keyed with the app's API secret.
 */
function proxyRequest({
  payload,
  shop = SHOP,
  secret = process.env.SHOPIFY_API_SECRET ?? "",
  omitSignature = false,
}: {
  payload: unknown;
  shop?: string;
  secret?: string;
  omitSignature?: boolean;
}): Request {
  const params = new URLSearchParams({
    shop,
    path_prefix: "/apps/unfiltered",
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  const data = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  if (!omitSignature) {
    params.set(
      "signature",
      createHmac("sha256", secret).update(data).digest("hex"),
    );
  }
  return new Request(
    `https://test-app.example.com/apps/unfiltered/search?${params}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    },
  );
}

const actionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as never;

interface SeedProduct {
  productId: string;
  title: string;
  vector?: number[];
  occasions?: string[];
  category?: string | null;
}

async function seed(products: SeedProduct[]): Promise<void> {
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
        priceMin: 100,
        priceMax: 100,
        currencyCode: "ILS",
        available: true,
        imageAltTexts: [],
        handle: `${product.productId}-handle`,
        featuredImageUrl: `https://cdn.example.com/${product.productId}.jpg`,
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: `hash-${product.productId}`,
      },
    });
    if (product.category !== undefined) {
      await db.productEnrichment.create({
        data: {
          shopDomain: SHOP,
          productId: product.productId,
          contentHash: `hash-${product.productId}`,
          status: "enriched",
          category: product.category,
          colors: [],
          occasions: product.occasions ?? [],
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

function fakeEmbeddings(options?: { costRecorder?: CostRecorder }): EmbeddingClient {
  return {
    dimension: 3,
    async embed(request) {
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

/** Install a real orchestrator over the given fakes as the route's seam. */
function installOrchestrator(options: {
  llm: LlmClient;
  embeddings?: EmbeddingClient;
}): void {
  orchestratorSeam.build = (routeDb) =>
    createSearchOrchestrator({
      db: routeDb as PrismaClient,
      classifier: createQueryClassifier({ llm: options.llm, timeoutMs: 500 }),
      extractor: createIntentExtractor({ llm: options.llm }),
      retriever: createRetriever({
        embeddings: options.embeddings ?? fakeEmbeddings(),
        store: createPgVectorRetrievalStore(routeDb as PrismaClient),
      }),
      classicStore: createPgTrgmClassicStore(routeDb as PrismaClient),
    });
}

beforeEach(async () => {
  orchestratorSeam.build = () => {
    throw new Error("search ran before authentication");
  };
  await db.aiCall.deleteMany();
  await db.productEnrichment.deleteMany();
  await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
  await db.catalogProduct.deleteMany();
});

describe("app proxy authentication (AC-2)", () => {
  it("rejects a request with no signature and never constructs a search", async () => {
    const response = await action(
      actionArgs(
        proxyRequest({ payload: { query: "shoes", sessionId: "s1" }, omitSignature: true }),
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("rejects a request signed with the wrong secret and never constructs a search", async () => {
    const response = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "shoes", sessionId: "s1" },
          secret: "not-the-app-secret",
        }),
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("takes the shop from the verified proxy params, ignoring any shop in the body", async () => {
    await seed([{ productId: "boot-1", title: "leather boots" }]);
    installOrchestrator({ llm: fakeLlm({}) });

    const response = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: "leather boots",
            sessionId: "s1",
            shopDomain: "evil-shop.myshopify.com",
            shop: "evil-shop.myshopify.com",
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // Results exist only under the signed shop's catalog, so serving them
    // proves retrieval keyed on the verified params, not the body.
    expect(body.results.map((r: { productId: string }) => r.productId)).toEqual(
      ["boot-1"],
    );
  });
});

describe("request validation", () => {
  it("rejects a body without query or sessionId", async () => {
    installOrchestrator({ llm: fakeLlm({}) });
    for (const payload of [
      {},
      { query: "shoes" },
      { query: "", sessionId: "s1" },
      { sessionId: "s1" },
      "not an object",
    ]) {
      const response = await action(actionArgs(proxyRequest({ payload })));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    }
  });

  it("rejects a chip removal without a previous intent", async () => {
    installOrchestrator({ llm: fakeLlm({}) });
    const response = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: "shoes",
            sessionId: "s1",
            removeChip: { field: "occasion", value: "wedding" },
          },
        }),
      ),
    );
    expect(response.status).toBe(400);
  });
});

describe("the response contract (AC-3, AC-5)", () => {
  it("serves a classic query with exactly the contract's keys and nothing more", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    installOrchestrator({ llm: fakeLlm({}) }); // heuristics settle; any LLM call throws

    const response = await action(
      actionArgs(proxyRequest({ payload: { query: "nike 90", sessionId: "s1" } })),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.route).toBe("classic");
    expect(body.degraded).toBe(false);
    expect(body.chips).toEqual([]);
    expect(body.intent).toBeNull();
    expect(typeof body.searchId).toBe("string");
    expect(body.results).toEqual([
      {
        productId: "sneaker-90",
        title: "nike 90",
        handle: "sneaker-90-handle",
        imageUrl: "https://cdn.example.com/sneaker-90.jpg",
        priceMin: 100,
        priceMax: 100,
        currencyCode: "ILS",
        available: true,
      },
    ]);
    expect(Object.keys(body.results[0]).sort()).toEqual(RESULT_KEYS);
  });

  it("serves an AI query with chips and the resolved intent for the client to echo", async () => {
    await seed([
      {
        productId: "silk-gown",
        title: "silk gown",
        vector: [0.9, 0.1, 0],
        category: "dress",
        occasions: ["wedding"],
      },
    ]);
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
      }),
    });

    const response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "s1" } })),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.route).toBe("ai");
    expect(body.degraded).toBe(false);
    expect(body.results.map((r: { productId: string }) => r.productId)).toEqual(
      ["silk-gown"],
    );
    expect(body.chips).toEqual([
      { field: "category", value: "dress" },
      { field: "occasion", value: "wedding" },
    ]);
    // The echoed intent is the full wire shape the client sends back as-is.
    expect(body.intent).toEqual(DRESS_INTENT);
  });

  it("keeps the degraded path on the exact contract shape with no internal error details", async () => {
    await seed([{ productId: "silk-gown", title: "silk gown elegant" }]);
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => {
          throw new Error("secret-internal-failure-detail");
        },
      }),
    });

    const response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "s1" } })),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.route).toBe("classic");
    expect(body.degraded).toBe(true);
    expect(body.chips).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("secret-internal-failure");
  });

  it("carries closeMatches on AI zero-hit responses, still within the contract", async () => {
    await seed([
      {
        productId: "linen-shirt",
        title: "elegant summer dress shirt",
        category: "shirt",
      },
    ]);
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT, // category "dress": nothing matches
      }),
    });

    const response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "s1" } })),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS_WITH_CLOSE_MATCHES);
    expect(body.results).toEqual([]);
    expect(body.chips.length).toBeGreaterThan(0);
    expect(
      body.closeMatches.map((r: { productId: string }) => r.productId),
    ).toEqual(["linen-shirt"]);
    expect(Object.keys(body.closeMatches[0]).sort()).toEqual(RESULT_KEYS);
  });
});

describe("chip removal (AC-4)", () => {
  it("recomputes without the removed constraint, drops its chip, and makes zero LLM calls", async () => {
    await seed([
      {
        productId: "wedding-gown",
        title: "wedding gown",
        vector: [0.9, 0.1, 0],
        category: "dress",
        occasions: ["wedding"],
      },
      {
        productId: "day-dress",
        title: "day dress",
        vector: [0.8, 0.2, 0],
        category: "dress",
        occasions: [],
      },
    ]);
    // Any classification or intent call throws AND would write a ledger row;
    // embeddings are allowed and metered through the real cost recorder.
    const costRecorder = createPrismaCostRecorder(db);
    installOrchestrator({
      llm: fakeLlm({ costRecorder }),
      embeddings: fakeEmbeddings({ costRecorder }),
    });

    const response = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: AI_QUERY,
            sessionId: "s1",
            previousIntent: DRESS_INTENT,
            removeChip: { field: "occasion", value: "wedding" },
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.route).toBe("ai");
    expect(body.degraded).toBe(false);
    // The occasion constraint is gone: the non-wedding dress now qualifies.
    expect(
      body.results.map((r: { productId: string }) => r.productId).sort(),
    ).toEqual(["day-dress", "wedding-gown"]);
    // Its chip is gone with it.
    expect(body.chips).toEqual([{ field: "category", value: "dress" }]);
    expect(body.intent.occasion).toBeNull();
    expect(body.intent.category).toBe("dress");

    // AC-4's no-LLM property, verified against the ledger itself.
    const rows = await db.aiCall.findMany({
      where: { searchId: body.searchId },
    });
    expect(
      rows.filter((row) =>
        ["classification", "intent"].includes(row.operation),
      ),
    ).toEqual([]);
  });
});
