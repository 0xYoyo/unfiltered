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
  type IntentTier,
  type QueryClassifier,
  type QueryRoute,
  type RetrievalConstraints,
  type Retriever,
} from "@unfiltered/engine";

import type { ClassicCardHit } from "./classic-store.server";
import { findReusableIntent, normalizeReuseQuery } from "./events.server";
import { SEARCH_STAGES, type SearchStage, type SearchStages } from "./stages";

export { SEARCH_STAGES, type SearchStage, type SearchStages } from "./stages";

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
 * - Classic zero hits (YOY-67 AC-3): a genuine classic route (heuristic or
 *   model-decided — not throttled, not already degraded) whose keyword
 *   search returns nothing for a non-empty query escalates once into the
 *   full AI path under reason "classic-zero-hit" — a cross-language query
 *   the model routed classic must not dead-end on a Latin-indexed catalog.
 *   The escalation runs the ladder below it unchanged; its own failure
 *   degrades back to the empty classic response without re-escalating.
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
 *   classic keyword search on the raw query. When keyword backfill finds
 *   nothing either — a Hebrew query against an EN catalog leaves trigram
 *   search empty-handed (YOY-52 AC-16) — close matches fall back to
 *   relaxed-constraint vector retrieval: the same cached query embedding,
 *   first with only the category constraint kept, then fully unconstrained,
 *   so the zero-hit state renders nearest-neighbor rescues cross-language.
 *   This fallback is best-effort: a failure inside it leaves close matches
 *   empty rather than degrading the response.
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

/**
 * Zero-hit close matches stay a short, curated list (YOY-107 AC-5): they are
 * a rescue gesture beside an empty result set, not a result set of their own,
 * so they keep a cap while primary hits no longer have one.
 */
const CLOSE_MATCH_LIMIT = 10;

/**
 * A constraint the close-match ladder may relax (YOY-111 AC-1), named as
 * the intent names it. `colorsExclude` is deliberately absent: an explicit
 * exclusion is never relaxed, at any rung, keyword fallback included — and
 * so are `attributesExclude` (the same promise for "not wool", YOY-133) and
 * `attributesInclude` (category-like: a bridal gown is what was asked for,
 * and a rescue that is not one is a keyword close match, not a relaxation).
 */
export type RelaxedConstraint =
  | "priceMax"
  | "priceMin"
  | "occasion"
  | "availabilityRequired"
  | "colorsInclude"
  | "category";

/**
 * The fixed relaxation order (YOY-111 AC-1): price first — the founder's
 * F-1 finding was ten over-budget black dresses — then occasion,
 * availability, colour inclusions, and the category last. `priceMin` and
 * `priceMax` relax together as the one "budget" constraint.
 */
const RELAXATION_ORDER: ReadonlyArray<ReadonlyArray<RelaxedConstraint>> = [
  ["priceMin", "priceMax"],
  ["occasion"],
  ["availabilityRequired"],
  ["colorsInclude"],
  ["category"],
];

/** One rung: the constraints still applied and the names relaxed so far. */
export interface RelaxationRung {
  relaxed: RelaxedConstraint[];
  constraints: RetrievalConstraints;
}

/**
 * Build the close-match relaxation ladder for an intent (YOY-111 AC-1):
 * each rung drops one more constraint group in RELAXATION_ORDER and keeps
 * every constraint not yet relaxed — a strictly cumulative loosening, so
 * the first rung with any hit is the closest set to what the shopper
 * asked. Groups the intent never stated are skipped, not counted as
 * relaxed. `colorsExclude` rides every rung untouched.
 */
