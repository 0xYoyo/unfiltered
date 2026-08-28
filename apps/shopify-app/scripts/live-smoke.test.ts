import { describe, expect, it } from "vitest";

import { createFakeStore, type FakeStore } from "../app/testing/fake-store.server";
import {
  formatSummary,
  loadConfig,
  parseArgs,
  readEngineSourceVersion,
  runSmoke,
  SMOKE_QUERIES,
  SmokeUsageError,
  type SmokeConfig,
} from "./live-smoke.mjs";

// The daily live smoke (YOY-112 AC-4) against an in-process fake deployment:
// no network, no database. The fake answers /healthz and
// /api/playground/search the way the real playground does, and each case
// bends exactly one answer to prove the matching assertion fires while the
// other three probes still run and report.

const VERSION = "9.9.9";
const CONFIG: SmokeConfig = { url: "https://fake.example", classicMaxMs: 1500, aiMaxMs: 6000 };

function searchBody(query: string, overrides: Record<string, unknown> = {}) {
  const ai = query !== SMOKE_QUERIES.classic;
  return {
    searchId: `search-${ai ? "ai" : "classic"}-${query.length}`,
    route: ai ? "ai" : "classic",
    degraded: false,
    results: [{ productId: "p1" }],
    chips: ai ? [{ field: "category", value: "dress" }] : [],
    intent: null,
    details: {
      routeReason: ai ? "model" : "short-query",
      latencyMs: ai ? 1800 : 24,
      limited: null,
      stages: {},
    },
    ...overrides,
  };
}

/** A healthy fake deployment; `bend` alters the answer for one query. */
function healthyStore(
  bend: (query: string) => Record<string, unknown> = () => ({}),
  version = VERSION,
): FakeStore {
  return createFakeStore({
    "/healthz": { status: "ok", engine: { version, search: { hits: [] } } },
    "/api/playground/search": (_call, url) => {
      const query = url.searchParams.get("query") ?? "";
      return searchBody(query, bend(query));
    },
  });
}

async function run(store: FakeStore) {
  const sessions: string[] = [];
  let counter = 0;
  const report = await runSmoke({
    url: CONFIG.url,
    config: CONFIG,
    expectedEngineVersion: VERSION,
    fetch: store.fetch,
    sessionId: () => {
      counter += 1;
      const id = `session-${counter}`;
      sessions.push(id);
      return id;
    },
    now: () => new Date("2026-08-27T06:00:00Z"),
  });
  return { report, sessions };
}

