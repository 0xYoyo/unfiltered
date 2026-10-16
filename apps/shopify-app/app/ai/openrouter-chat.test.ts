import type { AiCallUsage, CostRecorder } from "@unfiltered/engine";
import { describe, expect, it } from "vitest";

import { computeCostUsd } from "./pricing.server";
import {
  createOpenRouterEmbeddingClient,
  createOpenRouterLlmClient,
  DEFAULT_OPENROUTER_CARD_MODEL,
  DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  openRouterCatalogModelsFromEnv,
} from "./openrouter-chat.server";
import { OpenRouterApiError, OpenRouterConfigError, OpenRouterResponseError } from "./openrouter.server";

// The OpenRouter chat-completions and embeddings adapters (YOY-177 AC-1):
// the wire request each sends, the answer each parses, and the ledger row
// each call writes. A fake fetch answers; offline and $0.

function recorder(): CostRecorder & { rows: AiCallUsage[] } {
  const rows: AiCallUsage[] = [];
  return { rows, record: async (usage) => void rows.push(usage) };
}

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const SCHEMA = { type: "object", properties: { facts: { type: "string" } }, required: ["facts"] };

describe("openRouterCatalogModelsFromEnv (YOY-177 AC-1)", () => {
  it("defaults to the Gemini key's card and embedding models under their OpenRouter ids, and both are priced", () => {
    expect(openRouterCatalogModelsFromEnv({})).toEqual({
      cardModel: "google/gemini-3.5-flash-lite",
      embeddingModel: "google/gemini-embedding-001",
    });
    expect(
      openRouterCatalogModelsFromEnv({ OPENROUTER_CARD_MODEL: "a/b", OPENROUTER_EMBEDDING_MODEL: "c/d" }),
    ).toEqual({ cardModel: "a/b", embeddingModel: "c/d" });
    expect(computeCostUsd(DEFAULT_OPENROUTER_CARD_MODEL, 1_000_000, 1_000_000)).toBeCloseTo(2.8);
    expect(computeCostUsd(DEFAULT_OPENROUTER_EMBEDDING_MODEL, 1_000_000, 0)).toBeCloseTo(0.15);
  });
});

