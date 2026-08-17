import { describe, expect, it } from "vitest";

import { createFakeStore } from "../testing/fake-store.server";
import {
  BACKOFF_BASE_MS,
  createPoliteFetch,
  MAX_RETRIES,
  parseRetryAfterMs,
  parseRobotsRules,
  PoliteFetchError,
  POLITE_USER_AGENT_PRODUCT,
  robotsAllows,
  RobotsDisallowedError,
} from "./polite-fetch.server";

// Polite fetch (YOY-88 AC-5): identifying UA, timeout, Retry-After backoff,
// one in-flight request per host, robots.txt honored. Every test runs against
// the in-memory fake store — no network anywhere.

const CONTACT = "https://playground.example";
const ORIGIN = "https://demo-store.example";

function instantSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("identity and defaults", () => {
  it("sends the identifying User-Agent with the contact URL on every request (AC-5)", async () => {
    const store = createFakeStore({ "/robots.txt": "", "/products.json": { products: [] } });
    const polite = createPoliteFetch({ contactUrl: CONTACT, fetch: store.fetch });
    const response = await polite.fetch(`${ORIGIN}/products.json`);
    expect(response.ok).toBe(true);
    expect(polite.userAgent).toBe(`${POLITE_USER_AGENT_PRODUCT} (+${CONTACT})`);
    for (const request of store.requests) {
      expect(request.headers["User-Agent"]).toBe(`UnfilteredBot/1.0 (+${CONTACT})`);
    }
    // robots.txt was consulted first, once.
    expect(store.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/robots.txt",
      "/products.json",
    ]);
    expect(polite.stats).toEqual({ requests: 2, retries: 0, robotsSkipped: 0 });
  });

  it("times out a hanging request and reports it as a PoliteFetchError", async () => {
    const hanging = createPoliteFetch({
      contactUrl: CONTACT,
      timeoutMs: 20,
      respectRobots: false,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    await expect(hanging.fetch(`${ORIGIN}/products.json`)).rejects.toMatchObject({
      name: "PoliteFetchError",
      message: expect.stringContaining("timed out after 20 ms"),
    });
  });
});

describe("Retry-After backoff (AC-5)", () => {
  it("honors Retry-After seconds on 429 and 503, then succeeds", async () => {
    let attempts = 0;
    const store = createFakeStore({
      "/robots.txt": "",
      "/products.json": (call) => {
        attempts = call;
        if (call === 1) {
          return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } });
        }
        if (call === 2) {
          return new Response("busy", { status: 503, headers: { "Retry-After": "5" } });
        }
        return { products: [] };
      },
    });
    const { sleep, waits } = instantSleep();
    const polite = createPoliteFetch({ contactUrl: CONTACT, fetch: store.fetch, sleep });
    const response = await polite.fetch(`${ORIGIN}/products.json`);
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
    // Retry-After wins over the exponential base when it is larger.
    expect(waits).toEqual([2000, 5000]);
    expect(polite.stats.retries).toBe(2);
  });

  it("backs off exponentially without Retry-After and gives up after MAX_RETRIES", async () => {
    const store = createFakeStore({
      "/robots.txt": "",
      "/products.json": () => new Response("busy", { status: 503 }),
    });
    const { sleep, waits } = instantSleep();
    const polite = createPoliteFetch({ contactUrl: CONTACT, fetch: store.fetch, sleep });
    await expect(polite.fetch(`${ORIGIN}/products.json`)).rejects.toBeInstanceOf(
      PoliteFetchError,
    );
    expect(waits).toEqual(
      Array.from({ length: MAX_RETRIES }, (_, i) => BACKOFF_BASE_MS * 2 ** i),
    );
    // 1 robots + 1 first attempt + MAX_RETRIES retries.
    expect(polite.stats.requests).toBe(2 + MAX_RETRIES);
  });

  it("parses Retry-After as seconds or as an HTTP date", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("garbage")).toBeNull();
    const now = Date.parse("2026-08-17T12:00:00Z");
    expect(parseRetryAfterMs("Mon, 17 Aug 2026 12:00:10 GMT", now)).toBe(10_000);
  });
});