describe("live smoke (YOY-112)", () => {
  it("all green: four PASS probes, exit 0, every request a GET with a fresh sessionId", async () => {
    const store = healthyStore();
    const { report, sessions } = await run(store);

    expect(report.exitCode).toBe(0);
    expect(report.passed).toBe(4);
    expect(report.probes.map((probe) => [probe.name, probe.pass])).toEqual([
      ["healthz", true],
      ["classic", true],
      ["ai-en", true],
      ["ai-he", true],
    ]);
    // Exactly four requests, one per probe, all GET, three distinct sessions.
    expect(store.requests).toHaveLength(4);
    expect(store.requests[0]!.url).toBe("https://fake.example/healthz");
    expect(sessions).toEqual(["session-1", "session-2", "session-3"]);
    const submitted = store.requests.slice(1).map((request) => new URL(request.url));
    expect(submitted.map((url) => url.searchParams.get("query"))).toEqual([
      SMOKE_QUERIES.classic,
      SMOKE_QUERIES["ai-en"],
      SMOKE_QUERIES["ai-he"],
    ]);
    expect(new Set(submitted.map((url) => url.searchParams.get("sessionId"))).size).toBe(3);
    // The report carries the evidence fields per probe.
    expect(report.probes[2]).toMatchObject({
      searchId: expect.stringMatching(/^search-ai-/),
      latencyMs: 1800,
      route: "ai",
      routeReason: "model",
      chips: 1,
      failures: [],
    });
    expect(formatSummary(report)).toContain("4/4 passed → exit 0");
  });

  it("one failing probe: exit 1, the other three still run and pass", async () => {
    // The EN AI probe degrades to classic with no chips — the YOY-109 class.
    const store = healthyStore((query) =>
      query === SMOKE_QUERIES["ai-en"]
        ? { route: "classic", degraded: true, chips: [], details: { routeReason: "model", latencyMs: 900, limited: null, stages: {} } }
        : {},
    );
    const { report } = await run(store);

    expect(report.exitCode).toBe(1);
    expect(report.failed).toBe(1);
    expect(store.requests).toHaveLength(4);
    expect(report.probes.map((probe) => probe.pass)).toEqual([true, true, false, true]);
    expect(report.probes[2]!.failures).toEqual([
      'route is "classic", expected "ai"',
      "degraded is true, expected false",
      "chips: 0, expected ≥ 1 on the AI route",
    ]);
    const summary = formatSummary(report);
    expect(summary).toContain("FAIL  ai-en");
    expect(summary).toContain("3/4 passed → exit 1");
  });

  it("version mismatch fails the healthz probe and names both versions", async () => {
    const { report } = await run(healthyStore(() => ({}), "0.0.1"));

    expect(report.exitCode).toBe(1);
    expect(report.probes[0]!.pass).toBe(false);
    expect(report.probes[0]!.failures).toEqual([
      'engine.version is "0.0.1", expected "9.9.9" (packages/engine/src/index.ts)',
    ]);
    expect(report.probes.slice(1).every((probe) => probe.pass)).toBe(true);
  });

  it("a latency over its ceiling fails that probe only", async () => {
    const store = healthyStore((query) =>
      query === SMOKE_QUERIES.classic
        ? { details: { routeReason: "short-query", latencyMs: 1501, limited: null, stages: {} } }
        : query === SMOKE_QUERIES["ai-he"]
          ? { details: { routeReason: "model", latencyMs: 6000, limited: null, stages: {} } }
          : {},
    );
    const { report } = await run(store);

    expect(report.probes[1]!.failures).toEqual(["latencyMs 1501 > classicMaxMs 1500"]);
    // Exactly at the ceiling passes: the bar is inclusive.
    expect(report.probes[3]!.pass).toBe(true);
    expect(report.exitCode).toBe(1);
  });

  it("an unreachable host fails all four probes with the network error, still exit 1 not a throw", async () => {
    const store = createFakeStore({
      "*": () => {
        throw new TypeError("fetch failed");
      },
    });
    const { report } = await run(store);
    expect(report.exitCode).toBe(1);
    expect(report.probes.every((probe) => !probe.pass)).toBe(true);
    expect(report.probes[0]!.failures[0]).toContain("TypeError: fetch failed");
    expect(formatSummary(report)).toContain("0/4 passed → exit 1");
  });

  it("a non-200 healthz and a non-JSON body are reported, not thrown", async () => {
    const store = createFakeStore({
      "/healthz": new Response("gateway timeout", { status: 504 }),
      "/api/playground/search": (_call, url) => searchBody(url.searchParams.get("query") ?? ""),
    });
    const { report } = await run(store);
    expect(report.probes[0]!.failures).toEqual([
      "GET /healthz answered HTTP 504, expected 200",
      'engine.version is null, expected "9.9.9" (packages/engine/src/index.ts)',
    ]);
    expect(report.probes.slice(1).every((probe) => probe.pass)).toBe(true);
  });
});

describe("configuration", () => {
  // The ceilings were tightened from 1500/6000 on 2026-08-28 (YOY-124
  // AC-9b) once the M5 bars were held on the deployment: 800 ms sits above
  // the measured classic p95 (19-26 ms) with room for one slow sample, and
  // 3500 ms is docs/LATENCY.md's AI p95 bar itself, so a single AI sample
  // over it is the hedge-tail regression the canary exists to catch.
  it("the committed config names the Frankfurt origin and the tightened ceilings", () => {
    expect(loadConfig()).toEqual({
      url: "https://unfiltered-eu.onrender.com",
      classicMaxMs: 800,
      aiMaxMs: 3500,
    });
  });

  it("reads the engine version from the engine's source", () => {
    expect(readEngineSourceVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("parses --url and rejects anything else", () => {
    expect(parseArgs([])).toEqual({ url: null });
    expect(parseArgs(["--url", "https://x.example"])).toEqual({ url: "https://x.example" });
    expect(() => parseArgs(["--url"])).toThrow(SmokeUsageError);
    expect(() => parseArgs(["--verbose"])).toThrow(SmokeUsageError);
  });
});
