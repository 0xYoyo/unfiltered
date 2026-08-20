import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route the whole app at a throwaway test DB.
vi.mock("./db.server", async () => {
  const { createTestDb } = await import("./testing/helpers.server");
  return { default: await createTestDb() };
});

// AC-7: the routes run against a FAKE orchestrator, threaded through the
// REAL `getProxySearchOrchestrator` so the production wiring — the module
// singleton the proxy route also uses — is what these tests exercise.
const orchestratorSeam = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  response: undefined as Record<string, unknown> | undefined,
  fail: false,
}));
vi.mock("./search/proxy.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./search/proxy.server")>();
  return {
    ...original,
    getProxySearchOrchestrator: () => ({
      runSearch: (request: Record<string, unknown>) => {
        orchestratorSeam.requests.push(request);
        if (orchestratorSeam.fail) {
          return Promise.reject(new Error("orchestrator exploded"));
        }
        const forced = request.forceClassic === true;
        const preview = request.preview === true;
        return Promise.resolve({
          searchId: `search-${orchestratorSeam.requests.length}`,
          route: forced || preview ? "classic" : "ai",
          routeReason: forced ? "throttled" : preview ? "preview" : "model",
          intent: null,
          hits: [
            {
              productId: "p1",
              title: "Aurora Dress",
              url: "https://store.example.com/products/aurora",
              imageUrl: "https://cdn.example.com/aurora.jpg",
              priceMin: 100,
              priceMax: 120,
              currencyCode: "ILS",
              available: true,
              colorUnknown: false,
            },
          ],
          chips: forced || preview ? [] : [{ field: "category", value: "dress" }],
          degraded: forced,
          closeMatches: [],
          ...(orchestratorSeam.response ?? {}),
        });
      },
    }),
  };
});

import db from "./db.server";
import {
  clientIp,
  playgroundLimitsFromEnv,
  resetPlaygroundIpThrottle,
  resolveCatalog,
  startOfUtcDay,
  SEED_STORE_KEY_ENV,
} from "./playground/api.server";
import { action as clickAction } from "./routes/api.playground.click";
import { loader as searchLoader } from "./routes/api.playground.search";

// Route tests for the playground's own search/click API (YOY-90), on the
// embedded PGlite database with a fake orchestrator — zero network, zero
// LLM calls, and no Shopify session anywhere: this API is first-party and
// unauthenticated by design.

const SEED_KEY = "playground:seed";
const DEMO_SLUG = "demo";
const DEMO_KEY = "playground:demo";

/** The exact top-level response keys (AC-2): the proxy contract + details. */
const CONTRACT_KEYS = [
  "chips",
  "degraded",
  "details",
  "intent",
  "results",
  "route",
  "searchId",
].sort();

const DETAIL_KEYS = ["latencyMs", "limited", "routeReason"].sort();

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
].sort();

function searchRequest(
  query: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const params = new URLSearchParams({
    query: "elegant dress",
    sessionId: "s1",
    ...query,
  });
  return new Request(
    `https://playground.example.com/api/playground/search?${params}`,
    { headers },
  );
}

const loaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as never;

async function seedCatalog(slug: string, storeKey: string): Promise<void> {
  await db.playgroundCatalog.create({
    data: {
      slug,
      name: slug,
      storeKey,
      sourceUrl: `https://${slug}.example.com`,
      sourceKind: "shopify-public",
      productCount: 1,
    },
  });
}

/** Seed `count` AI-routed SearchEvent rows for a tenant, dated `at`. */
async function seedAiSearches(
  storeKey: string,
  count: number,
  at: Date = new Date(),
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await db.searchEvent.create({
      data: {
        searchId: `${storeKey}-seeded-${index}`,
        shopDomain: storeKey,
        sessionId: "seeded",
        query: "dress",
        route: "ai",
        degraded: false,
        latencyMs: 10,
        resultCount: 1,
        createdAt: at,
      },
    });
  }
}

