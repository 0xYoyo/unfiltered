import { createHmac, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  createIntentExtractor,
  createLlmJudge,
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
import { writeClickEvent } from "./search/events.server";
import { createFindStep } from "./search/find.server";
import { createSearchOrchestrator } from "./search/orchestrator.server";
import {
  intentEscalationThresholdFromEnv,
  INTENT_ESCALATION_THRESHOLD_ENV,
  intentHedgeAfterMsFromEnv,
  INTENT_HEDGE_AFTER_MS_ENV,
  intentReuseWindowMsFromEnv,
  INTENT_REUSE_WINDOW_MINUTES_ENV,
  resetProxySearchOrchestrator,
} from "./search/proxy.server";
import { EXAMPLE_QUERIES } from "./playground/strings";
import { createPgVectorRetrievalStore } from "./search/retrieval-store.server";
import { createSessionThrottle } from "./search/throttle.server";

// Route tests for the app-proxy search endpoint (YOY-46): signed requests
// built exactly the way Shopify signs proxy requests (HMAC-SHA256 over the
// sorted query params with the API secret), the real orchestrator over fake
// LLM/embedding clients, and the embedded PGlite database — zero network.

const SHOP = "proxy-shop.myshopify.com";

/** A query the routing heuristics cannot settle, so the model decides. */
const AI_QUERY = "elegant summer wedding dress with sleeves";

/** The intent the fake model extracts for AI_QUERY (wire format). */
const DRESS_INTENT = {
  category: "dress",
  priceMin: null,
  priceMax: null,
  currency: null,
  colorsInclude: [],
  colorsExclude: [],
  attributesExclude: [],
  attributesInclude: [],
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
const CONTRACT_KEYS_WITH_CLOSE_MATCHES = [...CONTRACT_KEYS, "closeMatches", "closeMatchesRelaxed"]
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
        storeId: request.storeId,
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
  /** Exact-query intent reuse window (YOY-64 AC-4); off by default. */
  intentReuseWindowMs?: number;
  /** Clock the reuse lookup reads, so a test can age the window. */
  intentReuseNow?: () => Date;
  /** Wire Engine v2's find step and set the env default (YOY-145); absent = no find step. */
  engineV2?: boolean;
  /** The judge's LLM port (YOY-147); absent = no judge wired. */
  judgeLlm?: LlmClient;
}): void {
  resetProxySearchOrchestrator();
  orchestratorSeam.build = (routeDb) =>
    createSearchOrchestrator({
      ...(options.intentReuseWindowMs !== undefined
        ? {
            intentReuse: {
              windowMs: options.intentReuseWindowMs,
              ...(options.intentReuseNow !== undefined
                ? { now: options.intentReuseNow }
                : {}),
            },
          }
        : {}),
      db: routeDb as PrismaClient,
      classifier: createQueryClassifier({ llm: options.llm, timeoutMs: 500 }),
      extractor: createIntentExtractor({ llm: options.llm }),
      retriever: createRetriever({
        embeddings: options.embeddings ?? fakeEmbeddings(),
        store: createPgVectorRetrievalStore(routeDb as PrismaClient),
      }),
      classicStore: createPgTrgmClassicStore(routeDb as PrismaClient),
      ...(options.engineV2 !== undefined
        ? {
            find: createFindStep({
              db: routeDb as PrismaClient,
              embeddings: options.embeddings ?? fakeEmbeddings(),
              classicStore: createPgTrgmClassicStore(routeDb as PrismaClient),
            }),
            engineV2: options.engineV2,
          }
        : {}),
      ...(options.judgeLlm !== undefined
        ? { judge: createLlmJudge({ llm: options.judgeLlm }) }
        : {}),
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

  it("rejects an unknown mode and any preview or classic rescue carrying refinement context (YOY-68, YOY-96 AC-9)", async () => {
    installOrchestrator({ llm: fakeLlm({}) });
    for (const payload of [
      { query: "shoes", sessionId: "s1", mode: "instant" },
      {
        query: "shoes",
        sessionId: "s1",
        mode: "classic",
        previousIntent: DRESS_INTENT,
      },
      {
        query: "shoes",
        sessionId: "s1",
        mode: "classic",
        previousIntent: DRESS_INTENT,
        removeChip: { field: "occasion", value: "wedding" },
      },
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

  it("logs one [search] stages line per submitted search and none for a preview (YOY-114 AC-2)", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    installOrchestrator({ llm: fakeLlm({}) });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await action(
        actionArgs(proxyRequest({ payload: { query: "nike 90", sessionId: "s1" } })),
      );
      const body = await response.json();
      expect(body).not.toHaveProperty("stages");

      const lines = log.mock.calls.filter(
        (call) => call[0] === "[search] stages",
      );
      expect(lines).toHaveLength(1);
      const logged = JSON.parse(lines[0]![1] as string) as Record<string, unknown>;
      expect(Object.keys(logged)).toEqual([
        "searchId",
        "route",
        "routeReason",
        "latencyMs",
        "stages",
        "intentTier",
      ]);
      // A classic route ran no intent call (YOY-116 AC-3).
      expect(logged.intentTier).toBeNull();
      expect(logged.searchId).toBe(body.searchId);
      expect(logged.route).toBe("classic");
      expect(logged.routeReason).toBe("sku-pattern");
      expect(typeof logged.latencyMs).toBe("number");
      expect(Object.keys(logged.stages as object)).toEqual(["classify", "classic"]);

      await action(
        actionArgs(
          proxyRequest({
            payload: { query: "nike", sessionId: "s1", mode: "preview" },
          }),
        ),
      );
      expect(
        log.mock.calls.filter((call) => call[0] === "[search] stages"),
      ).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
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

describe("negated-attribute chips (YOY-133 AC-5)", () => {
  it("removing a 'Not wool' chip recomputes without it, drops the chip, and echoes the intent without the word", async () => {
    await seed([
      { productId: "wool-dress", title: "wool dress", vector: [0.9, 0.1, 0], category: "dress", occasions: ["wedding"] },
      { productId: "silk-dress", title: "silk dress", vector: [0.8, 0.2, 0], category: "dress", occasions: ["wedding"] },
    ]);
    const costRecorder = createPrismaCostRecorder(db);
    installOrchestrator({
      llm: fakeLlm({ costRecorder }),
      embeddings: fakeEmbeddings({ costRecorder }),
    });
    const withWool = { ...DRESS_INTENT, attributesExclude: ["wool"] };

    // The held intent alone (a follow-up echo with no removal) still excludes.
    const kept = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: AI_QUERY,
            sessionId: "s1",
            previousIntent: withWool,
            removeChip: { field: "occasion", value: "wedding" },
          },
        }),
      ),
    );
    const keptBody = await kept.json();
    expect(keptBody.results.map((r: { productId: string }) => r.productId)).toEqual(["silk-dress"]);
    expect(keptBody.chips).toEqual([
      { field: "category", value: "dress" },
      { field: "attributesExclude", value: "wool" },
    ]);
    expect(keptBody.intent.attributesExclude).toEqual(["wool"]);
    expect(keptBody.intent.attributesInclude).toEqual([]);

    const response = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: AI_QUERY,
            sessionId: "s1",
            previousIntent: withWool,
            removeChip: { field: "attributesExclude", value: "wool" },
          },
        }),
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.route).toBe("ai");
    expect(
      body.results.map((r: { productId: string }) => r.productId).sort(),
    ).toEqual(["silk-dress", "wool-dress"]);
    expect(body.chips).toEqual([
      { field: "category", value: "dress" },
      { field: "occasion", value: "wedding" },
    ]);
    expect(body.intent.attributesExclude).toEqual([]);
    // Zero LLM calls on either removal.
    const calls = await db.aiCall.findMany();
    expect(calls.filter((row) => row.operation !== "embedding")).toEqual([]);
  });

  it("a previous intent recorded before the arrays existed still parses (absent reads as none)", async () => {
    await seed([{ productId: "dress", title: "dress", vector: [1, 0, 0], category: "dress" }]);
    installOrchestrator({ llm: fakeLlm({}) });
    const { attributesExclude: _x, attributesInclude: _i, ...legacy } = DRESS_INTENT;
    void _x;
    void _i;
    const response = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: AI_QUERY,
            sessionId: "s1",
            previousIntent: legacy,
            removeChip: { field: "occasion", value: "wedding" },
          },
        }),
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.intent.attributesExclude).toEqual([]);
    expect(body.intent.attributesInclude).toEqual([]);
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
    // Every submitted search keeps its routeReason (YOY-96 AC-9).
    expect(events[0]!.routeReason).toEqual(expect.any(String));

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

