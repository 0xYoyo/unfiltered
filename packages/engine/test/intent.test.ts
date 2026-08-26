import { describe, expect, it } from "vitest";

import {
  carryOverRefinementConstraints,
  createIntentExtractor,
  enforceComparativeBounds,
  INTENT_SCHEMA,
  IntentExtractionError,
  mergeRefinementIntent,
  parseIntent,
  parseRefinementAnswer,
  REFINEMENT_INTENT_SCHEMA,
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
// split the retrieval layer will consume. Since YOY-31 the response schema
// pins category/occasion to the canonical taxonomy, so recorded answers carry
// canonical English tokens regardless of the query's language.
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
      confidence: 0.9,
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
      confidence: 0.9,
    },
  },
  {
    name: "HE equivalent",
    query: "שמלה אלגנטית לחתונה בקיץ, לא שחור, עד 400",
    recorded: {
      category: "dress",
      priceMin: null,
      priceMax: 400,
      currency: null,
      colorsInclude: [],
      colorsExclude: ["שחור"],
      occasion: "wedding",
      size: null,
      availabilityRequired: false,
      softAttributes: ["אלגנטית", "קיץ"],
      confidence: 0.9,
    },
    expected: {
      category: "dress",
      priceMin: undefined,
      priceMax: 400,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: ["שחור"],
      occasion: "wedding",
      size: undefined,
      availabilityRequired: false,
      softAttributes: ["אלגנטית", "קיץ"],
      confidence: 0.9,
    },
  },
  {
    name: "mixed EN/HE query",
    query: "שמלת מקסי elegant לחתונה בקיץ במידה M במלאי",
    recorded: {
      category: "dress",
      priceMin: null,
      priceMax: null,
      currency: null,
      colorsInclude: [],
      colorsExclude: [],
      occasion: "wedding",
      size: "M",
      availabilityRequired: true,
      softAttributes: ["elegant", "קיץ"],
      confidence: 0.9,
    },
    expected: {
      category: "dress",
      priceMin: undefined,
      priceMax: undefined,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: [],
      occasion: "wedding",
      size: "M",
      availabilityRequired: true,
      softAttributes: ["elegant", "קיץ"],
      confidence: 0.9,
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
      confidence: 0.9,
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
      confidence: 0.9,
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
    // Strict enum semantics (YOY-35 AC-6): the value — null included — must
    // literally appear in the enum. The schema itself carries null as a
    // member, so no null exemption is needed for a conforming validator.
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
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

  it("rejects out-of-set category and occasion values (YOY-31 AC-3, AC-7)", () => {
    const valid = scenarios[0]!.recorded;
    expect(conforms(INTENT_SCHEMA, { ...valid, category: "dresses" })).toBe(false);
    expect(conforms(INTENT_SCHEMA, { ...valid, category: "שמלה" })).toBe(false);
    expect(conforms(INTENT_SCHEMA, { ...valid, occasion: "gala" })).toBe(false);
    // The canonical tokens and null all conform.
    expect(conforms(INTENT_SCHEMA, { ...valid, category: "other" })).toBe(true);
    expect(conforms(INTENT_SCHEMA, { ...valid, category: null, occasion: null })).toBe(true);
  });

  it("admits null from the schema alone under strict enum semantics (YOY-35 AC-6)", () => {
    // The checker grants no null exemption: an enum without null rejects it…
    expect(
      conforms({ type: ["string", "null"], enum: ["dress"] }, null),
    ).toBe(false);
    // …so null passing INTENT_SCHEMA proves the enum itself carries it.
    const categorySchema = (
      INTENT_SCHEMA.properties as Record<string, Record<string, unknown>>
    ).category!;
    expect(conforms(categorySchema, null)).toBe(true);
    expect(categorySchema.enum).toContain(null);
  });

  for (const scenario of scenarios) {
    it(`validates the recorded null-bearing answer for ${scenario.name}`, () => {
      expect(conforms(INTENT_SCHEMA, scenario.recorded)).toBe(true);
    });
  }
});

