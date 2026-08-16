import { describe, expect, it } from "vitest";

import {
  CLASSIFICATION_SCHEMA,
  createQueryClassifier,
  normalizeQuery,
  type LlmClient,
  type QueryRoute,
  type StructuredCompletionRequest,
} from "../src/index.js";

// Classifier tests run on stubs only — no LLM network call anywhere in the
// default run (AC-5). Live classification lives in the app's
// classification-live.test.ts behind LIVE_LLM_TESTS=1.

/** LlmClient stub answering every call with the given route. */
function llmStub(route: QueryRoute | Error | "invalid" | "never") {
  const calls: StructuredCompletionRequest[] = [];
  const llm: LlmClient = {
    async completeStructured(request) {
      calls.push(request);
      if (route === "never") {
        return new Promise(() => {});
      }
      if (route instanceof Error) {
        throw route;
      }
      if (route === "invalid") {
        return { route: "banana" };
      }
      return { route };
    },
  };
  return { llm, calls };
}

/** LlmClient that must never be reached: proves the zero-call fast path. */
const throwingLlm: LlmClient = {
  completeStructured() {
    throw new Error("the heuristic fast path must not reach the LLM port");
  },
};

describe("normalizeQuery", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeQuery("  Nike  AIR  Max\t90 ")).toBe("nike air max 90");
    expect(normalizeQuery("שמלה   אלגנטית")).toBe("שמלה אלגנטית");
  });
});

describe("heuristic fast path (AC-1, AC-5)", () => {
  // Clearly-simple queries on both sides of the language boundary: decided
  // deterministically, with a throwing stub proving zero LLM-port calls.
  const classicFixtures: Array<[query: string, reason: string]> = [
    ["", "empty-query"],
    ["   ", "empty-query"],
    ['"linen midi dress"', "quoted-phrase"],
    ["nike air max 90", "sku-pattern"],
    ["SM-1234-XL", "sku-pattern"],
    ["SB-2024", "sku-pattern"],
    ["900", "sku-pattern"],
    ["snowboard", "short-query"],
    ["aurora dress", "short-query"],
    // Quoted-phrase intent is script-independent (YOY-67 AC-2): the
    // non-Latin guard exempts only the length/shape rules, not this one.
    ['"שמלת ערב"', "quoted-phrase"],
  ];

  for (const [query, reason] of classicFixtures) {
    it(`routes ${JSON.stringify(query)} to classic (${reason}) with zero LLM calls`, async () => {
      const classifier = createQueryClassifier({ llm: throwingLlm });
      expect(await classifier.classify(query)).toEqual({
        route: "classic",
        reason,
      });
    });
  }
});

