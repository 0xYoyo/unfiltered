import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Route the whole app (shopify.server included) at a throwaway test DB.
vi.mock("./db.server", async () => {
  const { createTestDb } = await import("./testing/helpers.server");
  return { default: await createTestDb() };
});

import db from "./db.server";
import { action } from "./routes/apps.unfiltered.click";

// Click-beacon route tests (YOY-47 AC-3): proxy-signed requests, the
// embedded PGlite database, zero network. The beacon only records clicks
// whose searchId names a search the signed shop actually ran.

const SHOP = "click-shop.myshopify.com";
const SEARCH_ID = "search-1111";

function beaconRequest({
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
    `https://test-app.example.com/apps/unfiltered/click?${query}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    },
  );
}

const actionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as never;

const validPayload = {
  searchId: SEARCH_ID,
  sessionId: "sess-1",
  productId: "gid://shopify/Product/1",
  position: 2,
};

beforeEach(async () => {
  await db.clickEvent.deleteMany();
  await db.searchEvent.deleteMany();
  // The search this shop ran, which valid beacons reference.
  await db.searchEvent.create({
    data: {
      searchId: SEARCH_ID,
      shopDomain: SHOP,
      sessionId: "sess-1",
      query: "elegant dress",
      route: "ai",
      degraded: false,
      latencyMs: 42,
      resultCount: 3,
    },
  });
});

describe("click beacon auth", () => {
  it("rejects an unsigned request with 401 and writes nothing", async () => {
    const response = await action(
      actionArgs(beaconRequest({ payload: validPayload, omitSignature: true })),
    );
    expect(response.status).toBe(401);
    expect(await db.clickEvent.count()).toBe(0);
  });

  it("rejects a wrong-secret signature with 401 and writes nothing", async () => {
    const response = await action(
      actionArgs(beaconRequest({ payload: validPayload, secret: "wrong" })),
    );
    expect(response.status).toBe(401);
    expect(await db.clickEvent.count()).toBe(0);
  });

  it("adopts the signed shop, not a client duplicate smuggled before it (YOY-52 AC-18)", async () => {
    // Mirrors proxy-search.test.ts: the signature validator resolves
    // duplicate params last-wins, so a duplicate prepended in FRONT of the
    // signed set passes validation — the route must read the last `shop`
    // occurrence, the value the signature actually covered. Pinned here so a
    // regression reverting the click route alone to `.get("shop")` fails CI.
    const response = await action(
      actionArgs(
        beaconRequest({
          payload: validPayload,
          prependUnsigned: [["shop", "attacker-probe.myshopify.com"]],
        }),
      ),
    );

    // SEARCH_ID exists only under the signed shop, so recording the click
    // proves the foreign first occurrence was never adopted.
    expect(response.status).toBe(204);
    const rows = await db.clickEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shopDomain).toBe(SHOP);
  });
});

describe("cache suppression (YOY-52 AC-9)", () => {
  it("carries Cache-Control: no-store on a recorded 204 and on a 401", async () => {
    const recorded = await action(
      actionArgs(beaconRequest({ payload: validPayload })),
    );
    expect(recorded.status).toBe(204);
    expect(recorded.headers.get("Cache-Control")).toBe("no-store");

    const unsigned = await action(
      actionArgs(beaconRequest({ payload: validPayload, omitSignature: true })),
    );
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("click beacon recording (AC-3)", () => {
  it("records a ClickEvent and answers 204 with an empty body", async () => {
    const response = await action(
      actionArgs(beaconRequest({ payload: validPayload })),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    const rows = await db.clickEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      searchId: SEARCH_ID,
      shopDomain: SHOP,
      sessionId: "sess-1",
      productId: "gid://shopify/Product/1",
      position: 2,
    });
  });

  it("answers 404 and writes nothing for an unknown searchId", async () => {
    const response = await action(
      actionArgs(
        beaconRequest({
          payload: { ...validPayload, searchId: "never-happened" },
        }),
      ),
    );
    expect(response.status).toBe(404);
    expect(await db.clickEvent.count()).toBe(0);
  });

  it("answers 404 and writes nothing when the searchId belongs to another shop", async () => {
    await db.searchEvent.create({
      data: {
        searchId: "foreign-search",
        shopDomain: "other-shop.myshopify.com",
        sessionId: "sess-9",
        query: "boots",
        route: "classic",
        degraded: false,
        latencyMs: 10,
        resultCount: 1,
      },
    });
    const response = await action(
      actionArgs(
        beaconRequest({
          payload: { ...validPayload, searchId: "foreign-search" },
        }),
      ),
    );
    expect(response.status).toBe(404);
    expect(await db.clickEvent.count()).toBe(0);
  });

  it("rejects malformed bodies with 400 and writes nothing", async () => {
    for (const payload of [
      {},
      { ...validPayload, position: -1 },
      { ...validPayload, position: 1.5 },
      { ...validPayload, searchId: "" },
      { ...validPayload, productId: 7 },
      "not an object",
    ]) {
      const response = await action(actionArgs(beaconRequest({ payload })));
      expect(response.status).toBe(400);
    }
    expect(await db.clickEvent.count()).toBe(0);
  });
});