describe("temporal phrases are not occasions (YOY-35 AC-3)", () => {
  it("prompts that seasons and times of day belong in softAttributes", async () => {
    const { llm, calls } = llmStub(scenarios[3]!.recorded);
    const extractor = createIntentExtractor({ llm });

    // The recorded fixture for the temporal-phrase query ("rainy winter
    // evenings") carries occasion null, and the extracted intent drops it.
    const intent = await extractor.extract(scenarios[3]!.query);
    expect(scenarios[3]!.recorded.occasion).toBeNull();
    expect(intent.occasion).toBeUndefined();
    expect(intent.softAttributes).toContain("rainy winter evenings");

    expect(calls[0]!.prompt).toContain("an event the shopper dresses FOR");
    expect(calls[0]!.prompt).toContain("never occasions");
  });
});

describe("port call shape (AC-2, AC-4)", () => {
  it('calls the port with INTENT_SCHEMA and operation "intent"', async () => {
    const { llm, calls } = llmStub(scenarios[0]!.recorded);
    const extractor = createIntentExtractor({ llm });

    await extractor.extract(scenarios[0]!.query);

    expect(calls[0]!.schema).toBe(INTENT_SCHEMA);
    expect(calls[0]!.operation).toBe("intent");
  });

  it("pins extraction to temperature 0 (YOY-52)", async () => {
    const { llm, calls } = llmStub(scenarios[0]!.recorded);
    const extractor = createIntentExtractor({ llm });

    await extractor.extract(scenarios[0]!.query);

    // Structured extraction is deterministic by contract, refinement calls
    // included — the same plumbing classification pins.
    expect(calls[0]!.temperature).toBe(0);
  });

  it("forwards storeId and searchId to the port for metering", async () => {
    const { llm, calls } = llmStub(scenarios[0]!.recorded);
    const extractor = createIntentExtractor({ llm });

    await extractor.extract(scenarios[0]!.query, {
      storeId: "test-shop.myshopify.com",
      searchId: "search-1",
    });

    expect(calls[0]!.storeId).toBe("test-shop.myshopify.com");
    expect(calls[0]!.searchId).toBe("search-1");
  });
});