describe("model escalation (AC-2, AC-5)", () => {
  // Natural-language queries the heuristics cannot settle: English, Hebrew,
  // and mixed — each escalates to the port and returns the model's decision.
  const aiFixtures = [
    "elegant summer wedding dress, not black, under 400 ils",
    "שמלה אלגנטית לחתונה בקיץ לא שחור",
    "שמלת מקסי elegant לחתונה בקיץ",
    // Price-bound numbers are not SKUs (YOY-29 AC-7): these short queries
    // carry price intent and must reach the model, not the sku-pattern rule.
    "dress under 400",
    "שמלה עד 400",
    // Constraint-shaped queries across the live-run misroute triggers
    // (YOY-61 AC-1): 2-word color+noun — EN and HE — and digit-bearing
    // price bounds with the Hebrew prepositional prefix. None of these may
    // be settled classic by the short-query or sku-pattern rules.
    "blue snowboard",
    "סנובורד כחול",
    "blue snowboard under 900",
    "סנובורד כחול מתחת ל-900",
    "red dress",
    // Digit-free Hebrew attribute+noun (YOY-52 routing contract): the
    // heuristics escalate it, and the prompt's cross-language rule must then
    // steer the model to "ai" — keyword search cannot serve a Hebrew
    // attribute query against the English catalog index. The same-language
    // shape ("black dress") also escalates here; the MODEL routes it
    // classic per the hybrid ladder, which the eval goldens pin.
    "שמלה שחורה",
    // Non-Latin letters disarm the short-query and sku-pattern settling
    // rules (YOY-67 AC-2, Option B): a cross-language query is never
    // decided by length or digit shape — the hand check's `סנובורד`
    // dead-ended in classic exactly because the 1-token rule settled it
    // before the model could see it.
    "סנובורד",
    "שמלה",
    "נעלי ספורט",
    "מכנסי ג'ינס 501",
  ];

  for (const query of aiFixtures) {
    it(`escalates ${JSON.stringify(query)} to the model`, async () => {
      const { llm, calls } = llmStub("ai");
      const classifier = createQueryClassifier({ llm });

      expect(await classifier.classify(query)).toEqual({
        route: "ai",
        reason: "model",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.operation).toBe("classification");
      expect(calls[0]!.schema).toBe(CLASSIFICATION_SCHEMA);
      expect(calls[0]!.prompt).toContain(normalizeQuery(query));
      // The hybrid routing ladder (YOY-52 product decision) reaches the
      // model: cross-language queries route ai; same-language keyword-
      // servable shapes route classic.
      expect(calls[0]!.prompt).toContain("cross-language");
      // Routing is deterministic: the classifier always asks at temperature 0.
      expect(calls[0]!.temperature).toBe(0);
    });
  }

  it("returns the model's classic verdict for keyword-ish long queries", async () => {
    const { llm } = llmStub("classic");
    const classifier = createQueryClassifier({ llm });

    expect(
      await classifier.classify("adidas samba og white gum sole mens"),
    ).toEqual({ route: "classic", reason: "model" });
  });

  it("forwards storeId and searchId to the port for metering (AC-4)", async () => {
    const { llm, calls } = llmStub("ai");
    const classifier = createQueryClassifier({ llm });

    await classifier.classify("linen dress for a beach wedding in october", {
      storeId: "test-shop.myshopify.com",
      searchId: "search-1",
    });

    expect(calls[0]!.storeId).toBe("test-shop.myshopify.com");
    expect(calls[0]!.searchId).toBe("search-1");
  });
});

describe("cache (AC-3)", () => {
  it("classifies identical normalized queries with zero further LLM calls", async () => {
    const { llm, calls } = llmStub("ai");
    const classifier = createQueryClassifier({ llm });

    const first = await classifier.classify(
      "elegant summer wedding dress not black",
    );
    const second = await classifier.classify(
      "  Elegant   SUMMER wedding dress not black ",
    );

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("keeps caches independent between classifier instances", async () => {
    const first = llmStub("ai");
    await createQueryClassifier({ llm: first.llm }).classify(
      "elegant summer wedding dress not black",
    );

    const second = llmStub("ai");
    await createQueryClassifier({ llm: second.llm }).classify(
      "elegant summer wedding dress not black",
    );

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  it("evicts the oldest entry once the cache is full", async () => {
    const { llm, calls } = llmStub("ai");
    const classifier = createQueryClassifier({ llm, cacheSize: 1 });

    await classifier.classify("silky maxi dress for an autumn gala evening");
    await classifier.classify("warm wool coat for rainy winter commutes");
    await classifier.classify("silky maxi dress for an autumn gala evening");

    // The first query was evicted by the second, so it re-escalates.
    expect(calls).toHaveLength(3);
  });
});

describe("fail-safe (AC-6)", () => {
  const query = "elegant summer wedding dress not black under 400";

  it("returns classic when the LLM call errors", async () => {
    const { llm } = llmStub(new Error("gemini unreachable"));
    const classifier = createQueryClassifier({ llm });

    expect(await classifier.classify(query)).toEqual({
      route: "classic",
      reason: "model-error",
    });
  });

  it("returns classic when the LLM call times out", async () => {
    const { llm } = llmStub("never");
    const classifier = createQueryClassifier({ llm, timeoutMs: 10 });

    expect(await classifier.classify(query)).toEqual({
      route: "classic",
      reason: "model-error",
    });
  });

  it("returns classic when the model answers outside the schema", async () => {
    const { llm } = llmStub("invalid");
    const classifier = createQueryClassifier({ llm });

    expect(await classifier.classify(query)).toEqual({
      route: "classic",
      reason: "model-error",
    });
  });

  it("does not cache failures: the next identical query retries the model", async () => {
    let fail = true;
    const calls: StructuredCompletionRequest[] = [];
    const llm: LlmClient = {
      async completeStructured(request) {
        calls.push(request);
        if (fail) {
          throw new Error("transient outage");
        }
        return { route: "ai" };
      },
    };
    const classifier = createQueryClassifier({ llm });

    expect(await classifier.classify(query)).toEqual({
      route: "classic",
      reason: "model-error",
    });
    fail = false;
    expect(await classifier.classify(query)).toEqual({
      route: "ai",
      reason: "model",
    });
    expect(calls).toHaveLength(2);
  });
});
