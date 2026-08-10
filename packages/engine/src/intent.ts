/**
 * Intent extraction: turning a free-text shopper query into structured
 * intent — hard constraints for filtering and soft attributes for
 * similarity — in any language. Vendor-free by the engine's boundary rule:
 * the accuracy-tier model behind the port is the consumer's concern.
 */

import type { JsonSchema, LlmClient } from "./index.js";
import {
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
  normalizeCategory,
  normalizeOccasion,
} from "./taxonomy.js";

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
    // Optional fields admit null so the schema matches real model answers,
    // which return null for absent values (YOY-29 AC-8); a provider strictly
    // enforcing the response schema must not reject or retry on them.
    // category and occasion are pinned to the canonical taxonomy (YOY-31).
    // The enum lists null alongside the string tokens (YOY-35 AC-6), so a
    // strictly conforming validator accepts a null answer from the schema
    // alone; the provider adapter re-expresses the union in its nullable
    // dialect (string enum + nullable) without changing the request.
    category: {
      type: ["string", "null"],
      enum: [...CANONICAL_CATEGORIES, null],
    },
    priceMin: { type: ["number", "null"] },
    priceMax: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    colorsInclude: { type: "array", items: { type: "string" } },
    colorsExclude: { type: "array", items: { type: "string" } },
    occasion: {
      type: ["string", "null"],
      enum: [...CANONICAL_OCCASIONS, null],
    },
    size: { type: ["string", "null"] },
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
  /**
   * Intent extracted from the shopper's previous query in the same search
   * session, when the caller has one (YOY-42). Its presence turns the call
   * into a refinement: the model returns either that intent with the new
   * query's deltas applied, or a completely fresh intent when the query
   * changed topic — always a full Intent, never a patch. The engine holds no
   * session state; where a previous intent is kept between requests is the
   * caller's concern.
   */
  previousIntent?: Intent;
}

export interface IntentExtractor {
  /**
   * Extract structured intent from one free-text query. With
   * `context.previousIntent` the query is treated as a follow-up: the answer
   * is that intent with the query's deltas applied, or a fresh intent when
   * the shopper changed topic — a full Intent either way. Rejects with
   * IntentExtractionError when the model violates the schema twice; port
   * errors (network, provider) propagate unchanged.
   */
  extract(query: string, context?: IntentExtractionContext): Promise<Intent>;
}

export interface IntentExtractorOptions {
  /** LLM port; the consumer constructs it with its configured intent model. */
  llm: LlmClient;
}

/**
 * Serialize a previous intent for the prompt. Indented JSON on purpose: every
 * line of the block is indented, so none of it can look like the `Query:` line
 * the eval replay keys recordings by (YOY-42 AC-4).
 */
function serializePreviousIntent(intent: Intent): string {
  return JSON.stringify(intent, null, 2);
}

/**
 * Comparative phrasing lexicon (YOY-52 AC-15). Deliberately small, EN + HE,
 * matched as substrings of the raw follow-up query: an unlisted phrasing
 * simply gets no deterministic enforcement and the model's own answer stands.
 */
const CHEAPER_PHRASES = ["cheaper", "less expensive", "יותר זול", "זול יותר"];
const PRICIER_PHRASES = [
  "more expensive",
  "pricier",
  "יותר יקר",
  "יקר יותר",
];

/** Bound applied when the model names no figure of its own: 75% of the
 * previous bound on "cheaper", 125% on "more expensive". */
const CHEAPER_FACTOR = 0.75;
const PRICIER_FACTOR = 1.25;

function matchesAny(query: string, phrases: string[]): boolean {
  return phrases.some((phrase) => query.includes(phrase));
}

/**
 * Deterministic comparative enforcement (YOY-52 AC-15): after two live
 * regeneration runs, prompt-only instruction still let comparative follow-ups
 * echo the previous price bound unchanged, so the direction guarantee lives
 * in code. When the follow-up query carries comparative-cheaper phrasing, the
 * merged intent's priceMax must land strictly below the previous bound
 * (previous priceMax, else previous priceMin); comparative-more-expensive
 * must put priceMin strictly above the previous floor (previous priceMin,
 * else previous priceMax). A cooperative model's own figure passes untouched;
 * an uncooperative echo is overridden to 75% / 125% of the previous bound. A
 * bound the enforcement contradicts (a floor at or above the new cap, a cap
 * at or below the new floor) is cleared rather than shipped as an
 * empty-result filter. A query matching both directions is ambiguous and left
 * to the model.
 */
export function enforceComparativeBounds(
  query: string,
  previousIntent: Intent,
  intent: Intent,
): Intent {
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  const cheaper = matchesAny(normalized, CHEAPER_PHRASES);
  const pricier = matchesAny(normalized, PRICIER_PHRASES);
  if (cheaper === pricier) {
    return intent;
  }
  if (cheaper) {
    const bound = previousIntent.priceMax ?? previousIntent.priceMin;
    if (bound === undefined) {
      return intent;
    }
    const priceMax =
      intent.priceMax !== undefined && intent.priceMax < bound
        ? intent.priceMax
        : bound * CHEAPER_FACTOR;
    const priceMin =
      intent.priceMin !== undefined && intent.priceMin >= priceMax
        ? undefined
        : intent.priceMin;
    return { ...intent, priceMin, priceMax };
  }
  const floor = previousIntent.priceMin ?? previousIntent.priceMax;
  if (floor === undefined) {
    return intent;
  }
  const priceMin =
    intent.priceMin !== undefined && intent.priceMin > floor
      ? intent.priceMin
      : floor * PRICIER_FACTOR;
  const priceMax =
    intent.priceMax !== undefined && intent.priceMax <= priceMin
      ? undefined
      : intent.priceMax;
  return { ...intent, priceMin, priceMax };
}

