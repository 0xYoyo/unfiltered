import { createHmac, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  createLlmJudge,
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
import { resetProxySearchOrchestrator } from "./search/proxy.server";
import { createSessionThrottle } from "./search/throttle.server";

// Route tests for the app-proxy search endpoint (YOY-46): signed requests
// built exactly the way Shopify signs proxy requests (HMAC-SHA256 over the
// sorted query params with the API secret), the real Engine v2 orchestrator
// (find step, optional judge) over fake embedding and judge clients, and the
// embedded PGlite database — zero network.

const SHOP = "proxy-shop.myshopify.com";

/** A descriptive shopper sentence, the kind the find step serves. */
const QUERY = "something soft to wear to dinner";

/**
 * The exact top-level keys of a classic-only response — the keystroke
 * preview and the client-timeout rescue (AC-3/AC-5): unpaged, no carry.
 */
const CLASSIC_CONTRACT_KEYS = [
  "chips",
  "degraded",
  "results",
  "route",
  "searchId",
];

/**
 * The exact top-level keys of a submitted search's response: it always
 * pages (YOY-145 AC-4) and carries the refinement chain (YOY-150 AC-3).
 */
const CONTRACT_KEYS = [...CLASSIC_CONTRACT_KEYS, "carry", "page", "totalCount"].sort();

/**
 * The exact keys of one classic result card on the wire. `url` is the
 * server-resolved product link (YOY-87 AC-3); the storefront `handle` is a
 * DB column and never on the wire.
 */
const RESULT_KEYS = [
  "available",
  "currencyCode",
  "imageUrl",
  "priceMax",
  "priceMin",
  "productId",
  "title",
  "url",
];

/** A submitted search's card carries its label, null when none (YOY-147 AC-9). */
const FIND_RESULT_KEYS = [...RESULT_KEYS, "label"].sort();

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

/** POST one signed search and parse its JSON body. */
async function search(payload: Record<string, unknown>) {
  const response = await action(actionArgs(proxyRequest({ payload })));
  expect(response.status).toBe(200);
  return response.json();
}

const productIds = (cards: { productId: string }[]) =>
  cards.map((card) => card.productId);

interface SeedProduct {
  productId: string;
  title: string;
  /**
   * Card-vector distance knob: a card vector [1, y, 0] against the fake
   * query vector [1, 0, 0], so vector order is set by `y` alone. No card
   * vector when absent — the product is then found by keyword only.
   */
  y?: number;
}

async function seed(products: SeedProduct[]): Promise<void> {
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
    if (product.y !== undefined) {
      await db.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, 'prose', 'h', $4::vector(3), CURRENT_TIMESTAMP)`,
        randomUUID(),
        SHOP,
        product.productId,
        `[1,${product.y},0]`,
      );
    }
  }
}

/**
 * Fake embedding port: every query lands on [1, 0, 0], metered through the
 * cost recorder when one is given; `failWith` makes every call reject.
 */
function fakeEmbeddings(options?: {
  costRecorder?: CostRecorder;
  failWith?: Error;
}): EmbeddingClient & { calls: () => number } {
  let calls = 0;
  return {
    dimension: 3,
    calls: () => calls,
    async embed(request) {
      calls += 1;
      if (options?.failWith !== undefined) {
        throw options.failWith;
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

/** A judge LLM port answering every page with `answer`, counting its calls. */
function scriptedJudgeLlm(answer: unknown): LlmClient & {
  requests: StructuredCompletionRequest[];
} {
  const requests: StructuredCompletionRequest[] = [];
  return {
    requests,
    async completeStructured(request) {
      requests.push(request);
      return answer;
    },
  };
}

/** How many times the installed orchestrator was built (YOY-67 AC-7). */
let orchestratorBuilds = 0;

/** Install a real Engine v2 orchestrator over the given fakes as the route's seam.
 * Installing drops the module singleton (YOY-67 AC-7), so each install gets
 * a fresh build on the next request and memoizes from there. */
function installOrchestrator(
  options: {
    embeddings?: EmbeddingClient;
    /** The judge's LLM port (YOY-147); absent = no judge wired, pages are find-only. */
    judgeLlm?: LlmClient;
  } = {},
): void {
  resetProxySearchOrchestrator();
  orchestratorBuilds = 0;
  orchestratorSeam.build = (routeDb) => {
    orchestratorBuilds += 1;
    const classicStore = createPgTrgmClassicStore(routeDb as PrismaClient);
    return createSearchOrchestrator({
      db: routeDb as PrismaClient,
      classicStore,
      find: createFindStep({
        db: routeDb as PrismaClient,
        embeddings: options.embeddings ?? fakeEmbeddings(),
        classicStore,
      }),
      ...(options.judgeLlm !== undefined
        ? { judge: createLlmJudge({ llm: options.judgeLlm }) }
        : {}),
    });
  };
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
  await db.judgeAnswer.deleteMany();
  await db.judgeVerdict.deleteMany();
  await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
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
    installOrchestrator();

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
    expect(productIds(body.results)).toEqual(["boot-1"]);
    const events = await db.searchEvent.findMany();
    expect(events.map((event) => event.shopDomain)).toEqual([SHOP]);
  });

  it("takes the shop from the verified proxy params, ignoring any shop in the body", async () => {
    await seed([{ productId: "boot-1", title: "leather boots" }]);
    installOrchestrator();

    const body = await search({
      query: "leather boots",
      sessionId: "s1",
      shopDomain: "evil-shop.myshopify.com",
      shop: "evil-shop.myshopify.com",
    });

    // Results exist only under the signed shop's catalog, so serving them
    // proves retrieval keyed on the verified params, not the body.
    expect(productIds(body.results)).toEqual(["boot-1"]);
  });
});

describe("request validation", () => {
  it("rejects a body without query or sessionId", async () => {
    installOrchestrator();
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

  it("rejects an unknown mode and any preview or classic rescue carrying refinement context (YOY-68, YOY-96 AC-9)", async () => {
    installOrchestrator();
    for (const payload of [
      { query: "shoes", sessionId: "s1", mode: "instant" },
      { query: "shoes", sessionId: "s1", mode: "classic", previousQuery: "boots" },
      { query: "shoes", sessionId: "s1", mode: "preview", previousQuery: "boots" },
    ]) {
      const response = await action(actionArgs(proxyRequest({ payload })));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    }
  });

  it("ignores a sent previousIntent or removeChip rather than honouring it (YOY-155)", async () => {
    await seed([
      { productId: "wrap-dress", title: "Wrap Dress", y: 0.1 },
      { productId: "linen-shirt", title: "Linen Shirt", y: 0.2 },
    ]);
    installOrchestrator();

    const plain = await search({ query: QUERY, sessionId: "s1" });
    const legacy = await search({
      query: QUERY,
      sessionId: "s1",
      previousIntent: { category: "dress", occasion: "wedding" },
      removeChip: { field: "occasion", value: "wedding" },
    });

    // The old engine's refinement fields change nothing: same keys, same
    // cards, no echoed intent.
    expect(Object.keys(legacy).sort()).toEqual(CONTRACT_KEYS);
    expect(productIds(legacy.results)).toEqual(productIds(plain.results));
    expect(legacy.chips).toEqual([]);
    expect(legacy.carry).toBe(QUERY);

    // A rescue carrying them is no longer refinement context, so not a 400.
    const rescue = await action(
      actionArgs(
        proxyRequest({
          payload: {
            query: "wrap dress",
            sessionId: "s1",
            mode: "classic",
            previousIntent: { category: "dress" },
            removeChip: { field: "category", value: "dress" },
          },
        }),
      ),
    );
    expect(rescue.status).toBe(200);
  });
});

describe("the response contract (AC-3, AC-5)", () => {
  it("serves a submitted query with exactly the contract's keys and nothing more", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    installOrchestrator();

    const body = await search({ query: "nike 90", sessionId: "s1" });

    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.route).toBe("ai");
    expect(body.degraded).toBe(false);
    expect(body.chips).toEqual([]);
    expect(typeof body.searchId).toBe("string");
    expect(body).toMatchObject({ page: 1, totalCount: 1, carry: "nike 90" });
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
        label: null,
      },
    ]);
    expect(Object.keys(body.results[0]).sort()).toEqual(FIND_RESULT_KEYS);
    expect(body.results[0]).not.toHaveProperty("handle");
  });

  it("logs one [search] stages line per submitted search and none for a preview (YOY-114 AC-2)", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    installOrchestrator();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const body = await search({ query: "nike 90", sessionId: "s1" });
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
      ]);
      expect(logged.searchId).toBe(body.searchId);
      expect(logged.route).toBe("ai");
      // No judge wired: the page is served in find order (YOY-147 AC-11).
      expect(logged.routeReason).toBe("find-only");
      expect(typeof logged.latencyMs).toBe("number");
      expect(Object.keys(logged.stages as object)).toEqual(["find", "hydrate"]);

      await search({ query: "nike", sessionId: "s1", mode: "preview" });
      expect(
        log.mock.calls.filter((call) => call[0] === "[search] stages"),
      ).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the degraded path on the exact contract shape with no internal error details", async () => {
    // A failed embedding serves the keyword order flagged degraded (YOY-145
    // AC-8); the title is chosen so the keyword half finds it, giving the
    // degraded path a card to shape-check (YOY-87 AC-3).
    await seed([{ productId: "silk-gown", title: "silk gown", y: 0.1 }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installOrchestrator({
        embeddings: fakeEmbeddings({ failWith: new Error("secret-internal-failure-detail") }),
      });

      const body = await search({ query: "silk gown", sessionId: "s1" });

      expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
      expect(body.route).toBe("ai");
      expect(body.degraded).toBe(true);
      expect(body.chips).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("secret-internal-failure");
      // The degraded path serves the same card shape (YOY-87 AC-3): `url`
      // present, `handle` absent.
      expect(body.results.length).toBeGreaterThan(0);
      for (const result of body.results) {
        expect(Object.keys(result).sort()).toEqual(FIND_RESULT_KEYS);
        expect(result.url).toBe(`https://${SHOP}/products/silk-gown-handle`);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("answers a judged page's close products as closeMatches, with no old-engine keys on the wire (YOY-155 AC-5)", async () => {
    await seed([
      { productId: "linen-shirt", title: "Linen Shirt", y: 0.1 },
      { productId: "wrap-dress", title: "Wrap Dress", y: 0.2 },
    ]);
    // Linen shirt exact, wrap dress close: `exact` and `close` split the
    // same way under every judge provider (YOY-157 AC-27).
    installOrchestrator({ judgeLlm: scriptedJudgeLlm({ c: ["E-X", "CFF"], d: [{ n: 2, p: "linen", a: "silk" }] }) });

    const response = await action(
      actionArgs(proxyRequest({ payload: { query: QUERY, sessionId: "ac5" } })),
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw);

    expect(body.route).toBe("ai");
    expect(Object.keys(body).sort()).toEqual([...CONTRACT_KEYS, "closeMatches"].sort());
    expect(productIds(body.results)).toEqual(["linen-shirt"]);
    // The v2 close-verdict split (YOY-166 AC-1): the close card, on the card contract.
    expect(productIds(body.closeMatches)).toEqual(["wrap-dress"]);
    expect(Object.keys(body.closeMatches[0]).sort()).toEqual(FIND_RESULT_KEYS);
    expect(body).not.toHaveProperty("closeMatchesRelaxed");
    for (const key of ['"intent"', '"closeMatchesRelaxed"', '"colorUnknown"']) {
      expect(raw).not.toContain(key);
    }
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
      actionArgs(proxyRequest({ payload: { query: QUERY, sessionId: "s1" } })),
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
      actionArgs(proxyRequest({ payload: { query: QUERY, sessionId: "s1" } })),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });
});

