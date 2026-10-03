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
export class GeminiConfigError extends Error {
  override readonly name = "GeminiConfigError";
}

/** The Gemini API answered with a non-OK HTTP status. */
export class GeminiApiError extends Error {
  override readonly name = "GeminiApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** The Gemini API answered 200 but the payload was not usable. */
export class GeminiResponseError extends Error {
  override readonly name = "GeminiResponseError";
}

/**
 * A request exceeded its abort timeout before headers arrived. Carries the
 * conventional `ETIMEDOUT` code so callers' transport-error predicates (e.g.
 * the live regeneration retry ladder) treat it like any network timeout.
 */
export class GeminiTimeoutError extends Error {
  // Named so a log line or an escalation reason carries the class, not
  // "Error" (YOY-64: the intent-failure warn line read `"error":"Error"`).
  override readonly name = "GeminiTimeoutError";
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
  /**
   * Gemini thinking level for `generateContent`, sent as
   * `generationConfig.thinkingConfig.thinkingLevel`. Undefined sends no
   * thinkingConfig and leaves the model at its own default. Intent
   * extraction runs at `DEFAULT_INTENT_THINKING_LEVEL` (YOY-109): at the
   * model default, gemini-3.6-flash spends 350–1000 thought tokens per
   * intent call and sits in a 3–10 s band with an upstream-queue tail to
   * 50 s and occasional no-response hangs that run into the abort timeout
   * — every one of which degrades the search to classic. At "low" the same
   * prompt answers the same JSON in 1.5–5 s with no tail.
   */
  thinkingLevel?: string;
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
/** The lite intent tier the lite-first ladder asks first (YOY-116). */
export const DEFAULT_INTENT_LITE_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
/**
 * The vision model the ingestion enrichment pass reads product images with
 * (YOY-121 AC-2): the docs/VISION-MODEL.md decision — matches the pro tier
 * on category and colour, ties flash on contamination, 6× cheaper than pro,
 * and already the repo's classification model. Override with
 * `GEMINI_VISION_MODEL`.
 */
export const DEFAULT_VISION_MODEL = "gemini-3.5-flash-lite";
/**
 * The card writer's model (YOY-143 AC-2; PRD §3 Refinement 6): Flash-Lite
 * writes one plain-text card per product at load time. A bigger writer is
 * adopted only after the comparison the PRD names (NG-4). Override with
 * `GEMINI_CARD_MODEL`.
 */
export const DEFAULT_CARD_MODEL = "gemini-3.5-flash-lite";
/**
 * Default judge model (YOY-147 AC-2): Flash-Lite, one call per page of the
 * find set. Override with `GEMINI_JUDGE_MODEL`.
 */
export const DEFAULT_JUDGE_MODEL = "gemini-3.5-flash-lite";
/**
 * Default wish-extraction model (YOY-149 AC-1): Flash-Lite, one small call
 * per submitted v2 search, in parallel with the find step. Override with
 * `GEMINI_EXTRACT_MODEL`.
 */
export const DEFAULT_EXTRACT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_EMBEDDING_DIMENSION = 768;
/** Thinking level the intent client runs at unless the env overrides it. */
export const DEFAULT_INTENT_THINKING_LEVEL = "low";
/**
 * Thinking level of the lite intent call (YOY-116): set explicitly, never
 * the model default — model configuration is a first-class dimension
 * (YOY-109), and the lite tier's job is to be fast.
 */
export const DEFAULT_INTENT_LITE_THINKING_LEVEL = "low";
/**
 * Thinking level of the vision enrichment call (YOY-121, binding comment):
 * set explicitly, never the model default (the YOY-109 lesson), and the
 * level docs/VISION-MODEL.md measured the decision at. Override with
 * `GEMINI_VISION_THINKING_LEVEL` (`model-default` sends no thinkingConfig).
 */
export const DEFAULT_VISION_THINKING_LEVEL = "low";
/**
 * Thinking level of the card writer (YOY-143): explicit, never the model
 * default (the YOY-109 lesson). Override with `GEMINI_CARD_THINKING_LEVEL`
 * (`model-default` sends no thinkingConfig).
 */
export const DEFAULT_CARD_THINKING_LEVEL = "low";
/**
 * Thinking level of the judge call (YOY-147 AC-2): low, explicit, never the
 * model default (`GEMINI_JUDGE_THINKING_LEVEL`; `model-default` sends no
 * thinkingConfig).
 */
export const DEFAULT_JUDGE_THINKING_LEVEL = "low";
/**
 * Thinking level of the wish extraction (YOY-149 AC-1): minimal, explicit
 * (`GEMINI_EXTRACT_THINKING_LEVEL`; `model-default` sends no thinkingConfig).
 * Measured 2026-10-03 on six EN/HE wishes: minimal answered all six
 * correctly at the same latency as low (~0.8–1.0 s), where low once invented
 * an exclusion and once dropped a Hebrew price's currency.
 */
export const DEFAULT_EXTRACT_THINKING_LEVEL = "minimal";
/**
 * Per-request abort timeout of the lite intent call (YOY-116): the lite
 * tier exists to be fast, and a hung lite call escalates to the accuracy
 * tier, so it must give up long before the adapter's 60 s default —
 * gemini-3.5-flash-lite was observed hanging past 90 s on one refinement
 * prompt. Strictly below `DEFAULT_INTENT_TIMEOUT_MS` (YOY-124 AC-12), so a
 * hung lite call still has ladder budget left to escalate with instead of
 * degrading to classic on the spot. Override with
 * `GEMINI_INTENT_LITE_TIMEOUT_MS`.
 */
export const DEFAULT_INTENT_LITE_TIMEOUT_MS = 3_000;
/**
 * Per-request abort timeout of the accuracy-tier intent call AND the
 * wall-clock deadline of the whole lite-first ladder (YOY-64 AC-3): a
 * never-answering upstream must degrade the search to classic well inside
 * the widget's 30 s primary budget and after its 3 s classic-rescue budget
 * (both asserted against the widget's constants by a test). The ladder
 * deadline is what makes the bound hold end to end — without it a hung
 * upstream costs the lite timeout plus the accuracy timeout in series. The
 * adapter's 60 s default stays for enrichment and embedding. 4500 ms is the
 * shopper's worst-case wait (YOY-124 AC-12, decided on the 2026-08-28 live
 * run: AI p95 3421 ms, one degraded of 200, so the bound clears the measured
 * tail by ~1 s); it was 8000 before. Override with `GEMINI_INTENT_TIMEOUT_MS`.
 */
export const DEFAULT_INTENT_TIMEOUT_MS = 4_500;
/**
 * `GEMINI_INTENT_THINKING_LEVEL` value that sends no thinkingConfig at all,
 * restoring the model's own default thinking (the pre-YOY-109 behaviour).
 */
export const MODEL_DEFAULT_THINKING_LEVEL = "model-default";

export interface GeminiModelConfig {
  /** For classification and enrichment operations. */
  classificationModel: string;
  /** For intent extraction (the accuracy-tier model). */
  intentModel: string;
  /** For the lite-first intent call (YOY-116); escalates to `intentModel`. */
  intentLiteModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  /** For the vision enrichment pass at ingestion (YOY-121). */
  visionModel: string;
  /**
   * Thinking level for the vision client, or undefined to leave the model
   * at its own default (`GEMINI_VISION_THINKING_LEVEL=model-default`).
   */
  visionThinkingLevel: string | undefined;
  /** For the card writer at ingestion (YOY-143). */
  cardModel: string;
  /**
   * Thinking level for the card writer, or undefined to leave the model at
   * its own default (`GEMINI_CARD_THINKING_LEVEL=model-default`).
   */
  cardThinkingLevel: string | undefined;
  /** For the judge call (YOY-147): one call per page of the find set. */
  judgeModel: string;
  /**
   * Thinking level for the judge, or undefined to leave the model at its
   * own default (`GEMINI_JUDGE_THINKING_LEVEL=model-default`).
   */
  judgeThinkingLevel: string | undefined;
  /** For the wish extraction (YOY-149): one call per submitted v2 search. */
  extractModel: string;
  /**
   * Thinking level for the extraction, or undefined to leave the model at
   * its own default (`GEMINI_EXTRACT_THINKING_LEVEL=model-default`).
   */
  extractThinkingLevel: string | undefined;
  /**
   * Thinking level for the intent client, or undefined to leave the model at
   * its own default (`GEMINI_INTENT_THINKING_LEVEL=model-default`).
   */
  intentThinkingLevel: string | undefined;
  /**
   * Thinking level for the lite intent client, or undefined to leave the
   * model at its own default (`GEMINI_INTENT_LITE_THINKING_LEVEL=model-default`).
   */
  intentLiteThinkingLevel: string | undefined;
  /** Abort timeout for the lite intent call, ms (`GEMINI_INTENT_LITE_TIMEOUT_MS`). */
  intentLiteTimeoutMs: number;
  /** Abort timeout for the accuracy-tier intent call, ms (`GEMINI_INTENT_TIMEOUT_MS`). */
  intentTimeoutMs: number;
}

/**
 * Resolve model configuration from the environment with documented defaults:
 * GEMINI_CLASSIFICATION_MODEL, GEMINI_INTENT_MODEL, GEMINI_EMBEDDING_MODEL,
 * GEMINI_EMBEDDING_DIMENSION, GEMINI_INTENT_THINKING_LEVEL,
 * GEMINI_INTENT_LITE_MODEL, GEMINI_INTENT_LITE_THINKING_LEVEL,
 * GEMINI_INTENT_LITE_TIMEOUT_MS, GEMINI_INTENT_TIMEOUT_MS,
 * GEMINI_VISION_MODEL, GEMINI_VISION_THINKING_LEVEL, GEMINI_CARD_MODEL,
 * GEMINI_CARD_THINKING_LEVEL, GEMINI_JUDGE_MODEL, GEMINI_JUDGE_THINKING_LEVEL.
 */
export function geminiModelsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GeminiModelConfig {
  return {
    classificationModel:
      env.GEMINI_CLASSIFICATION_MODEL ?? DEFAULT_CLASSIFICATION_MODEL,
    intentModel: env.GEMINI_INTENT_MODEL ?? DEFAULT_INTENT_MODEL,
    intentLiteModel: env.GEMINI_INTENT_LITE_MODEL ?? DEFAULT_INTENT_LITE_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: parseEmbeddingDimension(env.GEMINI_EMBEDDING_DIMENSION),
    visionModel: env.GEMINI_VISION_MODEL ?? DEFAULT_VISION_MODEL,
    visionThinkingLevel: parseThinkingLevel(
      "GEMINI_VISION_THINKING_LEVEL",
      env.GEMINI_VISION_THINKING_LEVEL,
      DEFAULT_VISION_THINKING_LEVEL,
    ),
    cardModel: env.GEMINI_CARD_MODEL ?? DEFAULT_CARD_MODEL,
    cardThinkingLevel: parseThinkingLevel(
      "GEMINI_CARD_THINKING_LEVEL",
      env.GEMINI_CARD_THINKING_LEVEL,
      DEFAULT_CARD_THINKING_LEVEL,
    ),
    judgeModel: env.GEMINI_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    judgeThinkingLevel: parseThinkingLevel(
      "GEMINI_JUDGE_THINKING_LEVEL",
      env.GEMINI_JUDGE_THINKING_LEVEL,
      DEFAULT_JUDGE_THINKING_LEVEL,
    ),
    extractModel: env.GEMINI_EXTRACT_MODEL ?? DEFAULT_EXTRACT_MODEL,
    extractThinkingLevel: parseThinkingLevel(
      "GEMINI_EXTRACT_THINKING_LEVEL",
      env.GEMINI_EXTRACT_THINKING_LEVEL,
      DEFAULT_EXTRACT_THINKING_LEVEL,
    ),
    intentThinkingLevel: parseThinkingLevel(
      "GEMINI_INTENT_THINKING_LEVEL",
      env.GEMINI_INTENT_THINKING_LEVEL,
      DEFAULT_INTENT_THINKING_LEVEL,
    ),
    intentLiteThinkingLevel: parseThinkingLevel(
      "GEMINI_INTENT_LITE_THINKING_LEVEL",
      env.GEMINI_INTENT_LITE_THINKING_LEVEL,
      DEFAULT_INTENT_LITE_THINKING_LEVEL,
    ),
    intentLiteTimeoutMs: parsePositiveInt(
      "GEMINI_INTENT_LITE_TIMEOUT_MS",
      env.GEMINI_INTENT_LITE_TIMEOUT_MS,
      DEFAULT_INTENT_LITE_TIMEOUT_MS,
    ),
    intentTimeoutMs: parsePositiveInt(
      "GEMINI_INTENT_TIMEOUT_MS",
      env.GEMINI_INTENT_TIMEOUT_MS,
      DEFAULT_INTENT_TIMEOUT_MS,
    ),
  };
}

/**
 * Unset means the documented default; `model-default` means no override; a
 * blank value is a misconfiguration, not a silent fallback (YOY-109).
 */
function parseThinkingLevel(
  variable: string,
  raw: string | undefined,
  fallback: string,
): string | undefined {
  if (raw === undefined) {
    return fallback;
  }
  const level = raw.trim();
  if (level === "") {
    throw new GeminiConfigError(
      `${variable} must name a thinking level or "${MODEL_DEFAULT_THINKING_LEVEL}", got ${JSON.stringify(raw)}`,
    );
  }
  return level === MODEL_DEFAULT_THINKING_LEVEL ? undefined : level;
}

/** A positive-integer env value with a default; malformed fails loudly. */
function parsePositiveInt(
  variable: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value <= 0) {
    throw new GeminiConfigError(
      `${variable} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
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
  thinkingLevel: string | undefined;
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
    thinkingLevel: options.thinkingLevel,
  };
}

async function postJson(
  resolved: ResolvedOptions,
  path: string,
  body: unknown,
  callerSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  // The per-request timeout always arms; a caller's signal (the intent
  // ladder's deadline, YOY-64 AC-3) aborts the same request earlier.
  const timeout = AbortSignal.timeout(resolved.requestTimeoutMs);
  const signal =
    callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
  try {
    response = await resolved.fetchImpl(`${resolved.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": resolved.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new GeminiTimeoutError(
        callerSignal?.aborted === true && !timeout.aborted
          ? `Gemini API ${path} aborted by the caller's deadline before its ${resolved.requestTimeoutMs}ms timeout`
          : `Gemini API ${path} timed out after ${resolved.requestTimeoutMs}ms`,
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
    /** Thinking tokens — billed at the output rate, absent when zero. */
    thoughtsTokenCount?: number;
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
      const payload = (await postStructured(
        resolved,
        request,
        {
          contents: [
            {
              role: "user",
              parts: [
                // Images first, text last (YOY-120 AC-3): each image is an
                // inlineData part carrying its MIME type and base64 bytes.
                // A text-only request sends exactly the single text part it
                // always did.
                ...(request.images ?? []).map((image) => ({
                  inlineData: {
                    mimeType: image.mimeType,
                    data: Buffer.from(image.data).toString("base64"),
                  },
                })),
                { text: request.prompt },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: toGeminiResponseSchema(request.schema),
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
            ...(resolved.thinkingLevel !== undefined
              ? { thinkingConfig: { thinkingLevel: resolved.thinkingLevel } }
              : {}),
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
        // Gemini bills thinking at the output rate, so thought tokens join
        // the output count (YOY-96 AC-19): the ledger's existing output
        // price applies, no new column. At the model default an intent call
        // spends 350–1010 thought tokens against ~40 of answer — left out,
        // the ledger under-reports intent spend by 2–4× per call.
        outputTokens:
          (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        storeId: request.storeId,
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
 * `generateContent` with the aborted call metered (YOY-125 AC-6).
 *
 * A caller-aborted or timed-out completion still cost real money: Google
 * bills the prompt tokens of a request it has begun, and the intent hedge
 * (`hedgedAccuracy`) now aborts the losing tier on every occasion-class
 * query, so an aborted intent call is a normal outcome rather than a rare
 * deadline cut. `postJson` raises `GeminiTimeoutError` before any usage
 * metadata exists, so the row is written with the input tokens ESTIMATED
 * from the prompt — the embedding precedent: recorded with this estimate
 * rather than dropped from metering — and `outputTokens: 0`, since whatever
 * the model produced before the abort never reached us. The error is then
 * rethrown unchanged, so every caller behaves exactly as before.
 *
 * Only the prompt text is estimated; inline image bytes (`request.images`)
 * are not, and a vision call aborted mid-flight is therefore under-counted.
 * Nothing aborts vision calls today — they carry no caller signal and run
 * off the hot path.
 */
async function postStructured(
  resolved: ResolvedOptions,
  request: StructuredCompletionRequest,
  body: unknown,
): Promise<Record<string, unknown>> {
  try {
    return await postJson(
      resolved,
      `models/${resolved.modelId}:generateContent`,
      body,
      request.signal,
    );
  } catch (error) {
    if (error instanceof GeminiTimeoutError) {
      await resolved.costRecorder.record({
        provider: PROVIDER,
        modelId: resolved.modelId,
        operation: request.operation,
        inputTokens: estimateTokens([request.prompt]),
        outputTokens: 0,
        storeId: request.storeId,
        searchId: request.searchId,
      });
    }
    throw error;
  }
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
 * Estimate token count for metering a call whose real usage is unavailable:
 * an embedding batch (the API returns no usage metadata) or a completion cut
 * short by an abort (YOY-125 AC-6). See `ESTIMATED_CHARS_PER_TOKEN` for the
 * estimate's basis and error bound; the call is recorded with this estimate
 * rather than dropped from metering.
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
        storeId: request.storeId,
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
