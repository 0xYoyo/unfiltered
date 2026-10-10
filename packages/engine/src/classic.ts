/**
 * Classic keyword search: the zero-LLM result path. A port — the engine
 * owns the contract (request/response types and semantics), the consumer
 * implements it over its own database (the app: Postgres/pg_trgm trigram
 * search). Given a text query and a storeId it returns ranked product hits.
 * A classic search must never issue an LLM or embedding call.
 */

/**
 * The shared query normalizer: lowercased, trimmed, inner whitespace
 * collapsed — so trivially different spellings of one query search alike.
 */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/** One classic search against the consumer's store. */
export interface ClassicSearchRequest {
  /** Store the search runs against; results must come from it alone. */
  storeId: string;
  /**
   * Raw query text. Implementations normalize it themselves (`normalizeQuery`
   * is the shared normalizer). Absent or effectively empty → every product
   * of the store, unranked.
   */
  query?: string;
  /**
   * Maximum hits to return. ABSENT MEANS NO CAP (YOY-107): the store returns
   * every product matching the query, ranked — the parity floor is the full
   * match set, and the consumer paginates it for display. A number is a
   * deliberate cap.
   */
  limit?: number;
}

/** One ranked classic hit. */
export interface ClassicSearchHit {
  /** Consumer-assigned product identifier. */
  productId: string;
  /**
   * Keyword-relevance score in [0, 1]; higher is more relevant. A search
   * with no query text carries no signal to rank by and scores every hit 0.
   */
  score: number;
}

/** The outcome of one classic search. */
export interface ClassicSearchResult {
  /** Ranked hits, most relevant first. */
  hits: ClassicSearchHit[];
}

/** Port to the consumer's keyword-search store. Implementations live on the app side. */
export interface ClassicSearchStore {
  search(request: ClassicSearchRequest): Promise<ClassicSearchResult>;
}
