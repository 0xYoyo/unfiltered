import type { PrismaClient } from "@prisma/client";
import type { ClassicSearchStore, EmbeddingClient } from "@unfiltered/engine";

import { queryCardIndex, type CardIndexHit } from "./card-retrieval.server";

/**
 * The find step of Engine v2 (YOY-145): the products nearest to the raw
 * sentence, merged with keyword matches, with nothing but store, active and
 * published removing a product (AC-3).
 *
 * - One vector (AC-1): the raw sentence, trimmed, embedded as one text — no
 *   intent, no composed query text, no extraction (NG-1). The nearest
 *   `FIND_SET_SIZE` products come from the multi-vector card index
 *   (`queryCardIndex`, YOY-144), which already collapses by product and by
 *   family.
 * - Keyword matches: the pg_trgm store's full match set for the same text,
 *   with no constraints, in its own title-dominant order.
 * - Merge order (AC-2): a keyword match whose title strongly matches the
 *   query first, in keyword order; then the find set in vector order; then
 *   every remaining keyword match — those beyond the find set — in keyword
 *   order. A product appears once, and so does a family: a vector hit and a
 *   keyword hit may be different colourways of one family, and the earlier
 *   one speaks for it.
 * - Embedding failure (AC-8): the keyword order alone, flagged `degraded`.
 *   A card-index failure takes the same fallback — both are the vector half
 *   of the find step; a keyword-store failure is an outage and propagates,
 *   as it does on the old engine.
 */

/** Env var naming the find-set size (AC-1). */
export const FIND_SET_SIZE_ENV = "FIND_SET_SIZE";
/** Nearest products the vector half contributes (AC-1). */
export const DEFAULT_FIND_SET_SIZE = 150;

/**
 * A keyword match whose classic score reaches this leads the merged order
 * (AC-2). The score is `0.7 × word_similarity(query, title) + 0.3 ×
 * word_similarity(query, search text)`, and the second term is at most 0.3,
 * so 0.9 needs a title similarity of at least 6/7: the title holds the whole
 * query, give or take a typo — an exact-title search, not a descriptive one.
 */
export const STRONG_TITLE_SCORE = 0.9;

/** Query vectors kept per find step, oldest evicted first (page requests re-embed nothing). */
const QUERY_VECTOR_CACHE_SIZE = 256;

/**
 * The find-set size from `FIND_SET_SIZE`, a positive integer; unset means
 * the default. A malformed value fails at construction.
 */
export function findSetSizeFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[FIND_SET_SIZE_ENV];
  if (raw === undefined) {
    return DEFAULT_FIND_SET_SIZE;
  }
  const size = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(size) || size <= 0) {
    throw new Error(
      `${FIND_SET_SIZE_ENV} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return size;
}

/** One keyword match, as the merge reads it. */
export interface KeywordMatch {
  productId: string;
  score: number;
}

/**
 * The merged order of AC-2 over product ids, before the family pass. Pure:
 * `vector` is the find set nearest first, `keyword` the keyword matches in
 * keyword order.
 */
export function mergeFindOrder(
  vector: ReadonlyArray<string>,
  keyword: ReadonlyArray<KeywordMatch>,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (productId: string): void => {
    if (!seen.has(productId)) {
      seen.add(productId);
      merged.push(productId);
    }
  };
  for (const match of keyword) {
    if (match.score >= STRONG_TITLE_SCORE) {
      push(match.productId);
    }
  }
  vector.forEach(push);
  for (const match of keyword) {
    push(match.productId);
  }
  return merged;
}

/** The find step's answer: every found product in merged order. */
export interface FindResult {
  productIds: string[];
  /** True when the vector half failed and the keyword order was served alone (AC-8). */
  degraded: boolean;
}

export interface FindRequest {
  shopDomain: string;
  query: string;
  /** Correlation ID for the embedding call's ledger row. */
  searchId: string;
}

export interface FindStep {
  find(request: FindRequest): Promise<FindResult>;
}

export interface FindStepOptions {
  db: PrismaClient;
  embeddings: EmbeddingClient;
  classicStore: ClassicSearchStore;
  /** Nearest products taken from the card index; `FIND_SET_SIZE` by default. */
  findSetSize?: number;
  /** The card-index query; `queryCardIndex` by default (a seam for tests). */
  nearest?: (request: {
    db: PrismaClient;
    shopDomain: string;
    vector: number[];
    limit: number;
  }) => Promise<CardIndexHit[]>;
}

export function createFindStep(options: FindStepOptions): FindStep {
  const { db, embeddings, classicStore } = options;
  const findSetSize = options.findSetSize ?? DEFAULT_FIND_SET_SIZE;
  const nearest = options.nearest ?? queryCardIndex;
  const vectors = new Map<string, number[]>();

  async function embedQuery(text: string, shopDomain: string, searchId: string): Promise<number[]> {
    const cached = vectors.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const [vector] = await embeddings.embed({
      texts: [text],
      operation: "embedding",
      storeId: shopDomain,
      searchId,
    });
    if (vector === undefined) {
      throw new Error("embedding port returned no vector for the query");
    }
    vectors.set(text, vector);
    if (vectors.size > QUERY_VECTOR_CACHE_SIZE) {
      vectors.delete(vectors.keys().next().value!);
    }
    return vector;
  }

  /** Keep the first product of each family, in order (one family, one card). */
  async function collapseFamilies(shopDomain: string, productIds: string[]): Promise<string[]> {
    if (productIds.length === 0) {
      return [];
    }
    const rows = await db.catalogProduct.findMany({
      where: { shopDomain, productId: { in: productIds } },
      select: { productId: true, familyKey: true },
    });
    const familyOf = new Map(
      rows.map((row) => [row.productId, row.familyKey === "" ? row.productId : row.familyKey]),
    );
    const seen = new Set<string>();
    return productIds.filter((productId) => {
      const family = familyOf.get(productId) ?? productId;
      if (seen.has(family)) {
        return false;
      }
      seen.add(family);
      return true;
    });
  }

  return {
    async find({ shopDomain, query, searchId }) {
      const text = query.trim();
      // The two halves run side by side; the vector half's failure is a
      // value, so it cannot reject unobserved while the keyword half runs.
      const vectorHalf = embedQuery(text, shopDomain, searchId)
        .then((vector) => nearest({ db, shopDomain, vector, limit: findSetSize }))
        .then(
          (hits) => ({ ok: true as const, hits }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const keyword = await classicStore.search({ storeId: shopDomain, query: text });
      const vector = await vectorHalf;
      if (!vector.ok) {
        console.warn(
          "[search] find step vector half failed; serving the keyword order",
          JSON.stringify({
            searchId,
            error: vector.error instanceof Error ? vector.error.name : String(vector.error),
          }),
        );
      }
      const merged = mergeFindOrder(
        vector.ok ? vector.hits.map((hit) => hit.productId) : [],
        keyword.hits,
      );
      return {
        productIds: await collapseFamilies(shopDomain, merged),
        degraded: !vector.ok,
      };
    },
  };
}
