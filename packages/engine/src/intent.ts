/**
 * Intent extraction: turning a free-text shopper query into structured
 * intent — hard constraints for filtering and soft attributes for
 * similarity — in any language. Vendor-free by the engine's boundary rule:
 * the accuracy-tier model behind the port is the consumer's concern.
 */

import type { JsonSchema, LlmClient } from "./index.js";

/**
 * Structured intent extracted from one query. Optional fields are hard
 * constraints the shopper may or may not have stated; the arrays are always
 * present (possibly empty). Hard constraints drive filtering; softAttributes
 * drive similarity.
 */
export interface Intent {
  /** Product category the shopper asked for, e.g. "dress". */
  category?: string;
  /** Lower price bound, in `currency` units. */
  priceMin?: number;
  /** Upper price bound, in `currency` units. */
  priceMax?: number;
  /** ISO 4217 currency code of the price bounds, when the query states one. */
  currency?: string;
  /** Colors the shopper wants. */
  colorsInclude: string[];
  /** Colors the shopper explicitly rejects. */
  colorsExclude: string[];
  /** Occasion the item is for, e.g. "wedding". */
  occasion?: string;
  /** Requested size, e.g. "M" or "42". */
  size?: string;
  /** Whether the shopper requires the item to be in stock. */
  availabilityRequired: boolean;
  /** Free-form soft attributes for similarity, e.g. "elegant", "summer". */
  softAttributes: string[];
}

/** JSON Schema the model's extraction answer must satisfy. */
export const INTENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    category: { type: "string" },
    priceMin: { type: "number" },
    priceMax: { type: "number" },
    currency: { type: "string" },
    colorsInclude: { type: "array", items: { type: "string" } },
    colorsExclude: { type: "array", items: { type: "string" } },
    occasion: { type: "string" },
    size: { type: "string" },
    availabilityRequired: { type: "boolean" },
    softAttributes: { type: "array", items: { type: "string" } },
  },
  required: [
    "colorsInclude",
    "colorsExclude",
    "availabilityRequired",
    "softAttributes",
  ],
};

/**
 * The model failed to produce a schema-valid intent after the retry (AC-2).
 * Callers decide the fallback; the engine never invents an intent.
 */
export class IntentExtractionError extends Error {}

/** Per-call context forwarded to the LLM port for metering. */
export interface IntentExtractionContext {
  shopDomain?: string;
  searchId?: string;
}

export interface IntentExtractor {
  /**
   * Extract structured intent from one free-text query. Rejects with
   * IntentExtractionError when the model violates the schema twice; port
   * errors (network, provider) propagate unchanged.
   */
  extract(query: string, context?: IntentExtractionContext): Promise<Intent>;
}

export interface IntentExtractorOptions {
  /** LLM port; the consumer constructs it with its configured intent model. */
  llm: LlmClient;
}

function buildIntentPrompt(query: string): string {
  return [
    "Extract structured shopping intent from this product search query.",
    "Split what the shopper said into hard constraints and soft attributes:",
    "- category: the product type asked for, when stated.",
    "- priceMin / priceMax: numeric price bounds, when stated; currency as an",
    "  ISO 4217 code only when the query names or implies one.",
    "- colorsInclude: colors the shopper wants; colorsExclude: colors the",
    '  shopper rejects ("not black" → exclude black).',
    "- occasion: the event or context the item is for, when stated.",
    "- size: the requested size, when stated.",
    "- availabilityRequired: true only when the shopper asks for in-stock or",
    "  immediately available items.",
    "- softAttributes: every remaining descriptive quality (style, season,",
    "  material, mood) as short free-form phrases for similarity matching.",
    "Hard-constraint values (category, colors, occasion, size) must be",
    "lowercase English regardless of the query's language, so they match a",
    "normalized catalog vocabulary; softAttributes may stay in the shopper's",
    "language. Omit optional fields the query does not state; never invent",
    "constraints. Answer as JSON.",
    "",
    `Query: ${query}`,
  ].join("\n");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Validate a model answer against the Intent contract, normalizing absent
 * optionals (null or missing) to undefined. Returns null on any violation so
 * the extractor can retry.
 */
export function parseIntent(value: unknown): Intent | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const {
    category,
    priceMin,
    priceMax,
    currency,
    colorsInclude,
    colorsExclude,
    occasion,
    size,
    availabilityRequired,
    softAttributes,
  } = record;

  if (
    !isOptionalString(category) ||
    !isOptionalNumber(priceMin) ||
    !isOptionalNumber(priceMax) ||
    !isOptionalString(currency) ||
    !isStringArray(colorsInclude) ||
    !isStringArray(colorsExclude) ||
    !isOptionalString(occasion) ||
    !isOptionalString(size) ||
    typeof availabilityRequired !== "boolean" ||
    !isStringArray(softAttributes)
  ) {
    return null;
  }

  return {
    category: category ?? undefined,
    priceMin: priceMin ?? undefined,
    priceMax: priceMax ?? undefined,
    currency: currency ?? undefined,
    colorsInclude,
    colorsExclude,
    occasion: occasion ?? undefined,
    size: size ?? undefined,
    availabilityRequired,
    softAttributes,
  };
}

/**
 * Create an intent extractor over the given LLM port.
 *
 * Every call goes to the port with operation "intent", so a metered adapter
 * lands one cost-ledger row per attempt (AC-4). A schema-violating answer is
 * retried exactly once (AC-2); a second violation rejects with
 * IntentExtractionError rather than guessing.
 */
export function createIntentExtractor(
  options: IntentExtractorOptions,
): IntentExtractor {
  async function attempt(
    query: string,
    context?: IntentExtractionContext,
  ): Promise<Intent | null> {
    const completion = await options.llm.completeStructured({
      prompt: buildIntentPrompt(query),
      schema: INTENT_SCHEMA,
      operation: "intent",
      shopDomain: context?.shopDomain,
      searchId: context?.searchId,
    });
    return parseIntent(completion);
  }

  return {
    async extract(query, context) {
      const first = await attempt(query, context);
      if (first !== null) {
        return first;
      }
      const second = await attempt(query, context);
      if (second !== null) {
        return second;
      }
      throw new IntentExtractionError(
        "intent extraction produced schema-violating output twice",
      );
    },
  };
}
