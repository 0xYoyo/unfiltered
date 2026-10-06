/**
 * The pipeline stages a search can run (YOY-114), in pipeline order. The
 * orchestrator times each one it actually runs; `embed` and `retrieve` come
 * from the retriever's own split, `hydrate` covers every card hydration the
 * response needed, and `closeMatches` covers the zero-hit rescue (keyword
 * backfill plus relaxed retrieval). `find` is Engine v2's find step
 * (YOY-145 AC-11): the raw-sentence embedding, the card-index query and the
 * keyword search together; `judgeRows` is its judge step's database work
 * (YOY-159 AC-1): the page's rows, the cache key, the answer-cache read and
 * write and the verdict log; `judge` is the rest of the step (YOY-147
 * AC-12): the judge call, deadline included; `compose` is
 * the stated wishes applied to the find order (YOY-149): the catalog rows
 * read, the walls and the number tiers. A stage that did not run is absent.
 *
 * Shared between the server (the orchestrator's ledger, the playground
 * serializer) and the client (the engine-details panel renders the rows in
 * this order), so it lives outside any `.server` module.
 */
export const SEARCH_STAGES = [
  "classify",
  "intent",
  "embed",
  "retrieve",
  "find",
  "compose",
  "classic",
  "hydrate",
  "judgeRows",
  "judge",
  "closeMatches",
] as const;

export type SearchStage = (typeof SEARCH_STAGES)[number];

/** Whole milliseconds per stage actually run, keyed in pipeline order. */
export type SearchStages = Partial<Record<SearchStage, number>>;
