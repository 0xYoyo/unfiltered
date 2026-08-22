import { describe, expect, it } from "vitest";

import type { AiCallUsage } from "@unfiltered/engine";
import {
  DEFAULT_CLASSIFICATION_MODEL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_INTENT_MODEL,
  DEFAULT_INTENT_THINKING_LEVEL,
  MODEL_DEFAULT_THINKING_LEVEL,
  GeminiApiError,
  GeminiConfigError,
  GeminiResponseError,
  GeminiTimeoutError,
  createGeminiEmbeddingClient,
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "../src/index.js";

// All tests run on fixture responses through an injected fetch stub — no
// network, no API key from the environment.

const SCHEMA = {
  type: "object",
  properties: { color: { type: "string" } },
  required: ["color"],
};

function recorderSpy() {
  const recorded: AiCallUsage[] = [];
  return {
    recorded,
    recorder: {
      record: async (usage: AiCallUsage) => {
        recorded.push(usage);
      },
    },
  };
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fetchStub(status: number, payload: unknown) {
  const captured: CapturedRequest[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { captured, impl };
}

const completionFixture = {
  candidates: [{ content: { parts: [{ text: '{"color":"black"}' }] } }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8 },
};

function llmClient(
  fetchImpl: typeof fetch,
  recorder: { record: (usage: AiCallUsage) => Promise<void> },
  modelId = "test-flash-model",
) {
  return createGeminiLlmClient({
    modelId,
    apiKey: "test-key-not-real",
    costRecorder: recorder,
    fetchImpl,
  });
}

describe("model configuration", () => {
  it("defaults every model from the documented list", () => {
    const models = geminiModelsFromEnv({});
    expect(models).toEqual({
      classificationModel: DEFAULT_CLASSIFICATION_MODEL,
      intentModel: DEFAULT_INTENT_MODEL,
      embeddingModel: DEFAULT_EMBEDDING_MODEL,
      embeddingDimension: DEFAULT_EMBEDDING_DIMENSION,
      intentThinkingLevel: DEFAULT_INTENT_THINKING_LEVEL,
    });
    expect(DEFAULT_INTENT_THINKING_LEVEL).toBe("low");
  });

  it("reads every model from env overrides", () => {
    const models = geminiModelsFromEnv({
      GEMINI_CLASSIFICATION_MODEL: "model-a",
      GEMINI_INTENT_MODEL: "model-b",
      GEMINI_EMBEDDING_MODEL: "model-c",
      GEMINI_EMBEDDING_DIMENSION: "1536",
      GEMINI_INTENT_THINKING_LEVEL: "high",
    });
    expect(models).toEqual({
      classificationModel: "model-a",
      intentModel: "model-b",
      embeddingModel: "model-c",
      embeddingDimension: 1536,
      intentThinkingLevel: "high",
    });
  });

  it("rejects a malformed GEMINI_EMBEDDING_DIMENSION naming the variable (YOY-29 AC-3)", () => {
    for (const raw of ["not-a-number", "", "  ", "7.5", "-768", "0"]) {
      expect(() =>
        geminiModelsFromEnv({ GEMINI_EMBEDDING_DIMENSION: raw }),
      ).toThrow(GeminiConfigError);
      expect(() =>
        geminiModelsFromEnv({ GEMINI_EMBEDDING_DIMENSION: raw }),
      ).toThrow(/GEMINI_EMBEDDING_DIMENSION/);
    }
  });

  it("maps GEMINI_INTENT_THINKING_LEVEL=model-default to no override and rejects a blank value (YOY-109)", () => {
    expect(
      geminiModelsFromEnv({
        GEMINI_INTENT_THINKING_LEVEL: MODEL_DEFAULT_THINKING_LEVEL,
      }).intentThinkingLevel,
    ).toBeUndefined();
    expect(
      geminiModelsFromEnv({ GEMINI_INTENT_THINKING_LEVEL: " low " })
        .intentThinkingLevel,
    ).toBe("low");
    for (const raw of ["", "  "]) {
      expect(() =>
        geminiModelsFromEnv({ GEMINI_INTENT_THINKING_LEVEL: raw }),
      ).toThrow(GeminiConfigError);
      expect(() =>
        geminiModelsFromEnv({ GEMINI_INTENT_THINKING_LEVEL: raw }),
      ).toThrow(/GEMINI_INTENT_THINKING_LEVEL/);
    }
  });

  it("refuses to construct a client without an API key", () => {
    const { recorder } = recorderSpy();
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(() =>
        createGeminiLlmClient({ modelId: "m", costRecorder: recorder }),
      ).toThrow(GeminiConfigError);
    } finally {
      if (previous !== undefined) {
        process.env.GEMINI_API_KEY = previous;
      }
    }
  });
});

describe("structured completion", () => {
  it("shapes the request: model in URL, key in header, schema in generationConfig", async () => {
    const { recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, completionFixture);

    await llmClient(impl, recorder).completeStructured({
      prompt: "Classify this product",
      schema: SCHEMA,
      operation: "classification",
    });

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test-flash-model:generateContent",
    );
    expect(request.headers["x-goog-api-key"]).toBe("test-key-not-real");
    expect(request.body.contents).toEqual([
      { role: "user", parts: [{ text: "Classify this product" }] },
    ]);
    expect(request.body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    });
  });

  it("forwards a request temperature into generationConfig, omitting it otherwise (YOY-52)", async () => {
    const { recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, completionFixture);
    const client = llmClient(impl, recorder);

    await client.completeStructured({
      prompt: "Route this query",
      schema: SCHEMA,
      operation: "classification",
      temperature: 0,
    });

    expect(
      (captured[0]!.body.generationConfig as { temperature?: number })
        .temperature,
    ).toBe(0);
  });

  it("sends thinkingConfig.thinkingLevel when configured and no thinkingConfig otherwise (YOY-109)", async () => {
    const { recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, completionFixture);

    await createGeminiLlmClient({
      modelId: "test-intent-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      thinkingLevel: "low",
    }).completeStructured({
      prompt: "Extract intent",
      schema: SCHEMA,
      operation: "intent",
      temperature: 0,
    });
    expect(captured[0]!.body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0,
      thinkingConfig: { thinkingLevel: "low" },
    });

    // The classification client (no thinkingLevel) keeps the pre-YOY-109
    // body byte for byte: the model decides its own thinking.
    await llmClient(impl, recorder).completeStructured({
      prompt: "Route this query",
      schema: SCHEMA,
      operation: "classification",
    });
    expect(captured[1]!.body.generationConfig).not.toHaveProperty(
      "thinkingConfig",
    );
  });

  it("translates nullable type arrays to Gemini's nullable form in responseSchema (YOY-28)", async () => {
    const { recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, completionFixture);

    await llmClient(impl, recorder).completeStructured({
      prompt: "Extract intent",
      schema: {
        type: "object",
        properties: {
          category: { type: ["string", "null"] },
          priceMax: { type: ["number", "null"] },
          colors: { type: "array", items: { type: ["string", "null"] } },
          nested: {
            type: "object",
            properties: { size: { type: ["string", "null"] } },
          },
        },
        required: ["category"],
      },
      operation: "intent",
    });

    const config = captured[0]!.body.generationConfig as {
      responseSchema: unknown;
    };
    expect(config.responseSchema).toEqual({
      type: "object",
      properties: {
        category: { type: "string", nullable: true },
        priceMax: { type: "number", nullable: true },
        colors: { type: "array", items: { type: "string", nullable: true } },
        nested: {
          type: "object",
          properties: { size: { type: "string", nullable: true } },
        },
      },
      required: ["category"],
    });
    // Gemini rejects type arrays anywhere in the schema — none may survive.
    expect(JSON.stringify(config.responseSchema)).not.toContain('"type":[');
  });

  it("re-expresses a null-bearing enum through nullable, leaving the outgoing body as before (YOY-35 AC-6)", async () => {
    const { recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, completionFixture);

    // The engine's strictly self-consistent enum-or-null form: null appears
    // both in the type union and as an enum member.
    await llmClient(impl, recorder).completeStructured({
      prompt: "Extract intent",
      schema: {
        type: "object",
        properties: {
          category: {
            type: ["string", "null"],
            enum: ["dress", "coat", null],
          },
        },
        required: [],
      },
      operation: "intent",
    });

    const config = captured[0]!.body.generationConfig as {
      responseSchema: unknown;
    };
    // Identical Gemini request as before the enum carried null: string type,
    // string-only enum, nullable flag.
    expect(config.responseSchema).toEqual({
      type: "object",
      properties: {
        category: { type: "string", enum: ["dress", "coat"], nullable: true },
      },
      required: [],
    });
  });

  it("passes a schema with no null types through unchanged", async () => {
    const { recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, completionFixture);

    const schema = {
      type: "object",
      properties: {
        color: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["color"],
    };
    await llmClient(impl, recorder).completeStructured({
      prompt: "p",
      schema,
      operation: "classification",
    });

    const config = captured[0]!.body.generationConfig as {
      responseSchema: unknown;
    };
    expect(config.responseSchema).toEqual(schema);
  });

  it("parses the JSON candidate into an object", async () => {
    const { recorder } = recorderSpy();
    const { impl } = fetchStub(200, completionFixture);

    const result = await llmClient(impl, recorder).completeStructured({
      prompt: "p",
      schema: SCHEMA,
      operation: "classification",
    });

    expect(result).toEqual({ color: "black" });
  });

  it("records one metering row per call with real token counts", async () => {
    const { recorded, recorder } = recorderSpy();
    const { impl } = fetchStub(200, completionFixture);

    await llmClient(impl, recorder).completeStructured({
      prompt: "p",
      schema: SCHEMA,
      operation: "intent",
      storeId: "test-shop.myshopify.com",
      searchId: "search-1",
    });

    expect(recorded).toEqual([
      {
        provider: "google",
        modelId: "test-flash-model",
        operation: "intent",
        inputTokens: 120,
        outputTokens: 8,
        storeId: "test-shop.myshopify.com",
        searchId: "search-1",
      },
    ]);
  });

  it("still meters a schema-violating (non-JSON) answer before throwing", async () => {
    const { recorded, recorder } = recorderSpy();
    const { impl } = fetchStub(200, {
      candidates: [{ content: { parts: [{ text: "not json at all" }] } }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
    });

    await expect(
      llmClient(impl, recorder).completeStructured({
        prompt: "p",
        schema: SCHEMA,
        operation: "classification",
      }),
    ).rejects.toThrow(GeminiResponseError);
    expect(recorded).toHaveLength(1);
  });

  it("throws unmetered when the response carries no usageMetadata", async () => {
    const { recorded, recorder } = recorderSpy();
    const { impl } = fetchStub(200, {
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
    });

    await expect(
      llmClient(impl, recorder).completeStructured({
        prompt: "p",
        schema: SCHEMA,
        operation: "classification",
      }),
    ).rejects.toThrow(/usageMetadata/);
    expect(recorded).toHaveLength(0);
  });

  it("maps an HTTP error to GeminiApiError with status and body", async () => {
    const { recorded, recorder } = recorderSpy();
    const { impl } = fetchStub(429, { error: { message: "quota" } });

    const call = llmClient(impl, recorder).completeStructured({
      prompt: "p",
      schema: SCHEMA,
      operation: "classification",
    });

    await expect(call).rejects.toThrow(GeminiApiError);
    await expect(
      llmClient(impl, recorder).completeStructured({
        prompt: "p",
        schema: SCHEMA,
        operation: "classification",
      }),
    ).rejects.toMatchObject({ status: 429 });
    // A failed HTTP call consumed nothing meterable.
    expect(recorded).toHaveLength(0);
  });
});

describe("request timeout", () => {
  // A fetch stub that never answers on its own: it settles only when the
  // abort signal fires, exactly like a hung socket under real fetch.
  function hangingFetch() {
    const signals: AbortSignal[] = [];
    const impl = ((_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      signals.push(signal!);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason as Error);
        });
      });
    }) as typeof fetch;
    return { signals, impl };
  }

  it("aborts a hung request after requestTimeoutMs with GeminiTimeoutError", async () => {
    const { recorded, recorder } = recorderSpy();
    const { impl } = hangingFetch();

    const client = createGeminiLlmClient({
      modelId: "test-flash-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      requestTimeoutMs: 25,
    });
    const call = client.completeStructured({
      prompt: "p",
      schema: SCHEMA,
      operation: "classification",
    });

    await expect(call).rejects.toThrow(GeminiTimeoutError);
    await expect(
      client.completeStructured({
        prompt: "p",
        schema: SCHEMA,
        operation: "classification",
      }),
      // ETIMEDOUT is the contract transient-retry predicates key on.
    ).rejects.toMatchObject({ code: "ETIMEDOUT", timeoutMs: 25 });
    // A timed-out call never delivered usage — nothing to meter.
    expect(recorded).toHaveLength(0);
  });

  it("aborts a hung embedding request the same way", async () => {
    const { recorder } = recorderSpy();
    const { impl } = hangingFetch();

    const client = createGeminiEmbeddingClient({
      modelId: "test-embedding-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      requestTimeoutMs: 25,
    });
    await expect(client.embed({ texts: ["a"] })).rejects.toThrow(
      GeminiTimeoutError,
    );
  });

  it("arms a timeout signal on every request even when none is configured", async () => {
    const { recorder } = recorderSpy();
    let seen: AbortSignal | null | undefined;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return new Response(JSON.stringify(completionFixture), { status: 200 });
    }) as typeof fetch;

    await llmClient(impl, recorder).completeStructured({
      prompt: "p",
      schema: SCHEMA,
      operation: "classification",
    });

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});