describe("the OpenRouter LLM adapter (YOY-177 AC-1)", () => {
  it("posts the prompt with images first, a strict json_schema format and the reasoning effort; parses the content", async () => {
    const fetch = fakeFetch(200, {
      choices: [{ message: { content: '{"facts":"Linen."}' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 80 },
    });
    const costs = recorder();
    const client = createOpenRouterLlmClient({
      modelId: "google/gemini-3.5-flash-lite",
      reasoningEffort: "low",
      costRecorder: costs,
      apiKey: "k",
      fetchImpl: fetch.impl,
    });
    const answer = await client.completeStructured({
      prompt: "Write the card.",
      schema: SCHEMA,
      operation: "card",
      storeId: "playground:tentree",
      images: [{ mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }],
    });

    expect(answer).toEqual({ facts: "Linen." });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((fetch.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toEqual({
      model: "google/gemini-3.5-flash-lite",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
            { type: "text", text: "Write the card." },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "card", strict: true, schema: SCHEMA } },
      reasoning: { effort: "low" },
    });
    expect(costs.rows).toEqual([
      {
        provider: "openrouter",
        modelId: "google/gemini-3.5-flash-lite",
        operation: "card",
        inputTokens: 1200,
        outputTokens: 80,
        storeId: "playground:tentree",
      },
    ]);
  });

  it("sends a text-only prompt as a plain string and the temperature when given", async () => {
    const fetch = fakeFetch(200, { choices: [{ message: { content: '{"facts":"x"}' } }], usage: {} });
    const client = createOpenRouterLlmClient({ modelId: "m", costRecorder: recorder(), apiKey: "k", fetchImpl: fetch.impl });
    await client.completeStructured({ prompt: "p", schema: SCHEMA, operation: "card", temperature: 0 });
    const body = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(body.messages).toEqual([{ role: "user", content: "p" }]);
    expect(body.temperature).toBe(0);
    expect(body.reasoning).toBeUndefined();
  });

  it("records a paid call before failing on unusable content", async () => {
    const fetch = fakeFetch(200, { choices: [{ message: { content: "not json" } }], usage: { prompt_tokens: 5 } });
    const costs = recorder();
    const client = createOpenRouterLlmClient({ modelId: "m", costRecorder: costs, apiKey: "k", fetchImpl: fetch.impl });
    await expect(client.completeStructured({ prompt: "p", schema: SCHEMA, operation: "card" })).rejects.toBeInstanceOf(
      OpenRouterResponseError,
    );
    expect(costs.rows).toHaveLength(1);
  });

  it("throws the HTTP status on a non-OK answer and records nothing", async () => {
    const fetch = fakeFetch(402, "insufficient credits");
    const costs = recorder();
    const client = createOpenRouterLlmClient({ modelId: "m", costRecorder: costs, apiKey: "k", fetchImpl: fetch.impl });
    const error = await client
      .completeStructured({ prompt: "p", schema: SCHEMA, operation: "card" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenRouterApiError);
    expect((error as OpenRouterApiError).status).toBe(402);
    expect(costs.rows).toHaveLength(0);
  });

  it("refuses to build without an API key", () => {
    expect(() => createOpenRouterLlmClient({ modelId: "m", costRecorder: recorder(), apiKey: "" })).toThrow(
      OpenRouterConfigError,
    );
  });
});

describe("the OpenRouter embedding adapter (YOY-177 AC-1)", () => {
  it("asks for the dimension, orders by index, cuts longer vectors, re-normalizes and records the tokens", async () => {
    const fetch = fakeFetch(200, {
      data: [
        { index: 1, embedding: [0, 3, 4, 9] },
        { index: 0, embedding: [3, 4, 0, 9] },
      ],
      usage: { prompt_tokens: 12 },
    });
    const costs = recorder();
    const client = createOpenRouterEmbeddingClient({
      modelId: "google/gemini-embedding-001",
      dimension: 3,
      costRecorder: costs,
      apiKey: "k",
      fetchImpl: fetch.impl,
    });
    expect(client.dimension).toBe(3);
    const vectors = await client.embed({ texts: ["a", "b"], operation: "card-embedding", storeId: "s" });

    expect(vectors).toEqual([
      [0.6, 0.8, 0],
      [0, 0.6, 0.8],
    ]);
    expect(fetch.calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toEqual({
      model: "google/gemini-embedding-001",
      input: ["a", "b"],
      dimensions: 3,
    });
    expect(costs.rows).toEqual([
      {
        provider: "openrouter",
        modelId: "google/gemini-embedding-001",
        operation: "card-embedding",
        inputTokens: 12,
        outputTokens: 0,
        storeId: "s",
      },
    ]);
  });

  it("makes no call for no texts, and fails on a short vector or a wrong count", async () => {
    const none = fakeFetch(200, {});
    const empty = createOpenRouterEmbeddingClient({ modelId: "m", dimension: 3, costRecorder: recorder(), apiKey: "k", fetchImpl: none.impl });
    expect(await empty.embed({ texts: [] })).toEqual([]);
    expect(none.calls).toHaveLength(0);

    const short = fakeFetch(200, { data: [{ index: 0, embedding: [1, 2] }] });
    await expect(
      createOpenRouterEmbeddingClient({ modelId: "m", dimension: 3, costRecorder: recorder(), apiKey: "k", fetchImpl: short.impl }).embed({ texts: ["a"] }),
    ).rejects.toBeInstanceOf(OpenRouterResponseError);

    const count = fakeFetch(200, { data: [] });
    await expect(
      createOpenRouterEmbeddingClient({ modelId: "m", dimension: 3, costRecorder: recorder(), apiKey: "k", fetchImpl: count.impl }).embed({ texts: ["a"] }),
    ).rejects.toBeInstanceOf(OpenRouterResponseError);
  });
});
