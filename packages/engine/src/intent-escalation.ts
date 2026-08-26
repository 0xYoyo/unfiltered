/**
 * Lite-first confidence routing for intent extraction (YOY-116).
 *
 * Intent extraction is the dominant per-search cost and latency term, and
 * the accuracy tier answers every query even when a lite model would have
 * answered it identically. The ladder here runs the lite tier first and
 * escalates to the accuracy tier in exactly two cases:
 *
 * 1. The query matches a deterministic ESCALATION CLASS — a committed,
 *    unit-tested predicate over the raw query naming a shape the lite tier
 *    is known (from the eval diff on YOY-116) to get wrong. A class match
 *    goes STRAIGHT to the accuracy tier with no lite call: a known-weak
 *    class must not pay two calls of latency (co-manager clarification,
 *    2026-08-25).
 * 2. The lite answer's own `confidence` is below the threshold, or missing.
 *    Then the accuracy tier is asked and its answer REPLACES the lite one
 *    entirely — nothing is merged.
 * 3. The lite tier FAILS — a timeout, a provider error, a schema violation
 *    twice. The accuracy tier is the pre-ladder behaviour, so a lite failure
 *    must never leave the shopper worse off than before the ladder existed:
 *    it escalates (`kind: "lite-error"`) rather than degrading the search.
 *    Found on YOY-116: gemini-3.5-flash-lite hangs deterministically on the
 *    "same but cheaper" refinement prompt (r01), at every thinking level.
 *
 * Both calls carry the caller's `searchId`, operation `"intent"`, and their
 * own model id through their own LLM port, so the cost ledger keeps them
 * distinguishable. Refinements (`previousIntent`) follow the same rules on
 * the follow-up text; chip removal never reaches an extractor at all.
 *
 * Vendor-free by the engine's boundary rule: which models sit behind the
 * two ports is the consumer's concern.
 */

import type {
  Intent,
  IntentEscalation,
  IntentExtraction,
  IntentExtractionContext,
  IntentExtractor,
} from "./intent.js";

/**
 * Confidence below which a lite answer is discarded for an accuracy call.
 * Set on YOY-116 from the per-golden lite-vs-accuracy diff (AC-6): every
 * lite answer on the eval set reported 0.8–1.0 and the one wrong answer sat
 * at 0.9, indistinguishable from correct ones — so the floor is the lowest
 * confidence a correct lite answer reported, and it is a safety net for
 * out-of-distribution queries rather than the mechanism that caught the
 * known miss (that is the `mixed-script` class). Consumers may override it
 * (the app reads `INTENT_ESCALATION_THRESHOLD`).
 */
export const DEFAULT_INTENT_ESCALATION_THRESHOLD = 0.8;

/** One deterministic escalation class: a named predicate over the raw query. */
export interface IntentEscalationClass {
  /** Stable name, reported as the escalation reason. */
  name: string;
  /** Why the lite tier is skipped for this shape (evidence pointer). */
  description: string;
  /** True when the query belongs to the class. */
  matches(query: string): boolean;
}

/**
 * Occasion-bearing phrases, EN + HE. An occasion is the constraint the lite
 * tier confuses most (an event dressed FOR versus a season or a time of
 * day, which are soft attributes). Matched as whole words in both scripts:
 * Hebrew prefixes (ל, ב, ה) attach to the word, so "לחתונה" is itself the
 * whole word — and a substring match would make "לים" (to the beach) fire
 * inside "שרוולים" (sleeves), which it did on YOY-116's r02 until this
 * became word-bounded.
 */
const OCCASION_PHRASES_EN = [
  "wedding",
  "party",
  "gala",
  "office",
  "work",
  "interview",
  "night out",
  "date night",
  "beach",
  "cocktail",
  "formal",
  "black tie",
  "prom",
  "graduation",
  "everyday",
];

const OCCASION_PHRASES_HE = [
  "לחתונה",
  "חתונה",
  "למסיבה",
  "מסיבה",
  "למשרד",
  "לעבודה",
  "לראיון",
  "לערב",
  "לים",
  "לחוף",
  "לדייט",
  "לאירוע",
  "אירוע",
  "לגאלה",
  "לנשף",
  "ליומיום",
];

