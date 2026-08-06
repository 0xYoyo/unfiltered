/**
 * Retrieval: where a structured Intent becomes ranked results. Hard
 * constraints are pushed down to the store port as filters — never applied as
 * ranking preferences — and soft attributes rank the filtered set by vector
 * similarity to a query embedding. Vendor- and platform-free: data is reached
 * only through the injected store and embedding ports.
 */

import type { EmbeddingClient } from "./index.js";
import type { Intent } from "./intent.js";

/**
 * Hard constraints the store port must apply as filters. Derived from an
 * Intent by `constraintsFromIntent`; a product violating any of them must
 * never be returned, regardless of similarity.
 */
export interface RetrievalConstraints {
  /** Product category the results must belong to. */
  category?: string;
  /** Results must be purchasable at or above this price. */
  priceMin?: number;
  /** Results must be purchasable at or below this price. */
  priceMax?: number;
  /** Results must carry at least one of these colors. */
  colorsInclude: string[];
  /** Results must carry none of these colors. */
  colorsExclude: string[];
  /** Results must suit this occasion. */
  occasion?: string;
  /** Results must be available (in stock). */
  availableOnly: boolean;
}

/** One ranked hit from the store port: a product and its cosine distance. */
export interface StoreQueryHit {
  /** Consumer-assigned product identifier. */
  productId: string;
  /** Cosine distance to the query vector; lower is nearer. */
  distance: number;
}

/** One filtered similarity query against the consumer's store. */
export interface StoreQueryRequest {
  /** Store the query runs against; results must come from it alone. */
  shopDomain: string;
  /** Hard filters; every returned product must satisfy all of them. */
  constraints: RetrievalConstraints;
  /** Query embedding to rank the filtered set by cosine distance. */
  vector: number[];
  /** Maximum hits to return. */
  limit: number;
}

/**
 * Port to the consumer's product store. Implementations live on the app side
 * (e.g. Postgres/pgvector) and must apply every constraint as a filter inside
 * the store, never by post-ranking.
 */
export interface RetrievalStore {
  query(request: StoreQueryRequest): Promise<StoreQueryHit[]>;
}

/** One hard constraint the store applied, echoed back with the results. */
export interface AppliedConstraint {
  field:
    | "category"
    | "priceMin"
    | "priceMax"
    | "colorsInclude"
    | "colorsExclude"
    | "occasion"
    | "availability";
  value: string;
}

/** One ranked retrieval hit. */
export interface RetrievalHit {
  /** Consumer-assigned product identifier. */
  productId: string;
  /**
   * Similarity score `1 - cosine distance`, in [-1, 1]; higher is more
   * relevant. Cosine distance spans [0, 2], so anti-correlated vectors score
   * below zero — a valid hit, not a sentinel; consumers must not drop hits by
   * `score > 0`.
   */
  score: number;
}

/**
 * The intent carries no descriptive signal to embed (no category, occasion,
 * wanted colors, or soft attributes), so similarity ranking is undefined for
 * it. The engine never embeds an empty string — a metered call with a
 * provider-dependent, meaningless result. Callers decide the fallback, e.g.
 * classic constraint-only search.
 */
export class EmptyQueryTextError extends Error {}

/** The outcome of one retrieval. */
export interface RetrievalResult {
  /** Ranked hits, most similar first, all satisfying every constraint. */
  hits: RetrievalHit[];
  /** The hard constraints that were applied as filters. */
  appliedConstraints: AppliedConstraint[];
}

/** One retrieval request: an intent evaluated against one store. */
export interface RetrievalRequest {
  intent: Intent;
  /** Store context: which consumer store to search. */
  shopDomain: string;
  /** Maximum hits to return; defaults to 10. */
  limit?: number;
  /** Correlation ID tying together every call serving one search. */
  searchId?: string;
}

