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
// fake AI clients, threaded through the REAL getProxySearchOrchestrator so
// the module-singleton memoization (YOY-67 AC-7) is what these tests
// exercise. Parsing and serialization stay the real implementations.
const orchestratorSeam = vi.hoisted(() => ({
  build: undefined as ((db: PrismaClient) => unknown) | undefined,
}));
vi.mock("./search/proxy.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./search/proxy.server")>();
  return {
    ...original,
    getProxySearchOrchestrator: (db: PrismaClient) =>
      original.getProxySearchOrchestrator(db, (factoryDb) => {
        if (orchestratorSeam.build === undefined) {
          throw new Error("test installed no orchestrator");
        }
        return orchestratorSeam.build(
          factoryDb,
        ) as import("./search/orchestrator.server").SearchOrchestrator;
      }),
  };
});

// Failure-injection seam for the search-event log: when armed, the REAL
// writeSearchEvent runs against a store whose create rejects — Prisma's
// delegates are proxy-backed, so vi.spyOn on them corrupts the client.
const eventsSeam = vi.hoisted(() => ({ failNextSearchWrite: false }));
vi.mock("./search/events.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./search/events.server")>();
  return {
    ...original,
    writeSearchEvent: (
      dbArg: Parameters<typeof original.writeSearchEvent>[0],
      event: Parameters<typeof original.writeSearchEvent>[1],
    ) => {
      if (eventsSeam.failNextSearchWrite) {
        eventsSeam.failNextSearchWrite = false;
        const poisoned = {
          searchEvent: {
            create: () => Promise.reject(new Error("log store down")),
          },
        };
        return original.writeSearchEvent(poisoned as never, event);
      }
      return original.writeSearchEvent(dbArg, event);
    },
  };
});

// Replace the process-wide throttle singleton with a per-test instance so
// throttle tests control the clock and limit; the default is permissive so
// unrelated tests never trip it.
const throttleSeam = vi.hoisted(() => ({
  instance: undefined as
    | import("./search/throttle.server").SessionThrottle
    | undefined,
}));
vi.mock("./search/throttle.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./search/throttle.server")>();
  return {
    ...original,
    getSessionThrottle: () =>
      throttleSeam.instance ?? original.createSessionThrottle(),
  };
});

import db from "./db.server";
import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import { action } from "./routes/apps.unfiltered.search";
import { createPgTrgmClassicStore } from "./search/classic-store.server";
import { createSearchOrchestrator } from "./search/orchestrator.server";
import { resetProxySearchOrchestrator } from "./search/proxy.server";
import { createPgVectorRetrievalStore } from "./search/retrieval-store.server";
import { createSessionThrottle } from "./search/throttle.server";

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

/**
 * The exact keys of one result card on the wire. `url` is the
 * server-resolved product link (YOY-87 AC-3); the storefront `handle` is a
 * DB column and never on the wire.
 */
