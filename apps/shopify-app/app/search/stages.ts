/**
 * The pipeline stages a search can run (YOY-114), in pipeline order. The
 * orchestrator times each one it actually runs; `classic` is the keyword
 * search of a preview or a rescue, `hydrate` covers every card hydration
 * the response needed, and `find` is the find step (YOY-145 AC-11): the
 * raw-sentence embedding, the card-index query and the keyword search
 * together; `judgeRows` is its judge step's database work
 * (YOY-159 AC-1): the page's rows, the cache key, the answer-cache read and
 * write and the verdict log; `judge` is the rest of the step (YOY-147
 * AC-12): the judge call, deadline included; `compose` is
 * the stated wishes applied to the find order (YOY-149): the catalog rows
 * read, the walls and the number tiers; `extract` is the wish extraction
 * (YOY-171 AC-6), from its start with the search to its settle — or, when it
 * missed its grace, to the moment the page stopped waiting for it, a lower
 * bound — with `extractLate` 1 when it missed the grace and 0 when it made
 * it. A stage that did not run is absent.
 *
 * Shared between the server (the orchestrator's ledger, the playground
 * serializer) and the client (the engine-details panel renders the rows in
 * this order), so it lives outside any `.server` module.
 */
export const SEARCH_STAGES = [
  "extract",
  "find",
  "compose",
  "classic",
  "hydrate",
  "judgeRows",
  "judge",
] as const;

export type SearchStage = (typeof SEARCH_STAGES)[number];

/**
 * Whole milliseconds per stage actually run, keyed in pipeline order, and
 * whether the wish extraction missed its grace (YOY-171 AC-6), present
 * exactly when `extract` is.
 */
export type SearchStages = Partial<Record<SearchStage, number>> & { extractLate?: 0 | 1 };