describe("cache suppression (YOY-52 AC-9)", () => {
  it("carries Cache-Control: no-store on a signed 200 and on a 401", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    installOrchestrator();

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

describe("search event logging (YOY-47 AC-2)", () => {
  it("writes exactly one SearchEvent per search, including degraded and zero-hit", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);

    // A submitted search.
    installOrchestrator();
    let body = await search({ query: "nike 90", sessionId: "log-1" });
    let events = await db.searchEvent.findMany({
      where: { sessionId: "log-1" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      searchId: body.searchId,
      shopDomain: SHOP,
      sessionId: "log-1",
      query: "nike 90",
      route: "ai",
      routeReason: "find-only",
      degraded: false,
      resultCount: 1,
    });
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(0);

    // Degraded search (the embedding fails; keyword order serves).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installOrchestrator({ embeddings: fakeEmbeddings({ failWith: new Error("boom") }) });
      body = await search({ query: "nike 90", sessionId: "log-2" });
    } finally {
      warn.mockRestore();
    }
    events = await db.searchEvent.findMany({ where: { sessionId: "log-2" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      searchId: body.searchId,
      route: "ai",
      degraded: true,
      resultCount: 1,
    });

    // Zero-hit search: nothing near, nothing by keyword.
    installOrchestrator();
    body = await search({ query: "snowboard", sessionId: "log-3" });
    expect(body.results).toEqual([]);
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
    installOrchestrator();

    eventsSeam.failNextSearchWrite = true;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const responseBody = await search({ query: "nike 90", sessionId: "log-4" });
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
    installOrchestrator();
    // No page parameters: the first page at the default page size.
    const full = await search({ query: "nike 90", sessionId: "page-0" });
    expect(Object.keys(full).sort()).toEqual(CONTRACT_KEYS);
    expect(full).toMatchObject({ page: 1, totalCount: 3 });
    expect(full.results).toHaveLength(3);

    const body = await search({ query: "nike 90", sessionId: "page-2", page: 2, pageSize: 1 });
    expect(body).toMatchObject({ page: 2, totalCount: 3 });
    expect(body.results).toEqual([full.results[1]]);
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);

    const events = await db.searchEvent.findMany({
      where: { sessionId: { in: ["page-0", "page-2"] } },
      orderBy: { sessionId: "asc" },
    });
    expect(events.map((event) => [event.sessionId, event.page])).toEqual([
      ["page-0", 1],
      ["page-2", 2],
    ]);
  });

  it("ignores an engine parameter: Engine v2 is the only engine (YOY-155)", async () => {
    await seed(products);
    installOrchestrator();
    const body = await search({ query: "nike 90", sessionId: "engine-1", engine: "v1" });
    expect(body.route).toBe("ai");
    const [event] = await db.searchEvent.findMany({ where: { sessionId: "engine-1" } });
    // No judge wired: the find step served it (YOY-147 AC-11).
    expect(event).toMatchObject({ route: "ai", routeReason: "find-only" });
  });
});

describe("the judge on the storefront (YOY-147)", () => {
  it("logs a judged search as route ai, then serves the throttled session find order with no judge call (AC-7, AC-11)", async () => {
    await seed([
      { productId: "wrap-dress", title: "Wrap Dress", y: 0.1 },
      { productId: "linen-shirt", title: "Linen Shirt", y: 0.2 },
    ]);
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    // Wrap dress close, a fact off (linen, not silk); linen shirt exact.
    const judgeLlm = scriptedJudgeLlm({ c: ["CFF", "E-X"], d: [{ n: 1, p: "linen", a: "silk" }] });
    installOrchestrator({ judgeLlm });

    const judged = await search({ query: QUERY, sessionId: "judge-1" });
    expect(judged.route).toBe("ai");
    // The close wrap dress sits under the divider beside the exact shirt (YOY-166 AC-1).
    expect(productIds(judged.results)).toEqual(["linen-shirt"]);
    expect(judged.results.map((result: { label: unknown }) => result.label)).toEqual([null]);
    expect(
      judged.closeMatches.map((result: { productId: string; label: unknown }) => [
        result.productId,
        result.label,
      ]),
    ).toEqual([["wrap-dress", { template: "fact-differs", values: ["linen", "silk"] }]]);
    // The storefront wire carries no verdict and no details (AC-12).
    expect(JSON.stringify(judged)).not.toMatch(/verdict|"exact"|"close"/);
    expect(judged).not.toHaveProperty("details");

    // The judged search spent the session's budget of 1; the next is throttled.
    const capped = await search({ query: QUERY, sessionId: "judge-1" });
    expect(capped.route).toBe("classic");
    expect(productIds(capped.results)).toEqual(["wrap-dress", "linen-shirt"]);
    expect(judgeLlm.requests).toHaveLength(1);

    const events = await db.searchEvent.findMany({ where: { sessionId: "judge-1" } });
    expect(events.map((event) => [event.route, event.routeReason]).sort()).toEqual([
      ["ai", "judged"],
      ["classic", "capped"],
    ]);
  });
});

describe("Engine v2 pages and the session throttle (YOY-157 AC-29)", () => {
  it("answers route ai on a later page but records the session's budget once per submitted search", async () => {
    await seed([
      { productId: "a", title: "Wrap Dress", y: 0.1 },
      { productId: "b", title: "Linen Dress", y: 0.2 },
      { productId: "c", title: "Silk Dress", y: 0.3 },
    ]);
    const recorded: string[] = [];
    const inner = createSessionThrottle({ limit: 5, now: () => 0 });
    throttleSeam.instance = {
      shouldThrottle: (sessionId) => inner.shouldThrottle(sessionId),
      recordAiSearch: (sessionId) => {
        recorded.push(sessionId);
        inner.recordAiSearch(sessionId);
      },
      sessionCount: () => inner.sessionCount(),
    };
    // No judge wired: every page is find-only, which answers route ai (AC-23).
    installOrchestrator();
    const page = (number: number) =>
      search({ query: "a dress for dinner", sessionId: "scroll-1", page: number, pageSize: 1 });

    const first = await page(1);
    expect(first).toMatchObject({ route: "ai", page: 1 });
    expect(recorded).toEqual(["scroll-1"]);
    const second = await page(2);
    expect(second).toMatchObject({ route: "ai", page: 2 });
    const third = await page(3);
    expect(third).toMatchObject({ route: "ai", page: 3 });
    // Pages 2 and 3 are the same search scrolled: no further budget spent.
    expect(recorded).toEqual(["scroll-1"]);
  });
});

describe("per-session AI throttle (YOY-47 AC-4, AC-5)", () => {
  const dresses = () =>
    seed([
      { productId: "wrap-dress", title: "Wrap Dress", y: 0.1 },
      { productId: "linen-shirt", title: "Linen Shirt", y: 0.2 },
    ]);

  it("serves the search past the limit find order with no judge call, still on contract, still logged", async () => {
    await dresses();
    let nowMs = 0;
    throttleSeam.instance = createSessionThrottle({
      limit: 2,
      now: () => nowMs,
    });
    const judgeLlm = scriptedJudgeLlm({ c: ["E-X", "E-X"], d: [] });
    installOrchestrator({ judgeLlm });

    // Two judged searches consume the budget.
    for (const query of [QUERY, "a dress for dinner"]) {
      expect((await search({ query, sessionId: "t1" })).route).toBe("ai");
    }
    const callsBefore = judgeLlm.requests.length;
    expect(callsBefore).toBeGreaterThan(0);

    // The third is throttled: find order, route classic, no judge call.
    const body = await search({ query: "a shirt for dinner", sessionId: "t1" });
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body.route).toBe("classic");
    expect(body.degraded).toBe(false);
    expect(productIds(body.results)).toEqual(["wrap-dress", "linen-shirt"]);
    expect(judgeLlm.requests).toHaveLength(callsBefore);

    // Throttled searches still log a SearchEvent (AC-5), as capped (YOY-147 AC-11).
    const events = await db.searchEvent.findMany({
      where: { sessionId: "t1" },
    });
    expect(events.map((event) => event.routeReason).sort()).toEqual(["capped", "judged", "judged"]);

    // The window sliding clear restores the judged path.
    nowMs += 61_000;
    expect((await search({ query: "a shirt for dinner", sessionId: "t1" })).route).toBe("ai");
  });

  it("classic rescues and capped searches do not consume the budget", async () => {
    await dresses();
    const recorded: string[] = [];
    const inner = createSessionThrottle({ limit: 1, now: () => 0 });
    throttleSeam.instance = {
      shouldThrottle: (sessionId) => inner.shouldThrottle(sessionId),
      recordAiSearch: (sessionId) => {
        recorded.push(sessionId);
        inner.recordAiSearch(sessionId);
      },
      sessionCount: () => inner.sessionCount(),
    };
    installOrchestrator();

    // A classic rescue first: no budget spent.
    const rescue = await search({ query: "wrap dress", sessionId: "t2", mode: "classic" });
    expect(rescue.route).toBe("classic");
    expect(recorded).toEqual([]);

    // The budget of 1 is still available.
    expect((await search({ query: QUERY, sessionId: "t2" })).route).toBe("ai");
    expect(recorded).toEqual(["t2"]);

    // Now it is spent: capped, and the capped search records nothing.
    const capped = await search({ query: QUERY, sessionId: "t2" });
    expect(capped.route).toBe("classic");
    expect(recorded).toEqual(["t2"]);
  });
});