const WORD_BOUNDARY_EN = (phrase: string) =>
  new RegExp(`(^|[^a-z])${phrase.replace(/ /g, "\\s+")}($|[^a-z])`, "i");
const WORD_BOUNDARY_HE = (phrase: string) =>
  new RegExp(`(^|[^\\u05D0-\\u05EA])${phrase}($|[^\\u05D0-\\u05EA])`);

function normalize(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

const HEBREW_LETTER = /[\u05D0-\u05EA]/;
const LATIN_LETTER = /[a-z]/i;

/** The committed escalation classes, in evaluation order. */
export const INTENT_ESCALATION_CLASSES: readonly IntentEscalationClass[] = [
  {
    name: "mixed-script",
    description:
      "Hebrew and Latin letters in one query: the lite tier misread the only mixed-script golden it got wrong on YOY-116 (g15, an invented occasion), 1 of 3 mixed vs 0 of 22 single-script",
    matches(query) {
      return HEBREW_LETTER.test(query) && LATIN_LETTER.test(query);
    },
  },
  {
    name: "occasion",
    description:
      "occasion-bearing phrase (EN/HE): the lite tier mislabels events as soft attributes or picks the wrong canonical occasion",
    matches(query) {
      const normalized = normalize(query);
      return (
        OCCASION_PHRASES_EN.some((phrase) =>
          WORD_BOUNDARY_EN(phrase).test(normalized),
        ) || OCCASION_PHRASES_HE.some((phrase) => WORD_BOUNDARY_HE(phrase).test(normalized))
      );
    },
  },
];

/** The first class the query belongs to, or null. */
export function matchIntentEscalationClass(
  query: string,
  classes: readonly IntentEscalationClass[] = INTENT_ESCALATION_CLASSES,
): IntentEscalationClass | null {
  return classes.find((entry) => entry.matches(query)) ?? null;
}

export interface EscalatingIntentExtractorOptions {
  /** The lite-tier extractor (cheap, fast; asked first). */
  lite: IntentExtractor;
  /** The accuracy-tier extractor (the pre-YOY-116 behaviour). */
  accuracy: IntentExtractor;
  /** Confidence floor; defaults to `DEFAULT_INTENT_ESCALATION_THRESHOLD`. */
  threshold?: number;
  /** Escalation classes; defaults to the committed list. */
  classes?: readonly IntentEscalationClass[];
}

/**
 * The lite-first ladder as an `IntentExtractor` (so every existing consumer
 * keeps calling `extract`) that also reports the tier through
 * `extractDetailed`.
 */
export function createEscalatingIntentExtractor(
  options: EscalatingIntentExtractorOptions,
): Required<IntentExtractor> {
  const threshold = options.threshold ?? DEFAULT_INTENT_ESCALATION_THRESHOLD;
  const classes = options.classes ?? INTENT_ESCALATION_CLASSES;
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new RangeError(
      `intent escalation threshold must be within [0, 1], got ${threshold}`,
    );
  }

  async function accuracy(
    query: string,
    context: IntentExtractionContext | undefined,
    escalation: IntentEscalation,
  ): Promise<IntentExtraction> {
    const intent = await options.accuracy.extract(query, context);
    return { intent, tier: "accuracy", escalation };
  }

  async function extractDetailed(
    query: string,
    context?: IntentExtractionContext,
  ): Promise<IntentExtraction> {
    const matched = matchIntentEscalationClass(query, classes);
    if (matched !== null) {
      // Known-weak shape: straight to the accuracy tier, no lite call.
      return accuracy(query, context, { kind: "class", name: matched.name });
    }
    let lite: Intent;
    try {
      lite = await options.lite.extract(query, context);
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return accuracy(query, context, { kind: "lite-error", error: name });
    }
    const confidence = lite.confidence ?? null;
    if (confidence === null || confidence < threshold) {
      // The lite answer is discarded whole; the accuracy answer replaces it.
      return accuracy(query, context, { kind: "low-confidence", confidence });
    }
    return { intent: lite, tier: "lite", escalation: null };
  }

  return {
    async extract(query, context) {
      return (await extractDetailed(query, context)).intent;
    },
    extractDetailed,
  };
}