describe("one request in flight per host (AC-5)", () => {
  it("serializes concurrent requests to the same host, keeps hosts independent", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const perHost = new Map<string, number>();
    const fetch = async (input: string) => {
      const host = new URL(input).host;
      inFlight += 1;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Two same-host requests must never overlap.
      expect(perHost.get(host)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      perHost.set(host, 0);
      inFlight -= 1;
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    };
    const polite = createPoliteFetch({ contactUrl: CONTACT, fetch, respectRobots: false });
    await Promise.all([
      polite.fetch("https://a.example/1"),
      polite.fetch("https://a.example/2"),
      polite.fetch("https://a.example/3"),
      polite.fetch("https://b.example/1"),
    ]);
    // Cross-host requests did overlap (b ran alongside a).
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("per-host concurrency and spacing (YOY-89 AC-1)", () => {
  it("allows up to maxInFlightPerHost requests at once and spaces request starts by minSpacingMs", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    };
    let clock = 0;
    const waits: number[] = [];
    const polite = createPoliteFetch({
      contactUrl: CONTACT,
      fetch,
      respectRobots: false,
      maxInFlightPerHost: 4,
      minSpacingMs: 250,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => polite.fetch(`https://a.example/${i}`)));
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // Every start after the first waited for the 250 ms spacing.
    expect(waits).toHaveLength(5);
    expect(waits.every((ms) => ms === 250)).toBe(true);
    expect(polite.stats.requests).toBe(6);
  });
});

describe("robots.txt (AC-5)", () => {
  it("skips a disallowed path without fetching it and counts the skip", async () => {
    const store = createFakeStore({
      "/robots.txt": "User-agent: *\nDisallow: /products.json\n",
      "/products.json": { products: [] },
      "/meta.json": { currency: "ILS" },
    });
    const polite = createPoliteFetch({ contactUrl: CONTACT, fetch: store.fetch });
    await expect(polite.fetch(`${ORIGIN}/products.json?limit=1`)).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    // Allowed paths on the same host still go through; robots read once.
    expect((await polite.fetch(`${ORIGIN}/meta.json`)).ok).toBe(true);
    expect(store.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/robots.txt",
      "/meta.json",
    ]);
    expect(polite.stats.robotsSkipped).toBe(1);
  });

  it("prefers our own agent's group over *, and treats a missing robots.txt as allow-all", async () => {
    const ours = parseRobotsRules(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: UnfilteredBot",
        "Disallow: /cart",
        "Allow: /cart/public",
      ].join("\n"),
    );
    expect(robotsAllows(ours, "/products.json")).toBe(true);
    expect(robotsAllows(ours, "/cart.js")).toBe(false);
    expect(robotsAllows(ours, "/cart/public")).toBe(true);

    const wildcard = parseRobotsRules("User-agent: *\nDisallow: /*.json$\nDisallow: /private/");
    expect(robotsAllows(wildcard, "/products.json")).toBe(false);
    expect(robotsAllows(wildcard, "/products.json?limit=1")).toBe(true);
    expect(robotsAllows(wildcard, "/private/x")).toBe(false);
    expect(robotsAllows(wildcard, "/products/x")).toBe(true);

    expect(robotsAllows(parseRobotsRules(""), "/anything")).toBe(true);
    // Empty Disallow allows everything.
    expect(robotsAllows(parseRobotsRules("User-agent: *\nDisallow:"), "/x")).toBe(true);

    const store = createFakeStore({ "/products.json": { products: [] } });
    const polite = createPoliteFetch({ contactUrl: CONTACT, fetch: store.fetch });
    expect((await polite.fetch(`${ORIGIN}/products.json`)).ok).toBe(true);
  });
});