const RESULT_KEYS = [
  "available",
  "colorUnknown",
  "currencyCode",
  "imageUrl",
  "priceMax",
  "priceMin",
  "productId",
  "title",
  "url",
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
  prependUnsigned = [],
}: {
  payload: unknown;
  shop?: string;
  secret?: string;
  omitSignature?: boolean;
  /** Params placed before the signed set and left out of the signature. */
  prependUnsigned?: [name: string, value: string][];
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
  const query = [
    ...prependUnsigned.map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    ),
    params.toString(),
  ]
    .filter((part) => part !== "")
    .join("&");
  return new Request(
    `https://test-app.example.com/apps/unfiltered/search?${query}`,
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
        url: `https://${SHOP}/products/${product.productId}-handle`,
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

/** Install a real orchestrator over the given fakes as the route's seam.
 * Installing drops the module singleton (YOY-67 AC-7), so each install gets
 * a fresh build on the next request and memoizes from there. */
function installOrchestrator(options: {
  llm: LlmClient;
  embeddings?: EmbeddingClient;
}): void {
  resetProxySearchOrchestrator();
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
  resetProxySearchOrchestrator();
  orchestratorSeam.build = () => {
    throw new Error("search ran before authentication");
  };
  throttleSeam.instance = undefined;
  await db.aiCall.deleteMany();
  await db.searchEvent.deleteMany();
  await db.clickEvent.deleteMany();
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

  it("adopts the signed shop, not a client duplicate smuggled before it (YOY-52 AC-10)", async () => {
    // Shopify's edge strips client-set reserved `shop` params (probed live
    // 2026-08-09), so in production only the signed shop arrives. This pins
    // the defense-in-depth layer beneath that guarantee: the signature
    // validator resolves duplicate params last-wins — a duplicate in FRONT
    // of the signed set passes validation — so the route must read the last
    // occurrence, the value the signature actually covered.
    await seed([{ productId: "boot-1", title: "leather boots" }]);
    installOrchestrator({ llm: fakeLlm({}) });

    const response = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "leather boots", sessionId: "s1" },
          prependUnsigned: [["shop", "attacker-probe.myshopify.com"]],
        }),
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // boot-1 exists only under the signed shop's catalog, so serving it
    // proves the foreign first occurrence was never adopted.
    expect(body.results.map((r: { productId: string }) => r.productId)).toEqual(
      ["boot-1"],
    );
    const events = await db.searchEvent.findMany();
    expect(events.map((event) => event.shopDomain)).toEqual([SHOP]);
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

  it("rejects an unknown mode and any preview carrying refinement context (YOY-68)", async () => {
    installOrchestrator({ llm: fakeLlm({}) });
    for (const payload of [
      { query: "shoes", sessionId: "s1", mode: "instant" },
      {
        query: "shoes",
        sessionId: "s1",
        mode: "preview",
        previousIntent: DRESS_INTENT,
      },
      {
        query: "shoes",
        sessionId: "s1",
        mode: "preview",
        previousIntent: DRESS_INTENT,
        removeChip: { field: "occasion", value: "wedding" },
      },
    ]) {
      const response = await action(actionArgs(proxyRequest({ payload })));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    }
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
        url: `https://${SHOP}/products/sneaker-90-handle`,
        imageUrl: "https://cdn.example.com/sneaker-90.jpg",
        priceMin: 100,
        priceMax: 100,
        currencyCode: "ILS",
        available: true,
        colorUnknown: false,
      },
    ]);
    expect(Object.keys(body.results[0]).sort()).toEqual(RESULT_KEYS);
    expect(body.results[0]).not.toHaveProperty("handle");
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
    // Title chosen so the classic fallback finds it by keyword: the degraded
    // path then serves at least one card to shape-check (YOY-87 AC-3).
    await seed([{ productId: "silk-gown", title: "elegant summer wedding dress" }]);
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
    // The degraded path serves the same card shape (YOY-87 AC-3): `url`
    // present, `handle` absent.
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
      expect(result.url).toBe(`https://${SHOP}/products/silk-gown-handle`);
    }
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
    expect(body.closeMatches[0]).not.toHaveProperty("handle");
    expect(body.closeMatches[0].url).toBe(
      `https://${SHOP}/products/linen-shirt-handle`,
    );
  });
});

describe("unexpected-failure containment (YOY-52 AC-4)", () => {
  it("answers 500 with an empty body when runSearch throws below the fallback ladder", async () => {
    orchestratorSeam.build = () => ({
      runSearch: () => {
        throw new Error("secret-internal-failure-detail");
      },
    });

    const response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "s1" } })),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 500 with an empty body when orchestrator construction itself throws", async () => {
    orchestratorSeam.build = () => {
      throw new Error("GEMINI_API_KEY is not configured");
    };

    const response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "s1" } })),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });
});

describe("cache suppression (YOY-52 AC-9)", () => {
  it("carries Cache-Control: no-store on a signed 200 and on a 401", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    installOrchestrator({ llm: fakeLlm({}) });

    const ok = await action(
      actionArgs(proxyRequest({ payload: { query: "nike 90", sessionId: "s1" } })),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");

    const unsigned = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "nike 90", sessionId: "s1" },
          omitSignature: true,
        }),
      ),
    );
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("Cache-Control")).toBe("no-store");
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