describe("classic rescue mode (YOY-96 AC-9)", () => {
  it("serves classic-only results with zero model calls and no budget spent, logged as a real SearchEvent the click beacon can attribute to", async () => {
    await seed([
      { productId: "sneaker-90", title: "nike 90" },
      { productId: "silk-gown", title: "silk gown", y: 0.1 },
    ]);
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    const embeddings = fakeEmbeddings();
    // The submitted search's page is the silk gown alone (the one card vector).
    const judgeLlm = scriptedJudgeLlm({ c: ["E-X"], d: [] });
    installOrchestrator({ embeddings, judgeLlm });

    // A classic rescue: keyword results on the classic contract, zero
    // model calls, degraded like every forced-classic response.
    const rescue = await action(
      actionArgs(
        proxyRequest({
          payload: { query: "nike 90", sessionId: "c1", mode: "classic" },
        }),
      ),
    );
    expect(rescue.status).toBe(200);
    const body = await rescue.json();
    expect(Object.keys(body).sort()).toEqual(CLASSIC_CONTRACT_KEYS);
    expect(body.route).toBe("classic");
    expect(body.degraded).toBe(true);
    expect(body.chips).toEqual([]);
    expect(productIds(body.results)).toEqual(["sneaker-90"]);
    expect(Object.keys(body.results[0]).sort()).toEqual(RESULT_KEYS);
    expect(embeddings.calls()).toBe(0);
    expect(judgeLlm.requests).toHaveLength(0);

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
    // a genuine submitted search afterwards, which the judge answers.
    const submitted = await search({ query: QUERY, sessionId: "c1" });
    expect(submitted.route).toBe("ai");
    const after = await db.searchEvent.findMany({
      where: { sessionId: "c1" },
      orderBy: { createdAt: "asc" },
    });
    expect(after.map((event) => event.routeReason)).toEqual([
      "client-timeout-rescue",
      "judged",
    ]);
  });

  it("a throttled session's rescue still answers, model-free, and is logged as a rescue rather than as capped", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    throttleSeam.instance = createSessionThrottle({ limit: 0, now: () => 0 });
    const embeddings = fakeEmbeddings();
    installOrchestrator({ embeddings });

    const rescue = await search({ query: "nike 90", sessionId: "c2", mode: "classic" });
    expect(rescue.route).toBe("classic");
    expect(embeddings.calls()).toBe(0);
    const events = await db.searchEvent.findMany({
      where: { sessionId: "c2" },
    });
    expect(events.map((event) => event.routeReason)).toEqual([
      "client-timeout-rescue",
    ]);
  });
});