describe("refinement context (YOY-42 AC-1, AC-4)", () => {
  const previousIntent: Intent = scenarios[0]!.expected;

  it("leaves the prompt untouched when no previous intent is supplied", async () => {
    const { llm, calls } = llmStub(scenarios[0]!.recorded, scenarios[0]!.recorded);
    const extractor = createIntentExtractor({ llm });

    await extractor.extract(scenarios[0]!.query);
    await extractor.extract(scenarios[0]!.query, { storeId: "s.example" });

    // A context without previousIntent is the pre-YOY-42 prompt, byte for
    // byte — recordings and caches keyed on it stay valid.
    expect(calls[1]!.prompt).toBe(calls[0]!.prompt);
    expect(calls[0]!.prompt).not.toContain("Previous intent:");
    expect(calls[0]!.prompt.endsWith(`\nQuery: ${scenarios[0]!.query}`)).toBe(true);
  });

  it("asks for a merged-or-fresh full intent when a previous intent is supplied", async () => {
    const { llm, calls } = llmStub({
      ...scenarios[0]!.recorded,
      outcome: "refinement",
    });
    const extractor = createIntentExtractor({ llm });

    await extractor.extract("same but cheaper", { previousIntent });

    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("REFINEMENT");
    expect(prompt).toContain("TOPIC CHANGE");
    expect(prompt).toContain('"category": "dress"');
    expect(prompt).toContain('"colorsExclude": [');
    // A refinement call carries the outcome-judgment schema (YOY-52 run-5
    // directive); the answer stays a full Intent, never a patch.
    expect(calls[0]!.schema).toBe(REFINEMENT_INTENT_SCHEMA);
    expect(calls[0]!.operation).toBe("intent");
  });

  it("keeps the query line last and unambiguous for replay keying (AC-4)", async () => {
    const { llm, calls } = llmStub({
      ...scenarios[0]!.recorded,
      outcome: "refinement",
    });
    const extractor = createIntentExtractor({ llm });

    await extractor.extract("same but cheaper", { previousIntent });

    const prompt = calls[0]!.prompt;
    expect(prompt.endsWith("\nQuery: same but cheaper")).toBe(true);
    // Exactly one line can key a recording, even with the serialized previous
    // intent in the prompt: its lines are all indented.
    const keyLines = prompt.split("\n").filter((line) => /^(?:Title|Query): /.test(line));
    expect(keyLines).toEqual(["Query: same but cheaper"]);
  });

  it("carries the previous intent into the retry attempt too", async () => {
    const { llm, calls } = llmStub(
      { colorsInclude: "not-an-array" },
      { ...scenarios[0]!.recorded, outcome: "refinement" },
    );
    const extractor = createIntentExtractor({ llm });

    await extractor.extract("same but cheaper", { previousIntent });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toBe(calls[0]!.prompt);
  });

  it("retries an answer missing the outcome judgment, then errors out", async () => {
    // A full Intent without the outcome field is schema-violating on a
    // refinement call: code cannot infer the judgment, so it must retry
    // rather than guess.
    const { llm, calls } = llmStub(
      scenarios[0]!.recorded,
      scenarios[0]!.recorded,
    );
    const extractor = createIntentExtractor({ llm });

    await expect(
      extractor.extract("same but cheaper", { previousIntent }),
    ).rejects.toBeInstanceOf(IntentExtractionError);
    expect(calls).toHaveLength(2);
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

  it("normalizes category and occasion into the canonical taxonomy (YOY-31 AC-4, AC-5)", () => {
    const valid = scenarios[0]!.recorded;
    // g03's shape: a raw "gown"/"gala" answer must converge onto the golden's
    // documented dress/evening constraints, not the other way around.
    const gown = parseIntent({ ...valid, category: "gown", occasion: "gala" });
    expect(gown?.category).toBe("dress");
    expect(gown?.occasion).toBe("evening");
    const messy = parseIntent({ ...valid, category: " Dresses ", occasion: "Party" });
    expect(messy?.category).toBe("dress");
    expect(messy?.occasion).toBe("evening");
    // Unmappable values and the "other" bucket drop the constraint entirely
    // rather than hard-filtering on a token enrichment cannot carry.
    const unmappable = parseIntent({ ...valid, category: "widget", occasion: "brunch" });
    expect(unmappable?.category).toBeUndefined();
    expect(unmappable?.occasion).toBeUndefined();
    const other = parseIntent({ ...valid, category: "other", occasion: "other" });
    expect(other?.category).toBeUndefined();
    expect(other?.occasion).toBeUndefined();
  });

  it("canonicalizes size casing to uppercase (YOY-52)", () => {
    const valid = scenarios[0]!.recorded;
    expect(parseIntent({ ...valid, size: "m" })?.size).toBe("M");
    expect(parseIntent({ ...valid, size: "M" })?.size).toBe("M");
    expect(parseIntent({ ...valid, size: "42" })?.size).toBe("42");
    expect(parseIntent({ ...valid, size: null })?.size).toBeUndefined();
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

describe("deterministic comparative enforcement (YOY-52 AC-15)", () => {
  /** A merged intent echoing the previous bounds — the uncooperative case. */
  function merged(overrides: Partial<Intent>): Intent {
    return {
      colorsInclude: [],
      colorsExclude: [],
      availabilityRequired: false,
      softAttributes: [],
      ...overrides,
    };
  }

  describe("cheaper", () => {
    it("overrides an unchanged EN echo to 75% of the previous priceMax", () => {
      const previous = merged({ priceMax: 400, occasion: "wedding" });
      const intent = enforceComparativeBounds(
        "same but cheaper",
        previous,
        merged({ priceMax: 400, occasion: "wedding" }),
      );
      expect(intent.priceMax).toBe(300);
      expect(intent.priceMin).toBeUndefined();
      // Enforcement touches the price bounds only; carried constraints pass.
      expect(intent.occasion).toBe("wedding");
    });

    it("overrides an unchanged HE echo, both word orders", () => {
      const previous = merged({ priceMax: 900 });
      for (const query of ["אותו דבר אבל יותר זול", "זול יותר בבקשה"]) {
        expect(
          enforceComparativeBounds(query, previous, merged({ priceMax: 900 }))
            .priceMax,
        ).toBe(675);
      }
    });

    it("keeps a cooperative model's own strictly-lower figure", () => {
      const previous = merged({ priceMax: 400 });
      const intent = enforceComparativeBounds(
        "same but cheaper",
        previous,
        merged({ priceMax: 250 }),
      );
      expect(intent.priceMax).toBe(250);
    });

    it("falls back to the previous priceMin as the bound, clearing it once contradicted", () => {
      // Previous intent has only a floor: cheaper caps below it, and the
      // carried floor would empty every result, so it clears.
      const previous = merged({ priceMin: 200 });
      const intent = enforceComparativeBounds(
        "less expensive please",
        previous,
        merged({ priceMin: 200 }),
      );
      expect(intent.priceMax).toBe(150);
      expect(intent.priceMin).toBeUndefined();
    });

    it("does nothing when the previous intent carries no price bound", () => {
      const previous = merged({ occasion: "wedding" });
      const intent = enforceComparativeBounds(
        "same but cheaper",
        previous,
        merged({ occasion: "wedding" }),
      );
      expect(intent.priceMax).toBeUndefined();
      expect(intent.priceMin).toBeUndefined();
    });
  });

  describe("more expensive", () => {
    it("overrides an unchanged EN echo to 125% of the previous priceMin", () => {
      const previous = merged({ priceMin: 200 });
      const intent = enforceComparativeBounds(
        "show me more expensive ones",
        previous,
        merged({ priceMin: 200 }),
      );
      expect(intent.priceMin).toBe(250);
      expect(intent.priceMax).toBeUndefined();
    });

    it("raises above the previous priceMax when only a cap exists, clearing the contradicted cap (HE, both word orders)", () => {
      const previous = merged({ priceMax: 300 });
      for (const query of ["יותר יקר", "יקר יותר"]) {
        const intent = enforceComparativeBounds(
          query,
          previous,
          merged({ priceMax: 300 }),
        );
        expect(intent.priceMin).toBe(375);
        expect(intent.priceMax).toBeUndefined();
      }
    });

    it("keeps a cooperative model's own strictly-higher floor, still clearing a contradicted cap", () => {
      const previous = merged({ priceMin: 300, priceMax: 300 });
      const intent = enforceComparativeBounds(
        "pricier",
        previous,
        merged({ priceMin: 450, priceMax: 300 }),
      );
      expect(intent.priceMin).toBe(450);
      expect(intent.priceMax).toBeUndefined();
    });

    it("does nothing when the previous intent carries no price bound", () => {
      const previous = merged({});
      const intent = enforceComparativeBounds(
        "more expensive",
        previous,
        merged({}),
      );
      expect(intent.priceMin).toBeUndefined();
    });
  });

  it("leaves non-comparative and both-directions queries to the model", () => {
    const previous = merged({ priceMax: 400 });
    const echo = merged({ priceMax: 400 });
    expect(enforceComparativeBounds("in red", previous, echo)).toEqual(echo);
    expect(
      enforceComparativeBounds(
        "cheaper or more expensive, anything",
        previous,
        echo,
      ),
    ).toEqual(echo);
  });

  it("runs inside extract when a previous intent is supplied", async () => {
    const previousIntent: Intent = {
      category: "dress",
      priceMax: 400,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      availabilityRequired: false,
      softAttributes: ["elegant"],
    };
    // The model echoes the previous cap unchanged — the live failure shape.
    const { llm } = llmStub({
      outcome: "refinement",
      category: "dress",
      priceMin: null,
      priceMax: 400,
      currency: null,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      size: null,
      availabilityRequired: false,
      softAttributes: ["elegant"],
    });
    const extractor = createIntentExtractor({ llm });

    const intent = await extractor.extract("same but cheaper", {
      previousIntent,
    });

    expect(intent.priceMax).toBe(300);
    expect(intent.occasion).toBe("wedding");
    expect(intent.colorsExclude).toEqual(["black"]);
  });

  it("does not run without a previous intent, even on comparative phrasing", async () => {
    const { llm } = llmStub({
      category: null,
      priceMin: null,
      priceMax: 400,
      currency: null,
      colorsInclude: [],
      colorsExclude: [],
      occasion: null,
      size: null,
      availabilityRequired: false,
      softAttributes: ["cheaper"],
    });
    const extractor = createIntentExtractor({ llm });

    const intent = await extractor.extract("cheaper dresses under 400");

    expect(intent.priceMax).toBe(400);
  });
});

describe("refinement worked example (YOY-52)", () => {
  it("shows a comparative refinement preserving untouched constraints, in golden-free vocabulary", async () => {
    const previousIntent: Intent = scenarios[0]!.expected;
    const { llm, calls } = llmStub({
      ...scenarios[0]!.recorded,
      outcome: "refinement",
    });
    const extractor = createIntentExtractor({ llm });

    await extractor.extract("same but cheaper", { previousIntent });

    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("Worked example");
    expect(prompt).toContain('"occasion": "sport"');
    expect(prompt).toContain('"category": "boots"');
    // The example demonstrates the outcome judgment the schema requires.
    expect(prompt).toContain('"outcome": "refinement"');
    expect(prompt).toContain('"topic_change"');
    // The example must never collide with the replay's recording key.
    const keyLines = prompt
      .split("\n")
      .filter((line) => /^(?:Title|Query): /.test(line));
    expect(keyLines).toEqual(["Query: same but cheaper"]);
  });
});

describe("deterministic constraint carry-over (YOY-52 run-5 directive)", () => {
  function intent(overrides: Partial<Intent>): Intent {
    return {
      colorsInclude: [],
      colorsExclude: [],
      availabilityRequired: false,
      softAttributes: [],
      ...overrides,
    };
  }

  const previous = intent({
    category: "dress",
    priceMax: 400,
    colorsExclude: ["black"],
    occasion: "wedding",
    softAttributes: ["elegant"],
  });

  it("restores a constraint the model dropped — the roaming-drop shape", () => {
    // r01's live failure: occasion set previously, model returns it absent
    // on a refinement. Unphrased omission never clears a constraint.
    const merged = carryOverRefinementConstraints(
      previous,
      intent({ category: "dress", priceMax: 400, colorsExclude: ["black"] }),
    );
    expect(merged.occasion).toBe("wedding");
    expect(merged.colorsExclude).toEqual(["black"]);
    expect(merged.priceMax).toBe(400);
  });

  it("keeps the model's own changed values over the previous ones", () => {
    const merged = carryOverRefinementConstraints(
      previous,
      intent({
        category: "dress",
        priceMax: 250,
        colorsInclude: ["red"],
        colorsExclude: ["black"],
        occasion: "evening",
      }),
    );
    expect(merged.priceMax).toBe(250);
    expect(merged.colorsInclude).toEqual(["red"]);
    expect(merged.occasion).toBe("evening");
  });

  it("leaves availabilityRequired and softAttributes to the model", () => {
    const withAvailability = intent({
      ...previous,
      availabilityRequired: true,
      softAttributes: ["elegant"],
    });
    const merged = carryOverRefinementConstraints(
      withAvailability,
      intent({ category: "dress", softAttributes: ["בקיץ"] }),
    );
    // false is availabilityRequired's resting value, not an absent one —
    // restoring it would be a guess; soft attributes are not constraints.
    expect(merged.availabilityRequired).toBe(false);
    expect(merged.softAttributes).toEqual(["בקיץ"]);
  });

  it("mergeRefinementIntent discards everything on an explicit topic change", () => {
    const fresh = intent({ category: "sneakers", softAttributes: ["nike"] });
    const merged = mergeRefinementIntent("nike air max 90", previous, {
      outcome: "topic_change",
      intent: fresh,
    });
    expect(merged).toEqual(fresh);
    expect(merged.occasion).toBeUndefined();
    expect(merged.priceMax).toBeUndefined();
  });

  it("composes with comparative enforcement: restore first, then move the bound", () => {
    // The model both drops the previous cap AND fails to tighten: carry-over
    // restores 400, then cheaper-enforcement moves it to 300.
    const merged = mergeRefinementIntent("same but cheaper", previous, {
      outcome: "refinement",
      intent: intent({ category: "dress", colorsExclude: ["black"] }),
    });
    expect(merged.priceMax).toBe(300);
    expect(merged.occasion).toBe("wedding");
  });

  it("drops a restored cap the model's explicit non-comparative floor contradicts (AC-19)", () => {
    // "over 500" after a priceMax=400 search: the model sets a new floor and
    // returns no cap; restoring the old cap would ship priceMin=500 ∧
    // priceMax=400 — zero hits — and the query has no comparative lexicon
    // for enforcement to clear it. The model-set bound wins.
    const merged = mergeRefinementIntent("over 500", previous, {
      outcome: "refinement",
      intent: intent({ category: "dress", priceMin: 500 }),
    });
    expect(merged.priceMin).toBe(500);
    expect(merged.priceMax).toBeUndefined();
    // Untouched constraints still carry over.
    expect(merged.occasion).toBe("wedding");
  });

  it("drops a restored floor the model's explicit non-comparative cap contradicts (AC-19)", () => {
    const pricey = intent({ category: "coat", priceMin: 600 });
    const merged = mergeRefinementIntent("under 300", pricey, {
      outcome: "refinement",
      intent: intent({ category: "coat", priceMax: 300 }),
    });
    expect(merged.priceMax).toBe(300);
    expect(merged.priceMin).toBeUndefined();
  });

  it("keeps both bounds when the model set both — its answer stands (AC-19)", () => {
    const merged = mergeRefinementIntent("between prices", previous, {
      outcome: "refinement",
      intent: intent({ category: "dress", priceMin: 500, priceMax: 450 }),
    });
    // Neither bound was restored, so the contradiction is the model's own
    // answer and passes through unchanged, as before AC-19.
    expect(merged.priceMin).toBe(500);
    expect(merged.priceMax).toBe(450);
  });

  it("leaves a same-direction explicit bound and compatible restores untouched (AC-19)", () => {
    // New cap after old cap: nothing restored on the price axis, no
    // contradiction, no clearing.
    const merged = mergeRefinementIntent("under 250", previous, {
      outcome: "refinement",
      intent: intent({ category: "dress", priceMax: 250 }),
    });
    expect(merged.priceMax).toBe(250);
    expect(merged.priceMin).toBeUndefined();
    // Compatible floor + restored cap both survive.
    const compatible = mergeRefinementIntent("over 100", previous, {
      outcome: "refinement",
      intent: intent({ category: "dress", priceMin: 100 }),
    });
    expect(compatible.priceMin).toBe(100);
    expect(compatible.priceMax).toBe(400);
  });

  it("enforcement clears a restored cap a more-expensive follow-up contradicts", () => {
    // r09's shape: previous has only a cap; the model raises the floor but
    // returns no cap. Carry-over restores the 300 cap; enforcement then
    // clears it as contradicted by the new floor.
    const skirt = intent({ category: "skirt", priceMax: 300 });
    const merged = mergeRefinementIntent("יותר יקר", skirt, {
      outcome: "refinement",
      intent: intent({ category: "skirt", priceMin: 375 }),
    });
    expect(merged.priceMin).toBe(375);
    expect(merged.priceMax).toBeUndefined();
  });

  describe("parseRefinementAnswer", () => {
    const valid = { ...scenarios[0]!.recorded, outcome: "refinement" };

    it("parses a full intent plus the outcome judgment", () => {
      const answer = parseRefinementAnswer(valid);
      expect(answer?.outcome).toBe("refinement");
      expect(answer?.intent).toEqual(scenarios[0]!.expected);
      expect(
        parseRefinementAnswer({ ...valid, outcome: "topic_change" })?.outcome,
      ).toBe("topic_change");
    });

    it("rejects a missing, unknown, or wrong-typed outcome", () => {
      expect(parseRefinementAnswer(scenarios[0]!.recorded)).toBeNull();
      expect(parseRefinementAnswer({ ...valid, outcome: "fresh" })).toBeNull();
      expect(parseRefinementAnswer({ ...valid, outcome: null })).toBeNull();
      expect(parseRefinementAnswer(null)).toBeNull();
    });

    it("rejects an intent-invalid answer even with a valid outcome", () => {
      expect(
        parseRefinementAnswer({ ...valid, colorsInclude: "not-an-array" }),
      ).toBeNull();
    });
  });

  it("REFINEMENT_INTENT_SCHEMA requires the outcome judgment", () => {
    expect(REFINEMENT_INTENT_SCHEMA.required).toContain("outcome");
    const outcome = (
      REFINEMENT_INTENT_SCHEMA.properties as Record<
        string,
        Record<string, unknown>
      >
    ).outcome!;
    expect(outcome.enum).toEqual(["refinement", "topic_change"]);
    // Everything else is the Intent shape, unchanged.
    for (const key of Object.keys(
      INTENT_SCHEMA.properties as Record<string, unknown>,
    )) {
      expect(
        (REFINEMENT_INTENT_SCHEMA.properties as Record<string, unknown>)[key],
      ).toBeDefined();
    }
  });
});

describe("confidence (YOY-116 AC-1)", () => {
  it("INTENT_SCHEMA and the refinement schema require a 0–1 confidence", () => {
    expect(INTENT_SCHEMA.required).toContain("confidence");
    expect(REFINEMENT_INTENT_SCHEMA.required).toContain("confidence");
    expect((INTENT_SCHEMA.properties as Record<string, unknown>).confidence).toEqual({
      type: "number",
      minimum: 0,
      maximum: 1,
    });
  });

  it("parses a reported confidence and rejects one outside [0, 1] or of the wrong type", () => {
    const base = {
      colorsInclude: [],
      colorsExclude: [],
      availabilityRequired: false,
      softAttributes: [],
    };
    expect(parseIntent({ ...base, confidence: 0.85 })?.confidence).toBe(0.85);
    expect(parseIntent({ ...base, confidence: 0 })?.confidence).toBe(0);
    expect(parseIntent({ ...base, confidence: 1 })?.confidence).toBe(1);
    expect(parseIntent({ ...base, confidence: 1.2 })).toBeNull();
    expect(parseIntent({ ...base, confidence: -0.1 })).toBeNull();
    expect(parseIntent({ ...base, confidence: "high" })).toBeNull();
  });

  it("treats a missing or null confidence as absent, so pre-YOY-116 recordings still parse", () => {
    const base = {
      colorsInclude: [],
      colorsExclude: [],
      availabilityRequired: false,
      softAttributes: [],
    };
    expect(parseIntent(base)).not.toHaveProperty("confidence");
    expect(parseIntent({ ...base, confidence: null })).not.toHaveProperty("confidence");
  });

  it("asks the model for confidence in the prompt and keeps it out of the previous-intent block", async () => {
    const { llm, calls } = llmStub({
      colorsInclude: [],
      colorsExclude: [],
      availabilityRequired: false,
      softAttributes: [],
      outcome: "refinement",
      confidence: 0.9,
    });
    const previousIntent: Intent = {
      category: "dress",
      colorsInclude: [],
      colorsExclude: [],
      availabilityRequired: false,
      softAttributes: ["elegant"],
      confidence: 0.4,
    };
    await createIntentExtractor({ llm }).extract("cheaper", { previousIntent });
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("- confidence: a number from 0 to 1");
    // The previous intent's own confidence is not a constraint and is not
    // echoed into the prompt.
    const block = prompt.slice(prompt.indexOf("Previous intent:"));
    expect(block).not.toContain("confidence");
    expect(block).toContain('"category": "dress"');
  });
});
