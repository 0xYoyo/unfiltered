/**
 * Public API of the unfiltered search engine.
 *
 * Catalog-agnostic by contract: inputs and outputs speak only in generic
 * documents, fields, and scores — no commerce-platform concepts. Each
 * consumer is responsible for mapping its own catalog into and out of these
 * types.
 */

/** Semantic version of the engine's public API contract. */
export const version = "0.1.0";

/** A single searchable document, as the consumer indexed it. */
export interface EngineDocument {
  /** Consumer-assigned stable identifier. */
  id: string;
  /** Arbitrary named text fields to search over. */
  fields: Record<string, string>;
}

/** Options controlling a single search call. */
export interface SearchOptions {
  /** Maximum number of hits to return. Defaults to the engine's own limit. */
  limit?: number;
  /** Number of hits to skip, for pagination. */
  offset?: number;
}

/** One scored hit in a search result. */
export interface SearchHit {
  /** Identifier of the matching document. */
  documentId: string;
  /** Relevance score; higher is more relevant. */
  score: number;
}

/** The outcome of a search call. */
export interface SearchResult {
  /** Scored hits, most relevant first. */
  hits: SearchHit[];
  /** Total number of matching documents before limit/offset. */
  totalCount: number;
  /** The query string the engine actually evaluated. */
  query: string;
}

/** The engine's public interface. */
export interface Engine {
  /** API contract version this engine implements. */
  readonly version: string;
  /** Execute a search over the engine's index. */
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
}

/**
 * Create an engine instance.
 *
 * Stub implementation: no index, no matching — every search resolves to an
 * empty, well-typed result. Real search logic lands in later milestones.
 */
export function createEngine(): Engine {
  return {
    version,
    async search(query: string, _options?: SearchOptions): Promise<SearchResult> {
      return {
        hits: [],
        totalCount: 0,
        query,
      };
    },
  };
}