describe("search event logging (YOY-47 AC-2)", () => {
  it("writes exactly one SearchEvent per search, including degraded and zero-hit", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);

    // Classic search.
    installOrchestrator({ llm: fakeLlm({}) });
    let response = await action(
      actionArgs(proxyRequest({ payload: { query: "nike 90", sessionId: "log-1" } })),
    );
    let body = await response.json();
    let events = await db.searchEvent.findMany({
      where: { sessionId: "log-1" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      searchId: body.searchId,
      shopDomain: SHOP,
      sessionId: "log-1",
      query: "nike 90",
      route: "classic",
      degraded: false,
      resultCount: 1,
    });
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(0);

    // Degraded search (intent extraction fails).
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => {
          throw new Error("boom");
        },
      }),
    });
    response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "log-2" } })),
    );
    body = await response.json();
    events = await db.searchEvent.findMany({ where: { sessionId: "log-2" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      searchId: body.searchId,
      route: "classic",
      degraded: true,
    });

    // AI zero-hit search: resultCount counts primary hits, not closeMatches.
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => DRESS_INTENT,
      }),
    });
    response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "log-3" } })),
    );
    body = await response.json();
    events = await db.searchEvent.findMany({ where: { sessionId: "log-3" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      searchId: body.searchId,
      route: "ai",
      degraded: false,
      resultCount: 0,
    });
  });

  it("still answers the search when the event write fails", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    installOrchestrator({ llm: fakeLlm({}) });

    eventsSeam.failNextSearchWrite = true;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await action(
        actionArgs(
          proxyRequest({ payload: { query: "nike 90", sessionId: "log-4" } }),
        ),
      );
      expect(response.status).toBe(200);
      const responseBody = await response.json();
      expect(responseBody.results).toHaveLength(1);
      // The failure was swallowed, logged, and the row simply lost.
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(
        await db.searchEvent.count({ where: { sessionId: "log-4" } }),
      ).toBe(0);
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("per-session AI throttle (YOY-47 AC-4, AC-5)", () => {
  /** Fake LLM that counts invocations, answering the AI route + intent. */
  function countingAiLlm() {
    let calls = 0;
    return {
      llm: fakeLlm({
        classification: () => {
          calls += 1;
          return { route: "ai" };
        },
        intent: () => {
          calls += 1;
          return DRESS_INTENT;
        },
      }),
      invocations: () => calls,
    };
  }

  const aiSeed = () =>
    seed([
      {
        productId: "silk-gown",
        title: "silk gown",
        vector: [0.9, 0.1, 0],
        category: "dress",
        occasions: ["wedding"],
      },
    ]);

  it("forces the search past the limit onto classic with zero LLM calls, still on contract, still logged", async () => {
    await aiSeed();
    let nowMs = 0;
    throttleSeam.instance = createSessionThrottle({
      limit: 2,
      now: () => nowMs,
    });
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });

    // Two AI searches consume the budget.
    for (let i = 0; i < 2; i += 1) {
      const response = await action(
        actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t1" } })),
      );
      expect((await response.json()).route).toBe("ai");
    }
    const callsBefore = counting.invocations();
    expect(callsBefore).toBeGreaterThan(0);

    // The third is throttled: classic, degraded, no LLM invocation.
    const response = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t1" } })),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.route).toBe("classic");
    expect(body.degraded).toBe(true);
    expect(body.chips).toEqual([]);
    expect(counting.invocations()).toBe(callsBefore);

    // Throttled searches still log a SearchEvent (AC-5).
    const events = await db.searchEvent.findMany({
      where: { sessionId: "t1" },
    });
    expect(events).toHaveLength(3);
    expect(events.filter((event) => event.degraded)).toHaveLength(1);

    // The window sliding clear restores AI routing.
    nowMs += 61_000;
    const restored = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t1" } })),
    );
    expect((await restored.json()).route).toBe("ai");
  });

  it("classic-routed searches do not consume the budget", async () => {
    await aiSeed();
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });

    // A heuristic classic search first: no budget spent.
    const classic = await action(
      actionArgs(proxyRequest({ payload: { query: "nike 90", sessionId: "t2" } })),
    );
    expect((await classic.json()).route).toBe("classic");

    // The AI budget of 1 is still available.
    const ai = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t2" } })),
    );
    expect((await ai.json()).route).toBe("ai");

    // Now it is spent.
    const throttled = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t2" } })),
    );
    const throttledBody = await throttled.json();
    expect(throttledBody.route).toBe("classic");
    expect(throttledBody.degraded).toBe(true);
  });

  it("counts a degraded AI-classified search toward the budget (YOY-52 AC-5)", async () => {
    await aiSeed();
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => {
          throw new Error("extractor down");
        },
      }),
    });

    // The classifier decided AI; the extractor failed and the response
    // degraded to classic — real LLM spend happened, so budget is consumed.
    const degraded = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t4" } })),
    );
    const degradedBody = await degraded.json();
    expect(degradedBody.route).toBe("classic");
    expect(degradedBody.degraded).toBe(true);

    // The next AI-shaped query from that session is throttled: forced
    // classic with zero LLM calls (the fake would answer, but is not asked).
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });
    const throttled = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t4" } })),
    );
    const throttledBody = await throttled.json();
    expect(throttledBody.route).toBe("classic");
    expect(throttledBody.degraded).toBe(true);
    expect(counting.invocations()).toBe(0);
  });

  it("a model-decided classic search still consumes nothing, degraded or not (YOY-52 AC-5)", async () => {
    await aiSeed();
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });

    // The model itself fails: classic + degraded with reason "model-error" —
    // the classifier never decided the AI route, so no budget is consumed.
    installOrchestrator({
      llm: fakeLlm({
        classification: () => {
          throw new Error("classifier down");
        },
      }),
    });
    const modelError = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t5" } })),
    );
    const modelErrorBody = await modelError.json();
    expect(modelErrorBody.route).toBe("classic");
    expect(modelErrorBody.degraded).toBe(true);

    // The full budget of 1 is still available for a genuine AI search.
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });
    const ai = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t5" } })),
    );
    expect((await ai.json()).route).toBe("ai");
  });

  it("counts a classic zero-hit escalation toward the budget (YOY-67 AC-3)", async () => {
    await aiSeed();
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    installOrchestrator({
      llm: fakeLlm({
        // The model routes the cross-language query classic; the keyword
        // engine finds nothing, so the search escalates into the AI path.
        classification: () => ({ route: "classic" }),
        intent: () => DRESS_INTENT,
      }),
    });

    const escalated = await action(
      actionArgs(
        proxyRequest({ payload: { query: "שמלה לחתונה", sessionId: "t6" } }),
      ),
    );
    const escalatedBody = await escalated.json();
    expect(escalatedBody.route).toBe("ai");
    expect(escalatedBody.degraded).toBe(false);
    expect(
      escalatedBody.results.map((r: { productId: string }) => r.productId),
    ).toEqual(["silk-gown"]);

    // The escalation spent intent + embedding calls: the budget of 1 is gone.
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });
    const throttled = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t6" } })),
    );
    const throttledBody = await throttled.json();
    expect(throttledBody.route).toBe("classic");
    expect(throttledBody.degraded).toBe(true);
    expect(counting.invocations()).toBe(0);
  });

  it("counts a FAILED classic zero-hit escalation toward the budget (degraded classic-zero-hit)", async () => {
    await aiSeed();
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    installOrchestrator({
      llm: fakeLlm({
        // The model routes the cross-language query classic; the keyword
        // engine finds nothing, the escalation fires — and its intent call
        // fails. Real LLM spend happened, so the budget is still consumed.
        classification: () => ({ route: "classic" }),
        intent: () => {
          throw new Error("extractor down");
        },
      }),
    });

    const failed = await action(
      actionArgs(
        proxyRequest({ payload: { query: "שמלה לחתונה", sessionId: "t6f" } }),
      ),
    );
    const failedBody = await failed.json();
    expect(failedBody.route).toBe("classic");
    expect(failedBody.degraded).toBe(true);
    expect(failedBody.results).toEqual([]);

    // The next AI-shaped query from that session is throttled: forced
    // classic with zero LLM calls.
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });
    const throttled = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t6f" } })),
    );
    const throttledBody = await throttled.json();
    expect(throttledBody.route).toBe("classic");
    expect(throttledBody.degraded).toBe(true);
    expect(counting.invocations()).toBe(0);
  });

  it("chip-removal requests are neither counted nor throttled", async () => {
    await aiSeed();
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    const counting = countingAiLlm();
    const costRecorder = createPrismaCostRecorder(db);
    installOrchestrator({
      llm: counting.llm,
      embeddings: fakeEmbeddings({ costRecorder }),
    });

    // Spend the whole budget.
    await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "t3" } })),
    );
    const callsBefore = counting.invocations();

    // A chip-removal request still runs the AI path — no classification or
    // intent call, so nothing to throttle and nothing counted.
    const removal = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: AI_QUERY,
            sessionId: "t3",
            previousIntent: DRESS_INTENT,
            removeChip: { field: "occasion", value: "wedding" },
          },
        }),
      ),
    );
    const removalBody = await removal.json();
    expect(removalBody.route).toBe("ai");
    expect(removalBody.degraded).toBe(false);
    expect(counting.invocations()).toBe(callsBefore);
  });
});

