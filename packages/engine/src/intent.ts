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
  /**
   * The model's own confidence, 0–1, that the hard constraints above are
   * complete and correct for the query (YOY-116 AC-1). Required of every
   * model answer; absent only on answers recorded before it existed. The
   * lite-first ladder escalates on a low or missing value.
   */
  confidence?: number;
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
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "colorsInclude",
    "colorsExclude",
    "availabilityRequired",
    "softAttributes",
    "confidence",
  ],
};

/**
 * The model's judgment of what a follow-up query is (YOY-52 run-5
 * directive): a refinement of the previous search, or a change of topic.
 * The judgment stays with the model — it has been reliable across every
 * live run — while the constraint mechanics it gates are deterministic
 * code (carry-over and comparative enforcement below).
 */
export type RefinementOutcome = "refinement" | "topic_change";

export const REFINEMENT_OUTCOMES: readonly RefinementOutcome[] = [
  "refinement",
  "topic_change",
];

/**
 * Schema for refinement calls — extraction with a previous intent present.
 * The answer stays a full Intent (never a patch; the delta-output redesign
 * was explicitly rejected) plus the one extra field code cannot infer: the
 * model's explicit refinement/topic-change judgment, which gates whether
 * constraint carry-over applies.
 */
export const REFINEMENT_INTENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ...(INTENT_SCHEMA.properties as Record<string, unknown>),
    outcome: { type: "string", enum: [...REFINEMENT_OUTCOMES] },
  },
  required: [...(INTENT_SCHEMA.required as string[]), "outcome"],
};

/**
 * The model failed to produce a schema-valid intent after the retry (AC-2).
 * Callers decide the fallback; the engine never invents an intent.
 */
export class IntentExtractionError extends Error {}