export function relaxationLadder(intent: Intent): RelaxationRung[] {
  const base = constraintsFromIntent(intent);
  const present = (name: RelaxedConstraint): boolean => {
    switch (name) {
      case "priceMin":
        return base.priceMin !== undefined && base.priceMin !== null;
      case "priceMax":
        return base.priceMax !== undefined && base.priceMax !== null;
      case "occasion":
        return base.occasion !== undefined && base.occasion !== null;
      case "availabilityRequired":
        return base.availableOnly;
      case "colorsInclude":
        return base.colorsInclude.length > 0;
      case "category":
        return base.category !== undefined && base.category !== null;
    }
  };
  const rungs: RelaxationRung[] = [];
  const relaxed: RelaxedConstraint[] = [];
  let current: RetrievalConstraints = { ...base };
  for (const group of RELAXATION_ORDER) {
    const stated = group.filter(present);
    if (stated.length === 0) {
      continue;
    }
    relaxed.push(...stated);
    current = { ...current };
    for (const name of stated) {
      switch (name) {
        case "priceMin":
          delete current.priceMin;
          break;
        case "priceMax":
          delete current.priceMax;
          break;
        case "occasion":
          delete current.occasion;
          break;
        case "availabilityRequired":
          current.availableOnly = false;
          break;
        case "colorsInclude":
          current.colorsInclude = [];
          break;
        case "category":
          delete current.category;
          break;
      }
    }
    rungs.push({ relaxed: [...relaxed], constraints: current });
  }
  return rungs;
}

/**
 * One structured line per intent-extraction failure (YOY-109). The catch
 * below stays type-blind and the fallback stays silent for the shopper, but
 * the failure's class — the Gemini adapter's error name, its HTTP status or
 * code when it carries one, and how long the call ran — must reach the
 * server log: the live degraded-with-intent-null failures were diagnosable
 * only by reproduction because nothing recorded what actually threw.
 */
function warnIntentFailure(
  searchId: string,
  routeReason: SearchRouteReason,
  error: unknown,
  startedAt: number,
): void {
  const detail =
    error instanceof Error
      ? {
          error: error.name,
          message: error.message,
          ...("status" in error ? { status: error.status } : {}),
          ...("code" in error ? { code: error.code } : {}),
        }
      : { error: String(error) };
  console.warn(
    "[search] intent extraction failed; degrading to classic",
    JSON.stringify({
      searchId,
      routeReason,
      elapsedMs: Date.now() - startedAt,
      ...detail,
    }),
  );
}

/**
 * Why the response took the route it did: the classifier's reason,
 * "resolved-intent" when the caller supplied the intent itself (chip
 * removal, YOY-46) and no classification ran, "throttled" when the
 * caller forced the classic path (YOY-47) and no classification ran, or
 * "classic-zero-hit" when a genuine classic route found nothing and
 * escalated once into the AI path (YOY-67 AC-3), "preview" when the
 * caller asked for a keystroke preview (YOY-68) and no classification ran,
 * or "client-timeout-rescue" when the widget's submitted search ran out its
 * own budget and re-asked down the classic path (YOY-108 / YOY-96 AC-9) —
 * again with no classification run.
 */
export type SearchRouteReason =
  | ClassificationReason
  | "resolved-intent"
  | ForceClassicReason
  | "classic-zero-hit"
  | "preview"
  | "intent-reuse";

/**
 * Why a caller forced the classic path (`forceClassic`): the session spent
 * its AI budget ("throttled", YOY-47), or the shopper's submitted search
 * timed out client-side and the widget is rescuing it with the same query
 * down the zero-LLM path ("client-timeout-rescue", YOY-96 AC-9). Both are
 * served identically; the reason is what the SearchEvent ledger keeps so
 * the two stay distinguishable in analytics.
 */