describe("keystroke preview mode (YOY-68 AC-1/AC-3)", () => {
  /** Fake LLM that counts invocations, answering the AI route + intent. */
  function countingAiLlm() {
    let calls = 0;
    return {
      llm: fakeLlm({
        classification: () => {
          calls += 1;
          return { route: "ai" };
        },
        intent: () => {
          calls += 1;
          return DRESS_INTENT;
        },
      }),
      invocations: () => calls,
    };
  }

  it("serves classic-only results on contract with zero LLM calls, no SearchEvent, and no budget spent", async () => {
    await seed([
      { productId: "sneaker-90", title: "nike 90" },
      {
        productId: "silk-gown",
        title: "silk gown",
        vector: [0.9, 0.1, 0],
        category: "dress",
        occasions: ["wedding"],
      },
    ]);
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });

    // An AI-shaped query as a preview: classic results, zero LLM calls.
    const preview = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "nike 90", sessionId: "p1", mode: "preview" },
        }),
      ),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(Object.keys(previewBody).sort()).toEqual(CONTRACT_KEYS);
    expect(previewBody.route).toBe("classic");
    expect(previewBody.degraded).toBe(false);
    expect(previewBody.chips).toEqual([]);
    expect(
      previewBody.results.map((r: { productId: string }) => r.productId),
    ).toEqual(["sneaker-90"]);
    expect(counting.invocations()).toBe(0);

    // No SearchEvent row exists for the preview (AC-3).
    expect(await db.searchEvent.count({ where: { sessionId: "p1" } })).toBe(0);

    // The preview consumed no AI budget: the full budget of 1 still serves
    // a genuine submitted AI search afterwards.
    const submitted = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "p1" } })),
    );
    expect((await submitted.json()).route).toBe("ai");
    expect(await db.searchEvent.count({ where: { sessionId: "p1" } })).toBe(1);
  });

  it("previews keep working for a throttled session, still LLM-free and unlogged", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    // A session with its budget fully spent: shouldThrottle would say yes,
    // but previews never consult it.
    throttleSeam.instance = createSessionThrottle({ limit: 0, now: () => 0 });
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });

    const preview = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "nike 90", sessionId: "p2", mode: "preview" },
        }),
      ),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.route).toBe("classic");
    // Not the throttled degradation (YOY-47) — a preview is the intended
    // shape, so it is not flagged degraded.
    expect(previewBody.degraded).toBe(false);
    expect(counting.invocations()).toBe(0);
    expect(await db.searchEvent.count({ where: { sessionId: "p2" } })).toBe(0);
  });

  it("a preview with zero classic hits does not run the zero-hit escalation", async () => {
    // Empty catalog: a submitted classic search would escalate (YOY-67
    // AC-3); a preview must not spend the intent call.
    const counting = countingAiLlm();
    installOrchestrator({ llm: counting.llm });

    const preview = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "סנובורד כחול", sessionId: "p3", mode: "preview" },
        }),
      ),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.route).toBe("classic");
    expect(previewBody.results).toEqual([]);
    expect(previewBody.degraded).toBe(false);
    expect(counting.invocations()).toBe(0);
  });
});

describe("orchestrator module singleton (YOY-67 AC-7)", () => {
  it("serves repeat requests from one orchestrator: one classification call, identical route", async () => {
    await seed([
      {
        productId: "silk-gown",
        title: "silk gown",
        vector: [0.9, 0.1, 0],
        category: "dress",
        occasions: ["wedding"],
      },
    ]);
    let classificationCalls = 0;
    installOrchestrator({
      llm: fakeLlm({
        classification: () => {
          classificationCalls += 1;
          return { route: "ai" };
        },
        intent: () => DRESS_INTENT,
      }),
    });

    // Two requests with the same normalized query (spelled differently so
    // normalization, not string identity, is what dedupes them). Before the
    // singleton, each request built a fresh classifier with an empty
    // decision cache — the live run recorded the same query taking opposite
    // routes 1.6s apart despite temperature 0.
    const first = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "c1" } })),
    );
    const second = await action(
      actionArgs(
        proxyRequest({
          payload: { query: `  ${AI_QUERY.toUpperCase()}  `, sessionId: "c2" } ,
        }),
      ),
    );

    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.route).toBe("ai");
    expect(secondBody.route).toBe("ai");
    expect(classificationCalls).toBe(1);
  });
});
