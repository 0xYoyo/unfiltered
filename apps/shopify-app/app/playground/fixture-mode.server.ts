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
  | "preview";

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
  const text = query.toLowerCase();
  for (const name of ["empty", "error", "timeout", "delayed"] as const) {
    if (text.includes(name)) {
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
  }
}

function asResponse(fixture: unknown): PlaygroundSearchResponse {
  return fixture as PlaygroundSearchResponse;
}

export function sleep(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}
