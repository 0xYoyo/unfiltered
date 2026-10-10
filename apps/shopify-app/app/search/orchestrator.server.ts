import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type {
  ClassicSearchStore,
  Judge,
  JudgeLabel,
  JudgeVerdictCode,
  WishExtractor,
} from "@unfiltered/engine";

import type { ClassicCardHit } from "./classic-store.server";
import { extractThroughCache, type CachedExtraction } from "./extraction-cache.server";
import type { FindStep } from "./find.server";
import {
  DEFAULT_JUDGE_DEADLINE_MS,
  DEFAULT_JUDGE_GIVE_UP_MS,
  parkLatePage,
  runJudgeStep,
  type JudgeCallTimes,
  type JudgeStepItem,
} from "./judge-step.server";
import { SEARCH_STAGES, type SearchStage, type SearchStages } from "./stages";
import {
  composeWishes,
  DEFAULT_EXTRACTION_GRACE_MS,
  DEFAULT_PRICE_NEAR_PERCENT,
  DEFAULT_TIER_FRONT_SIZE,
  hasAppliedWishes,
  keepUnremoved,
  loadWishProducts,
  wishChips,
  type CodeLabel,
  type RemovedChip,
  type WishChip,
} from "./wishes.server";

export { SEARCH_STAGES, type SearchStage, type SearchStages } from "./stages";

/**
 * The search orchestrator: one server-side function behind the product's
 * single search bar (YOY-45). A submitted search runs the find step — the
 * raw sentence's nearest products merged with keyword matches (YOY-145) —
 * with the wish extraction in parallel (YOY-149), composes the stated
 * wishes onto the find order, and judges the page (YOY-147). Keystroke
 * previews (YOY-68) and the widget's client-timeout rescue (YOY-96 AC-9)
 * are classic keyword search only, with zero model calls.
 *
 * Classic-store errors are NOT caught: classic search is the floor and
 * shares its database with everything else, so a failure there is an
 * infrastructure outage and must surface to the caller's own error
 * handling.
 *
 * One searchId is generated per orchestrated search (when the caller does
 * not thread its own) and forwarded to every AI port call, so all AiCall
 * ledger rows serving one search share it.
 */

/** Which path produced the primary hits: the keyword engine or the find step. */
export type SearchRoute = "classic" | "ai";

/**
 * Why the response took the route it did: "preview" when the caller asked
 * for a keystroke preview (YOY-68), or "client-timeout-rescue" when the
 * widget's submitted search ran out its own budget and re-asked down the
 * classic path (YOY-96 AC-9). A submitted search answers with the judge's
 * outcome (YOY-147 AC-11).
 */
export type SearchRouteReason = "preview" | ForceClassicReason | V2RouteReason;

/**
 * A submitted search's routeReasons (YOY-147 AC-11): "judged",
 * "judge-timeout" or "judge-error" when a judge call started, "capped" when
 * a throttle or cap kept it from starting, and "find-only" when the page
 * had nothing to judge — beyond the find set, or no judge wired.
 * "judge-cached" (YOY-148 AC-2) is a page served from a stored judge answer
 * with no call.
 */
export type V2RouteReason =
  | "judged"
  | "judge-timeout"
  | "judge-error"
  | "judge-cached"
  | "capped"
  | "find-only";

/** One requested page of results (YOY-145 AC-4): 1-based, 1 to 48 per page. */
export interface SearchPaging {
  page: number;
  pageSize: number;
}

