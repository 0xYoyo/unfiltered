/**
 * The pipeline stages a search can run (YOY-114), in pipeline order. The
 * orchestrator times each one it actually runs; `embed` and `retrieve` come
 * from the retriever's own split, `hydrate` covers every card hydration the
 * response needed, and `closeMatches` covers the zero-hit rescue (keyword
 * backfill plus relaxed retrieval). A stage that did not run is absent.
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
  "classic",
  "hydrate",
  "closeMatches",
] as const;

export type SearchStage = (typeof SEARCH_STAGES)[number];

/** Whole milliseconds per stage actually run, keyed in pipeline order. */
export type SearchStages = Partial<Record<SearchStage, number>>;
