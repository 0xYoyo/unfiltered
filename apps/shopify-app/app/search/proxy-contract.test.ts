import { afterEach, describe, expect, it, vi } from "vitest";

import { createSearchClient } from "../../widget/src/search-client";
import type { SearchResponse } from "./orchestrator.server";
import {
  parseClickBeaconParams,
  parseProxySearchParams,
  serializeProxySearchResponse,
} from "./proxy.server";

/**
 * Widget↔route contract, with NO stub between the widget's real request
 * serialization and the route's real parsing (YOY-60 AC-4). The M3 live run
 * failed exactly in that unpinned gap; here the widget's own client builds
 * the request, fetch is captured at the network boundary, and the captured
 * URL feeds the same parse functions the route's loader calls. The response
 * direction is pinned the same way: the route's real serializer produces
 * the body the client really consumes.
 */

// The wire form of an echoed intent — a previous response's `intent` field,
// absent optionals as null — exactly what the widget holds and echoes back.
const WIRE_INTENT = {
  category: "dress",
  priceMin: null,
  priceMax: 400,
  currency: "ILS",
  colorsInclude: [],
  colorsExclude: ["black"],
  occasion: null,
  size: null,
  availabilityRequired: false,
  softAttributes: ["elegant"],
};

const ORCHESTRATOR_RESPONSE = {
  searchId: "search-contract-1",
  route: "ai",
  degraded: false,
  routeReason: "internal-only-must-not-leak",
  hits: [
    {
      productId: "gid://shopify/Product/1",
      title: "Silk Gown",
      handle: "silk-gown",
      imageUrl: null,
      priceMin: 350,
      priceMax: 350,
      currencyCode: "ILS",
      available: true,
    },
  ],
  chips: [{ field: "priceMax", value: "400" }],
  intent: null,
  closeMatches: [],
} as unknown as SearchResponse;

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function captureFetch(captured: CapturedRequest[]): void {
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      captured.push({ url: input, init });
      return Promise.resolve(
        Response.json(serializeProxySearchResponse(ORCHESTRATOR_RESPONSE)),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search request: widget serialization → route parsing", () => {
  it("round-trips a refinement request with previousIntent and removeChip", async () => {
    const captured: CapturedRequest[] = [];
    captureFetch(captured);

    const client = createSearchClient();
    await client.search("elegant dress", "session-1", {
      previousIntent: WIRE_INTENT,
      removeChip: { field: "priceMax", value: "400" },
    });

    expect(captured).toHaveLength(1);
    // The fault class this incident exposed: a browser POST cannot ride the
    // app proxy (the edge 400s any POST carrying Origin), so the widget
    // must send a bodiless GET.
    expect(captured[0].init?.method).toBe("GET");
    expect(captured[0].init?.body).toBeUndefined();

    const url = new URL(captured[0].url, "https://shop.example");
    expect(url.pathname).toBe("/apps/unfiltered/search");

    const parsed = parseProxySearchParams(url.searchParams);
    expect(parsed).not.toBeNull();
    expect(parsed?.query).toBe("elegant dress");
    expect(parsed?.sessionId).toBe("session-1");
    expect(parsed?.removeChip).toEqual({ field: "priceMax", value: "400" });
    // parseIntent normalizes the wire nulls away; the constraints survive.
    expect(parsed?.previousIntent).toMatchObject({
      category: "dress",
      priceMax: 400,
      colorsExclude: ["black"],
      availabilityRequired: false,
    });
    expect(parsed?.previousIntent?.priceMin).toBeUndefined();
  });

  it("omits previousIntent entirely on a new search (YOY-49 AC-5)", async () => {
    const captured: CapturedRequest[] = [];
    captureFetch(captured);

    await createSearchClient().search("snowboard", "session-2");

    const url = new URL(captured[0].url, "https://shop.example");
    expect(url.searchParams.has("previousIntent")).toBe(false);
    expect(url.searchParams.has("removeChip")).toBe(false);
    const parsed = parseProxySearchParams(url.searchParams);
    expect(parsed).toEqual({ query: "snowboard", sessionId: "session-2" });
  });

  it("round-trips a keystroke preview and omits mode on submitted searches (YOY-68)", async () => {
    const captured: CapturedRequest[] = [];
    captureFetch(captured);

    const client = createSearchClient();
    await client.search("snowb", "session-5", { preview: true });
    await client.search("snowboard", "session-5");

    const previewUrl = new URL(captured[0]!.url, "https://shop.example");
    expect(previewUrl.searchParams.get("mode")).toBe("preview");
    const preview = parseProxySearchParams(previewUrl.searchParams);
    expect(preview).toEqual({
      query: "snowb",
      sessionId: "session-5",
      mode: "preview",
    });

    // The submitted search carries NO mode parameter — its absence is what
    // runs the full pipeline.
    const submitUrl = new URL(captured[1]!.url, "https://shop.example");
    expect(submitUrl.searchParams.has("mode")).toBe(false);
    expect(parseProxySearchParams(submitUrl.searchParams)).toEqual({
      query: "snowboard",
      sessionId: "session-5",
    });
  });

  it("round-trips a Hebrew query and coexists with Shopify's signed proxy params", async () => {
    const captured: CapturedRequest[] = [];
    captureFetch(captured);

    await createSearchClient().search("שמלה אלגנטית לערב", "session-3");

    const url = new URL(captured[0].url, "https://shop.example");
    // Shopify's edge appends its own signed params to the same query
    // string before forwarding; parsing must not read or trip on them.
    url.searchParams.set("shop", "unfiltered-dev.myshopify.com");
    url.searchParams.set("path_prefix", "/apps/unfiltered");
    url.searchParams.set("timestamp", "1754750000");
    url.searchParams.set("signature", "deadbeef");

    const parsed = parseProxySearchParams(url.searchParams);
    expect(parsed?.query).toBe("שמלה אלגנטית לערב");
  });
});

describe("search response: route serialization → widget consumption", () => {
  it("the client returns exactly the serialized contract body", async () => {
    const captured: CapturedRequest[] = [];
    captureFetch(captured);

    const response = await createSearchClient().search("gown", "session-4");
    expect(response.searchId).toBe("search-contract-1");
    expect(response.route).toBe("ai");
    expect(response.results).toEqual(ORCHESTRATOR_RESPONSE.hits);
    expect(response.chips).toEqual([{ field: "priceMax", value: "400" }]);
    // The serializer's explicit re-mapping keeps internals off the wire.
    expect(response).not.toHaveProperty("routeReason");
  });
});

describe("click beacon: widget serialization → route parsing", () => {
  it("round-trips the beacon over a bodiless GET", async () => {
    const captured: CapturedRequest[] = [];
    captureFetch(captured);

    createSearchClient().sendClickBeacon({
      searchId: "search-contract-1",
      sessionId: "session-1",
      productId: "gid://shopify/Product/1",
      position: 2,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].init?.method).toBe("GET");
    expect(captured[0].init?.body).toBeUndefined();
    expect(captured[0].init?.keepalive).toBe(true);

    const url = new URL(captured[0].url, "https://shop.example");
    expect(url.pathname).toBe("/apps/unfiltered/click");
    expect(parseClickBeaconParams(url.searchParams)).toEqual({
      searchId: "search-contract-1",
      sessionId: "session-1",
      productId: "gid://shopify/Product/1",
      position: 2,
    });
  });
});
