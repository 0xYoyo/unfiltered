/**
 * Google AI Studio (Gemini) adapter for the engine's LLM and embedding ports.
 *
 * Every call is metered through the engine's CostRecorder port before its
 * response is interpreted, so even schema-violating output is paid-for and
 * recorded. Model IDs are never hardcoded at call sites: they arrive through
 * options, with env-derived defaults exposed by `geminiModelsFromEnv`.
 */

import type {
  CostRecorder,
  EmbeddingClient,
  EmbeddingRequest,
  LlmClient,
  StructuredCompletionRequest,
} from "@unfiltered/engine";

const PROVIDER = "google";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Adapter misconfiguration (e.g. missing API key). */
export class GeminiConfigError extends Error {}

/** The Gemini API answered with a non-OK HTTP status. */
export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** The Gemini API answered 200 but the payload was not usable. */
export class GeminiResponseError extends Error {}

/**
 * A request exceeded its abort timeout before headers arrived. Carries the
 * conventional `ETIMEDOUT` code so callers' transport-error predicates (e.g.
 * the live regeneration retry ladder) treat it like any network timeout.
 */
export class GeminiTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
  }
}

export interface GeminiClientOptions {
  /** Provider model ID, e.g. from `geminiModelsFromEnv()`. Never hardcode. */
  modelId: string;
  /** Ledger port every call records through. */
  costRecorder: CostRecorder;
  /** Defaults to `GEMINI_API_KEY` from the environment. */
  apiKey?: string;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** API base URL; defaults to the Google AI Studio endpoint. */
  baseUrl?: string;
  /**
   * Per-request abort timeout in milliseconds; defaults to
   * `DEFAULT_REQUEST_TIMEOUT_MS`. A request that has not answered by then
   * throws `GeminiTimeoutError` instead of waiting out undici's ~5-minute
   * headers timeout.
   */
  requestTimeoutMs?: number;
}

export interface GeminiEmbeddingClientOptions extends GeminiClientOptions {
  /** Vector dimension to request; defaults to `DEFAULT_EMBEDDING_DIMENSION`. */
  dimension?: number;
}

/** Default per-request abort timeout (YOY-28 wrap-up item 3). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Documented default model IDs; override via env, never in code. */
export const DEFAULT_CLASSIFICATION_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_INTENT_MODEL = "gemini-3.6-flash";
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const DEFAULT_EMBEDDING_DIMENSION = 768;

export interface GeminiModelConfig {
  /** For classification and enrichment operations. */
  classificationModel: string;
  /** For intent extraction (the accuracy-tier model). */
  intentModel: string;
  embeddingModel: string;
  embeddingDimension: number;
}

/**
 * Resolve model configuration from the environment with documented defaults:
 * GEMINI_CLASSIFICATION_MODEL, GEMINI_INTENT_MODEL, GEMINI_EMBEDDING_MODEL,
 * GEMINI_EMBEDDING_DIMENSION.
 */
export function geminiModelsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GeminiModelConfig {
  return {
    classificationModel:
      env.GEMINI_CLASSIFICATION_MODEL ?? DEFAULT_CLASSIFICATION_MODEL,
    intentModel: env.GEMINI_INTENT_MODEL ?? DEFAULT_INTENT_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: parseEmbeddingDimension(env.GEMINI_EMBEDDING_DIMENSION),
  };
}

/**
 * A malformed dimension must fail here, at configuration time, not surface
 * later as NaN-sized requests (YOY-29 AC-3).
 */
