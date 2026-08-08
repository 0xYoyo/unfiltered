import { describe, expect, it } from "vitest";

import { createSessionThrottle, throttleLimitFromEnv } from "./throttle.server";

// Sliding-window throttle unit tests (YOY-47 AC-4) with a controllable
// clock; the route-level behavior (forced classic, no LLM calls) is covered
// in proxy-search.test.ts.

function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("createSessionThrottle", () => {
  it("throttles a session only once its window budget is spent", () => {
    const clock = fakeClock();
    const throttle = createSessionThrottle({ limit: 2, now: clock.now });

    expect(throttle.shouldThrottle("s1")).toBe(false);
    throttle.recordAiSearch("s1");
    expect(throttle.shouldThrottle("s1")).toBe(false);
    throttle.recordAiSearch("s1");
    expect(throttle.shouldThrottle("s1")).toBe(true);
  });

  it("slides: the window clearing restores the budget", () => {
    const clock = fakeClock();
    const throttle = createSessionThrottle({
      limit: 2,
      windowMs: 60_000,
      now: clock.now,
    });

    throttle.recordAiSearch("s1");
    clock.advance(30_000);
    throttle.recordAiSearch("s1");
    expect(throttle.shouldThrottle("s1")).toBe(true);

    // 31s later the first search is out of the window; one slot is free.
    clock.advance(31_000);
    expect(throttle.shouldThrottle("s1")).toBe(false);

    // Another 30s and the second is out too.
    clock.advance(30_000);
    expect(throttle.shouldThrottle("s1")).toBe(false);
    throttle.recordAiSearch("s1");
    throttle.recordAiSearch("s1");
    expect(throttle.shouldThrottle("s1")).toBe(true);
  });

  it("tracks sessions independently", () => {
    const throttle = createSessionThrottle({ limit: 1, now: fakeClock().now });
    throttle.recordAiSearch("s1");
    expect(throttle.shouldThrottle("s1")).toBe(true);
    expect(throttle.shouldThrottle("s2")).toBe(false);
  });
});

describe("throttleLimitFromEnv", () => {
  it("defaults to 10 and rejects invalid values", () => {
    expect(throttleLimitFromEnv({})).toBe(10);
    expect(throttleLimitFromEnv({ SEARCH_AI_THROTTLE_PER_MINUTE: "25" })).toBe(
      25,
    );
    expect(throttleLimitFromEnv({ SEARCH_AI_THROTTLE_PER_MINUTE: "0" })).toBe(
      10,
    );
    expect(throttleLimitFromEnv({ SEARCH_AI_THROTTLE_PER_MINUTE: "-3" })).toBe(
      10,
    );
    expect(
      throttleLimitFromEnv({ SEARCH_AI_THROTTLE_PER_MINUTE: "many" }),
    ).toBe(10);
  });
});