/** The page size a request without valid page parameters gets (AC-4). */
export const DEFAULT_PAGE_SIZE = 24;
/** The largest page a request may ask for (AC-4). */
export const MAX_PAGE_SIZE = 48;

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
   * The refinement chain this query follows (YOY-150 AC-1 – AC-3): the
   * `carry` of the previous response, echoed back by the client. Find, the
   * extraction and the judge read it.
   */
  previousQuery?: string;
  /**
   * Chips the shopper removed from a previous response (YOY-149 AC-15):
   * the facts they name are not applied and their chips are absent.
   */
  removedChips?: RemovedChip[];
  /**
   * Keep the search from spending on the judge (YOY-147 AC-7): a throttle
   * or a playground cap serves find order with no judge call, route
   * "classic", reason "capped". With `forceClassicReason`
   * "client-timeout-rescue" the search is classic keyword results instead,
   * zero model calls, `degraded: true` (YOY-96 AC-9).
   */
  forceClassic?: boolean;
  /**
   * "throttled" by default; "client-timeout-rescue" when the widget re-asks
   * a submitted search that timed out on its side.
   */
  forceClassicReason?: ForceClassicReason;
  /**
   * Keystroke preview (YOY-68 AC-1): classic-only results with zero model
   * calls of any kind. Unlike the rescue, the response is NOT degraded: a
   * preview is the intended shape. Takes precedence over every other mode.
   */
  preview?: boolean;
  /** Correlation ID to thread through every AI call; generated when absent. */
  searchId?: string;
  /**
   * Cap on classic hits (previews and the unpaged rescue). ABSENT means the
   * full match set (YOY-107). A submitted search always pages instead.
   */
  limit?: number;
  /**
   * Serve one page (YOY-145 AC-4): `hits` is that page, and the response
   * carries `page` and `totalCount`. A submitted search always pages (first
   * page by default); the classic rescue pages by slicing its full result
   * (AC-5). Keystroke previews ignore it (AC-9).
   */
  paging?: SearchPaging;
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
   * The card's label (YOY-147 AC-9): on every submitted-search card, null
   * when it carries none; absent on classic results. A code-computed label
   * (YOY-149 AC-12) replaces the judge's.
   */
  label?: JudgeLabel | CodeLabel | null;
  /**
   * The judge's verdict (YOY-147 AC-12): diagnostic, for the playground's
   * details only — the storefront wire never carries it. Absent when the
   * judge did not answer for the card.
   */
  verdict?: JudgeVerdictCode;
  /**
   * The verdict stands in for a call that never answered (YOY-159):
   * diagnostic, for the playground's details only.
   */
  standIn?: true;
}

/** The single response shape every orchestrated search resolves to. */
export interface SearchResponse {
  /** Correlation ID shared by every AI call that served this search. */
  searchId: string;
  /** Route that produced the primary hits: the keyword engine or the find step. */
  route: SearchRoute;
  /** Why the search took its route (diagnostic; the query log reads it). */
  routeReason: SearchRouteReason;
  /** Ranked primary results. */
  hits: ProductCard[];
  /** One chip per kept stated fact (YOY-149 AC-14); none on classic results. */
  chips: WishChip[];
  /** True when a failed embedding served keyword order (YOY-145 AC-8), and on the rescue. */
  degraded: boolean;
  /**
   * Where the milliseconds went (YOY-114): whole ms per stage actually run,
   * floored. Diagnostic — the playground shows it and the proxy logs it; it
   * is never persisted and never reaches the storefront contract.
   */
  stages: SearchStages;
  /** The page `hits` holds (YOY-145 AC-4); present exactly when the response is paged. */
  page?: number;
  /** Results across every page (YOY-145 AC-4); present exactly when `page` is. */
  totalCount?: number;
  /**
   * True when the judge missed its deadline and runs on (YOY-148 AC-7): the
   * page's labels arrive through the labels endpoint. Absent otherwise.
   */
  labelsPending?: true;
  /**
   * Whether the wish extraction answered in time to compose this page
   * (YOY-149 AC-4): present on every find-path response, false when it was
   * late, failed, or no extractor is wired.
   */
  extractionInTime?: boolean;
  /**
   * Whether the extraction cache answered (YOY-149 AC-18): no extraction
   * call was made. Present exactly when `extractionInTime` is.
   */
  extractionCached?: boolean;
  /**
   * The text the client sends as `previousQuery` next time (YOY-150 AC-3):
   * present on every find-path response. The chain's first sentence plus
   * up to two most recent refinements, newline-separated, when the query
   * refines; the query alone when it replaces or starts a chain.
   */
  carry?: string;
  /**
   * A second reading of the query that a page-1 product fits (YOY-150
   * AC-7), at most four words in the shopper's language; the surfaces
   * render it as one chip. Absent when there is none.
   */
  otherReading?: string;
  /**
   * The judge call's single provider calls as the page was served (YOY-159
   * AC-1). Diagnostic — the playground shows it; never on the storefront
   * contract. Absent when no judge call started.
   */
  judgeCalls?: JudgeCallTimes;
}

/** Refinements a carry keeps after the chain's first sentence (YOY-150 AC-3). */
export const CARRY_REFINEMENTS = 2;

