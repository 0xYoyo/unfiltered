import { describe, expect, it } from "vitest";

import {
  createIntentExtractor,
  INTENT_SCHEMA,
  IntentExtractionError,
  parseIntent,
  type Intent,
  type LlmClient,
  type StructuredCompletionRequest,
} from "../src/index.js";

// Extraction tests replay recorded model answers through a stub — no LLM
// network call anywhere in the default run (AC-5). Live extraction lives in
// the app's intent-live.test.ts behind LIVE_LLM_TESTS=1.

/** LlmClient stub answering successive calls with the given completions. */
function llmStub(...completions: unknown[]) {
  const calls: StructuredCompletionRequest[] = [];
  const llm: LlmClient = {
    async completeStructured(request) {
      calls.push(request);
      if (calls.length > completions.length) {
        throw new Error("stub exhausted: more calls than recorded completions");
      }
      return completions[calls.length - 1];
    },
  };
  return { llm, calls };
}

interface RecordedScenario {
  name: string;
  query: string;
  /** The model's raw JSON answer, recorded from a live extraction run. */
  recorded: Record<string, unknown>;
  /** The Intent the engine must parse out of it. */
  expected: Intent;
}

// The four AC-3 scenarios. `recorded` is the model's answer verbatim —
// including null-for-absent optionals — and `expected` shows the hard/soft
// split the retrieval layer will consume.
const scenarios: RecordedScenario[] = [
  {
    name: "EN query with price cap and color exclusion",
    query: "elegant summer wedding dress, not black, under 400",
    recorded: {
      category: "dress",
      priceMin: null,
      priceMax: 400,
      currency: null,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      size: null,
      availabilityRequired: false,
      softAttributes: ["elegant", "summer"],
    },
    expected: {
      category: "dress",
      priceMin: undefined,
      priceMax: 400,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      size: undefined,
      availabilityRequired: false,
      softAttributes: ["elegant", "summer"],
    },
  },
  {
    name: "HE equivalent",
    query: "שמלה אלגנטית לחתונה בקיץ, לא שחור, עד 400",
    recorded: {
      category: "שמלה",
      priceMin: null,
      priceMax: 400,
      currency: null,
      colorsInclude: [],
      colorsExclude: ["שחור"],
      occasion: "חתונה",
      size: null,
      availabilityRequired: false,
      softAttributes: ["אלגנטית", "קיץ"],
    },
    expected: {
      category: "שמלה",
      priceMin: undefined,
      priceMax: 400,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: ["שחור"],
      occasion: "חתונה",
      size: undefined,
      availabilityRequired: false,
      softAttributes: ["אלגנטית", "קיץ"],
    },
  },
  {
    name: "mixed EN/HE query",
    query: "שמלת מקסי elegant לחתונה בקיץ במידה M במלאי",
    recorded: {
      category: "שמלת מקסי",
      priceMin: null,
      priceMax: null,
      currency: null,
      colorsInclude: [],
      colorsExclude: [],
      occasion: "חתונה",
      size: "M",
      availabilityRequired: true,
      softAttributes: ["elegant", "קיץ"],
    },
    expected: {
      category: "שמלת מקסי",
      priceMin: undefined,
      priceMax: undefined,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: [],
      occasion: "חתונה",
      size: "M",
      availabilityRequired: true,
      softAttributes: ["elegant", "קיץ"],
    },
  },
  {
    name: "no hard constraints, soft attributes only",
    query: "something cozy and warm for rainy winter evenings",
    recorded: {
      category: null,
      priceMin: null,
      priceMax: null,
      currency: null,
      colorsInclude: [],
      colorsExclude: [],
      occasion: null,
      size: null,
      availabilityRequired: false,
      softAttributes: ["cozy", "warm", "rainy winter evenings"],
    },
    expected: {
      category: undefined,
      priceMin: undefined,
      priceMax: undefined,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: [],
      occasion: undefined,
      size: undefined,
      availabilityRequired: false,
      softAttributes: ["cozy", "warm", "rainy winter evenings"],
    },
  },
];

