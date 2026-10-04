/**
 * OpenRouter adapter for the engine's decision port (YOY-152 AC-1): the
 * judge challenger, TypeSafe's Jev, answers typed questions through
 * OpenRouter's decisions endpoint. Every call is metered through the
 * CostRecorder port before its answers are read, so even an unusable
 * answer is paid for and recorded (AC-5). The model id arrives through
 * options, with the env-derived default from `openRouterModelsFromEnv`.
 */

import type {
  CostRecorder,
  DecisionAnswer,
  DecisionClient,
  DecisionRequest,
} from "@unfiltered/engine";

const PROVIDER = "openrouter";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/alpha";

/** The judge challenger's model (YOY-152 AC-1); override with `OPENROUTER_JUDGE_MODEL`. */
export const DEFAULT_OPENROUTER_JUDGE_MODEL = "typesafe/jev-1.13";
/** Per-request abort timeout unless the caller passes one. */
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 30_000;

/** Adapter misconfiguration (a missing API key). */
export class OpenRouterConfigError extends Error {
  override readonly name = "OpenRouterConfigError";
}

/** OpenRouter answered with a non-OK HTTP status. */
export class OpenRouterApiError extends Error {
  override readonly name = "OpenRouterApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** OpenRouter answered 200 but the payload was not usable. */
export class OpenRouterResponseError extends Error {
  override readonly name = "OpenRouterResponseError";
}

/** A request ran past its abort timeout. */
export class OpenRouterTimeoutError extends Error {
  override readonly name = "OpenRouterTimeoutError";
  readonly code = "ETIMEDOUT";
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
  }
}

export interface OpenRouterModelConfig {
  judgeModel: string;
}

export function openRouterModelsFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenRouterModelConfig {
  return { judgeModel: env.OPENROUTER_JUDGE_MODEL ?? DEFAULT_OPENROUTER_JUDGE_MODEL };
}

export interface OpenRouterDecisionClientOptions {
  /** Provider model id, e.g. from `openRouterModelsFromEnv()`. Never hardcode. */
  modelId: string;
  costRecorder: CostRecorder;
  /** Defaults to `OPENROUTER_API_KEY` from the environment. */
  apiKey?: string;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

interface WireAnswer {
  type?: unknown;
  choice?: unknown;
  noul?: unknown;
}

/** The port's question types in the wire's terms: `yes-no` is Jev's `noul`. */
function wireQuestions(questions: DecisionRequest["questions"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [
      key,
      question.type === "yes-no"
        ? {
            type: "noul",
            instructions: question.instructions,
            criteria: { true: question.criteria.yes, false: question.criteria.no },
          }
        : { type: "choice", instructions: question.instructions, criteria: question.criteria },
    ]),
  );
}

/** One wire answer in the port's terms; null when its shape is unknown. */
function portAnswer(answer: WireAnswer): DecisionAnswer | null {
  if (answer.type === "noul" && typeof answer.noul === "number") {
    return { type: "yes-no", yes: answer.noul };
  }
  if (answer.type === "choice" && typeof answer.choice === "string") {
    return { type: "choice", choice: answer.choice };
  }
  return null;
}

export function createOpenRouterDecisionClient(
  options: OpenRouterDecisionClientOptions,
): DecisionClient {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new OpenRouterConfigError("OPENROUTER_API_KEY is not set");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
  return {
    async decide(request) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        request.signal !== undefined ? AbortSignal.any([request.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/decisions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: options.modelId,
            state: request.state,
            questions: wireQuestions(request.questions),
          }),
          signal,
        });
      } catch (error) {
        if (timeout.aborted && !request.signal?.aborted) {
          throw new OpenRouterTimeoutError(
            `OpenRouter decision request timed out after ${timeoutMs} ms`,
            timeoutMs,
          );
        }
        throw error;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new OpenRouterApiError(
          `OpenRouter decisions answered HTTP ${response.status}`,
          response.status,
          text,
        );
      }
      let payload: { answers?: Record<string, WireAnswer>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        throw new OpenRouterResponseError("OpenRouter decisions answered a body that is not JSON");
      }
      // Metered before the answers are read (AC-5): a paid call is recorded
      // even when its answers turn out unusable.
      const usage = payload.usage ?? {};
      await options.costRecorder.record({
        provider: PROVIDER,
        modelId: options.modelId,
        operation: request.operation,
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        ...(request.storeId !== undefined ? { storeId: request.storeId } : {}),
        ...(request.searchId !== undefined ? { searchId: request.searchId } : {}),
      });
      const answers: Record<string, DecisionAnswer> = {};
      for (const key of Object.keys(request.questions)) {
        const raw = payload.answers?.[key];
        const answer = raw === undefined || raw === null ? null : portAnswer(raw);
        if (answer === null) {
          throw new OpenRouterResponseError(`OpenRouter decisions gave no usable answer for ${key}`);
        }
        answers[key] = answer;
      }
      return answers;
    },
  };
}
