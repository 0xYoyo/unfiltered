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
    ["מכנסי ג'ינס 501", "sku-pattern"],
    ["red dress", "short-query"],
    ["שמלה", "short-query"],
    ["נעלי ספורט", "short-query"],
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
    });
  }

  it("returns the model's classic verdict for keyword-ish long queries", async () => {
    const { llm } = llmStub("classic");
    const classifier = createQueryClassifier({ llm });

    expect(
      await classifier.classify("adidas samba og white gum sole mens"),
    ).toEqual({ route: "classic", reason: "model" });
  });

  it("forwards shopDomain and searchId to the port for metering (AC-4)", async () => {
    const { llm, calls } = llmStub("ai");
    const classifier = createQueryClassifier({ llm });

    await classifier.classify("linen dress for a beach wedding in october", {
      shopDomain: "test-shop.myshopify.com",
      searchId: "search-1",
    });

    expect(calls[0]!.shopDomain).toBe("test-shop.myshopify.com");
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