describe("recorded extraction fixtures (AC-1, AC-3, AC-5)", () => {
  for (const scenario of scenarios) {
    it(`extracts ${scenario.name}`, async () => {
      const { llm, calls } = llmStub(scenario.recorded);
      const extractor = createIntentExtractor({ llm });

      expect(await extractor.extract(scenario.query)).toEqual(
        scenario.expected,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toContain(scenario.query);
    });
  }
});

describe("INTENT_SCHEMA admits null optionals (YOY-29 AC-8)", () => {
  // Minimal JSON Schema checker covering the constructs INTENT_SCHEMA uses:
  // enough to prove the schema itself — as sent to the provider — accepts
  // the recorded null-bearing answers, without leaning on parseIntent.
  function conforms(schema: Record<string, unknown>, value: unknown): boolean {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matchesType = types.some((type) => {
      switch (type) {
        case "null":
          return value === null;
        case "string":
          return typeof value === "string";
        case "number":
          return typeof value === "number";
        case "boolean":
          return typeof value === "boolean";
        case "array":
          return (
            Array.isArray(value) &&
            value.every((item) =>
              conforms(schema.items as Record<string, unknown>, item),
            )
          );
        case "object":
          return typeof value === "object" && value !== null;
        default:
          return false;
      }
    });
    if (!matchesType) {
      return false;
    }
    if (types.includes("object") && typeof value === "object" && value !== null) {
      const properties = (schema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const record = value as Record<string, unknown>;
      const required = (schema.required ?? []) as string[];
      return (
        required.every((key) => key in record) &&
        Object.entries(record).every(
          ([key, item]) => !(key in properties) || conforms(properties[key]!, item),
        )
      );
    }
    return true;
  }

  it("rejects a wrong-typed answer, proving the checker has teeth", () => {
    expect(conforms(INTENT_SCHEMA, { ...scenarios[0]!.recorded, priceMax: "400" })).toBe(false);
    expect(conforms(INTENT_SCHEMA, { colorsInclude: [] })).toBe(false);
  });

  for (const scenario of scenarios) {
    it(`validates the recorded null-bearing answer for ${scenario.name}`, () => {
      expect(conforms(INTENT_SCHEMA, scenario.recorded)).toBe(true);
    });
  }
});

describe("port call shape (AC-2, AC-4)", () => {
  it('calls the port with INTENT_SCHEMA and operation "intent"', async () => {
    const { llm, calls } = llmStub(scenarios[0]!.recorded);
    const extractor = createIntentExtractor({ llm });

    await extractor.extract(scenarios[0]!.query);

    expect(calls[0]!.schema).toBe(INTENT_SCHEMA);
    expect(calls[0]!.operation).toBe("intent");
  });

  it("forwards shopDomain and searchId to the port for metering", async () => {
    const { llm, calls } = llmStub(scenarios[0]!.recorded);
    const extractor = createIntentExtractor({ llm });

    await extractor.extract(scenarios[0]!.query, {
      shopDomain: "test-shop.myshopify.com",
      searchId: "search-1",
    });

    expect(calls[0]!.shopDomain).toBe("test-shop.myshopify.com");
    expect(calls[0]!.searchId).toBe("search-1");
  });
});

describe("schema validation and retry (AC-2)", () => {
  it("retries once on a schema violation, then returns the valid answer", async () => {
    const { llm, calls } = llmStub(
      { colorsInclude: "not-an-array" },
      scenarios[0]!.recorded,
    );
    const extractor = createIntentExtractor({ llm });

    expect(await extractor.extract(scenarios[0]!.query)).toEqual(
      scenarios[0]!.expected,
    );
    expect(calls).toHaveLength(2);
  });

  it("rejects with IntentExtractionError after two schema violations", async () => {
    const { llm, calls } = llmStub({ route: "banana" }, "not even an object");
    const extractor = createIntentExtractor({ llm });

    await expect(
      extractor.extract(scenarios[0]!.query),
    ).rejects.toBeInstanceOf(IntentExtractionError);
    expect(calls).toHaveLength(2);
  });

  it("propagates port errors unchanged, without a retry", async () => {
    const calls: StructuredCompletionRequest[] = [];
    const llm: LlmClient = {
      async completeStructured(request) {
        calls.push(request);
        throw new Error("gemini unreachable");
      },
    };
    const extractor = createIntentExtractor({ llm });

    await expect(extractor.extract(scenarios[0]!.query)).rejects.toThrow(
      "gemini unreachable",
    );
    expect(calls).toHaveLength(1);
  });
});

describe("parseIntent", () => {
  it("rejects wrong types for every field", () => {
    const valid = scenarios[0]!.recorded;
    expect(parseIntent(null)).toBeNull();
    expect(parseIntent("intent")).toBeNull();
    expect(parseIntent({ ...valid, category: 7 })).toBeNull();
    expect(parseIntent({ ...valid, priceMax: "400" })).toBeNull();
    expect(parseIntent({ ...valid, priceMax: Number.NaN })).toBeNull();
    expect(parseIntent({ ...valid, colorsExclude: [7] })).toBeNull();
    expect(parseIntent({ ...valid, availabilityRequired: "no" })).toBeNull();
    expect(parseIntent({ ...valid, softAttributes: undefined })).toBeNull();
  });

  it("normalizes missing optionals like nulls", () => {
    expect(
      parseIntent({
        colorsInclude: [],
        colorsExclude: [],
        availabilityRequired: false,
        softAttributes: ["linen"],
      }),
    ).toEqual({
      category: undefined,
      priceMin: undefined,
      priceMax: undefined,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: [],
      occasion: undefined,
      size: undefined,
      availabilityRequired: false,
      softAttributes: ["linen"],
    });
  });
});