describe("server-side pages (YOY-145)", () => {
  const products = ["a", "b", "c"].map((suffix) => ({
    productId: `nike-90-${suffix}`,
    title: `nike 90 ${suffix}`,
  }));

  it("serves one page with page and totalCount, and logs the page on its SearchEvent (AC-4, AC-5, AC-10)", async () => {
    await seed(products);
    installOrchestrator({ llm: fakeLlm({}), engineV2: false });
    const full = await (
      await action(actionArgs(proxyRequest({ payload: { query: "nike 90", sessionId: "page-0" } })))
    ).json();
    // No page parameters: the unpaged contract, no page keys.
    expect(Object.keys(full).sort()).toEqual(CONTRACT_KEYS.slice().sort());
    expect(full.results).toHaveLength(3);

    const response = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "nike 90", sessionId: "page-2", page: 2, pageSize: 1 },
        }),
      ),
    );
    const body = await response.json();
    expect(body).toMatchObject({ page: 2, totalCount: 3 });
    expect(body.results).toEqual([full.results[1]]);
    expect(Object.keys(body).sort()).toEqual(
      [...CONTRACT_KEYS, "page", "totalCount"].sort(),
    );

    const events = await db.searchEvent.findMany({
      where: { sessionId: { in: ["page-0", "page-2"] } },
      orderBy: { sessionId: "asc" },
    });
    expect(events.map((event) => [event.sessionId, event.page])).toEqual([
      ["page-0", 1],
      ["page-2", 2],
    ]);
  });

  it("ignores an engine parameter: the env switch alone decides the storefront's engine (AC-6)", async () => {
    await seed(products);
    installOrchestrator({ llm: fakeLlm({}), engineV2: false });
    await action(
      actionArgs(
        proxyRequest({ payload: { query: "nike 90", sessionId: "engine-1", engine: "v2" } }),
      ),
    );
    const [event] = await db.searchEvent.findMany({ where: { sessionId: "engine-1" } });
    // v2 here (no judge wired) would answer "find-only" (YOY-147 AC-11).
    expect(event!.routeReason).not.toBe("find-only");
    expect(event!.route).toBe("classic");
  });
});