function parseEmbeddingDimension(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_EMBEDDING_DIMENSION;
  }
  const dimension = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(dimension) || dimension <= 0) {
    throw new GeminiConfigError(
      `GEMINI_EMBEDDING_DIMENSION must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return dimension;
}

interface ResolvedOptions {
  modelId: string;
  costRecorder: CostRecorder;
  apiKey: string;
  fetchImpl: typeof fetch;
  baseUrl: string;
  requestTimeoutMs: number;
}

function resolveOptions(options: GeminiClientOptions): ResolvedOptions {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiConfigError(
      "GEMINI_API_KEY is not set and no apiKey option was provided",
    );
  }
  return {
    modelId: options.modelId,
    costRecorder: options.costRecorder,
    apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

async function postJson(
  resolved: ResolvedOptions,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await resolved.fetchImpl(`${resolved.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": resolved.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.requestTimeoutMs),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new GeminiTimeoutError(
        `Gemini API ${path} timed out after ${resolved.requestTimeoutMs}ms`,
        resolved.requestTimeoutMs,
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw new GeminiApiError(
      `Gemini API ${path} answered ${response.status}`,
      response.status,
      await response.text(),
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Translate a JSON-Schema nullable union (`type: ["string", "null"]`) into
 * Gemini's structured-output dialect (`type: "string", nullable: true`),
 * recursively through the whole schema. Gemini's responseSchema rejects type
 * arrays outright (YOY-28). A null admitted in an `enum` alongside the union
 * (the engine's strictly self-consistent enum-or-null form, YOY-35 AC-6) is
 * likewise re-expressed through `nullable` — the enum sent to Gemini lists
 * only the string tokens, exactly as before the engine added null to it.
 * Everything else passes through unchanged: the engine speaks JSON Schema;
 * this adapter owns the vendor dialect.
 */
export function toGeminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiResponseSchema);
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  const translated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    translated[key] = toGeminiResponseSchema(value);
  }
  const type = translated.type;
  if (Array.isArray(type) && type.includes("null")) {
    const nonNull = type.filter((entry) => entry !== "null");
    if (nonNull.length === 1) {
      translated.type = nonNull[0];
      translated.nullable = true;
      if (Array.isArray(translated.enum) && translated.enum.includes(null)) {
        translated.enum = translated.enum.filter((entry) => entry !== null);
      }
    }
  }
  return translated;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * LLM structured-output client over Gemini `generateContent` with a response
 * JSON schema. The call is recorded to the cost ledger before the output is
 * parsed: a schema-violating answer still cost real tokens.
 */
export function createGeminiLlmClient(options: GeminiClientOptions): LlmClient {
  const resolved = resolveOptions(options);

  return {
    async completeStructured(
      request: StructuredCompletionRequest,
    ): Promise<unknown> {
      const payload = (await postJson(
        resolved,
        `models/${resolved.modelId}:generateContent`,
        {
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: toGeminiResponseSchema(request.schema),
          },
        },
      )) as GenerateContentResponse;

      const usage = payload.usageMetadata;
      if (!usage || typeof usage.promptTokenCount !== "number") {
        // Refuse to guess token counts for a completion: a response without
        // usage metadata would otherwise be silently unmetered spend.
        throw new GeminiResponseError(
          `Gemini response for ${resolved.modelId} carried no usageMetadata; call not metered`,
        );
      }
      await resolved.costRecorder.record({
        provider: PROVIDER,
        modelId: resolved.modelId,
        operation: request.operation,
        inputTokens: usage.promptTokenCount,
        outputTokens: usage.candidatesTokenCount ?? 0,
        shopDomain: request.shopDomain,
        searchId: request.searchId,
      });

      const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") {
        throw new GeminiResponseError(
          `Gemini response for ${resolved.modelId} contained no text candidate`,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new GeminiResponseError(
          `Gemini response for ${resolved.modelId} was not valid JSON: ${text.slice(0, 200)}`,
        );
      }
    },
  };
}

interface BatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

/**
 * Basis of the embedding token estimate (YOY-29 AC-4): `batchEmbedContents`
 * returns no usage metadata, so metering falls back to the common ~4
 * characters-per-token heuristic for Latin-script text. Error bound: roughly
 * a factor of two — non-Latin scripts (Hebrew in this catalog) tokenize to
 * fewer characters per token, so the estimate skews LOW for HE-heavy text.
 * Replace with real usage metadata if the API ever provides it.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for embedding metering. See
 * `ESTIMATED_CHARS_PER_TOKEN` for the estimate's basis and error bound; the
 * call is recorded with this estimate rather than dropped from metering.
 */
function estimateTokens(texts: string[]): number {
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN);
}

/**
 * Embedding client over Gemini `batchEmbedContents`, truncating to the
 * configured dimension via `outputDimensionality`. Vectors are re-normalized
 * to unit length: gemini-embedding-001 only normalizes full 3072-dimension
 * output, and truncated vectors must be normalized manually per Google's
 * embedding docs.
 */
export function createGeminiEmbeddingClient(
  options: GeminiEmbeddingClientOptions,
): EmbeddingClient {
  const resolved = resolveOptions(options);
  const dimension = options.dimension ?? DEFAULT_EMBEDDING_DIMENSION;

  return {
    dimension,
    async embed(request: EmbeddingRequest): Promise<number[][]> {
      if (request.texts.length === 0) {
        return [];
      }
      const payload = (await postJson(
        resolved,
        `models/${resolved.modelId}:batchEmbedContents`,
        {
          requests: request.texts.map((text) => ({
            model: `models/${resolved.modelId}`,
            content: { parts: [{ text }] },
            outputDimensionality: dimension,
          })),
        },
      )) as BatchEmbedResponse;

      await resolved.costRecorder.record({
        provider: PROVIDER,
        modelId: resolved.modelId,
        operation: request.operation ?? "embedding",
        inputTokens: estimateTokens(request.texts),
        outputTokens: 0,
        shopDomain: request.shopDomain,
        searchId: request.searchId,
      });

      const embeddings = payload.embeddings;
      if (!embeddings || embeddings.length !== request.texts.length) {
        throw new GeminiResponseError(
          `Gemini returned ${embeddings?.length ?? 0} embeddings for ${request.texts.length} texts`,
        );
      }
      return embeddings.map((embedding, index) => {
        const values = embedding.values;
        if (!values || values.length !== dimension) {
          throw new GeminiResponseError(
            `Embedding ${index} has dimension ${values?.length ?? 0}, expected ${dimension}`,
          );
        }
        const norm = Math.sqrt(
          values.reduce((sum, value) => sum + value * value, 0),
        );
        if (norm === 0) {
          throw new GeminiResponseError(`Embedding ${index} is the zero vector`);
        }
        return values.map((value) => value / norm);
      });
    },
  };
}
