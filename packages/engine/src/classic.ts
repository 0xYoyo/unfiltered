/**
 * Classic keyword search: the zero-LLM result path. A port in the
 * RetrievalStore pattern — the engine owns the contract (request/response
 * types and semantics), the consumer implements it over its own database
 * (the app: Postgres/pg_trgm trigram search). Given a text query and a
 * storeId it returns ranked product hits; given constraints and no query
 * text it filters without ranking by similarity. A classic search must never
 * issue an LLM or embedding call.
 */

import type { RetrievalConstraints } from "./retrieve.js";

/** One classic search against the consumer's store. */
export interface ClassicSearchRequest {
  /** Store the search runs against; results must come from it alone. */
  storeId: string;
  /**
   * Raw query text. Implementations normalize it themselves (the engine's
   * `normalizeQuery` is the shared normalizer). Absent or effectively empty
   * → constraint-only mode: results are filtered by `constraints` alone.
   */
  query?: string;
  /**
   * Hard filters; every returned product must satisfy all of them, with the
   * same predicate semantics as the vector RetrievalStore: unknown enrichment
   * passes positive occasion/color constraints, category is evidence-required
   * (expanded through the taxonomy's category groups), and a price cap
   * compares against the product's minimum price.
   */
  constraints?: RetrievalConstraints;
  /**
   * Maximum hits to return. ABSENT MEANS NO CAP (YOY-107): the store returns
   * every product matching the query and constraints, ranked — the parity
   * floor is the full match set, and the consumer paginates it for display.
   * A number is a deliberate cap, used where a short list is the contract
   * (zero-hit close matches).
   */
  limit?: number;
}

/** One ranked classic hit. */
export interface ClassicSearchHit {
  /** Consumer-assigned product identifier. */
  productId: string;
  /**
   * Keyword-relevance score in [0, 1]; higher is more relevant. Constraint-
   * only searches carry no text signal to rank by and score every hit 0.
   */
  score: number;
  /**
   * True when a color constraint (inclusion or exclusion) was applied and
   * this product's enrichment states no colors — it passed on the
   * unknown-passes leniency, not on evidence (YOY-67 AC-5). Implementations
   * rank such hits strictly below evidence-backed hits. Absent when no
   * color constraint was applied.
   */
  colorUnknown?: boolean;
}

/** The outcome of one classic search. */
export interface ClassicSearchResult {
  /** Ranked hits, most relevant first, all satisfying every constraint. */
  hits: ClassicSearchHit[];
}

/**
 * Port to the consumer's keyword-search store. Implementations live on the
 * app side and must apply every constraint as a filter inside the store,
 * never by post-ranking — the same rule as RetrievalStore.
 */
export interface ClassicSearchStore {
  search(request: ClassicSearchRequest): Promise<ClassicSearchResult>;
}
