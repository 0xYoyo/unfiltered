import { describe, expect, it } from "vitest";

import {
  createEscalatingIntentExtractor,
  DEFAULT_INTENT_ESCALATION_THRESHOLD,
  DEFAULT_INTENT_HEDGE_AFTER_MS,
  INTENT_ESCALATION_CLASSES,
  matchIntentEscalationClass,
  type Intent,
  type IntentExtractionContext,
  type IntentExtractor,
} from "../src/index.js";

// The lite-first ladder (YOY-116 AC-2, AC-4): which tier answers, how many
// calls each path makes, and that both tiers see the same context. Tiers are
// stubs; the real models sit behind the consumer's ports.

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    colorsInclude: [],
    colorsExclude: [],
    availabilityRequired: false,
    softAttributes: [],
    ...overrides,
  };
}

/** A stub tier that answers a fixed intent and logs its calls. */
function tier(answer: Intent) {
  const calls: Array<{ query: string; context?: IntentExtractionContext }> = [];
  const extractor: IntentExtractor = {
    async extract(query, context) {
      calls.push({ query, context });
      return answer;
    },
  };
  return { extractor, calls };
}

describe("escalation classes (AC-2)", () => {
  it("names occasion-bearing queries in EN and HE, as whole words in EN", () => {
    for (const query of [
      "something to wear to a wedding",
      "party dress in stock under 400",
      "beige office skirt under 200",
      "leather jacket for a night out",
      "Gala gown",
      "שמלה לחתונה בקיץ",
      "חצאית מיני שחורה למסיבה",
      "מעיל לעבודה",
      "נעליים לערב",
    ]) {
      expect(matchIntentEscalationClass(query)?.name, query).toBe("occasion");
    }
  });

  it("names mixed Hebrew/Latin queries — the lite tier's one eval miss on YOY-116", () => {
    for (const query of [
      "מעיל winter אלגנטי בצבע camel",
      "נעלי עקב elegant בצבע red",
      "accessory אלגנטי בצבע white",
    ]) {
      expect(matchIntentEscalationClass(query)?.name, query).toBe("mixed-script");
    }
    // Digits and punctuation beside one script are not mixed script.
    expect(matchIntentEscalationClass("שמלה שחורה מתחת ל-400")).toBeNull();
    expect(matchIntentEscalationClass("dress under 400, size M")).toBeNull();
  });

  it("leaves plain product queries to the lite tier", () => {
    for (const query of [
      "linen shirt under 300",
      "warm winter coat under 500, not black",
      "white sneakers",
      "cozy cashmere sweater for cold winter evenings",
      "שמלה שחורה מתחת ל-400",
      "network cable",
      "homework planner",
      // "sleeveless": contains לים (to the beach) as a substring only.
      "בלי שרוולים",
      "שמלה בלי שרוולים",
    ]) {
      expect(matchIntentEscalationClass(query), query).toBeNull();
    }
  });

  it("commits exactly the documented classes with a name and a description each", () => {
    expect(INTENT_ESCALATION_CLASSES.map((entry) => entry.name)).toEqual(["mixed-script", "occasion"]);
    for (const entry of INTENT_ESCALATION_CLASSES) {
      expect(entry.description.length).toBeGreaterThan(10);
    }
    expect(DEFAULT_INTENT_ESCALATION_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_INTENT_ESCALATION_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe("the lite-first ladder (AC-2)", () => {
  const context = { storeId: "s", searchId: "search-1" };

  it("answers from the lite tier alone when its confidence clears the threshold", async () => {
    const lite = tier(intent({ category: "top", confidence: 0.95 }));
    const accuracy = tier(intent({ category: "dress", confidence: 1 }));
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      threshold: 0.8,
    });

    const result = await ladder.extractDetailed("linen shirt under 300", context);
    expect(result.tier).toBe("lite");
    expect(result.escalation).toBeNull();
    expect(result.intent.category).toBe("top");
    expect(lite.calls).toHaveLength(1);
    expect(accuracy.calls).toHaveLength(0);
    // Both ports see the caller's context verbatim.
    expect(lite.calls[0]!.context).toEqual(context);
    // extract() is the same ladder, tier dropped.
    expect((await ladder.extract("linen shirt under 300", context)).category).toBe("top");
  });

  it("escalates on low confidence: the accuracy answer replaces the lite one entirely", async () => {
    const lite = tier(intent({ category: "top", colorsInclude: ["red"], confidence: 0.4 }));
    const accuracy = tier(intent({ category: "dress", confidence: 0.9 }));
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      threshold: 0.8,
    });

    const result = await ladder.extractDetailed("a thing for the thing", context);
    expect(result.tier).toBe("accuracy");
    expect(result.escalation).toEqual({ kind: "low-confidence", confidence: 0.4 });
    expect(result.intent).toEqual(intent({ category: "dress", confidence: 0.9 }));
    expect(lite.calls).toHaveLength(1);
    expect(accuracy.calls).toHaveLength(1);
    expect(accuracy.calls[0]!.context).toEqual(context);
  });

  it("escalates on a missing confidence (an answer that did not report one)", async () => {
    const lite = tier(intent({ category: "top" }));
    const accuracy = tier(intent({ category: "dress", confidence: 0.9 }));
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
    });
    const result = await ladder.extractDetailed("mystery", context);
    expect(result.tier).toBe("accuracy");
    expect(result.escalation).toEqual({ kind: "low-confidence", confidence: null });
  });

  it("a class match goes straight to the accuracy tier with no lite call (co-manager clarification)", async () => {
    const lite = tier(intent({ category: "dress", confidence: 1 }));
    const accuracy = tier(intent({ category: "dress", occasion: "wedding", confidence: 0.9 }));
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
    });

    const result = await ladder.extractDetailed("something to wear to a wedding", context);
    expect(result.tier).toBe("accuracy");
    expect(result.escalation).toEqual({ kind: "class", name: "occasion" });
    expect(result.intent.occasion).toBe("wedding");
    expect(lite.calls).toHaveLength(0);
    expect(accuracy.calls).toHaveLength(1);
  });

  it("applies the same rules to a refinement, on the follow-up text (AC-4)", async () => {
    const previousIntent = intent({ category: "dress", priceMax: 400 });
    const lite = tier(intent({ category: "dress", priceMax: 300, confidence: 0.9 }));
    const accuracy = tier(intent({ category: "dress", priceMax: 300, occasion: "wedding", confidence: 0.9 }));
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
    });

    // A plain comparative follow-up: lite, confident → lite answers, and the
    // previous intent reached it.
    const cheaper = await ladder.extractDetailed("same but cheaper", { previousIntent });
    expect(cheaper.tier).toBe("lite");
    expect(lite.calls[0]!.context?.previousIntent).toBe(previousIntent);

    // A follow-up naming an occasion is a class match on the follow-up text.
    const wedding = await ladder.extractDetailed("for a wedding", { previousIntent });
    expect(wedding.tier).toBe("accuracy");
    expect(wedding.escalation).toEqual({ kind: "class", name: "occasion" });
    expect(accuracy.calls[0]!.context?.previousIntent).toBe(previousIntent);
  });

  it("uses the committed default threshold and rejects one outside [0, 1]", async () => {
    const lite = tier(intent({ confidence: DEFAULT_INTENT_ESCALATION_THRESHOLD }));
    const accuracy = tier(intent({ confidence: 1 }));
    // Exactly at the threshold stays lite: the floor is inclusive.
    const ladder = createEscalatingIntentExtractor({ lite: lite.extractor, accuracy: accuracy.extractor });
    expect((await ladder.extractDetailed("plain query")).tier).toBe("lite");
    expect(() =>
      createEscalatingIntentExtractor({ lite: lite.extractor, accuracy: accuracy.extractor, threshold: 1.5 }),
    ).toThrow(RangeError);
  });

  it("a lite-tier failure escalates to the accuracy tier rather than failing the search", async () => {
    // The r01 shape from YOY-116: the lite model hung on "same but cheaper".
    const lite: IntentExtractor = {
      async extract() {
        const error = new Error("lite call timed out");
        error.name = "GeminiTimeoutError";
        throw error;
      },
    };
    const accuracy = tier(intent({ category: "dress", priceMax: 300, confidence: 1 }));
    const ladder = createEscalatingIntentExtractor({ lite, accuracy: accuracy.extractor });
    const result = await ladder.extractDetailed("same but cheaper");
    expect(result.tier).toBe("accuracy");
    expect(result.escalation).toEqual({ kind: "lite-error", error: "GeminiTimeoutError" });
    expect(result.intent.priceMax).toBe(300);
    expect(accuracy.calls).toHaveLength(1);
  });

  it("propagates the accuracy tier's error unchanged: the ladder never invents an intent", async () => {
    const lite = tier(intent({ confidence: 0.1 }));
    const accuracy: IntentExtractor = {
      async extract() {
        throw new Error("accuracy backend down");
      },
    };
    const ladder = createEscalatingIntentExtractor({ lite: lite.extractor, accuracy });
    await expect(ladder.extract("plain query")).rejects.toThrow("accuracy backend down");
  });
});