/** One sentence as a carry holds it: whitespace collapsed, so newlines only separate. */
function carrySentence(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The carry of a response (YOY-150 AC-3): the query alone when there is no
 * previous chain or the query replaces it; otherwise the chain's first
 * sentence plus its two most recent refinements, this query the last.
 * `refines` is null when the extraction was late or not wired — read as
 * refining.
 */
export function nextCarry(query: string, previousQuery: string | undefined, refines: boolean | null): string {
  const sentence = carrySentence(query);
  const chain = (previousQuery ?? "")
    .split("\n")
    .map(carrySentence)
    .filter((part) => part !== "");
  if (chain.length === 0 || refines === false) {
    return sentence;
  }
  const [first, ...refinements] = chain;
  return [first!, ...[...refinements, sentence].slice(-CARRY_REFINEMENTS)].join("\n");
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

/** A response before its stage ledger is attached. */
type StagelessResponse = Omit<SearchResponse, "stages">;

export interface SearchOrchestrator {
  runSearch(request: SearchRequest): Promise<SearchResponse>;
}

export interface SearchOrchestratorOptions {
  /** Catalog snapshot source for card hydration. */
  db: PrismaClient;
  /** The keyword store previews and the client-timeout rescue search. */
  classicStore: ClassicSearchStore;
  /** The find step (YOY-145). */
  find: FindStep;
  /** The judge (YOY-147). Absent means pages are served in find order with reason "find-only". */
  judge?: Judge;
  /** How long the judge may take after its call started; 1,500 ms by default (AC-6). */
  judgeDeadlineMs?: number;
  /**
   * When a judge call past its deadline is given up, counted from its
   * start; 6,000 ms by default (YOY-148 AC-6).
   */
  judgeGiveUpMs?: number;
  /** The wish extraction (YOY-149). Absent means pages compose with no stated wishes. */
  wishExtractor?: WishExtractor;
  /** How long the page waits for the extraction after find; 800 ms by default (AC-3, AC-18). */
  extractionGraceMs?: number;
  /** How far over the cap a price is still near, in percent; 10 by default (AC-5, AC-12). */
  priceNearPercent?: number;
  /** How many find candidates the number tiers reorder; 48 by default (AC-5). */
  tierFrontSize?: number;
}

export function createSearchOrchestrator(
  options: SearchOrchestratorOptions,
): SearchOrchestrator {
  const {
    db,
    classicStore,
    find,
    judge,
    judgeDeadlineMs = DEFAULT_JUDGE_DEADLINE_MS,
    judgeGiveUpMs = DEFAULT_JUDGE_GIVE_UP_MS,
    wishExtractor,
    extractionGraceMs = DEFAULT_EXTRACTION_GRACE_MS,
    priceNearPercent = DEFAULT_PRICE_NEAR_PERCENT,
    tierFrontSize = DEFAULT_TIER_FRONT_SIZE,
  } = options;

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
        // Status guard (YOY-61 AC-3) and publication guard (YOY-67 AC-4),
        // matching the search stores' predicates: hits only ever come from
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
        },
      ];
    });
  }

  return {
    async runSearch(request: SearchRequest): Promise<SearchResponse> {
      const stages = createStageLedger();
      let response: StagelessResponse;
      if (request.preview === true) {
        // Keystroke preview (YOY-68 AC-1): the shopper is still typing, so
        // the bar behaves like a normal search bar — classic keyword
        // results only, nothing degraded about it, and no paging (AC-9).
        response = await classicSearch(request, "preview", false, stages);
      } else if (request.forceClassicReason === "client-timeout-rescue") {
        // The client-timeout rescue (YOY-96 AC-9): the widget's submitted
        // search timed out on its side and it re-asks down the zero-model
        // keyword path, degraded so the response is honest about it.
        if (request.paging !== undefined) {
          // The rescue pages by slicing its full result (YOY-145 AC-5): the
          // limit is dropped so the slice and `totalCount` see every match.
          const full = await classicSearch(
            { ...request, limit: undefined },
            "client-timeout-rescue",
            true,
            stages,
          );
          const { page, pageSize } = request.paging;
          response = {
            ...full,
            hits: full.hits.slice((page - 1) * pageSize, page * pageSize),
            page,
            totalCount: full.hits.length,
          };
        } else {
          response = await classicSearch(request, "client-timeout-rescue", true, stages);
        }
      } else {
        response = await findPath(request, stages);
      }
      return { ...response, stages: stages.snapshot() };
    },
  };

  /**
   * Classic keyword results for the raw query (previews and the rescue):
   * zero model calls. The pg_trgm store returns the card fields in its one
   * statement (YOY-115 AC-1), so no hydration query runs and no `hydrate`
   * stage is booked; a store that hands back bare hits (a fake, another
   * implementation) is hydrated, with the publication guard in
   * `hydrateCards` then the only guard.
   */
  async function classicSearch(
    request: SearchRequest,
    routeReason: "preview" | "client-timeout-rescue",
    degraded: boolean,
    stages: ReturnType<typeof createStageLedger>,
  ): Promise<StagelessResponse> {
    const result = await stages.time("classic", () =>
      classicStore.search({
        storeId: request.shopDomain,
        query: request.query,
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      }),
    );
    const hits: ReadonlyArray<{ productId: string } | ClassicCardHit> = result.hits;
    const cards = hits.every((hit): hit is ClassicCardHit => "card" in hit)
      ? hits.map((hit) => ({
          productId: hit.productId,
          title: hit.card.title,
          url: hit.card.url,
          imageUrl: hit.card.imageUrl,
          priceMin: hit.card.priceMin,
          priceMax: hit.card.priceMax,
          currencyCode: hit.card.currencyCode,
          available: hit.card.available,
        }))
      : await stages.time("hydrate", () => hydrateCards(request.shopDomain, hits));
    return {
      searchId: request.searchId ?? randomUUID(),
      route: "classic",
      routeReason,
      hits: cards,
      chips: [],
      degraded,
    };
  }

  /**
   * A submitted search (YOY-145): the find step's merged order, composed
   * with the stated wishes (YOY-149), one page of it hydrated, then judged
   * (YOY-147). A failed embedding serves the keyword order flagged degraded
   * (YOY-145 AC-8).
   *
   * The judge sees only the page's part inside the find set (YOY-147
   * AC-10): a page beyond it is served in keyword order with no call, and
   * a page straddling the boundary keeps its keyword tail after the judged
   * part. A forced-classic request (throttle or cap) is never judged
   * (AC-7). The route names the path that answered (YOY-157 AC-23): "ai"
   * for every page that went through find — judged, served from the answer
   * cache, timed out, failed or find-only — and "classic" only for a capped
   * or forced-classic page. Previews and the client-timeout rescue never
   * reach this path and stay "classic".
   */
  async function findPath(
    request: SearchRequest,
    stages: ReturnType<typeof createStageLedger>,
  ): Promise<StagelessResponse> {
    const startedAt = performance.now();
    const searchId = request.searchId ?? randomUUID();
    const { page, pageSize } = request.paging ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE };
    // The extraction starts with the search, in parallel with find (YOY-149
    // AC-1) — under a throttle or cap too, so the code's labels still hold
    // there (AC-13).
    const previousQuery =
      request.previousQuery !== undefined && request.previousQuery.trim() !== ""
        ? request.previousQuery
        : undefined;
    const extraction = startExtraction(request, searchId, previousQuery);
    const found = await stages.time("find", () =>
      find.find({
        shopDomain: request.shopDomain,
        query: request.query,
        searchId,
        ...(previousQuery !== undefined ? { previousQuery } : {}),
      }),
    );
    const settled = await extraction.settle();
    const extracted = settled?.wishes ?? null;
    // Removed chips belong to their chain (YOY-150 AC-11): they hold across
    // a refinement, and a query that replaces the chain starts with none.
    const removedChips =
      previousQuery !== undefined && extracted?.refines === false ? [] : (request.removedChips ?? []);
    const wishes = extracted === null ? null : keepUnremoved(extracted, removedChips);
    let ordered = { productIds: found.productIds, findSetCount: found.findSetCount };
    let codeLabels = new Map<string, CodeLabel>();
    if (wishes !== null && hasAppliedWishes(wishes)) {
      const composed = await stages.time("compose", async () =>
        composeWishes(
          found.productIds,
          found.findSetCount,
          await loadWishProducts(db, request.shopDomain, found.productIds),
          wishes,
          { nearPercent: priceNearPercent, tierFront: tierFrontSize },
        ),
      );
      ordered = composed;
      codeLabels = composed.labels;
    }
    const pageStart = (page - 1) * pageSize;
    const pageIds = ordered.productIds.slice(pageStart, pageStart + pageSize);
    const inFindSet = new Set(pageIds.slice(0, Math.max(0, ordered.findSetCount - pageStart)));
    const hydrated = await stages.time("hydrate", () =>
      hydrateCards(
        request.shopDomain,
        pageIds.map((productId) => ({ productId })),
      ),
    );
    const cards = hydrated.map((card): ProductCard => ({ ...card, label: null }));
    const judgedPart = cards.filter((card) => inFindSet.has(card.productId));
    const tail = cards.filter((card) => !inFindSet.has(card.productId));

    // A judged part's cards, then the keyword tail, each with its label: a
    // code-computed label replaces the judge's on the same card (AC-12).
    // The late page is composed the same way (YOY-171 AC-1).
    const withLabels = (judgedItems: readonly JudgeStepItem<ProductCard>[] | null) =>
      [
        ...(judgedItems === null
          ? cards
          : [
              ...judgedItems.map(({ item, verdict, label, standIn }) => ({
                ...item,
                label,
                ...(verdict !== null ? { verdict } : {}),
                ...(standIn === true ? { standIn } : {}),
              })),
              ...tail,
            ]),
      ].map((card) => {
        const codeLabel = codeLabels.get(card.productId);
        return codeLabel === undefined ? card : { ...card, label: codeLabel };
      });
    const respond = (
      routeReason: V2RouteReason,
      hits: ProductCard[],
      judged: {
        labelsPending?: boolean;
        otherReading?: string | null;
        calls?: JudgeCallTimes | null;
      } = {},
    ): StagelessResponse => {
      // The second reading is offered on page 1 only (AC-7).
      const otherReading = page === 1 ? (judged.otherReading ?? null) : null;
      return {
        searchId,
        route: request.forceClassic === true ? "classic" : "ai",
        routeReason,
        hits,
        chips: wishes === null ? [] : wishChips(wishes),
        degraded: found.degraded,
        page,
        totalCount: ordered.productIds.length,
        ...(judged.labelsPending === true ? { labelsPending: true as const } : {}),
        extractionInTime: extracted !== null,
        extractionCached: settled?.cached === true,
        carry: nextCarry(request.query, previousQuery, extracted?.refines ?? null),
        ...(otherReading !== null ? { otherReading } : {}),
        ...(judged.calls !== undefined && judged.calls !== null ? { judgeCalls: judged.calls } : {}),
      };
    };

    if (request.forceClassic === true) {
      return respond("capped", withLabels(null));
    }
    if (judge === undefined || judgedPart.length === 0) {
      return respond("find-only", withLabels(null));
    }
    const judgeStartedAt = performance.now();
    const judged = await runJudgeStep({
      judge,
      db,
      shopDomain: request.shopDomain,
      sentence: request.query,
      ...(previousQuery !== undefined ? { previousSentence: previousQuery } : {}),
      items: judgedPart,
      searchId,
      deadlineMs: judgeDeadlineMs,
      giveUpMs: judgeGiveUpMs,
      page,
      positionOffset: pageStart,
      // A removed `exclude` chip is not applied through the judge either (AC-15).
      applyExcluded: !removedChips.some((chip) => chip.field === "exclude"),
    });
    // The step's database time apart from its call's (YOY-159 AC-1).
    stages.add("judgeRows", judged.rowsMs);
    stages.add("judge", Math.max(0, performance.now() - judgeStartedAt - judged.rowsMs));
    if (judged.late !== undefined) {
      // The late answer's page, composed as the in-time one would have been
      // (YOY-171 AC-1), for the labels endpoint to hand over.
      parkLatePage(
        request.shopDomain,
        searchId,
        page,
        judged.late.then((late) =>
          late === null
            ? null
            : {
                response: {
                  ...respond("judge-timeout", withLabels(late.items), {
                    otherReading: late.otherReading,
                    calls: late.calls,
                  }),
                  stages: stages.snapshot(),
                },
                latencyMs: Math.round(performance.now() - startedAt),
              },
        ),
      );
    }
    return respond(
      judged.outcome,
      withLabels(judged.items),
      { labelsPending: judged.labelsPending, otherReading: judged.otherReading, calls: judged.calls },
    );
  }

  /**
   * Start the wish extraction (YOY-149 AC-1, AC-3, AC-18), through the
   * extraction cache. `settle` waits for it no longer than the grace after
   * the call to `settle` — made when find finishes — and answers the moment
   * it lands; null when it is late, failed, or not wired. A late call is
   * not aborted: it runs on and fills the cache for the next search.
   */
  function startExtraction(
    request: SearchRequest,
    searchId: string,
    previousQuery: string | undefined,
  ): { settle(): Promise<CachedExtraction | null> } {
    if (wishExtractor === undefined) {
      return { settle: () => Promise.resolve(null) };
    }
    const answer = extractThroughCache(db, wishExtractor, {
      sentence: request.query,
      ...(previousQuery !== undefined ? { previousSentence: previousQuery } : {}),
      storeId: request.shopDomain,
      searchId,
    })
      .then(
        (extraction): CachedExtraction | null => extraction,
        (error: unknown) => {
          console.warn(
            "[search] wish extraction failed; composing without it",
            JSON.stringify({ searchId, error: error instanceof Error ? error.name : String(error) }),
          );
          return null;
        },
      );
    return {
      async settle() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), extractionGraceMs);
        });
        const settled = await Promise.race([answer, grace]);
        clearTimeout(timer);
        return settled === "late" ? null : settled;
      },
    };
  }
}