describe("the judge on the storefront (YOY-147)", () => {
  it("logs a judged search as route ai, then serves the throttled session find order with no judge call (AC-7, AC-11)", async () => {
    await seed([
      { productId: "wrap-dress", title: "Wrap Dress" },
      { productId: "linen-shirt", title: "Linen Shirt" },
    ]);
    for (const [index, productId] of ["wrap-dress", "linen-shirt"].entries()) {
      await db.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, 'prose', 'h', $4::vector(3), CURRENT_TIMESTAMP)`,
        randomUUID(),
        SHOP,
        productId,
        `[1,${(index + 1) / 10},0]`,
      );
    }
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    const judgeCalls: StructuredCompletionRequest[] = [];
    installOrchestrator({
      llm: fakeLlm({}),
      engineV2: true,
      judgeLlm: {
        async completeStructured(request) {
          judgeCalls.push(request);
          // Wrap dress close, a fact off (linen, not silk); linen shirt exact.
          return { c: ["CFF", "E-X"], d: [{ n: 1, p: "linen", a: "silk" }] };
        },
      },
    });
    const query = "something soft to wear to dinner";

    const judged = await (
      await action(actionArgs(proxyRequest({ payload: { query, sessionId: "judge-1" } })))
    ).json();
    expect(judged.route).toBe("ai");
    // The close wrap dress sits under the divider beside the exact shirt (YOY-166 AC-1).
    expect(judged.results.map((result: { productId: string }) => result.productId)).toEqual([
      "linen-shirt",
    ]);
    expect(judged.results.map((result: { label: unknown }) => result.label)).toEqual([null]);
    expect(
      judged.closeMatches.map((result: { productId: string; label: unknown }) => [
        result.productId,
        result.label,
      ]),
    ).toEqual([["wrap-dress", { template: "fact-differs", values: ["linen", "silk"] }]]);
    expect(judged.closeMatchesRelaxed).toEqual([]);
    // The storefront wire carries no verdict and no details (AC-12).
    expect(JSON.stringify(judged)).not.toMatch(/verdict|"exact"|"close"/);
    expect(judged).not.toHaveProperty("details");

    // The judged search spent the session's budget of 1; the next is throttled.
    const capped = await (
      await action(actionArgs(proxyRequest({ payload: { query, sessionId: "judge-1" } })))
    ).json();
    expect(capped.route).toBe("classic");
    expect(capped.results.map((result: { productId: string }) => result.productId)).toEqual([
      "wrap-dress",
      "linen-shirt",
    ]);
    expect(judgeCalls).toHaveLength(1);

    const events = await db.searchEvent.findMany({ where: { sessionId: "judge-1" } });
    expect(events.map((event) => [event.route, event.routeReason]).sort()).toEqual([
      ["ai", "judged"],
      ["classic", "capped"],
    ]);
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

describe("classic rescue mode (YOY-96 AC-9)", () => {
  it("serves classic-only results with zero LLM calls and no budget spent, logged as a real SearchEvent the click beacon can attribute to", async () => {
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
    let calls = 0;
    installOrchestrator({
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
    });

    // An AI-shaped query as a classic rescue: keyword results on contract,
    // zero LLM calls, degraded like every forced-classic response.
    const rescue = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "nike 90", sessionId: "c1", mode: "classic" },
        }),
      ),
    );
    expect(rescue.status).toBe(200);
    const body = await rescue.json();
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.route).toBe("classic");
    expect(body.degraded).toBe(true);
    expect(body.chips).toEqual([]);
    expect(
      body.results.map((r: { productId: string }) => r.productId),
    ).toEqual(["sneaker-90"]);
    expect(calls).toBe(0);

    // Unlike a preview, the rescue is a submitted search: exactly one
    // SearchEvent, carrying the rescue reason, under the returned searchId.
    const events = await db.searchEvent.findMany({
      where: { sessionId: "c1" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      searchId: body.searchId,
      shopDomain: SHOP,
      query: "nike 90",
      route: "classic",
      routeReason: "client-timeout-rescue",
      degraded: true,
      resultCount: 1,
    });

    // …so a click on a rescued card attributes: the beacon's searchId
    // validation finds the row.
    expect(
      await writeClickEvent(db, {
        searchId: body.searchId,
        shopDomain: SHOP,
        sessionId: "c1",
        productId: "sneaker-90",
        position: 0,
      }),
    ).toBe(true);

    // The rescue consumed no AI budget: the full budget of 1 still serves
    // a genuine submitted AI search afterwards, which logs "model".
    const submitted = await action(
      actionArgs(proxyRequest({ payload: { query: AI_QUERY, sessionId: "c1" } })),
    );
    const submittedBody = await submitted.json();
    expect(submittedBody.route).toBe("ai");
    const after = await db.searchEvent.findMany({
      where: { sessionId: "c1" },
      orderBy: { createdAt: "asc" },
    });
    expect(after.map((event) => event.routeReason)).toEqual([
      "client-timeout-rescue",
      "model",
    ]);
  });

  it("a throttled session's rescue still answers, LLM-free, and is logged as a rescue rather than as throttled", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    throttleSeam.instance = createSessionThrottle({ limit: 0, now: () => 0 });
    let calls = 0;
    installOrchestrator({
      llm: fakeLlm({
        classification: () => {
          calls += 1;
          return { route: "ai" };
        },
      }),
    });

    const rescue = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "nike 90", sessionId: "c2", mode: "classic" },
        }),
      ),
    );
    expect(rescue.status).toBe(200);
    expect((await rescue.json()).route).toBe("classic");
    expect(calls).toBe(0);
    const events = await db.searchEvent.findMany({
      where: { sessionId: "c2" },
    });
    expect(events.map((event) => event.routeReason)).toEqual([
      "client-timeout-rescue",
    ]);
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

describe("intent escalation threshold from env (YOY-116 AC-2)", () => {
  it("defaults to the engine's committed threshold and reads a [0, 1] override", () => {
    expect(intentEscalationThresholdFromEnv({})).toBeGreaterThan(0);
    expect(intentEscalationThresholdFromEnv({ [INTENT_ESCALATION_THRESHOLD_ENV]: "0.5" })).toBe(0.5);
    expect(intentEscalationThresholdFromEnv({ [INTENT_ESCALATION_THRESHOLD_ENV]: "1" })).toBe(1);
  });

  it("rejects a malformed or out-of-range value, naming the variable", () => {
    for (const raw of ["", " ", "abc", "1.5", "-0.1"]) {
      expect(() =>
        intentEscalationThresholdFromEnv({ [INTENT_ESCALATION_THRESHOLD_ENV]: raw }),
      ).toThrow(/INTENT_ESCALATION_THRESHOLD/);
    }
  });
});

describe("intent hedge delay from env (YOY-64 AC-6)", () => {
  it("defaults to the engine's committed delay and reads a positive millisecond override", () => {
    expect(intentHedgeAfterMsFromEnv({})).toBe(2500);
    expect(intentHedgeAfterMsFromEnv({ [INTENT_HEDGE_AFTER_MS_ENV]: "1500" })).toBe(1500);
  });

  it("rejects a malformed or non-positive value, naming the variable", () => {
    for (const raw of ["", " ", "abc", "0", "-100"]) {
      expect(() => intentHedgeAfterMsFromEnv({ [INTENT_HEDGE_AFTER_MS_ENV]: raw })).toThrow(
        /INTENT_HEDGE_AFTER_MS/,
      );
    }
  });
});

describe("exact-query intent reuse through the proxy (YOY-64 AC-4)", () => {
  it("each playground example submitted twice: the second makes no LLM call, is logged, and is not budgeted", async () => {
    await seed([
      {
        productId: "silk-gown",
        title: "silk gown",
        vector: [0.9, 0.1, 0],
        category: "dress",
        occasions: ["wedding"],
      },
    ]);
    let intentCalls = 0;
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => {
          intentCalls += 1;
          return DRESS_INTENT;
        },
        costRecorder: createPrismaCostRecorder(db),
      }),
      intentReuseWindowMs: 60 * 60_000,
    });
    const examples = [...EXAMPLE_QUERIES.en, ...EXAMPLE_QUERIES.he]
      .filter((example) => example.kind !== "refinement")
      .map((example) => example.text);
    expect(examples.length).toBeGreaterThanOrEqual(10);

    for (const query of examples) {
      const first = await (
        await action(actionArgs(proxyRequest({ payload: { query, sessionId: "demo" } })))
      ).json();
      expect(first.route, query).toBe("ai");
      const rowsAfterFirst = await db.aiCall.count({ where: { searchId: first.searchId } });
      expect(rowsAfterFirst, query).toBeGreaterThan(0);

      const second = await (
        await action(actionArgs(proxyRequest({ payload: { query, sessionId: "demo-2" } })))
      ).json();
      expect(second.route, query).toBe("ai");
      expect(second.results, query).toEqual(first.results);
      expect(second.chips, query).toEqual(first.chips);
      expect(second.intent, query).toEqual(first.intent);
      // Zero LLM calls: no AiCall rows at all for the reused search.
      expect(await db.aiCall.count({ where: { searchId: second.searchId } }), query).toBe(0);
      // Logged as a normal SearchEvent, with the reuse reason.
      const event = await db.searchEvent.findFirst({ where: { searchId: second.searchId } });
      expect(event?.routeReason, query).toBe("intent-reuse");
      expect(event?.route, query).toBe("ai");
    }
    // One intent call per distinct example, none for the repeats.
    expect(intentCalls).toBe(examples.length);
    // The throttle saw only the first submissions of each example.
    const events = await db.searchEvent.findMany({ where: { routeReason: "intent-reuse" } });
    expect(events).toHaveLength(examples.length);
  });

  it("the reuse window is anchored on the extraction, not on the last reuse (YOY-125 AC-3)", async () => {
    // A hot query — a playground "Try:" example, a demo — is searched at
    // least once per window forever. If a reuse row stored the intent it was
    // served, `findReusableIntent` would keep finding a fresh row and the
    // query would never re-extract after a prompt or model change. Anchoring
    // on the extraction caps a served intent's staleness at exactly the
    // window.
    await seed([
      { productId: "silk-gown", title: "silk gown", vector: [0.9, 0.1, 0], category: "dress" },
    ]);
    let intentCalls = 0;
    const clock = { now: new Date("2026-08-28T09:00:00.000Z") };
    installOrchestrator({
      llm: fakeLlm({
        classification: () => ({ route: "ai" }),
        intent: () => {
          intentCalls += 1;
          return DRESS_INTENT;
        },
      }),
      intentReuseWindowMs: 60 * 60_000,
      intentReuseNow: () => clock.now,
    });

    const submit = async (sessionId: string) => {
      const body = await (
        await action(
          actionArgs(proxyRequest({ payload: { query: "wedding dress", sessionId } })),
        )
      ).json();
      // The rows carry a real `createdAt`; age them to the simulated clock so
      // the window sees the same timeline the lookup does.
      await db.searchEvent.updateMany({
        where: { searchId: body.searchId },
        data: { createdAt: clock.now },
      });
      const event = await db.searchEvent.findFirst({ where: { searchId: body.searchId } });
      if (event === null) {
        throw new Error("every submitted search logs one SearchEvent");
      }
      return event;
    };

    const first = await submit("s1");
    expect(first.route).toBe("ai");
    expect(first.routeReason).not.toBe("intent-reuse");
    expect(first.intent).not.toBeNull();
    expect(intentCalls).toBe(1);

    // +40 min: inside the window, served from the extraction above.
    clock.now = new Date("2026-08-28T09:40:00.000Z");
    const second = await submit("s2");
    expect(second.routeReason).toBe("intent-reuse");
    expect(intentCalls).toBe(1);
    // The reuse row logs as a normal SearchEvent but stores no intent, so it
    // cannot re-anchor the window on itself.
    expect(second.route).toBe("ai");
    expect(second.intent).toBeNull();
    expect(second.normalizedQuery).toBeNull();

    // +100 min from the only extraction: the window has expired, so the
    // query re-extracts even though it was searched 60 min ago.
    clock.now = new Date("2026-08-28T10:40:00.000Z");
    const third = await submit("s3");
    expect(third.routeReason).not.toBe("intent-reuse");
    expect(intentCalls).toBe(2);
  });

  it("stores the served intent keyed by the normalized query, and nothing for classic or degraded searches", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }, { productId: "silk-gown", title: "silk gown", vector: [0.9, 0.1, 0], category: "dress" }]);
    installOrchestrator({
      llm: fakeLlm({ classification: () => ({ route: "ai" }), intent: () => DRESS_INTENT }),
      intentReuseWindowMs: 60 * 60_000,
    });
    const ai = await (await action(actionArgs(proxyRequest({ payload: { query: "  Elegant summer WEDDING dress   with sleeves", sessionId: "s1" } })))).json();
    const aiRow = await db.searchEvent.findFirst({ where: { searchId: ai.searchId } });
    expect(aiRow?.normalizedQuery).toBe("elegant summer wedding dress with sleeves");
    expect(aiRow?.intent).toMatchObject({ category: "dress", occasion: "wedding" });

    const classic = await (await action(actionArgs(proxyRequest({ payload: { query: "nike 90", sessionId: "s1" } })))).json();
    const classicRow = await db.searchEvent.findFirst({ where: { searchId: classic.searchId } });
    expect(classicRow?.normalizedQuery).toBeNull();
    expect(classicRow?.intent).toBeNull();
  });
});

describe("intent reuse window from env (YOY-64 AC-4)", () => {
  it("defaults to 60 minutes, reads minutes, and 0 disables", () => {
    expect(intentReuseWindowMsFromEnv({})).toBe(60 * 60_000);
    expect(intentReuseWindowMsFromEnv({ [INTENT_REUSE_WINDOW_MINUTES_ENV]: "15" })).toBe(15 * 60_000);
    expect(intentReuseWindowMsFromEnv({ [INTENT_REUSE_WINDOW_MINUTES_ENV]: "0" })).toBe(0);
    for (const raw of ["", "abc", "-1"]) {
      expect(() => intentReuseWindowMsFromEnv({ [INTENT_REUSE_WINDOW_MINUTES_ENV]: raw })).toThrow(
        /INTENT_REUSE_WINDOW_MINUTES/,
      );
    }
  });
});