/** Per-call context forwarded to the LLM port for metering. */
export interface IntentExtractionContext {
  storeId?: string;
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

/** Which model tier produced an intent (YOY-116). */
export type IntentTier = "lite" | "accuracy";

/** Why an extraction went to the accuracy tier. */
export type IntentEscalation =
  | { kind: "class"; name: string }
  | { kind: "low-confidence"; confidence: number | null }
  | { kind: "lite-error"; error: string };

/** An extraction with the tier that produced it. */
export interface IntentExtraction {
  intent: Intent;
  tier: IntentTier;
  /** Set when the accuracy tier answered because of an escalation. */
  escalation: IntentEscalation | null;
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
  /**
   * The same extraction, reporting which tier answered (YOY-116). Present on
   * tier-aware extractors (the lite-first ladder); a plain single-model
   * extractor is tier-agnostic and leaves it out, so consumers report null.
   */
  extractDetailed?(
    query: string,
    context?: IntentExtractionContext,
  ): Promise<IntentExtraction>;
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
  // The previous intent's confidence is the last call's self-assessment,
  // not a constraint; it stays out of the prompt so the block reads as the
  // shopper's intent alone (and stays byte-identical to pre-YOY-116 prompts
  // for the same intent).
  const { confidence: _confidence, ...previous } = intent;
  void _confidence;
  return JSON.stringify(previous, null, 2);
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
 * A parsed refinement answer: the model's outcome judgment plus the full
 * intent it returned. Produced by parseRefinementAnswer, consumed by
 * mergeRefinementIntent — the single production merge path.
 */
export interface RefinementAnswer {
  outcome: RefinementOutcome;
  intent: Intent;
}

/**
 * Validate a refinement-call answer: a full Intent plus the required
 * outcome judgment. Returns null on any violation so the extractor can
 * retry, same as parseIntent.
 */
export function parseRefinementAnswer(value: unknown): RefinementAnswer | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const outcome = (value as Record<string, unknown>).outcome;
  if (outcome !== "refinement" && outcome !== "topic_change") {
    return null;
  }
  const intent = parseIntent(value);
  return intent === null ? null : { outcome, intent };
}

/**
 * Deterministic constraint carry-over (YOY-52 run-5 directive): under the
 * locked M3 design, constraint removal happens via chips (×) or New search,
 * never via unphrased omission — a follow-up that does not name a constraint
 * cannot legitimately clear it. Live runs showed the model nondeterministically
 * dropping constraints it was instructed to carry (r01's occasion, r02's on
 * another run), so any constraint field set in the previous intent that comes
 * back null/absent in a refinement answer is restored from the previous
 * intent. Refinement outcomes only — a topic change discards everything.
 * availabilityRequired is untouched: false is its resting value, not an
 * absent one, so restoring it would be a guess. softAttributes stay the
 * model's: they are similarity hints, not constraints.
 */
export function carryOverRefinementConstraints(
  previousIntent: Intent,
  intent: Intent,
): Intent {
  return {
    ...intent,
    category: intent.category ?? previousIntent.category,
    priceMin: intent.priceMin ?? previousIntent.priceMin,
    priceMax: intent.priceMax ?? previousIntent.priceMax,
    currency: intent.currency ?? previousIntent.currency,
    occasion: intent.occasion ?? previousIntent.occasion,
    size: intent.size ?? previousIntent.size,
    colorsInclude:
      intent.colorsInclude.length > 0
        ? intent.colorsInclude
        : previousIntent.colorsInclude,
    colorsExclude:
      intent.colorsExclude.length > 0
        ? intent.colorsExclude
        : previousIntent.colorsExclude,
  };
}

/**
 * THE production refinement merge (YOY-52 run-5 directive): every consumer
 * that turns a raw refinement answer into a searchable intent — the runtime
 * orchestrator, the offline eval rescore, the live regeneration — reaches
 * this function through extract(), so carry-over and comparative enforcement
 * apply identically everywhere. Enforcement runs after carry-over on
 * purpose: a restored previous bound that a comparative follow-up should
 * have moved is then moved by code.
 */
export function mergeRefinementIntent(
  query: string,
  previousIntent: Intent,
  answer: RefinementAnswer,
): Intent {
  if (answer.outcome === "topic_change") {
    return answer.intent;
  }
  let merged = carryOverRefinementConstraints(previousIntent, answer.intent);
  // A restored bound must never contradict the model's own answer (YOY-52
  // AC-19): "over 500" after a priceMax=400 search phrases an explicit new
  // floor in non-comparative wording, and unconditionally restoring the old
  // cap would ship priceMin=500 ∧ priceMax=400 — zero hits by construction,
  // and enforceComparativeBounds only clears contradictions for
  // comparative-lexicon queries. An explicitly model-set bound always beats
  // a restored one, so when the merged bounds contradict and exactly one of
  // the two was restored, the restored one drops. Both-restored cannot
  // contradict (they coexisted in the previous intent); both-model-set is
  // the model's answer and stands, as today.
  const priceMinRestored =
    answer.intent.priceMin === undefined && merged.priceMin !== undefined;
  const priceMaxRestored =
    answer.intent.priceMax === undefined && merged.priceMax !== undefined;
  if (
    merged.priceMin !== undefined &&
    merged.priceMax !== undefined &&
    merged.priceMin > merged.priceMax &&
    priceMinRestored !== priceMaxRestored
  ) {
    merged = priceMinRestored
      ? { ...merged, priceMin: undefined }
      : { ...merged, priceMax: undefined };
  }
  return enforceComparativeBounds(query, previousIntent, merged);
}

/**
 * Refinement instructions, appended only when the caller supplies a previous
 * intent. Without one the prompt stays byte-for-byte what it was before
 * YOY-42, so recordings and caches keyed on it remain valid.
 */
function refinementSection(previousIntent: Intent): string[] {
  return [
    "",
    "This shopper already searched once; their previous intent is below.",
    "Decide which the new query is:",
    "- a REFINEMENT (it adjusts, adds, or removes constraints: \"same but",
    "  cheaper\", \"in red\", \"without sleeves\"): return the previous intent",
    "  with exactly those deltas applied, keeping every untouched constraint",
    "  and soft attribute; add no constraint (occasion included) the",
    "  follow-up did not state. A comparative MUST move the bound it names —",
    "  repeating the previous value is wrong: \"cheaper\" (\"יותר זול\") returns",
    "  a priceMax strictly below the previous priceMax (about a quarter lower",
    "  when no number is named); \"more expensive\" (\"יותר יקר\") returns a",
    "  priceMin strictly above the previous priceMin, or above the previous",
    "  priceMax when only that bound exists, clearing the contradicted",
    "  priceMax. Worked example — previous intent",
    '  {"category": "boots", "priceMax": 80, "colorsInclude": ["purple"],',
    '   "colorsExclude": [], "occasion": "sport", "availabilityRequired": false,',
    '   "softAttributes": ["waterproof"]}, follow-up "pricier" answers',
    '  {"outcome": "refinement", "category": "boots", "priceMin": 100,',
    '   "priceMax": null, "colorsInclude": ["purple"], "colorsExclude": [],',
    '   "occasion": "sport", "availabilityRequired": false,',
    '   "softAttributes": ["waterproof"]}.',
    "- a TOPIC CHANGE (a different product or search altogether): discard the",
    "  previous intent entirely and extract the new query alone.",
    "Either way answer with a complete intent in the same JSON shape — never a",
    '  patch — plus "outcome": "refinement" or "topic_change".',
    "",
    `Previous intent: ${serializePreviousIntent(previousIntent)}`,
  ];
}

function buildIntentPrompt(query: string, previousIntent?: Intent): string {
  // Trimmed on YOY-64 AC-2 (≥ 30 % fewer input tokens than the pre-M5
  // prompt): the category vocabulary is no longer listed — the response
  // schema's enum already binds it — and every rule is stated once, tersely.
  // Two things the trim must keep, measured live against the lite tier on
  // the eval goldens (6 samples each): the occasion vocabulary spelled out
  // with "null when the query states no occasion" (without it the lite
  // model invents "casual"/"evening" for g10 and r09 in 2–3 of 6 samples),
  // and the "omit / never invent" rule placed LAST, right before the query
  // (moved to the top it stopped binding the refinement answer).
  return [
    "Extract shopping intent from this search query as JSON.",
    "Hard constraints are lowercase English whatever the query's language:",
    '- category: the product type ("other" if none of the allowed values fits).',
    "- priceMin / priceMax: numeric bounds; currency as ISO 4217 when named.",
    '- colorsInclude / colorsExclude: colors wanted / rejected ("not black" →',
    "  exclude black).",
    `- occasion: one of ${CANONICAL_OCCASIONS.join(", ")} —`,
    "  an event the shopper dresses FOR (a wedding, the office, a night out).",
    "  Null when the query states no occasion.",
    '  Seasons and times of day ("winter", "evenings") are softAttributes,',
    "  never occasions.",
    "- size: the requested size.",
    "- availabilityRequired: true only for in-stock asks.",
    "- softAttributes: every remaining quality (style, season, material, mood)",
    "  as short phrases, in the shopper's language.",
    "- confidence: 0 to 1, how sure the hard constraints are complete and",
    "  correct; low when ambiguous or mixed-language.",
    "Omit any constraint the query does not state; never invent one.",
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
    confidence,
  } = record;

  if (
    !isOptionalNumber(confidence) ||
    (typeof confidence === "number" && (confidence < 0 || confidence > 1)) ||
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
    // Optional at parse on purpose: the schema requires it of the model, but
    // recordings made before YOY-116 carry none, and a missing value reads
    // as "unknown" — which the escalation ladder treats as low.
    ...(confidence === undefined || confidence === null ? {} : { confidence }),
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
    previousIntent: Intent | undefined,
    context?: IntentExtractionContext,
  ): Promise<Intent | null> {
    const completion = await options.llm.completeStructured({
      prompt: buildIntentPrompt(query, previousIntent),
      // A refinement call carries the outcome-judgment field; a plain
      // extraction keeps the pre-YOY-42 schema byte for byte.
      schema:
        previousIntent === undefined ? INTENT_SCHEMA : REFINEMENT_INTENT_SCHEMA,
      operation: "intent",
      // Structured extraction has no use for sampling variance, and
      // run-to-run eval stability requires determinism (YOY-52) — same rule
      // as classification.
      temperature: 0,
      storeId: context?.storeId,
      searchId: context?.searchId,
    });
    if (previousIntent === undefined) {
      return parseIntent(completion);
    }
    const answer = parseRefinementAnswer(completion);
    return answer === null
      ? null
      : mergeRefinementIntent(query, previousIntent, answer);
  }

  return {
    async extract(query, context) {
      const previousIntent = context?.previousIntent;
      const extracted =
        (await attempt(query, previousIntent, context)) ??
        (await attempt(query, previousIntent, context));
      if (extracted === null) {
        throw new IntentExtractionError(
          "intent extraction produced schema-violating output twice",
        );
      }
      return extracted;
    },
  };
}
