/**
 * OpenRouter adapters for the LLM and embedding ports (YOY-177 AC-1): the
 * card writer and the card embedder can run on OpenRouter's
 * OpenAI-compatible chat-completions and embeddings APIs, calling the same
 * Gemini model family the Gemini key serves, so a card run can be paid on
 * OpenRouter when the Gemini balance is short. Chosen by `CARD_PROVIDER`
 * (app/catalog/card.server.ts); the Gemini key stays the default and
 * production search never builds these clients.
 *
 * Every call is metered through the CostRecorder port, priced from
 * config/ai-prices.json under the OpenRouter model id, before its answer
 * is parsed: an unusable answer is still paid for and recorded.
 */

import type {
  CostRecorder,
  EmbeddingClient,
  EmbeddingRequest,
  LlmClient,
  StructuredCompletionRequest,
} from "@unfiltered/engine";

import {
  DEFAULT_OPENROUTER_TIMEOUT_MS,
  OpenRouterApiError,
  OpenRouterConfigError,
  OpenRouterResponseError,
  OpenRouterTimeoutError,
} from "./openrouter.server";

const PROVIDER = "openrouter";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** The card model over OpenRouter: the Gemini key's card model, `gemini-3.5-flash-lite`. */
export const DEFAULT_OPENROUTER_CARD_MODEL = "google/gemini-3.5-flash-lite";
/** The embedding model over OpenRouter: the Gemini key's `gemini-embedding-001`, so vectors share one space. */
export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "google/gemini-embedding-001";

export interface OpenRouterCatalogModels {
  cardModel: string;
  embeddingModel: string;
}

/** `OPENROUTER_CARD_MODEL` and `OPENROUTER_EMBEDDING_MODEL`, else the defaults above. */
export function openRouterCatalogModelsFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenRouterCatalogModels {
  return {
    cardModel: env.OPENROUTER_CARD_MODEL ?? DEFAULT_OPENROUTER_CARD_MODEL,
    embeddingModel: env.OPENROUTER_EMBEDDING_MODEL ?? DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  };
}

interface OpenRouterClientOptions {
  /** Provider model id, e.g. from `openRouterCatalogModelsFromEnv()`. Never hardcode. */
  modelId: string;
  costRecorder: CostRecorder;
  /** Defaults to `OPENROUTER_API_KEY` from the environment. */
  apiKey?: string;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export interface OpenRouterLlmClientOptions extends OpenRouterClientOptions {
  /**
   * Reasoning effort sent as `reasoning.effort` ("minimal", "low", "medium",
   * "high"), the Gemini adapter's thinking level; absent leaves the model's
   * default.
   */
  reasoningEffort?: string;
}

export interface OpenRouterEmbeddingClientOptions extends OpenRouterClientOptions {
  /** The vector dimension every answer is cut to; the Gemini key's configured dimension. */
  dimension: number;
}

interface Usage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

function apiKeyOf(options: OpenRouterClientOptions): string {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new OpenRouterConfigError("OPENROUTER_API_KEY is not set");
  }
  return apiKey;
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** POST one JSON body and return the parsed JSON answer; HTTP and timeout failures throw. */
async function postJson(
  options: OpenRouterClientOptions,
  apiKey: string,
  path: string,
  body: unknown,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal !== undefined ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (timeout.aborted && !callerSignal?.aborted) {
      throw new OpenRouterTimeoutError(`OpenRouter ${path} timed out after ${timeoutMs} ms`, timeoutMs);
    }
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new OpenRouterApiError(`OpenRouter ${path} answered HTTP ${response.status}`, response.status, text);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenRouterResponseError(`OpenRouter ${path} answered a body that is not JSON`);
  }
}

