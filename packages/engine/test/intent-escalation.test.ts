import { describe, expect, it } from "vitest";

import {
  createEscalatingIntentExtractor,
  DEFAULT_INTENT_ESCALATION_THRESHOLD,
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
