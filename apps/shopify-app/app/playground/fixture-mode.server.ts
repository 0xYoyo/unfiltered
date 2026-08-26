/**
 * Fixture mode for the playground UI lane (YOY-92 AC-8).
 *
 * With `PLAYGROUND_FIXTURES=1` the playground API answers from committed
 * JSON instead of the orchestrator, so the Playwright lane needs no
 * database, no Gemini key, and no network. The fixture is chosen by the
 * query text, which keeps every UI state one `page.goto` away and keeps the
 * selection visible in the test rather than hidden in a harness.
 *
 * The flag is read per request rather than at module load: a route module
 * evaluated once at boot would otherwise freeze the mode for the process,
 * and the tests that assert the guard is off would need a separate server.
 */

import aiChipRemovedFixture from "./fixtures/ai-chip-removed.json";
import aiReuseFixture from "./fixtures/ai-reuse.json";
import aiZeroHitFixture from "./fixtures/ai-zero-hit.json";
import aiFixture from "./fixtures/ai.json";
import colorUnknownFixture from "./fixtures/color-unknown.json";
import degradedFixture from "./fixtures/degraded.json";
import emptyFixture from "./fixtures/empty.json";
import previewFixture from "./fixtures/preview.json";
import resultsFixture from "./fixtures/results.json";

import type { PlaygroundSearchResponse } from "./api.server";

export const PLAYGROUND_FIXTURES_ENV = "PLAYGROUND_FIXTURES";

/** Named fixture behaviours, selected by a token in the query text. */
export type PlaygroundFixtureName =
  | "results"
  | "empty"
  | "error"
  | "timeout"
  | "delayed"
  | "preview"
  // YOY-93: the AI states.
  | "ai"
  | "ai-chip-removed"
  | "ai-zero-hit"
  | "ai-delayed"
  | "ai-reuse"
  | "degraded"
  | "color-unknown";

/** How long the `delayed` fixture waits — long enough to observe loading. */
export const FIXTURE_DELAY_MS = 700;

/**
 * Long enough that any client timeout fires first, short enough that a hung
 * request cannot outlive the test run.
 */
export const FIXTURE_TIMEOUT_MS = 30_000;

export function playgroundFixturesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PLAYGROUND_FIXTURES_ENV] === "1";
}

/**
 * Query text → fixture. A submitted search naming no fixture gets
 * `results`; a preview gets the shorter `preview` set, because a preview
 * that returned the submitted set would hide exactly the difference the
 * lane exists to prove.
 */
export function selectFixture(
  query: string,
  preview: boolean,
): PlaygroundFixtureName {
  // Whole words, not substrings: "ai" appears inside "rail", "plain", and
  // "available", so a substring match routed the `empty rail` query to the
  // AI fixture. Selection has to be predictable from reading the query.
  const words = new Set(query.toLowerCase().split(/[^a-z]+/i));
  const has = (word: string): boolean => words.has(word);

  // A preview is classic-only by contract, so it can never select an AI
  // fixture however it is worded (AC-1: chips never render on a preview).
  if (!preview) {
    if (has("zero")) {
      return "ai-zero-hit";
    }
    if (has("reuse")) {
      // Exact-query intent reuse (YOY-64 AC-4): the AI answer served from a
      // stored intent — reason "intent-reuse", no classify/intent stages.
      return "ai-reuse";
    }
    if (has("degraded")) {
      return "degraded";
    }
    if (has("color")) {
      return "color-unknown";
    }
    if (has("ai")) {
      return has("delayed") ? "ai-delayed" : "ai";
    }
  }

  for (const name of ["empty", "error", "timeout", "delayed"] as const) {
    if (has(name)) {
      return name;
    }
  }
  return preview ? "preview" : "results";
}

export interface FixtureOutcome {
  /** Milliseconds to wait before answering. */
  delayMs: number;
  status: number;
  body: PlaygroundSearchResponse | null;
}

export function fixtureOutcome(
  name: PlaygroundFixtureName,
): FixtureOutcome {
  switch (name) {
    case "empty":
      return { delayMs: 0, status: 200, body: asResponse(emptyFixture) };
    case "error":
      return { delayMs: 0, status: 500, body: null };
    case "timeout":
      return { delayMs: FIXTURE_TIMEOUT_MS, status: 200, body: null };
    case "delayed":
      return {
        delayMs: FIXTURE_DELAY_MS,
        status: 200,
        body: asResponse(resultsFixture),
      };
    case "preview":
      return { delayMs: 0, status: 200, body: asResponse(previewFixture) };
    case "results":
      return { delayMs: 0, status: 200, body: asResponse(resultsFixture) };
    case "ai":
      return { delayMs: 0, status: 200, body: asResponse(aiFixture) };
    case "ai-chip-removed":
      return {
        delayMs: 0,
        status: 200,
        body: asResponse(aiChipRemovedFixture),
      };
    case "ai-reuse":
      return { delayMs: 0, status: 200, body: asResponse(aiReuseFixture) };
    case "ai-zero-hit":
      return { delayMs: 0, status: 200, body: asResponse(aiZeroHitFixture) };
    case "ai-delayed":
      return {
        delayMs: FIXTURE_DELAY_MS,
        status: 200,
        body: asResponse(aiFixture),
      };
    case "degraded":
      return { delayMs: 0, status: 200, body: asResponse(degradedFixture) };
    case "color-unknown":
      return {
        delayMs: 0,
        status: 200,
        body: asResponse(colorUnknownFixture),
      };
  }
}

function asResponse(fixture: unknown): PlaygroundSearchResponse {
  return fixture as PlaygroundSearchResponse;
}

/**
 * Chip removal answers a contract-correct echo (AC-7): the same search with
 * the dismissed constraint gone from BOTH the chip row and the intent, and
 * the products it had excluded back in the set. Serving the unchanged AI
 * fixture would let a broken remove-and-re-render pass its test.
 *
 * Only the `colorsExclude` chip has a recorded echo, because that is the one
 * the specs remove; any other chip falls through to the plain AI fixture
 * rather than pretending to a change the fixture cannot represent.
 */
export function selectFixtureForRemoval(
  removeChip: { field: string; value: string } | null,
): PlaygroundFixtureName {
  return removeChip !== null && removeChip.field === "colorsExclude"
    ? "ai-chip-removed"
    : "ai";
}

export function sleep(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The catalog registry the UI lane sees (YOY-94 AC-4). Fixture mode answers
 * from this map instead of `PlaygroundCatalog`, so the store-preload page
 * and its unknown-slug path are both reachable without a database. Exactly
 * one slug is known; everything else is unknown, which is what makes the
 * 404 page testable.
 */
export const FIXTURE_CATALOGS: Record<
  string,
  { name: string; productCount: number; storeKey: string }
> = {
  "demo-store": {
    name: "Demo Store",
    productCount: 120,
    storeKey: "playground:demo-store",
  },
};

export function fixtureCatalog(
  slug: string,
): { name: string; productCount: number; storeKey: string } | null {
  return FIXTURE_CATALOGS[slug] ?? null;
}
