import { describe, expect, it } from "vitest";

import {
  FIXTURE_DELAY_MS,
  fixtureOutcome,
  playgroundFixturesEnabled,
  selectFixture,
} from "./fixture-mode.server";

/**
 * Fixture-mode routing (YOY-92 AC-8). The UI lane depends on the query text
 * choosing the fixture, and production depends on the whole branch being
 * unreachable without the flag.
 */

describe("the fixture flag", () => {
  it("is off unless PLAYGROUND_FIXTURES is exactly 1", () => {
    expect(playgroundFixturesEnabled({})).toBe(false);
    expect(playgroundFixturesEnabled({ PLAYGROUND_FIXTURES: "" })).toBe(false);
    expect(playgroundFixturesEnabled({ PLAYGROUND_FIXTURES: "0" })).toBe(false);
    expect(playgroundFixturesEnabled({ PLAYGROUND_FIXTURES: "true" })).toBe(
      false,
    );
    expect(playgroundFixturesEnabled({ PLAYGROUND_FIXTURES: "1" })).toBe(true);
  });
});

describe("fixture selection by query text", () => {
  it("routes each named state", () => {
    expect(selectFixture("empty rail", false)).toBe("empty");
    expect(selectFixture("error case", false)).toBe("error");
    expect(selectFixture("timeout case", false)).toBe("timeout");
    expect(selectFixture("delayed case", false)).toBe("delayed");
  });

  it("is case-insensitive", () => {
    expect(selectFixture("EMPTY", false)).toBe("empty");
  });

  it("defaults a submit to results and a preview to the preview set", () => {
    expect(selectFixture("dress", false)).toBe("results");
    expect(selectFixture("dress", true)).toBe("preview");
  });

  it("lets a named state win over the preview default, so previews are testable too", () => {
    expect(selectFixture("empty", true)).toBe("empty");
  });

  it("routes the AI states, and never on a preview (AC-1)", () => {
    expect(selectFixture("ai elegant dress", false)).toBe("ai");
    expect(selectFixture("ai zero hit", false)).toBe("ai-zero-hit");
    expect(selectFixture("ai delayed", false)).toBe("ai-delayed");
    expect(selectFixture("degraded", false)).toBe("degraded");
    expect(selectFixture("ai color beige", false)).toBe("color-unknown");
    // A preview is classic-only however it is worded.
    expect(selectFixture("ai elegant dress", true)).toBe("preview");
    expect(selectFixture("ai zero hit", true)).toBe("preview");
  });

  it("matches whole words, not substrings", () => {
    // "ai" lives inside "rail", "plain", and "available"; a substring match
    // sent `empty rail` to the AI fixture.
    expect(selectFixture("empty rail", false)).toBe("empty");
    expect(selectFixture("plain dress", false)).toBe("results");
    expect(selectFixture("available now", false)).toBe("results");
  });
});

describe("fixture outcomes", () => {
  it("answers the contract shape for the states that return a body", () => {
    for (const name of ["results", "preview", "empty"] as const) {
      const outcome = fixtureOutcome(name);
      expect(outcome.status).toBe(200);
      expect(outcome.delayMs).toBe(0);
      expect(outcome.body).not.toBeNull();
      expect(Object.keys(outcome.body!).sort()).toEqual(
        ["chips", "degraded", "details", "intent", "results", "route", "searchId"].sort(),
      );
      expect(Object.keys(outcome.body!.details).sort()).toEqual(
        ["intentTier", "latencyMs", "limited", "routeReason", "stages"].sort(),
      );
    }
  });

  it("returns cards the playground can render", () => {
    const results = fixtureOutcome("results").body!.results;
    expect(results.length).toBeGreaterThan(0);
    // The states the card rules name (AC-6) each have a card in the set: a
    // price range, a sold-out product, and a product with neither image nor
    // url.
    expect(results.some((card) => card.priceMin !== card.priceMax)).toBe(true);
    expect(results.some((card) => !card.available)).toBe(true);
    expect(
      results.some((card) => card.url === null && card.imageUrl === null),
    ).toBe(true);
  });

  it("answers the empty fixture with zero results, not an error", () => {
    const outcome = fixtureOutcome("empty");
    expect(outcome.status).toBe(200);
    expect(outcome.body!.results).toEqual([]);
  });

  it("answers error with a 500 and no body", () => {
    expect(fixtureOutcome("error")).toEqual({
      delayMs: 0,
      status: 500,
      body: null,
    });
  });

  it("holds the timeout fixture open long enough for any client timeout", () => {
    const outcome = fixtureOutcome("timeout");
    expect(outcome.delayMs).toBeGreaterThan(FIXTURE_DELAY_MS);
    expect(outcome.body).toBeNull();
  });

  it("delays the delayed fixture long enough to observe the loading state", () => {
    const outcome = fixtureOutcome("delayed");
    expect(outcome.delayMs).toBe(FIXTURE_DELAY_MS);
    expect(outcome.body!.results.length).toBeGreaterThan(0);
  });
});