async function clearTables(): Promise<void> {
  await db.clickEvent.deleteMany();
  await db.searchEvent.deleteMany();
  await db.playgroundCatalog.deleteMany();
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  orchestratorSeam.requests = [];
  orchestratorSeam.response = undefined;
  orchestratorSeam.fail = false;
  resetPlaygroundIpThrottle();
  await clearTables();
  process.env[SEED_STORE_KEY_ENV] = SEED_KEY;
  delete process.env.PLAYGROUND_AI_THROTTLE_PER_MINUTE;
  delete process.env.PLAYGROUND_DAILY_AI_CAP;
  delete process.env.PLAYGROUND_CATALOG_DAILY_AI_CAP;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("catalog resolution and error shapes (AC-1)", () => {
  it("searches the seed tenant when no catalog is named", async () => {
    const response = await searchLoader(loaderArgs(searchRequest({})));

    expect(response.status).toBe(200);
    expect(orchestratorSeam.requests[0].shopDomain).toBe(SEED_KEY);
  });

  it("searches the named catalog's tenant key", async () => {
    await seedCatalog(DEMO_SLUG, DEMO_KEY);

    await searchLoader(loaderArgs(searchRequest({ catalog: DEMO_SLUG })));

    expect(orchestratorSeam.requests[0].shopDomain).toBe(DEMO_KEY);
  });

  it("answers 404 with an empty body for an unknown slug — never the seed", async () => {
    const response = await searchLoader(
      loaderArgs(searchRequest({ catalog: "nope" })),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(orchestratorSeam.requests).toHaveLength(0);
  });

  it("answers 503 when no catalog is named and the seed env is unset", async () => {
    delete process.env[SEED_STORE_KEY_ENV];

    const response = await searchLoader(loaderArgs(searchRequest({})));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(orchestratorSeam.requests).toHaveLength(0);
  });

  it("answers 400 with an empty body for a malformed request", async () => {
    const response = await searchLoader(
      loaderArgs(
        new Request(
          "https://playground.example.com/api/playground/search?sessionId=s1",
        ),
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(orchestratorSeam.requests).toHaveLength(0);
  });

  it("answers 500 with an empty body when the orchestrator throws", async () => {
    orchestratorSeam.fail = true;

    const response = await searchLoader(loaderArgs(searchRequest({})));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });

  it("carries no-store and no CORS headers on every status (AC-1, NG-2)", async () => {
    const ok = await searchLoader(loaderArgs(searchRequest({})));
    const notFound = await searchLoader(
      loaderArgs(searchRequest({ catalog: "nope" })),
    );

    for (const response of [ok, notFound]) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  it("resolveCatalog reads the seed key from the injected env", async () => {
    expect(await resolveCatalog(db, null, { [SEED_STORE_KEY_ENV]: "k" })).toEqual(
      { storeKey: "k", slug: null },
    );
    expect(await resolveCatalog(db, null, {})).toEqual({ status: 503 });
    expect(await resolveCatalog(db, "missing", {})).toEqual({ status: 404 });
  });
});

describe("the response contract (AC-2)", () => {
  it("answers exactly the proxy contract plus details, and nothing else", async () => {
    const response = await searchLoader(loaderArgs(searchRequest({})));
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(Object.keys(body.details as object).sort()).toEqual(DETAIL_KEYS);
    expect(Object.keys((body.results as object[])[0]).sort()).toEqual(
      RESULT_KEYS,
    );
    // The orchestrator's diagnostic fields reach `details` only through the
    // serializer's explicit mapping — never the top level.
    expect(body).not.toHaveProperty("routeReason");
    expect(body).not.toHaveProperty("hits");
    expect((body.details as { routeReason: string }).routeReason).toBe("model");
    expect((body.details as { limited: unknown }).limited).toBeNull();
    expect(
      (body.details as { latencyMs: number }).latencyMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("includes closeMatches only when the response carries them", async () => {
    orchestratorSeam.response = {
      hits: [],
      closeMatches: [
        {
          productId: "p2",
          title: "Close",
          url: null,
          imageUrl: null,
          priceMin: 10,
          priceMax: 10,
          currencyCode: "ILS",
          available: true,
          colorUnknown: false,
        },
      ],
    };

    const body = (await (
      await searchLoader(loaderArgs(searchRequest({})))
    ).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [...CONTRACT_KEYS, "closeMatches"].sort(),
    );
  });

  it("asks the orchestrator for 24 primary hits", async () => {
    await searchLoader(loaderArgs(searchRequest({})));

    expect(orchestratorSeam.requests[0].limit).toBe(24);
  });
});

describe("preview, refinement, and chip removal pass through (AC-3)", () => {
  it("a preview runs classic-only and writes no SearchEvent", async () => {
    const response = await searchLoader(
      loaderArgs(searchRequest({ mode: "preview" })),
    );

    expect(response.status).toBe(200);
    expect(orchestratorSeam.requests[0]).toMatchObject({ preview: true });
    expect(orchestratorSeam.requests[0].forceClassic).toBeUndefined();
    expect(await db.searchEvent.count()).toBe(0);
  });

  it("a refinement forwards previousIntent verbatim", async () => {
    const intent = {
      category: "dress",
      priceMin: null,
      priceMax: 400,
      currency: "ILS",
      colorsInclude: ["blue"],
      colorsExclude: [],
      occasion: null,
      size: null,
      availabilityRequired: false,
      softAttributes: [],
    };

    await searchLoader(
      loaderArgs(searchRequest({ previousIntent: JSON.stringify(intent) })),
    );

    expect(orchestratorSeam.requests[0].previousIntent).toMatchObject({
      category: "dress",
      priceMax: 400,
      colorsInclude: ["blue"],
    });
  });

  it("a chip removal enters at retrieval with the surgery applied", async () => {
    const intent = {
      category: "dress",
      priceMin: null,
      priceMax: 400,
      currency: "ILS",
      colorsInclude: ["blue"],
      colorsExclude: [],
      occasion: null,
      size: null,
      availabilityRequired: false,
      softAttributes: [],
    };

    await searchLoader(
      loaderArgs(
        searchRequest({
          previousIntent: JSON.stringify(intent),
          removeChip: JSON.stringify({
            field: "colorsInclude",
            value: "blue",
          }),
        }),
      ),
    );

    const request = orchestratorSeam.requests[0];
    expect(request.resolvedIntent).toMatchObject({ colorsInclude: [] });
    expect(request.previousIntent).toBeUndefined();
    expect(request.forceClassic).toBeUndefined();
  });

  it("neither a preview nor a chip removal is limited, even over a cap", async () => {
    // Caps guard AI spend; these paths make no LLM call, so limiting them
    // would degrade a visitor for budget they cannot consume.
    process.env.PLAYGROUND_DAILY_AI_CAP = "1";
    await seedAiSearches(SEED_KEY, 5);
    const intent = {
      category: "dress",
      priceMin: null,
      priceMax: null,
      currency: null,
      colorsInclude: ["blue"],
      colorsExclude: [],
      occasion: null,
      size: null,
      availabilityRequired: false,
      softAttributes: [],
    };

    const preview = (await (
      await searchLoader(loaderArgs(searchRequest({ mode: "preview" })))
    ).json()) as { details: { limited: unknown } };
    const removal = (await (
      await searchLoader(
        loaderArgs(
          searchRequest({
            previousIntent: JSON.stringify(intent),
            removeChip: JSON.stringify({
              field: "colorsInclude",
              value: "blue",
            }),
          }),
        ),
      )
    ).json()) as { details: { limited: unknown } };

    expect(preview.details.limited).toBeNull();
    expect(removal.details.limited).toBeNull();
    expect(
      orchestratorSeam.requests.every(
        (request) => request.forceClassic === undefined,
      ),
    ).toBe(true);
  });
});

describe("per-IP AI throttle (AC-4)", () => {
  it("forces classic past the per-minute budget, and only for that IP", async () => {
    process.env.PLAYGROUND_AI_THROTTLE_PER_MINUTE = "2";
    const headers = { "x-forwarded-for": "1.2.3.4, 10.0.0.1" };

    for (let index = 0; index < 2; index += 1) {
      const body = (await (
        await searchLoader(loaderArgs(searchRequest({}, headers)))
      ).json()) as { details: { limited: unknown }; degraded: boolean };
      expect(body.details.limited).toBeNull();
      expect(body.degraded).toBe(false);
    }

    const limited = (await (
      await searchLoader(loaderArgs(searchRequest({}, headers)))
    ).json()) as { details: { limited: unknown }; degraded: boolean };

    expect(limited.details.limited).toBe("ip");
    expect(limited.degraded).toBe(true);
    expect(orchestratorSeam.requests.at(-1)).toMatchObject({
      forceClassic: true,
    });

    // A different visitor is untouched by this one's rate.
    const other = (await (
      await searchLoader(
        loaderArgs(searchRequest({}, { "x-forwarded-for": "5.6.7.8" })),
      )
    ).json()) as { details: { limited: unknown } };
    expect(other.details.limited).toBeNull();
  });

  it("keys the throttle by the first X-Forwarded-For entry, then the connection address, then unknown", () => {
    const withHeader = new Request("https://p.example.com/", {
      headers: { "x-forwarded-for": " 9.9.9.9 , 10.0.0.1" },
    });
    expect(clientIp(withHeader)).toBe("9.9.9.9");
    expect(clientIp(withHeader, "127.0.0.1")).toBe("9.9.9.9");

    const bare = new Request("https://p.example.com/");
    expect(clientIp(bare, "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIp(bare)).toBe("unknown");
    expect(clientIp(bare, "   ")).toBe("unknown");
  });
});

describe("daily AI caps (AC-5)", () => {
  it("serves classic once the global cap is reached, across every playground tenant", async () => {
    process.env.PLAYGROUND_DAILY_AI_CAP = "3";
    await seedCatalog(DEMO_SLUG, DEMO_KEY);
    // Spread across tenants: the global ceiling counts the playground as a
    // whole, not one catalog.
    await seedAiSearches(SEED_KEY, 2);
    await seedAiSearches(DEMO_KEY, 1);

    const body = (await (
      await searchLoader(loaderArgs(searchRequest({})))
    ).json()) as { details: { limited: unknown }; degraded: boolean };

    expect(body.details.limited).toBe("daily-global");
    expect(body.degraded).toBe(true);
    expect(orchestratorSeam.requests[0]).toMatchObject({ forceClassic: true });
    expect(await db.aiCall.count()).toBe(0);
  });

  it("serves classic once one catalog's cap is reached, leaving others alone", async () => {
    process.env.PLAYGROUND_CATALOG_DAILY_AI_CAP = "2";
    await seedCatalog(DEMO_SLUG, DEMO_KEY);
    await seedAiSearches(DEMO_KEY, 2);

    const capped = (await (
      await searchLoader(loaderArgs(searchRequest({ catalog: DEMO_SLUG })))
    ).json()) as { details: { limited: unknown } };
    expect(capped.details.limited).toBe("daily-catalog");

    const seedCatalogResponse = (await (
      await searchLoader(loaderArgs(searchRequest({})))
    ).json()) as { details: { limited: unknown } };
    expect(seedCatalogResponse.details.limited).toBeNull();
  });

  it("counts only today's AI rows: yesterday's do not carry over", async () => {
    process.env.PLAYGROUND_DAILY_AI_CAP = "2";
    const yesterday = new Date(startOfUtcDay(new Date()).getTime() - 60_000);
    await seedAiSearches(SEED_KEY, 5, yesterday);

    const body = (await (
      await searchLoader(loaderArgs(searchRequest({})))
    ).json()) as { details: { limited: unknown } };

    expect(body.details.limited).toBeNull();
  });

  it("counts only AI-routed rows: classic searches never consume the cap", async () => {
    process.env.PLAYGROUND_DAILY_AI_CAP = "1";
    await db.searchEvent.create({
      data: {
        searchId: "classic-1",
        shopDomain: SEED_KEY,
        sessionId: "s",
        query: "dress",
        route: "classic",
        degraded: false,
        latencyMs: 5,
        resultCount: 1,
      },
    });

    const body = (await (
      await searchLoader(loaderArgs(searchRequest({})))
    ).json()) as { details: { limited: unknown } };

    expect(body.details.limited).toBeNull();
  });

  it("reports the broadest binding constraint when several would bind", async () => {
    // Global and per-IP both bind; the global ceiling is what the visitor
    // cannot do anything about, so that is what the response names.
    process.env.PLAYGROUND_DAILY_AI_CAP = "1";
    process.env.PLAYGROUND_AI_THROTTLE_PER_MINUTE = "1";
    await seedAiSearches(SEED_KEY, 1);
    const headers = { "x-forwarded-for": "1.2.3.4" };

    await searchLoader(loaderArgs(searchRequest({}, headers)));
    const body = (await (
      await searchLoader(loaderArgs(searchRequest({}, headers)))
    ).json()) as { details: { limited: unknown } };

    expect(body.details.limited).toBe("daily-global");
  });

  it("reads its ceilings from the environment, falling back on nonsense", () => {
    expect(playgroundLimitsFromEnv({})).toEqual({
      ipPerMinute: 10,
      dailyGlobal: 2000,
      dailyCatalog: 500,
    });
    expect(
      playgroundLimitsFromEnv({
        PLAYGROUND_AI_THROTTLE_PER_MINUTE: "3",
        PLAYGROUND_DAILY_AI_CAP: "0",
        PLAYGROUND_CATALOG_DAILY_AI_CAP: "abc",
      }),
    ).toEqual({ ipPerMinute: 3, dailyGlobal: 2000, dailyCatalog: 500 });
  });
});

describe("event logging and the click beacon (AC-6)", () => {
  function clickRequest(
    body: unknown,
    query: Record<string, string> = {},
  ): Request {
    const params = new URLSearchParams(query);
    return new Request(
      `https://playground.example.com/api/playground/click?${params}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  it("writes exactly one SearchEvent per submitted search, under the tenant key", async () => {
    await seedCatalog(DEMO_SLUG, DEMO_KEY);

    await searchLoader(loaderArgs(searchRequest({ catalog: DEMO_SLUG })));

    const events = await db.searchEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      shopDomain: DEMO_KEY,
      sessionId: "s1",
      query: "elegant dress",
      route: "ai",
      resultCount: 1,
    });
  });

  it("logs a limited search too — the caps are counted from this table", async () => {
    process.env.PLAYGROUND_DAILY_AI_CAP = "1";
    await seedAiSearches(SEED_KEY, 1);

    await searchLoader(loaderArgs(searchRequest({})));

    const events = await db.searchEvent.findMany({
      where: { sessionId: "s1" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ route: "classic", degraded: true });
  });

  it("records a click against that catalog's own search", async () => {
    await seedCatalog(DEMO_SLUG, DEMO_KEY);
    const body = (await (
      await searchLoader(loaderArgs(searchRequest({ catalog: DEMO_SLUG })))
    ).json()) as { searchId: string };

    const response = await clickAction(
      loaderArgs(
        clickRequest(
          {
            searchId: body.searchId,
            sessionId: "s1",
            productId: "p1",
            position: 0,
          },
          { catalog: DEMO_SLUG },
        ),
      ),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const clicks = await db.clickEvent.findMany();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({
      shopDomain: DEMO_KEY,
      productId: "p1",
      position: 0,
    });
  });

  it("answers 404 and writes nothing for a searchId from another catalog", async () => {
    await seedCatalog(DEMO_SLUG, DEMO_KEY);
    // The search belongs to the seed catalog…
    const body = (await (
      await searchLoader(loaderArgs(searchRequest({})))
    ).json()) as { searchId: string };

    // …and the click claims it for the demo catalog.
    const response = await clickAction(
      loaderArgs(
        clickRequest(
          {
            searchId: body.searchId,
            sessionId: "s1",
            productId: "p1",
            position: 0,
          },
          { catalog: DEMO_SLUG },
        ),
      ),
    );

    expect(response.status).toBe(404);
    expect(await db.clickEvent.count()).toBe(0);
  });

  it("answers 404 for an unknown searchId and 400 for a malformed body", async () => {
    const unknown = await clickAction(
      loaderArgs(
        clickRequest({
          searchId: "nope",
          sessionId: "s1",
          productId: "p1",
          position: 0,
        }),
      ),
    );
    expect(unknown.status).toBe(404);

    const malformed = await clickAction(
      loaderArgs(clickRequest({ searchId: "only" })),
    );
    expect(malformed.status).toBe(400);
    expect(await db.clickEvent.count()).toBe(0);
  });

  it("answers 404 for a click naming an unknown catalog", async () => {
    const response = await clickAction(
      loaderArgs(
        clickRequest(
          {
            searchId: "s",
            sessionId: "s1",
            productId: "p1",
            position: 0,
          },
          { catalog: "nope" },
        ),
      ),
    );

    expect(response.status).toBe(404);
  });
});