export type ForceClassicReason = "throttled" | "client-timeout-rescue";

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
   * reason `forceClassicReason`, "throttled" when absent. Takes precedence
   * over `resolvedIntent`.
   */
  forceClassic?: boolean;
  /**
   * The reason a forced-classic response carries (YOY-96 AC-9): "throttled"
   * by default; "client-timeout-rescue" when the widget re-asks a submitted
   * search that timed out on its side. Ignored unless `forceClassic` is set.
   */
  forceClassicReason?: ForceClassicReason;
  /**
   * Keystroke preview (YOY-68 AC-1): classic-only results with zero LLM
   * calls of any kind — no classification, no zero-hit escalation. Unlike
   * `forceClassic`, the response is NOT degraded: a preview is the intended
   * shape, not a budget fallback. Takes precedence over every other mode.
   */
  preview?: boolean;
  /** Correlation ID to thread through every AI call; generated when absent. */
  searchId?: string;
  /**
   * Cap on primary hits. ABSENT — the storefront's own shape — means the FULL
   * match set (YOY-107): both routes return every product matching the query
   * and its hard constraints, ranked, and the consumer paginates it with the
   * theme's own pagination. Zero-hit close matches are capped separately and
   * always (AC-5), so this never widens them.
   */
  limit?: number;
}

/** One ranked result card, hydrated from the catalog snapshot. */
export interface ProductCard {
  productId: string;
  title: string;
  /**
   * Server-resolved product link (YOY-87, LEAK-2), rendered verbatim by the
   * widget; null when the ingestion adapter could not resolve one. The
   * storefront handle stays a DB column — adapter-internal, never on a card.
   */
  url: string | null;
  /** Featured image URL, when the product has one. */
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  /**
   * Passed a positive color constraint on unknown-passes leniency, not on
   * evidence (YOY-67 AC-5): the widget renders such cards de-emphasized and
   * labeled. False whenever no positive color constraint was applied.
   */
  colorUnknown: boolean;
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
  /**
   * Which constraints the close-match ladder relaxed to fill `closeMatches`
   * (YOY-111 AC-2), in relaxation order; `[]` when nothing was relaxed —
   * every non-zero-hit response, and a zero-hit with no close matches.
   */
  closeMatchesRelaxed: RelaxedConstraint[];
  /**
   * Which model tier produced `intent` (YOY-116): "lite" or "accuracy" from
   * a tier-aware extractor, null when no intent call ran (classic routes,
   * chip removal, previews) or the extractor is tier-agnostic.
   */
  intentTier: IntentTier | null;
  /**
   * Where the milliseconds went (YOY-114): whole ms per stage actually run,
   * floored. Stages that overlap (YOY-64 AC-5: classification ∥ intent
   * extraction, retrieval ∥ the speculative close-match search) each book
   * their own wall time, so the sum can exceed the response's wall time —
   * that excess is the overlap, and every single stage stays ≤ wall.
   * Diagnostic — the playground shows it and the proxy logs it; it is never
   * persisted and never reaches the storefront contract.
   */
  stages: SearchStages;
}

/**
 * One search's stage ledger: accumulates fractional wall time per stage
 * (a stage may run more than once — hydration of hits and of close matches
 * both land on `hydrate`) and reports whole milliseconds in pipeline order.
 */
function createStageLedger() {
  const elapsed = new Map<SearchStage, number>();
  const add = (stage: SearchStage, ms: number): void => {
    elapsed.set(stage, (elapsed.get(stage) ?? 0) + ms);
  };
  return {
    add,
    async time<T>(stage: SearchStage, run: () => Promise<T>): Promise<T> {
      const startedAt = performance.now();
      try {
        return await run();
      } finally {
        add(stage, performance.now() - startedAt);
      }
    },
    snapshot(): SearchStages {
      const stages: SearchStages = {};
      for (const stage of SEARCH_STAGES) {
        const ms = elapsed.get(stage);
        if (ms !== undefined) {
          stages[stage] = Math.floor(ms);
        }
      }
      return stages;
    },
  };
}

/** A response before its stage ledger and intent tier are attached. */
type StagelessResponse = Omit<SearchResponse, "stages" | "intentTier">;

/** Mutable slot the intent call fills with the tier that answered. */
interface TierSlot {
  value: IntentTier | null;
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
  /**
   * Exact-query intent reuse (YOY-64 AC-4): a submitted query whose
   * normalized text equals one this store was served within `windowMs` is
   * answered from that search's stored intent with zero LLM calls. Absent
   * means off (tests, the eval harness); production passes the env window.
   */
  intentReuse?: { windowMs: number; now?: () => Date };
}