describe("ladder deadline (YOY-64 AC-3)", () => {
  /** A tier that never answers on its own and honours the context's signal. */
  function hangingTier(name: string) {
    const calls: Array<{ query: string; context?: IntentExtractionContext }> = [];
    const extractor: IntentExtractor = {
      extract(query, context) {
        calls.push({ query, context });
        return new Promise<Intent>((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => {
            const error = new Error(`${name} call timed out`);
            error.name = "GeminiTimeoutError";
            reject(error);
          });
        });
      },
    };
    return { extractor, calls };
  }

  it("a hung lite call with no budget left degrades right there: no accuracy call", async () => {
    const lite = hangingTier("lite");
    const accuracy = tier(intent({ category: "dress", confidence: 1 }));
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      deadlineMs: 40,
    });
    const startedAt = performance.now();
    await expect(ladder.extractDetailed("plain query", { searchId: "s1" })).rejects.toMatchObject({
      name: "GeminiTimeoutError",
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(lite.calls).toHaveLength(1);
    expect(accuracy.calls).toHaveLength(0);
    // The tier saw the caller's context plus the ladder's signal.
    expect(lite.calls[0]!.context?.searchId).toBe("s1");
    expect(lite.calls[0]!.context?.signal?.aborted).toBe(true);
  });

  it("an accuracy call reached after a fast lite failure is cut at the same deadline", async () => {
    const lite: IntentExtractor = {
      async extract() {
        throw new Error("lite backend 503");
      },
    };
    const accuracy = hangingTier("accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite,
      accuracy: accuracy.extractor,
      deadlineMs: 40,
    });
    const startedAt = performance.now();
    await expect(ladder.extract("plain query")).rejects.toMatchObject({ name: "GeminiTimeoutError" });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(accuracy.calls).toHaveLength(1);
    expect(accuracy.calls[0]!.context?.signal?.aborted).toBe(true);
  });

  it("a class match's accuracy call is bounded by the deadline too", async () => {
    const lite = tier(intent({ confidence: 1 }));
    const accuracy = hangingTier("accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      deadlineMs: 40,
    });
    await expect(ladder.extract("something to wear to a wedding")).rejects.toMatchObject({
      name: "GeminiTimeoutError",
    });
    expect(lite.calls).toHaveLength(0);
    expect(accuracy.calls).toHaveLength(1);
  });

  it("combines the caller's own signal with the deadline, and passes the context through untouched without one", async () => {
    const lite = hangingTier("lite");
    const accuracy = tier(intent({ confidence: 1 }));
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      deadlineMs: 10_000,
    });
    const caller = new AbortController();
    const pending = ladder.extract("plain query", { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "GeminiTimeoutError" });
    expect(accuracy.calls).toHaveLength(0);

    // No deadline: the context object reaches the tier as given (no signal invented).
    const plainLite = tier(intent({ confidence: 1 }));
    const plain = createEscalatingIntentExtractor({ lite: plainLite.extractor, accuracy: accuracy.extractor });
    const context: IntentExtractionContext = { searchId: "s2" };
    await plain.extract("plain query", context);
    expect(plainLite.calls[0]!.context).toEqual(context);
    expect(plainLite.calls[0]!.context?.signal).toBeUndefined();
  });

  it("rejects a non-positive deadline", () => {
    const lite = tier(intent({ confidence: 1 }));
    const accuracy = tier(intent({ confidence: 1 }));
    expect(() =>
      createEscalatingIntentExtractor({ lite: lite.extractor, accuracy: accuracy.extractor, deadlineMs: 0 }),
    ).toThrow(RangeError);
  });
});

