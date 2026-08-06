/**
 * Query classification: the routing decision between classic search and the
 * AI pipeline. A deterministic heuristic layer settles clearly-simple queries
 * with zero LLM calls; everything else escalates to the LLM port. Vendor-free
 * by the engine's boundary rule — the model behind the port is the consumer's
 * concern.
 */

import type { JsonSchema, LlmClient } from "./index.js";

/** Where a query should be routed. */
export type QueryRoute = "classic" | "ai";

/** Why a route was chosen: the deciding heuristic rule, or the model. */
export type ClassificationReason =
  | "empty-query"
  | "quoted-phrase"
  | "sku-pattern"
  | "short-query"
  | "model"
  | "model-error";

/** The classifier's answer for one query. */
export interface ClassificationDecision {
  route: QueryRoute;
  reason: ClassificationReason;
}

/** JSON Schema the model's classification answer must satisfy. */
export const CLASSIFICATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    route: { type: "string", enum: ["classic", "ai"] },
  },
  required: ["route"],
};

/** Per-call context forwarded to the LLM port for metering. */
export interface ClassificationContext {
  shopDomain?: string;
  searchId?: string;
}

export interface QueryClassifier {
  /** Decide the route for one query string. Never rejects: LLM failures fall back to `classic`. */
  classify(
    query: string,
    context?: ClassificationContext,
  ): Promise<ClassificationDecision>;
}

export interface QueryClassifierOptions {
  /** LLM port; the consumer constructs it with its configured classification model. */
  llm: LlmClient;
  /** Milliseconds before an in-flight LLM call fails safe to `classic`. */
  timeoutMs?: number;
  /** Maximum cached normalized queries; oldest entries are evicted first. */
  cacheSize?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_SIZE = 1000;

/**
 * Cache key and heuristic input: lowercased, trimmed, inner whitespace
 * collapsed — so trivially different spellings of one query classify once.
 */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A token that looks like a SKU / model number: has a digit, and is only letters, digits, and dashes. */
const SKU_TOKEN = /^(?=.*\d)[\p{L}\p{N}-]+$/u;

/** A bare number: SKU-looking only through its digits, with no letter evidence. */
const PURE_NUMBER = /^\p{N}+$/u;

/**
 * Words and standalone currency symbols that mark the following bare number
 * as a price bound ("dress under 400", "שמלה עד 400") rather than a model
 * number — such queries carry natural-language intent and must escalate.
 */
const PRICE_MARKERS = new Set([
  "under",
  "over",
  "below",
  "above",
  "עד",
  "מעל",
  "$",
  "₪",
  "€",
]);

/** SKU_TOKEN, except a bare number right after a price marker is a price bound, not a SKU. */
function isSkuToken(tokens: string[], index: number): boolean {
  const token = tokens[index]!;
  if (!SKU_TOKEN.test(token)) {
    return false;
  }
  return !(
    PURE_NUMBER.test(token) &&
    index > 0 &&
    PRICE_MARKERS.has(tokens[index - 1]!)
  );
}

/**
 * Deterministic fast path (AC-1): settle clearly-simple queries as `classic`
 * without touching the LLM port. Returns null when the heuristics cannot
 * decide. Rules, in order:
 *
 * - empty query → classic (nothing to interpret)
 * - whole query wrapped in quotes → classic (exact-phrase intent)
 * - ≤4 tokens with a SKU/model-number-looking token → classic ("nike air max 90");
 *   a bare number right after a price marker ("dress under 400") is not one
 * - ≤2 tokens → classic (too short to carry natural-language intent)
 */
export function classifyByHeuristics(
  normalized: string,
): ClassificationDecision | null {
  if (normalized === "") {
    return { route: "classic", reason: "empty-query" };
  }
  if (/^["'“”„].*["'“”„]$/.test(normalized)) {
    return { route: "classic", reason: "quoted-phrase" };
  }
  const tokens = normalized.split(" ");
  if (tokens.length <= 4 && tokens.some((_, index) => isSkuToken(tokens, index))) {
    return { route: "classic", reason: "sku-pattern" };
  }
  if (tokens.length <= 2) {
    return { route: "classic", reason: "short-query" };
  }
  return null;
}

function buildClassificationPrompt(normalized: string): string {
  return [
    "Route this e-commerce product search query.",
    'Answer "classic" when the query is a plain keyword, brand, or product-',
    'code lookup that classic keyword search handles well. Answer "ai" when',
    "the query expresses natural-language intent: descriptive attributes,",
    "occasions, comparisons, negations, price constraints, or full sentences.",
    "The query may be in any language. Answer as JSON.",
    "",
    `Query: ${normalized}`,
  ].join("\n");
}

function parseRoute(value: unknown): QueryRoute | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const route = (value as Record<string, unknown>).route;
  return route === "classic" || route === "ai" ? route : null;
}

/**
 * Create a classifier over the given LLM port.
 *
 * Undecided queries escalate to the model with operation "classification",
 * so a metered adapter lands one cost-ledger row per call (AC-4). Successful
 * model decisions are cached by normalized query (AC-3); errors, timeouts,
 * and schema-violating answers are NOT cached — they fail safe to `classic`
 * for this call only (AC-6) and the next identical query retries the model.
 */
export function createQueryClassifier(
  options: QueryClassifierOptions,
): QueryClassifier {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
  const cache = new Map<string, ClassificationDecision>();

  async function classifyByModel(
    normalized: string,
    context?: ClassificationContext,
  ): Promise<ClassificationDecision> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = await Promise.race([
        options.llm.completeStructured({
          prompt: buildClassificationPrompt(normalized),
          schema: CLASSIFICATION_SCHEMA,
          operation: "classification",
          shopDomain: context?.shopDomain,
          searchId: context?.searchId,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("classification timed out")),
            timeoutMs,
          );
        }),
      ]);
      const route = parseRoute(completion);
      if (route === null) {
        return { route: "classic", reason: "model-error" };
      }
      const decision: ClassificationDecision = { route, reason: "model" };
      cache.set(normalized, decision);
      if (cache.size > cacheSize) {
        cache.delete(cache.keys().next().value!);
      }
      return decision;
    } catch {
      // Fail safe (AC-6): a failed or timed-out call routes to classic search
      // rather than blocking the shopper.
      return { route: "classic", reason: "model-error" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async classify(query, context) {
      const normalized = normalizeQuery(query);
      const heuristic = classifyByHeuristics(normalized);
      if (heuristic !== null) {
        return heuristic;
      }
      const cached = cache.get(normalized);
      if (cached !== undefined) {
        return cached;
      }
      return classifyByModel(normalized, context);
    },
  };
}