export function createSearchOrchestrator(
  options: SearchOrchestratorOptions,
): SearchOrchestrator {
  const { db, classifier, extractor, retriever, classicStore, intentReuse } =
    options;

  /** Hydrate ranked hits into display cards, preserving hit order. Hits
   * whose snapshot row vanished between ranking and hydration are dropped
   * rather than served as half-empty cards. */
  async function hydrateCards(
    shopDomain: string,
    hits: ReadonlyArray<{ productId: string; colorUnknown?: boolean }>,
  ): Promise<ProductCard[]> {
    if (hits.length === 0) {
      return [];
    }
    const rows = await db.catalogProduct.findMany({
      where: {
        shopDomain,
        productId: { in: hits.map((hit) => hit.productId) },
        // Status guard (YOY-61 AC-3) and publication guard (YOY-67 AC-4),
        // matching both search stores' predicates: hits only ever come from
        // those guarded stores, so this is defense in depth — a non-active
        // or unpublished row must never be served, whatever handed us its id.
        status: "ACTIVE",
        publishedAt: { not: null },
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
          url: row.url,
          imageUrl: row.featuredImageUrl,
          priceMin: row.priceMin,
          priceMax: row.priceMax,
          currencyCode: row.currencyCode,
          available: row.available,
          colorUnknown: hit.colorUnknown === true,
        },
      ];
    });
  }

  return {
    async runSearch(request: SearchRequest): Promise<SearchResponse> {
      const stages = createStageLedger();
      const tier: TierSlot = { value: null };
      const response = await execute(request, stages, tier);
      return { ...response, stages: stages.snapshot(), intentTier: tier.value };
    },
  };

  async function execute(
    request: SearchRequest,
    stages: ReturnType<typeof createStageLedger>,
    tier: TierSlot,
  ): Promise<StagelessResponse> {
    const { query, shopDomain } = request;
    const searchId = request.searchId ?? randomUUID();
    // Undefined by default: the full match set (YOY-107). Forwarded to the
    // stores as-is, where an absent limit means no LIMIT clause.
    const limit = request.limit;
    const hydrate = (
      hits: ReadonlyArray<{ productId: string; colorUnknown?: boolean }>,
    ): Promise<ProductCard[]> =>
      stages.time("hydrate", () => hydrateCards(shopDomain, hits));

    /**
     * One intent extraction, booked as the `intent` stage (both tiers of an
     * escalated call land in the same stage) and reporting which tier
     * answered (YOY-116). A tier-agnostic extractor reports null. The tier
     * is returned, not written to the response slot here: a speculative
     * extraction (YOY-64 AC-5) that a classic route discards must leave
     * `intentTier` null, so only the caller that consumes the intent
     * commits its tier.
     */
    const extractIntent = (): Promise<{
      intent: Intent;
      tier: IntentTier | null;
    }> =>
      stages.time("intent", async () => {
        const context = {
          storeId: shopDomain,
          searchId,
          previousIntent: request.previousIntent,
        };
        if (extractor.extractDetailed !== undefined) {
          const detailed = await extractor.extractDetailed(query, context);
          return { intent: detailed.intent, tier: detailed.tier };
        }
        return { intent: await extractor.extract(query, context), tier: null };
      });
    const commitIntent = (extracted: {
      intent: Intent;
      tier: IntentTier | null;
    }): Intent => {
      tier.value = extracted.tier;
      return extracted.intent;
    };

    /**
     * Cards for classic hits (YOY-115 AC-1/AC-3): the pg_trgm store returns
     * the card fields in its one statement, so no hydration query runs and
     * no `hydrate` stage is booked. A classic store that hands back bare
     * hits (a fake, another implementation) still hydrates as before — the
     * publication guard in `hydrateCards` is then the only guard, exactly
     * as it was.
     */
    const classicCards = (
      hits: ReadonlyArray<
        { productId: string; colorUnknown?: boolean } | ClassicCardHit
      >,
    ): Promise<ProductCard[]> => {
      if (!hits.every((hit): hit is ClassicCardHit => "card" in hit)) {
        return hydrate(hits);
      }
      return Promise.resolve(
        hits.map((hit) => ({
          productId: hit.productId,
          title: hit.card.title,
          url: hit.card.url,
          imageUrl: hit.card.imageUrl,
          priceMin: hit.card.priceMin,
          priceMax: hit.card.priceMax,
          currencyCode: hit.card.currencyCode,
          available: hit.card.available,
          colorUnknown: hit.colorUnknown === true,
        })),
      );
    };

    const classicResponse = async (
      routeReason: SearchRouteReason,
      degraded: boolean,
      intent: Intent | null = null,
      escalateOnEmpty = false,
    ): Promise<StagelessResponse> => {
      const result = await stages.time("classic", () =>
        classicStore.search({
          storeId: shopDomain,
          query,
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
      if (
        escalateOnEmpty &&
        result.hits.length === 0 &&
        query.trim() !== ""
      ) {
        // Classic zero hits must not be a dead end (YOY-67 AC-3): the
        // keyword engine has nothing for this query — a cross-language
        // query against a Latin index being the live-run shape — so the
        // search escalates ONCE into the full AI path. Only a genuine
        // classic route escalates: throttled responses stay classic by
        // budget decision, degraded fallbacks already failed the AI path,
        // and the escalation's own failure lands back here with
        // escalateOnEmpty unset, so there is no loop.
        return escalatedAiPath();
      }
      return {
        searchId,
        route: "classic",
        routeReason,
        intent,
        hits: await classicCards(result.hits),
        chips: [],
        degraded,
        closeMatches: [],
        closeMatchesRelaxed: [],
      };
    };

    /**
     * Close matches on an AI zero-hit (YOY-111 AC-1, superseding the
     * YOY-52 AC-16 two-rung fallback): re-query the vector store with the
     * intent's cached embedding — the query text composes from the same
     * intent, so no further embedding call happens — down the relaxation
     * ladder, one constraint group at a time, stopping at the first rung
     * with hits. `colorsExclude` is applied on every rung. When even the
     * last rung is empty, the raw-query keyword search that ran alongside
     * retrieval is the final fallback — and it, too, carries the intent's
     * exclusions in constraint mode. Best-effort: a rung's failure moves on
     * to the next fallback rather than degrading the zero-hit response.
     */
    const closeMatchLadder = async (
      intent: Intent,
      limit: number,
      keyword: Promise<
        | { ok: true; result: { hits: Array<{ productId: string }> } }
        | { ok: false; error: unknown }
      >,
    ): Promise<{
      hits: Array<{ productId: string }>;
      relaxed: RelaxedConstraint[];
    }> => {
      let relaxed: RelaxedConstraint[] = [];
      for (const rung of relaxationLadder(intent)) {
        relaxed = rung.relaxed;
        try {
          const result = await retriever.retrieve({
            intent,
            storeId: shopDomain,
            limit,
            searchId,
            constraintsOverride: rung.constraints,
          });
          if (result.hits.length > 0) {
            return { hits: result.hits, relaxed };
          }
        } catch {
          break;
        }
      }
      const speculated = await keyword;
      if (!speculated.ok) {
        throw speculated.error;
      }
      return speculated.result.hits.length > 0
        ? { hits: speculated.result.hits, relaxed }
        : { hits: [], relaxed: [] };
    };

    // Retrieval and everything below it on the ladder, shared by the
    // extracted-intent path and the resolved-intent (chip removal) path.
    const aiPath = async (
      intent: Intent,
      routeReason: SearchRouteReason,
    ): Promise<StagelessResponse> => {
      let hits: Array<{ productId: string; colorUnknown?: boolean }>;
      let chips: AppliedConstraint[];
      // Speculative keyword close matches (YOY-64 AC-5): the zero-hit
      // rescue's classic search depends only on the raw query, not on
      // retrieval's output, so it runs alongside retrieval and is simply
      // dropped when retrieval finds hits. A cheap indexed statement; its
      // failure surfaces exactly as the sequential call's would — only when
      // the rescue is used.
      const speculativeClose = classicStore
        .search({
          storeId: shopDomain,
          query,
          // The keyword fallback honours the intent's exclusions too
          // (YOY-111 AC-1): "not black" is never relaxed, not even here.
          constraints: {
            colorsInclude: [],
            colorsExclude: intent.colorsExclude,
            attributesExclude: intent.attributesExclude,
            attributesInclude: [],
            availableOnly: false,
          },
          limit: CLOSE_MATCH_LIMIT,
        })
        .then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const retrieveStartedAt = performance.now();
      try {
        const retrieval = await retriever.retrieve({
          intent,
          storeId: shopDomain,
          ...(limit !== undefined ? { limit } : {}),
          searchId,
        });
        // The retriever reports its own embed/query split; a retriever
        // without one is booked whole as retrieval.
        if (retrieval.timings !== undefined) {
          stages.add("embed", retrieval.timings.embedMs);
          stages.add("retrieve", retrieval.timings.retrieveMs);
        } else {
          stages.add("retrieve", performance.now() - retrieveStartedAt);
        }
        hits = retrieval.hits;
        chips = retrieval.appliedConstraints;
      } catch (error) {
        // A failed retrieval still ran: book its wall time as retrieval
        // so the ledger's sum stays honest about where the time went.
        stages.add("retrieve", performance.now() - retrieveStartedAt);
        if (error instanceof EmptyQueryTextError) {
          // AC-5: constraints without descriptive text. Constraint-only
          // classic search, chips kept, not degraded — the response honors
          // every constraint the shopper stated.
          const constraints = constraintsFromIntent(intent);
          const result = await stages.time("classic", () =>
            classicStore.search({
              storeId: shopDomain,
              constraints,
              ...(limit !== undefined ? { limit } : {}),
            }),
          );
          return {
            searchId,
            route: "ai",
            routeReason,
            intent,
            hits: await classicCards(result.hits),
            chips: appliedConstraints(constraints),
            degraded: false,
            closeMatches: [],
            closeMatchesRelaxed: [],
          };
        }
        return classicResponse(routeReason, true, intent);
      }

      if (hits.length === 0) {
        // AC-6: retrieval worked, nothing satisfied every constraint. Keep
        // the chips and offer close matches down the relaxation ladder
        // (YOY-111 AC-1) — AC-5 (YOY-107): a short curated list, whatever
        // the primary set's size. The keyword fallback already ran
        // alongside retrieval (YOY-64 AC-5).
        const close = await stages.time("closeMatches", () =>
          closeMatchLadder(intent, CLOSE_MATCH_LIMIT, speculativeClose),
        );
        return {
          searchId,
          route: "ai",
          routeReason,
          intent,
          hits: [],
          chips,
          degraded: false,
          // Keyword close matches carry their cards; relaxed vector rescues
          // are bare ids and hydrate as before.
          closeMatches: await classicCards(close.hits),
          closeMatchesRelaxed: close.relaxed,
        };
      }

      return {
        searchId,
        route: "ai",
        routeReason,
        intent,
        hits: await hydrate(hits),
        chips,
        degraded: false,
        closeMatches: [],
        closeMatchesRelaxed: [],
      };
    };

    /**
     * The one-time classic zero-hit escalation (YOY-67 AC-3): the full AI
     * path from intent extraction down, under reason "classic-zero-hit" so
     * the caller's budget accounting can see LLM spend happened. An
     * extraction failure degrades back to the (still empty) classic
     * response rather than surfacing an error.
     */
    const escalatedAiPath = async (): Promise<StagelessResponse> => {
      let intent: Intent;
      const startedAt = Date.now();
      try {
        intent = commitIntent(await extractIntent());
      } catch (error) {
        warnIntentFailure(searchId, "classic-zero-hit", error, startedAt);
        return classicResponse("classic-zero-hit", true);
      }
      return aiPath(intent, "classic-zero-hit");
    };

    if (request.preview === true) {
      // Keystroke preview (YOY-68 AC-1): the shopper is still typing, so
      // the bar behaves like a normal search bar — classic keyword results
      // only, no classification, no escalation, and nothing degraded about
      // it. The full pipeline waits for the explicit submit.
      return classicResponse("preview", false);
    }

    if (request.forceClassic === true) {
      // Forced classic: the caller has decided this search must not reach
      // the AI path — the session spent its budget (YOY-47, "throttled")
      // or the widget is rescuing a submitted search that timed out on
      // its side (YOY-96 AC-9, "client-timeout-rescue"). Classic keyword
      // results, zero LLM calls, degraded so the response is honest about
      // not being the AI path; the reason is what the ledger keeps.
      return classicResponse(request.forceClassicReason ?? "throttled", true);
    }

    if (request.resolvedIntent !== undefined) {
      // Chip removal (YOY-46): the caller already holds the intent, so no
      // classification and no extraction — zero LLM calls on this path.
      return aiPath(request.resolvedIntent, "resolved-intent");
    }

    // Exact-query intent reuse (YOY-64 AC-4): the same normalized query
    // this store was served within the window is answered from that
    // search's stored intent — no classification, no extraction, zero LLM
    // calls. Never for a refinement (a follow-up's meaning depends on the
    // previous intent) and never for chip removal (handled above). A
    // lookup failure falls through to the full ladder: reuse is an
    // optimisation, never a dependency.
    if (intentReuse !== undefined && request.previousIntent === undefined) {
      try {
        const reusable = await findReusableIntent(db, {
          shopDomain,
          normalizedQuery: normalizeReuseQuery(query),
          windowMs: intentReuse.windowMs,
          now: intentReuse.now?.(),
        });
        if (reusable !== null) {
          return aiPath(reusable.intent, "intent-reuse");
        }
      } catch (error) {
        console.warn(
          "[search] intent reuse lookup failed; running the full ladder",
          JSON.stringify({ searchId, error: String(error) }),
        );
      }
    }

    // Classification ∥ intent extraction (YOY-64 AC-5): extraction depends
    // only on the query, not on the classifier's decision, so when the
    // classifier has no settled answer (no heuristic rule, no cached model
    // decision) the intent call starts alongside the model classification
    // instead of after it. A model-decided classic route then discards the
    // in-flight extraction — its cost lands in the ledger and is the price
    // of the overlap on that (rare) shape; a settled decision never
    // speculates, so heuristic-classic queries stay LLM-free.
    const settled = classifier.settled?.(query) ?? null;
    const speculativeIntent =
      settled === null
        ? extractIntent().then(
            (extracted) => ({ ok: true as const, extracted }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : null;

    // The classifier never rejects by contract: failures and timeouts come
    // back as { route: "classic", reason: "model-error" }.
    const decision = await stages.time("classify", () =>
      classifier.classify(query, {
        storeId: shopDomain,
        searchId,
      }),
    );

    if (decision.route === "classic") {
      // "model-error" means the model was needed and failed — served
      // classic, but flagged degraded (AC-4). Heuristic and model-decided
      // classic routes are the genuine article, and only those escalate
      // when the keyword engine comes back empty (YOY-67 AC-3) — a failing
      // model is not asked to rescue its own failure.
      const degraded = decision.reason === "model-error";
      return classicResponse(decision.reason, degraded, null, !degraded);
    }

    let intent: Intent;
    const startedAt = Date.now();
    try {
      if (speculativeIntent !== null) {
        const speculated = await speculativeIntent;
        if (!speculated.ok) {
          throw speculated.error;
        }
        intent = commitIntent(speculated.extracted);
      } else {
        intent = commitIntent(await extractIntent());
      }
    } catch (error) {
      warnIntentFailure(searchId, decision.reason, error, startedAt);
      return classicResponse(decision.reason, true);
    }

    return aiPath(intent, decision.reason);
  }
}