function embeddingFixture(dimension: number, count: number) {
  return {
    embeddings: Array.from({ length: count }, (_, i) => ({
      // Non-normalized values so tests prove re-normalization.
      values: Array.from({ length: dimension }, (_, j) =>
        j === i % dimension ? 2 : 0,
      ),
    })),
  };
}

describe("embeddings", () => {
  it("shapes a batch request with outputDimensionality per text", async () => {
    const { recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, embeddingFixture(4, 2));

    const client = createGeminiEmbeddingClient({
      modelId: "test-embedding-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      dimension: 4,
    });
    await client.embed({ texts: ["first text", "second text"] });

    const request = captured[0]!;
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test-embedding-model:batchEmbedContents",
    );
    expect(request.body.requests).toEqual([
      {
        model: "models/test-embedding-model",
        content: { parts: [{ text: "first text" }] },
        outputDimensionality: 4,
      },
      {
        model: "models/test-embedding-model",
        content: { parts: [{ text: "second text" }] },
        outputDimensionality: 4,
      },
    ]);
  });

  it("returns one unit-length vector per text in the declared dimension", async () => {
    const { recorder } = recorderSpy();
    const { impl } = fetchStub(200, embeddingFixture(4, 2));

    const client = createGeminiEmbeddingClient({
      modelId: "test-embedding-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      dimension: 4,
    });
    const vectors = await client.embed({ texts: ["a", "b"] });

    expect(client.dimension).toBe(4);
    expect(vectors).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
  });

  it("meters the batch as one embedding-operation row with estimated tokens", async () => {
    const { recorded, recorder } = recorderSpy();
    const { impl } = fetchStub(200, embeddingFixture(4, 2));

    const client = createGeminiEmbeddingClient({
      modelId: "test-embedding-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      dimension: 4,
    });
    // 8 + 8 chars → ceil(16 / 4) = 4 estimated tokens.
    await client.embed({ texts: ["12345678", "12345678"], searchId: "s-1" });

    expect(recorded).toEqual([
      {
        provider: "google",
        modelId: "test-embedding-model",
        operation: "embedding",
        inputTokens: 4,
        outputTokens: 0,
        storeId: undefined,
        searchId: "s-1",
      },
    ]);
  });

  it("embeds nothing and records nothing for an empty batch", async () => {
    const { recorded, recorder } = recorderSpy();
    const { captured, impl } = fetchStub(200, {});

    const client = createGeminiEmbeddingClient({
      modelId: "test-embedding-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
    });
    expect(await client.embed({ texts: [] })).toEqual([]);
    expect(captured).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("fails loudly on a dimension mismatch", async () => {
    const { recorder } = recorderSpy();
    const { impl } = fetchStub(200, embeddingFixture(8, 1));

    const client = createGeminiEmbeddingClient({
      modelId: "test-embedding-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      dimension: 4,
    });
    await expect(client.embed({ texts: ["a"] })).rejects.toThrow(
      /dimension 8, expected 4/,
    );
  });

  it("fails loudly when the embedding count does not match the text count", async () => {
    const { recorder } = recorderSpy();
    const { impl } = fetchStub(200, embeddingFixture(4, 1));

    const client = createGeminiEmbeddingClient({
      modelId: "test-embedding-model",
      apiKey: "test-key-not-real",
      costRecorder: recorder,
      fetchImpl: impl,
      dimension: 4,
    });
    await expect(client.embed({ texts: ["a", "b"] })).rejects.toThrow(
      /1 embeddings for 2 texts/,
    );
  });
});