/** The image bytes as an OpenAI-style data URL content part. */
function imagePart(image: { mimeType: string; data: Uint8Array }): unknown {
  return {
    type: "image_url",
    image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}` },
  };
}

/**
 * The LLM port over OpenRouter chat completions: the prompt (images first,
 * as the Gemini adapter orders them), the schema as a strict
 * `json_schema` response format, the answer's message content parsed as JSON.
 */
export function createOpenRouterLlmClient(options: OpenRouterLlmClientOptions): LlmClient {
  const apiKey = apiKeyOf(options);
  return {
    async completeStructured(request: StructuredCompletionRequest): Promise<unknown> {
      const images = request.images ?? [];
      const content =
        images.length === 0
          ? request.prompt
          : [...images.map(imagePart), { type: "text", text: request.prompt }];
      const payload = (await postJson(
        options,
        apiKey,
        "chat/completions",
        {
          model: options.modelId,
          messages: [{ role: "user", content }],
          response_format: {
            type: "json_schema",
            json_schema: { name: request.operation, strict: true, schema: request.schema },
          },
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(options.reasoningEffort !== undefined ? { reasoning: { effort: options.reasoningEffort } } : {}),
        },
        request.signal,
      )) as { choices?: { message?: { content?: unknown } }[]; usage?: Usage };
      const usage = payload.usage ?? {};
      await options.costRecorder.record({
        provider: PROVIDER,
        modelId: options.modelId,
        operation: request.operation,
        inputTokens: tokens(usage.prompt_tokens),
        outputTokens: tokens(usage.completion_tokens),
        ...(request.storeId !== undefined ? { storeId: request.storeId } : {}),
        ...(request.searchId !== undefined ? { searchId: request.searchId } : {}),
      });
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim() === "") {
        throw new OpenRouterResponseError("OpenRouter chat completion answered no content");
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new OpenRouterResponseError("OpenRouter chat completion content is not JSON");
      }
    },
  };
}

/**
 * The embedding port over OpenRouter embeddings, asking for `dimension`
 * values. gemini-embedding-001 is Matryoshka-trained, so a longer answer
 * is cut to its first `dimension` values — what Gemini's
 * `outputDimensionality` returns — and every vector is re-normalized to
 * unit length, as the Gemini adapter does.
 */
export function createOpenRouterEmbeddingClient(
  options: OpenRouterEmbeddingClientOptions,
): EmbeddingClient {
  const apiKey = apiKeyOf(options);
  const { dimension } = options;
  return {
    dimension,
    async embed(request: EmbeddingRequest): Promise<number[][]> {
      if (request.texts.length === 0) {
        return [];
      }
      const payload = (await postJson(options, apiKey, "embeddings", {
        model: options.modelId,
        input: request.texts,
        dimensions: dimension,
      })) as { data?: { embedding?: unknown; index?: unknown }[]; usage?: Usage };
      const usage = payload.usage ?? {};
      await options.costRecorder.record({
        provider: PROVIDER,
        modelId: options.modelId,
        operation: request.operation ?? "embedding",
        inputTokens: tokens(usage.prompt_tokens),
        outputTokens: 0,
        ...(request.storeId !== undefined ? { storeId: request.storeId } : {}),
        ...(request.searchId !== undefined ? { searchId: request.searchId } : {}),
      });
      const data = payload.data ?? [];
      if (data.length !== request.texts.length) {
        throw new OpenRouterResponseError(
          `OpenRouter returned ${data.length} embeddings for ${request.texts.length} texts`,
        );
      }
      const ordered = [...data].sort((a, b) => tokens(a.index) - tokens(b.index));
      return ordered.map((entry, index) => {
        const values = entry.embedding;
        if (!Array.isArray(values) || values.length < dimension || values.some((v) => typeof v !== "number")) {
          throw new OpenRouterResponseError(
            `Embedding ${index} has dimension ${Array.isArray(values) ? values.length : 0}, expected ${dimension}`,
          );
        }
        const cut = (values as number[]).slice(0, dimension);
        const norm = Math.sqrt(cut.reduce((sum, value) => sum + value * value, 0));
        if (norm === 0) {
          throw new OpenRouterResponseError(`Embedding ${index} is the zero vector`);
        }
        return cut.map((value) => value / norm);
      });
    },
  };
}
