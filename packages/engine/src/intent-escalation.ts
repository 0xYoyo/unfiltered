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
 * The ladder runs under ONE budget (`deadlineMs`, YOY-64 AC-3): an abort
 * signal armed per extraction is forwarded to both tiers through the
 * extraction context, so a lite call that times out with no budget left
 * degrades the search right there instead of spending a second full
 * timeout on the accuracy tier (lite 8 s + accuracy 8 s = 16 s before the
 * classic fallback, found in review of unfiltered PR #117), and an
 * accuracy call reached after a fast lite failure is cut at the deadline,
 * not at its own per-request timeout. With no `deadlineMs` each tier is
 * bounded only by its own port's timeout — the eval harness's replay.
 *
 * A class match's accuracy call is HEDGED (`hedgeAfterMs`, YOY-64 AC-6).
 * The AC-6 measurement on the deployment (2026-08-26) found the accuracy
 * model at 1.5–7 s on occasion-class prompts, hanging to the 8 s deadline
 * in 13 of 60 such calls, while every lite-answered query sat at
 * 640–1400 ms — the class rule was the entire AI p95 miss. Running the
 * class lite-first instead regressed g09 on the eval harness (the lite tier
 * labels gold wedding sandals `sneakers`; the golden needs `shoes`), so per
 * the co-manager decision the class stays and its tail is bounded: when the
 * accuracy call is still pending after `hedgeAfterMs`, the lite tier is
 * fired alongside it and the first schema-valid answer wins, the loser's
 * call aborted through its own signal. A lite win reports
 * `{ kind: "hedge" }` with `tier: "lite"`; the hedge is a latency
 * instrument, so the confidence floor does not apply to its answer — past
 * the hedge delay a lite answer beats a classic degrade. Only class
 * escalations hedge: the accuracy call after a low-confidence or failed
 * lite answer already has the lite tier's verdict.
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

/**
 * How long a class-escalated accuracy call may run before the lite hedge
 * fires, ms (YOY-64 AC-6). Set from the AC-6 run: the accuracy tier
 * answered occasion-class prompts in 1.5–7 s when it answered at all and the
 * lite tier in 640–1400 ms, so a hedge at 2.5 s lands a lite answer near
 * 3.1–3.9 s on a hung accuracy call instead of a classic degrade at 8 s.
 * Consumers may override it (the app reads `INTENT_HEDGE_AFTER_MS`).
 */
export const DEFAULT_INTENT_HEDGE_AFTER_MS = 2500;

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
      "occasion-bearing phrase (EN/HE): the lite tier mislabels events as soft attributes or picks the wrong canonical occasion (YOY-64: kept after a lite-first trial regressed g09; its accuracy call is hedged instead)",
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
  /**
   * How long a class match's accuracy call may run before the lite tier is
   * fired alongside it and the first valid answer wins, ms (YOY-64 AC-6).
   * Defaults to `DEFAULT_INTENT_HEDGE_AFTER_MS`.
   */
  hedgeAfterMs?: number;
  /**
   * Wall-clock budget for the whole ladder, ms: one abort signal bounds the
   * lite call and any accuracy call after it. Absent means no ladder-level
   * bound (each tier's own port timeout applies).
   */
  deadlineMs?: number;
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
  const deadlineMs = options.deadlineMs;
  if (deadlineMs !== undefined && !(Number.isFinite(deadlineMs) && deadlineMs > 0)) {
    throw new RangeError(
      `intent escalation deadlineMs must be a positive number, got ${deadlineMs}`,
    );
  }
  const hedgeAfterMs = options.hedgeAfterMs ?? DEFAULT_INTENT_HEDGE_AFTER_MS;
  if (!(Number.isFinite(hedgeAfterMs) && hedgeAfterMs > 0)) {
    throw new RangeError(
      `intent escalation hedgeAfterMs must be a positive number, got ${hedgeAfterMs}`,
    );
  }

  /**
   * The context both tiers see: the caller's, plus the ladder's deadline
   * signal when one is configured (combined with the caller's own signal).
   * Without a deadline the context passes through untouched.
   */
  function budgeted(
    context: IntentExtractionContext | undefined,
  ): IntentExtractionContext | undefined {
    if (deadlineMs === undefined) {
      return context;
    }
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal =
      context?.signal === undefined
        ? deadline
        : AbortSignal.any([context.signal, deadline]);
    return { ...context, signal };
  }

  async function accuracy(
    query: string,
    context: IntentExtractionContext | undefined,
    escalation: IntentEscalation,
  ): Promise<IntentExtraction> {
    const intent = await options.accuracy.extract(query, context);
    return { intent, tier: "accuracy", escalation };
  }

  /** The context plus one more abort signal, so the loser of a race is cancelled. */
  function cancellable(
    context: IntentExtractionContext | undefined,
    controller: AbortController,
  ): IntentExtractionContext {
    const signal =
      context?.signal === undefined
        ? controller.signal
        : AbortSignal.any([context.signal, controller.signal]);
    return { ...context, signal };
  }

  /**
   * A class match's accuracy call, hedged (YOY-64 AC-6): once it has run for
   * `hedgeAfterMs` without answering, the lite tier is asked alongside it
   * and whichever answers first wins; the other call is aborted. An
   * accuracy failure while the hedge is in flight waits for the hedge, and
   * only when both fail does the accuracy error propagate — so a failing
   * hedge never makes the result worse than the unhedged call, and the
   * error the caller logs is still the accuracy tier's (the deadline's
   * GeminiTimeoutError when the budget cut both).
   */
  function hedgedAccuracy(
    query: string,
    context: IntentExtractionContext | undefined,
    name: string,
  ): Promise<IntentExtraction> {
    const escalation: IntentEscalation = { kind: "class", name };
    const accuracyAbort = new AbortController();
    const liteAbort = new AbortController();
    return new Promise<IntentExtraction>((resolve, reject) => {
      let settled = false;
      let hedgeInFlight = false;
      let accuracyFailure: { error: unknown } | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        accuracyAbort.abort();
        liteAbort.abort();
        outcome();
      };
      options.accuracy.extract(query, cancellable(context, accuracyAbort)).then(
        (intent) => settle(() => resolve({ intent, tier: "accuracy", escalation })),
        (error: unknown) => {
          accuracyFailure = { error };
          if (!hedgeInFlight) {
            settle(() => reject(error));
          }
        },
      );
      timer = setTimeout(() => {
        timer = undefined;
        if (settled || accuracyFailure !== null) {
          return;
        }
        hedgeInFlight = true;
        options.lite.extract(query, cancellable(context, liteAbort)).then(
          (intent) =>
            settle(() =>
              resolve({
                intent,
                tier: "lite",
                escalation: { kind: "hedge", name, afterMs: hedgeAfterMs },
              }),
            ),
          () => {
            hedgeInFlight = false;
            const failure = accuracyFailure;
            if (failure !== null) {
              settle(() => reject(failure.error));
            }
          },
        );
      }, hedgeAfterMs);
    });
  }

  async function extractDetailed(
    query: string,
    rawContext?: IntentExtractionContext,
  ): Promise<IntentExtraction> {
    const startedAt = Date.now();
    const context = budgeted(rawContext);
    const matched = matchIntentEscalationClass(query, classes);
    if (matched !== null) {
      // Known-weak shape: straight to the accuracy tier, no lite call up
      // front — the lite tier joins only as the hedge past `hedgeAfterMs`.
      return hedgedAccuracy(query, context, matched.name);
    }
    let lite: Intent;
    try {
      lite = await options.lite.extract(query, context);
    } catch (error) {
      const budgetSpent =
        context?.signal?.aborted === true ||
        (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs);
      if (budgetSpent) {
        // The ladder's budget is spent (or the caller gave up): a second
        // call would only add a second timeout. The elapsed check covers a
        // lite port whose own timeout equals the deadline and fires first —
        // the production wiring, 8 s and 8 s — where the deadline signal may
        // not have flipped yet. The lite error propagates unchanged so the
        // caller's log names the class (GeminiTimeoutError).
        throw error;
      }
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