export interface Retriever {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

export interface RetrieverOptions {
  /** Embedding port; the consumer constructs it with its configured model. */
  embeddings: EmbeddingClient;
  /** Store port; the consumer implements it over its own database. */
  store: RetrievalStore;
  /** Maximum cached query embeddings; oldest entries are evicted first. */
  cacheSize?: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_CACHE_SIZE = 1000;

/**
 * Map an Intent's hard constraints to store filters. Size is intentionally
 * not mapped: the engine's store contract carries no per-size inventory, so a
 * size constraint cannot be enforced as a filter and must never silently
 * become a ranking preference.
 */
export function constraintsFromIntent(intent: Intent): RetrievalConstraints {
  return {
    category: intent.category,
    priceMin: intent.priceMin,
    priceMax: intent.priceMax,
    colorsInclude: intent.colorsInclude,
    colorsExclude: intent.colorsExclude,
    occasion: intent.occasion,
    availableOnly: intent.availabilityRequired,
  };
}

/** The applied-constraint list echoed back with results (NG-2: list only). */
export function appliedConstraints(
  constraints: RetrievalConstraints,
): AppliedConstraint[] {
  const applied: AppliedConstraint[] = [];
  if (constraints.category !== undefined) {
    applied.push({ field: "category", value: constraints.category });
  }
  if (constraints.priceMin !== undefined) {
    applied.push({ field: "priceMin", value: String(constraints.priceMin) });
  }
  if (constraints.priceMax !== undefined) {
    applied.push({ field: "priceMax", value: String(constraints.priceMax) });
  }
  for (const color of constraints.colorsInclude) {
    applied.push({ field: "colorsInclude", value: color });
  }
  for (const color of constraints.colorsExclude) {
    applied.push({ field: "colorsExclude", value: color });
  }
  if (constraints.occasion !== undefined) {
    applied.push({ field: "occasion", value: constraints.occasion });
  }
  if (constraints.availableOnly) {
    applied.push({ field: "availability", value: "in stock" });
  }
  return applied;
}

/**
 * Deterministic query text embedded for similarity ranking: the intent's
 * descriptive signal in fixed order — category, occasion, wanted colors, then
 * soft attributes — empty parts dropped, mirroring the catalog side's
 * composed embedding text so query and product vectors share a vocabulary.
 */
export function composeQueryText(intent: Intent): string {
  const parts = [
    intent.category ?? "",
    intent.occasion ?? "",
    ...intent.colorsInclude,
    ...intent.softAttributes,
  ];
  return parts.filter((part) => part !== "").join("\n");
}

/**
 * Create a retriever over the given embedding and store ports.
 *
 * Hard constraints travel to the store as filters; the store ranks the
 * filtered set by cosine distance, which is returned as `score = 1 -
 * distance` (range [-1, 1]) so higher is better. The query-side embedding
 * call carries operation "embedding" for metering (AC-3) and is cached by
 * composed query text, so identical intents embed once per retriever. An
 * intent whose composed query text is empty rejects with
 * EmptyQueryTextError before any embedding call (YOY-29 AC-9).
 */
export function createRetriever(options: RetrieverOptions): Retriever {
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
  const cache = new Map<string, number[]>();

  async function embedQuery(
    text: string,
    shopDomain: string,
    searchId?: string,
  ): Promise<number[]> {
    const cached = cache.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const vectors = await options.embeddings.embed({
      texts: [text],
      operation: "embedding",
      shopDomain,
      searchId,
    });
    const vector = vectors[0];
    if (vector === undefined) {
      throw new Error("embedding port returned no vector for the query text");
    }
    cache.set(text, vector);
    if (cache.size > cacheSize) {
      cache.delete(cache.keys().next().value!);
    }
    return vector;
  }

  return {
    async retrieve(request) {
      const constraints = constraintsFromIntent(request.intent);
      const queryText = composeQueryText(request.intent);
      if (queryText === "") {
        throw new EmptyQueryTextError(
          "intent has no descriptive signal to embed; similarity ranking is undefined",
        );
      }
      const vector = await embedQuery(
        queryText,
        request.shopDomain,
        request.searchId,
      );
      const hits = await options.store.query({
        shopDomain: request.shopDomain,
        constraints,
        vector,
        limit: request.limit ?? DEFAULT_LIMIT,
      });
      return {
        hits: hits.map((hit) => ({
          productId: hit.productId,
          score: 1 - hit.distance,
        })),
        appliedConstraints: appliedConstraints(constraints),
      };
    },
  };
}
