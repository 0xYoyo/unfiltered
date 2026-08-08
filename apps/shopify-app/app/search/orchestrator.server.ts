import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  appliedConstraints,
  constraintsFromIntent,
  EmptyQueryTextError,
  type AppliedConstraint,
  type ClassicSearchStore,
  type ClassificationReason,
  type Intent,
  type IntentExtractor,
  type QueryClassifier,
  type QueryRoute,
  type Retriever,
} from "@unfiltered/engine";

/**
 * The hybrid search orchestrator (YOY-45): one server-side function behind
 * the product's single search bar. It sequences classification → intent
 * extraction → vector retrieval, with classic keyword search as the floor a
 * failing AI path silently lands on — the shopper never chooses a mode and
 * never sees an error caused by us.
 *
 * The fallback ladder, top to bottom:
 *
 * - Routing: heuristics settle clearly-simple queries instantly; otherwise
 *   the LLM classifier decides. Classic-routed queries run the trigram
 *   keyword engine and carry no chips. A classifier failure or timeout
 *   surfaces as reason "model-error" (the classifier never rejects) and is
 *   served as classic results with `degraded: true`.
 * - Any AI-path failure — intent LLM error or timeout (the Gemini adapter's
 *   GeminiTimeoutError/GeminiApiError taxonomy propagates through the
 *   extractor port), IntentExtractionError, embedding failure, retrieval
 *   store error — yields classic keyword results for the raw query with
 *   `degraded: true` and no chips. The catch is deliberately type-blind: on
 *   this path no error shape may ever reach the caller, whatever threw it.
 * - EmptyQueryTextError is the one designed exception: the intent extracted
 *   fine but carries no descriptive text to embed ("not black under ₪400"),
 *   so the orchestrator runs constraint-only classic search and KEEPS the
 *   chips for the applied constraints — the shopper got exactly what they
 *   asked for, so `degraded` stays false.
 * - AI zero-hits: retrieval succeeded but matched nothing. The response
 *   keeps the chips, an empty primary hit list, and close matches from
 *   classic keyword search on the raw query.
 *
 * Classic-store errors are NOT caught: classic search is the ladder's floor
 * and shares its database with everything else, so there is nothing left to
 * fall back to — a failure there is an infrastructure outage, not an AI-path
 * failure, and must surface to the caller's own error handling.
 *
 * One searchId is generated per orchestrated search (when the caller does
 * not thread its own) and forwarded to every AI port call, so all AiCall
 * ledger rows serving one search share it.
 */

const DEFAULT_LIMIT = 10;

/**
 * Why the response took the route it did: the classifier's reason,
 * "resolved-intent" when the caller supplied the intent itself (chip
 * removal, YOY-46) and no classification ran, or "throttled" when the
 * caller forced the classic path (YOY-47) and no classification ran.
 */
export type SearchRouteReason =
  | ClassificationReason
  | "resolved-intent"
  | "throttled";

/** One orchestrated search request. */
export interface SearchRequest {
  /** Raw shopper query text. */
  query: string;
  /** Shop the search runs against. */
  shopDomain: string;
  /**
   * Intent extracted from the shopper's previous query in this session, when
   * the caller keeps one. Passed through to the extractor context unchanged
   * (NG-2); the orchestrator holds no session state.
   */
  previousIntent?: Intent;
  /**
   * A fully resolved intent to search with as-is (YOY-46 chip removal): the
   * orchestrator skips classification and extraction — no LLM call of any
   * kind — and enters the AI path at retrieval, with the same fallback
   * ladder below it. Mutually exclusive with `previousIntent`.
   */
  resolvedIntent?: Intent;
  /**
   * Force the classic path without consulting the classifier — zero LLM
   * calls (YOY-47 throttle). The response is served `degraded: true` with
   * reason "throttled". Takes precedence over `resolvedIntent`.
   */
  forceClassic?: boolean;
  /** Correlation ID to thread through every AI call; generated when absent. */
  searchId?: string;
  /** Maximum primary hits (and close matches) to return; defaults to 10. */
  limit?: number;
}

/** One ranked result card, hydrated from the catalog snapshot. */
export interface ProductCard {
  productId: string;
  title: string;
  handle: string;
  /** Featured image URL, when the product has one. */
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
}

/** The single response shape every orchestrated search resolves to. */
export interface SearchResponse {
  /** Correlation ID shared by every AI call that served this search. */
  searchId: string;
  /** Route that produced the primary hits: the keyword engine or the AI path. */
  route: QueryRoute;
  /**
   * Why routing went the way it did (diagnostic; the eval scorecard and the
   * later query log read it). On a degraded response this is the classifier's
   * reason for the original decision, not the fallback's.
   */
  routeReason: SearchRouteReason;
  /** The extracted intent, when the AI path produced one (diagnostic). */
  intent: Intent | null;
  /** Ranked primary results. */
  hits: ProductCard[];
  /** Applied-constraint chips; only AI-resolved searches carry any. */
  chips: AppliedConstraint[];
  /** True when an AI-path failure was silently served as classic results. */
  degraded: boolean;
  /** Classic close matches, populated only on AI zero-hit responses. */
  closeMatches: ProductCard[];
}

export interface SearchOrchestrator {
  runSearch(request: SearchRequest): Promise<SearchResponse>;
}