describe("hedged class escalation (YOY-64 AC-6)", () => {
  const context = { storeId: "s", searchId: "search-hedge" };

  function abortError(name: string) {
    const error = new Error(`${name} call aborted`);
    error.name = "GeminiTimeoutError";
    return error;
  }

  /** A stub tier that answers after `delayMs` unless aborted first. */
  function slowTier(answer: Intent, delayMs: number, name = "tier") {
    const calls: Array<{ query: string; context?: IntentExtractionContext; at: number }> = [];
    const extractor: IntentExtractor = {
      extract(query, context) {
        calls.push({ query, context, at: performance.now() });
        return new Promise<Intent>((resolve, reject) => {
          if (context?.signal?.aborted) {
            reject(abortError(name));
            return;
          }
          const timer = setTimeout(() => resolve(answer), delayMs);
          context?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortError(name));
          });
        });
      },
    };
    return { extractor, calls };
  }

  /** A stub tier that fails after `delayMs` with the named error. */
  function failingTier(errorName: string, delayMs: number) {
    const calls: Array<{ query: string; context?: IntentExtractionContext }> = [];
    const extractor: IntentExtractor = {
      extract(query, context) {
        calls.push({ query, context });
        return new Promise<Intent>((_resolve, reject) => {
          setTimeout(() => {
            const error = new Error(`${errorName} from the stub`);
            error.name = errorName;
            reject(error);
          }, delayMs);
        });
      },
    };
    return { extractor, calls };
  }

  /** A stub tier that never answers until its signal aborts. */
  function hangingTier(name: string) {
    return slowTier(intent(), 60_000, name);
  }

  it("commits a default hedge delay inside the ladder deadline the app wires (8000 ms)", () => {
    expect(DEFAULT_INTENT_HEDGE_AFTER_MS).toBeGreaterThan(0);
    expect(DEFAULT_INTENT_HEDGE_AFTER_MS).toBeLessThan(8000);
  });

  it("an accuracy answer inside the hedge delay is the whole story: no lite call at all", async () => {
    const lite = slowTier(intent({ category: "dress", confidence: 1 }), 0, "lite");
    const accuracy = slowTier(intent({ category: "dress", occasion: "wedding", confidence: 0.9 }), 5, "accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      hedgeAfterMs: 80,
    });
    const result = await ladder.extractDetailed("something to wear to a wedding", context);
    expect(result.tier).toBe("accuracy");
    expect(result.escalation).toEqual({ kind: "class", name: "occasion" });
    expect(lite.calls).toHaveLength(0);
    // The accuracy tier saw the caller's context.
    expect(accuracy.calls[0]!.context?.searchId).toBe("search-hedge");
  });

  it("past the hedge delay the lite tier runs alongside a pending accuracy call and its answer wins", async () => {
    // Deliberately below the confidence floor: the hedge is a latency
    // instrument, so a schema-valid lite answer wins regardless.
    const lite = slowTier(intent({ category: "dress", occasion: "wedding", confidence: 0.5 }), 5, "lite");
    const accuracy = hangingTier("accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      hedgeAfterMs: 20,
      deadlineMs: 2_000,
    });
    const startedAt = performance.now();
    const result = await ladder.extractDetailed("something to wear to a wedding", context);
    const elapsed = performance.now() - startedAt;
    expect(result.tier).toBe("lite");
    expect(result.escalation).toEqual({ kind: "hedge", name: "occasion", afterMs: 20 });
    expect(result.intent.occasion).toBe("wedding");
    expect(elapsed).toBeLessThan(500);
    // The hedge fired after the delay, not up front, with the caller's context.
    expect(lite.calls).toHaveLength(1);
    expect(lite.calls[0]!.at - startedAt).toBeGreaterThanOrEqual(15);
    expect(lite.calls[0]!.context?.searchId).toBe("search-hedge");
    // The loser was cancelled through its own signal.
    expect(accuracy.calls).toHaveLength(1);
    expect(accuracy.calls[0]!.context?.signal?.aborted).toBe(true);
  });

  it("the accuracy answer still wins when it lands before the hedge does, and the hedge is cancelled", async () => {
    const lite = slowTier(intent({ category: "dress", confidence: 1 }), 200, "lite");
    const accuracy = slowTier(intent({ category: "dress", occasion: "wedding", confidence: 0.9 }), 40, "accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      hedgeAfterMs: 10,
    });
    const result = await ladder.extractDetailed("something to wear to a wedding", context);
    expect(result.tier).toBe("accuracy");
    expect(result.escalation).toEqual({ kind: "class", name: "occasion" });
    expect(lite.calls).toHaveLength(1);
    expect(lite.calls[0]!.context?.signal?.aborted).toBe(true);
  });

  it("a failing hedge leaves the accuracy call to finish", async () => {
    const lite = failingTier("GeminiProviderError", 0);
    const accuracy = slowTier(intent({ category: "dress", occasion: "wedding", confidence: 0.9 }), 60, "accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      hedgeAfterMs: 10,
    });
    const result = await ladder.extractDetailed("something to wear to a wedding", context);
    expect(result.tier).toBe("accuracy");
    expect(lite.calls).toHaveLength(1);
  });

  it("an accuracy failure after the hedge fired waits for the hedge; only both failing rejects, with the accuracy error", async () => {
    const answered = createEscalatingIntentExtractor({
      lite: slowTier(intent({ category: "dress", occasion: "wedding", confidence: 0.9 }), 60, "lite").extractor,
      accuracy: failingTier("GeminiProviderError", 30).extractor,
      hedgeAfterMs: 10,
    });
    const result = await answered.extractDetailed("something to wear to a wedding", context);
    expect(result.tier).toBe("lite");
    expect(result.escalation).toEqual({ kind: "hedge", name: "occasion", afterMs: 10 });

    const bothFail = createEscalatingIntentExtractor({
      lite: failingTier("IntentExtractionError", 40).extractor,
      accuracy: failingTier("GeminiProviderError", 30).extractor,
      hedgeAfterMs: 10,
    });
    await expect(bothFail.extract("something to wear to a wedding", context)).rejects.toMatchObject({
      name: "GeminiProviderError",
    });
  });

  it("an accuracy failure before the hedge fires rejects at once, and no hedge is started", async () => {
    const lite = slowTier(intent({ confidence: 1 }), 0, "lite");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: failingTier("GeminiProviderError", 5).extractor,
      hedgeAfterMs: 80,
    });
    await expect(ladder.extract("something to wear to a wedding", context)).rejects.toMatchObject({
      name: "GeminiProviderError",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lite.calls).toHaveLength(0);
  });

  it("the hedge is bounded by the ladder deadline like both tiers (AC-3 holds)", async () => {
    const lite = hangingTier("lite");
    const accuracy = hangingTier("accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      hedgeAfterMs: 10,
      deadlineMs: 40,
    });
    const startedAt = performance.now();
    await expect(ladder.extract("something to wear to a wedding", context)).rejects.toMatchObject({
      name: "GeminiTimeoutError",
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(lite.calls).toHaveLength(1);
    expect(accuracy.calls).toHaveLength(1);
    expect(lite.calls[0]!.context?.signal?.aborted).toBe(true);
    expect(accuracy.calls[0]!.context?.signal?.aborted).toBe(true);
  });

  it("never hedges the accuracy call that follows a lite answer or a lite failure", async () => {
    const lite = slowTier(intent({ category: "dress", confidence: 0.1 }), 0, "lite");
    const accuracy = slowTier(intent({ category: "dress", confidence: 0.9 }), 40, "accuracy");
    const ladder = createEscalatingIntentExtractor({
      lite: lite.extractor,
      accuracy: accuracy.extractor,
      hedgeAfterMs: 5,
    });
    const result = await ladder.extractDetailed("plain query", context);
    expect(result.tier).toBe("accuracy");
    expect(result.escalation).toEqual({ kind: "low-confidence", confidence: 0.1 });
    // One lite call — the answer that escalated — and no second one as a hedge.
    expect(lite.calls).toHaveLength(1);
  });

  it("rejects a non-positive hedge delay", () => {
    const lite = slowTier(intent({ confidence: 1 }), 0);
    const accuracy = slowTier(intent({ confidence: 1 }), 0);
    for (const hedgeAfterMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createEscalatingIntentExtractor({ lite: lite.extractor, accuracy: accuracy.extractor, hedgeAfterMs }),
      ).toThrow(RangeError);
    }
  });
});
