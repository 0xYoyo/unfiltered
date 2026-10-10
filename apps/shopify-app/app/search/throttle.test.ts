import { describe, expect, it } from "vitest";

import {
  allowanceAcross,
  createSessionThrottle,
  previewExtractionAllowance,
  previewExtractionLimitFromEnv,
  throttleLimitFromEnv,
} from "./throttle.server";

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

  it("sweeps abandoned sessions once their window slides clear (YOY-52 AC-6)", () => {
    const clock = fakeClock();
    const throttle = createSessionThrottle({
      windowMs: 60_000,
      now: clock.now,
      sweepEvery: 10,
    });

    // Many one-shot sessions that never revisit.
    for (let i = 0; i < 100; i += 1) {
      throttle.recordAiSearch(`abandoned-${i}`);
    }
    expect(throttle.sessionCount()).toBe(100);

    // Their windows slide clear; per-session pruning alone would never see
    // them again. The next sweepEvery-th call collects every expired entry.
    clock.advance(61_000);
    for (let i = 0; i < 10; i += 1) {
      throttle.shouldThrottle("active");
    }
    expect(throttle.sessionCount()).toBe(0);

    // A still-active session survives the sweep.
    throttle.recordAiSearch("active");
    clock.advance(30_000);
    for (let i = 0; i < 100; i += 1) {
      throttle.recordAiSearch(`abandoned-b-${i}`);
    }
    clock.advance(31_000); // active's entry is now expired too, batch b's not
    for (let i = 0; i < 10; i += 1) {
      throttle.shouldThrottle("probe");
    }
    expect(throttle.sessionCount()).toBe(100);
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

describe("the preview-extraction allowance (YOY-171 AC-13)", () => {
  it("defaults to 30 a minute and reads PREVIEW_EXTRACTIONS_PER_MINUTE", () => {
    expect(previewExtractionLimitFromEnv({})).toBe(30);
    expect(previewExtractionLimitFromEnv({ PREVIEW_EXTRACTIONS_PER_MINUTE: "5" })).toBe(5);
    expect(previewExtractionLimitFromEnv({ PREVIEW_EXTRACTIONS_PER_MINUTE: "0" })).toBe(30);
    expect(previewExtractionLimitFromEnv({ PREVIEW_EXTRACTIONS_PER_MINUTE: "lots" })).toBe(30);
  });

  it("spends one slot per allowed call, per key, and refuses past the limit", () => {
    const throttle = createSessionThrottle({ limit: 2 });
    const allow = previewExtractionAllowance(throttle, "ip-a");
    expect([allow(), allow(), allow()]).toEqual([true, true, false]);
    expect(previewExtractionAllowance(throttle, "ip-b")()).toBe(true);
  });
});

describe("an allowance across buckets (YOY-171 AC-15)", () => {
  it("is refused when any bucket is spent, and spends one slot in every bucket when granted", () => {
    const session = createSessionThrottle({ limit: 5 });
    const shop = createSessionThrottle({ limit: 2 });
    const allow = (sessionId: string) =>
      allowanceAcross([
        [session, sessionId],
        [shop, "shop.myshopify.com"],
      ])();
    // Rotating the session does not reset the shop's bucket.
    expect([allow("a"), allow("b"), allow("c")]).toEqual([true, true, false]);
    // The refused call spent nothing in the session bucket.
    expect(session.shouldThrottle("c")).toBe(false);
  });
});