/**
 * Refinement instructions, appended only when the caller supplies a previous
 * intent. Without one the prompt stays byte-for-byte what it was before
 * YOY-42, so recordings and caches keyed on it remain valid.
 */
function refinementSection(previousIntent: Intent): string[] {
  return [
    "",
    "This shopper already searched once. The intent extracted from their",
    "previous query is below. Decide which of two things the new query is:",
    "- a REFINEMENT of that search (it adjusts, adds, or removes constraints:",
    '  "same but cheaper", "in red", "without sleeves"): return the previous',
    "  intent with exactly those deltas applied, keeping every constraint and",
    "  soft attribute the new query did not touch. A comparative MUST move",
    "  the bound it names — repeating the previous value unchanged is wrong:",
    '  "cheaper" ("יותר זול") returns a priceMax strictly below the previous',
    "  priceMax (about a quarter lower when the shopper names no number);",
    '  "more expensive" ("יותר יקר") returns a priceMin strictly above the',
    "  previous priceMin, or above the previous priceMax when only that",
    "  bound exists — clearing the now-contradicted priceMax.",
    "  Worked example of a comparative refinement — previous intent:",
    '    {"category": "boots", "priceMax": 80, "colorsInclude": ["purple"],',
    '     "colorsExclude": [], "occasion": "sport",',
    '     "availabilityRequired": false, "softAttributes": ["waterproof"]}',
    '  follow-up "pricier" answers:',
    '    {"category": "boots", "priceMin": 100, "priceMax": null,',
    '     "colorsInclude": ["purple"], "colorsExclude": [],',
    '     "occasion": "sport", "availabilityRequired": false,',
    '     "softAttributes": ["waterproof"]}',
    "  — the named bound moved, and every constraint the follow-up did not",
    "  touch (occasion included) returned verbatim.",
    "- a TOPIC CHANGE (it names a different product or search altogether):",
    "  discard the previous intent entirely and extract the new query alone,",
    "  carrying nothing over.",
    "Either way, answer with a complete intent in the same JSON shape — never",
    "a patch, never a reference to what changed.",
    "",
    `Previous intent: ${serializePreviousIntent(previousIntent)}`,
  ];
}

function buildIntentPrompt(query: string, previousIntent?: Intent): string {
  return [
    "Extract structured shopping intent from this product search query.",
    "Split what the shopper said into hard constraints and soft attributes:",
    "- category: the product type asked for, when stated. Must be one of:",
    `  ${CANONICAL_CATEGORIES.join(", ")}. Use null when the query states`,
    '  no category and "other" when the stated category fits none of them.',
    "- priceMin / priceMax: numeric price bounds, when stated; currency as an",
    "  ISO 4217 code only when the query names or implies one.",
    "- colorsInclude: colors the shopper wants; colorsExclude: colors the",
    '  shopper rejects ("not black" → exclude black).',
    "- occasion: an event the shopper dresses FOR (a wedding, the office, a",
    "  night out), when stated. Must be one of:",
    `  ${CANONICAL_OCCASIONS.join(", ")}. Seasons and times of day`,
    '  ("winter", "evenings") are never occasions — they are softAttributes.',
    '  Use null when the query states no occasion and "other" when it fits',
    "  none of them.",
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
    ...(previousIntent === undefined ? [] : refinementSection(previousIntent)),
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
 * Fold one raw category/occasion answer into the canonical taxonomy (YOY-31
 * AC-4): in-set-but-messy values ("Dresses", "gala") converge onto canonical
 * tokens; unmappable values — and the explicit "other" bucket, which names no
 * real constraint — drop to undefined so retrieval never hard-filters on a
 * token the enrichment side cannot carry.
 */
function normalizedConstraint<T extends string>(
  raw: string | undefined,
  normalize: (value: string) => T | null,
): T | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const canonical = normalize(raw);
  return canonical === null || canonical === "other" ? undefined : canonical;
}

/**
 * Validate a model answer against the Intent contract, normalizing absent
 * optionals (null or missing) to undefined and category/occasion into the
 * canonical taxonomy. Returns null on any violation so the extractor can
 * retry.
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
    category: normalizedConstraint(category ?? undefined, normalizeCategory),
    priceMin: priceMin ?? undefined,
    priceMax: priceMax ?? undefined,
    currency: currency ?? undefined,
    colorsInclude,
    colorsExclude,
    occasion: normalizedConstraint(occasion ?? undefined, normalizeOccasion),
    // Size casing is canonicalized at parse (YOY-52): the model answers "m"
    // or "M" interchangeably, and downstream comparison must not care.
    size: (size ?? undefined)?.toUpperCase(),
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
      prompt: buildIntentPrompt(query, context?.previousIntent),
      schema: INTENT_SCHEMA,
      operation: "intent",
      // Structured extraction has no use for sampling variance, and
      // run-to-run eval stability requires determinism (YOY-52) — same rule
      // as classification.
      temperature: 0,
      shopDomain: context?.shopDomain,
      searchId: context?.searchId,
    });
    return parseIntent(completion);
  }

  return {
    async extract(query, context) {
      const extracted =
        (await attempt(query, context)) ?? (await attempt(query, context));
      if (extracted === null) {
        throw new IntentExtractionError(
          "intent extraction produced schema-violating output twice",
        );
      }
      return context?.previousIntent === undefined
        ? extracted
        : enforceComparativeBounds(query, context.previousIntent, extracted);
    },
  };
}