describe("keystroke preview mode (YOY-68 AC-1/AC-3)", () => {
  it("serves classic-only results on contract with zero model calls, no SearchEvent, and no budget spent", async () => {
    await seed([
      { productId: "sneaker-90", title: "nike 90" },
      { productId: "silk-gown", title: "silk gown", y: 0.1 },
    ]);
    throttleSeam.instance = createSessionThrottle({ limit: 1, now: () => 0 });
    const embeddings = fakeEmbeddings();
    installOrchestrator({ embeddings });

    const previewBody = await search({ query: "nike 90", sessionId: "p1", mode: "preview" });
    expect(Object.keys(previewBody).sort()).toEqual(CLASSIC_CONTRACT_KEYS);
    expect(previewBody.route).toBe("classic");
    expect(previewBody.degraded).toBe(false);
    expect(previewBody.chips).toEqual([]);
    expect(productIds(previewBody.results)).toEqual(["sneaker-90"]);
    expect(embeddings.calls()).toBe(0);

    // No SearchEvent row exists for the preview (AC-3).
    expect(await db.searchEvent.count({ where: { sessionId: "p1" } })).toBe(0);

    // The preview consumed no AI budget: the full budget of 1 still serves
    // a genuine submitted search afterwards.
    expect((await search({ query: QUERY, sessionId: "p1" })).route).toBe("ai");
    expect(await db.searchEvent.count({ where: { sessionId: "p1" } })).toBe(1);
  });

  it("previews keep working for a throttled session, still model-free and unlogged", async () => {
    await seed([{ productId: "sneaker-90", title: "nike 90" }]);
    // A session with its budget fully spent: shouldThrottle would say yes,
    // but previews never consult it.
    throttleSeam.instance = createSessionThrottle({ limit: 0, now: () => 0 });
    const embeddings = fakeEmbeddings();
    installOrchestrator({ embeddings });

    const previewBody = await search({ query: "nike 90", sessionId: "p2", mode: "preview" });
    expect(previewBody.route).toBe("classic");
    // Not the throttled shape — a preview is the intended shape, so it is
    // not flagged degraded.
    expect(previewBody.degraded).toBe(false);
    expect(embeddings.calls()).toBe(0);
    expect(await db.searchEvent.count({ where: { sessionId: "p2" } })).toBe(0);
  });

  it("a preview with zero classic hits stays model-free", async () => {
    // Card vectors exist, so a submitted search would find something; a
    // preview must not spend the embedding call to look.
    await seed([{ productId: "blue-board", title: "Blue Snowboard", y: 0.1 }]);
    const costRecorder = createPrismaCostRecorder(db);
    const embeddings = fakeEmbeddings({ costRecorder });
    installOrchestrator({ embeddings });

    const previewBody = await search({ query: "סנובורד כחול", sessionId: "p3", mode: "preview" });
    expect(previewBody.route).toBe("classic");
    expect(previewBody.results).toEqual([]);
    expect(previewBody.degraded).toBe(false);
    expect(embeddings.calls()).toBe(0);
    expect(await db.aiCall.count()).toBe(0);
  });
});

describe("orchestrator module singleton (YOY-67 AC-7)", () => {
  it("serves repeat requests from one memoized orchestrator build", async () => {
    await seed([{ productId: "silk-gown", title: "silk gown", y: 0.1 }]);
    installOrchestrator();

    // Before the singleton, each request built a fresh orchestrator and
    // threw away its per-instance clients (the judge's keep-alive pool,
    // the find step's query-vector cache) on every search.
    const first = await search({ query: QUERY, sessionId: "c1" });
    const second = await search({ query: QUERY, sessionId: "c2" });
    const preview = await search({ query: "silk", sessionId: "c3", mode: "preview" });

    expect(first.route).toBe("ai");
    expect(second.route).toBe("ai");
    expect(preview.route).toBe("classic");
    expect(orchestratorBuilds).toBe(1);
  });
});