export interface SearchOrchestratorOptions {
  /** Catalog snapshot source for card hydration. */
  db: PrismaClient;
  classifier: QueryClassifier;
  extractor: IntentExtractor;
  retriever: Retriever;
  classicStore: ClassicSearchStore;
}

export function createSearchOrchestrator(
  options: SearchOrchestratorOptions,
): SearchOrchestrator {
  const { db, classifier, extractor, retriever, classicStore } = options;

  /** Hydrate ranked hits into display cards, preserving hit order. Hits
   * whose snapshot row vanished between ranking and hydration are dropped
   * rather than served as half-empty cards. */
  async function hydrateCards(
    shopDomain: string,
    hits: ReadonlyArray<{ productId: string }>,
  ): Promise<ProductCard[]> {
    if (hits.length === 0) {
      return [];
    }
    const rows = await db.catalogProduct.findMany({
      where: {
        shopDomain,
        productId: { in: hits.map((hit) => hit.productId) },
      },
    });
    const byId = new Map(rows.map((row) => [row.productId, row]));
    return hits.flatMap((hit) => {
      const row = byId.get(hit.productId);
      if (row === undefined) {
        return [];
      }
      return [
        {
          productId: row.productId,
          title: row.title,
          handle: row.handle,
          imageUrl: row.featuredImageUrl,
          priceMin: row.priceMin,
          priceMax: row.priceMax,
          currencyCode: row.currencyCode,
          available: row.available,
        },
      ];
    });
  }

  return {
    async runSearch(request: SearchRequest): Promise<SearchResponse> {
      const { query, shopDomain } = request;
      const searchId = request.searchId ?? randomUUID();
      const limit = request.limit ?? DEFAULT_LIMIT;

      const classicResponse = async (
        routeReason: SearchRouteReason,
        degraded: boolean,
        intent: Intent | null = null,
      ): Promise<SearchResponse> => {
        const result = await classicStore.search({ shopDomain, query, limit });
        return {
          searchId,
          route: "classic",
          routeReason,
          intent,
          hits: await hydrateCards(shopDomain, result.hits),
          chips: [],
          degraded,
          closeMatches: [],
        };
      };

      // Retrieval and everything below it on the ladder, shared by the
      // extracted-intent path and the resolved-intent (chip removal) path.
      const aiPath = async (
        intent: Intent,
        routeReason: SearchRouteReason,
      ): Promise<SearchResponse> => {
        let hits: Array<{ productId: string }>;
        let chips: AppliedConstraint[];
        try {
          const retrieval = await retriever.retrieve({
            intent,
            shopDomain,
            limit,
            searchId,
          });
          hits = retrieval.hits;
          chips = retrieval.appliedConstraints;
        } catch (error) {
          if (error instanceof EmptyQueryTextError) {
            // AC-5: constraints without descriptive text. Constraint-only
            // classic search, chips kept, not degraded — the response honors
            // every constraint the shopper stated.
            const constraints = constraintsFromIntent(intent);
            const result = await classicStore.search({
              shopDomain,
              constraints,
              limit,
            });
            return {
              searchId,
              route: "ai",
              routeReason,
              intent,
              hits: await hydrateCards(shopDomain, result.hits),
              chips: appliedConstraints(constraints),
              degraded: false,
              closeMatches: [],
            };
          }
          return classicResponse(routeReason, true, intent);
        }

        if (hits.length === 0) {
          // AC-6: retrieval worked, nothing satisfied every constraint. Keep
          // the chips and offer classic keyword matches as close matches.
          const close = await classicStore.search({ shopDomain, query, limit });
          return {
            searchId,
            route: "ai",
            routeReason,
            intent,
            hits: [],
            chips,
            degraded: false,
            closeMatches: await hydrateCards(shopDomain, close.hits),
          };
        }

        return {
          searchId,
          route: "ai",
          routeReason,
          intent,
          hits: await hydrateCards(shopDomain, hits),
          chips,
          degraded: false,
          closeMatches: [],
        };
      };

      if (request.forceClassic === true) {
        // Throttled (YOY-47): the caller has decided this session spent its
        // AI budget — classic keyword results, zero LLM calls, degraded so
        // the response is honest about not being the AI path.
        return classicResponse("throttled", true);
      }

      if (request.resolvedIntent !== undefined) {
        // Chip removal (YOY-46): the caller already holds the intent, so no
        // classification and no extraction — zero LLM calls on this path.
        return aiPath(request.resolvedIntent, "resolved-intent");
      }

      // The classifier never rejects by contract: failures and timeouts come
      // back as { route: "classic", reason: "model-error" }.
      const decision = await classifier.classify(query, {
        shopDomain,
        searchId,
      });

      if (decision.route === "classic") {
        // "model-error" means the model was needed and failed — served
        // classic, but flagged degraded (AC-4). Heuristic and model-decided
        // classic routes are the genuine article.
        return classicResponse(
          decision.reason,
          decision.reason === "model-error",
        );
      }

      let intent: Intent;
      try {
        intent = await extractor.extract(query, {
          shopDomain,
          searchId,
          previousIntent: request.previousIntent,
        });
      } catch {
        return classicResponse(decision.reason, true);
      }

      return aiPath(intent, decision.reason);
    },
  };
}
