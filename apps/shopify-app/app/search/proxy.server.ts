import type { PrismaClient } from "@prisma/client";
import {
  createJudge,
  createWishExtractor,
  judgeProviderFromEnv,
  type JudgeProvider,
} from "@unfiltered/engine";
import {
  createGeminiEmbeddingClient,
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";

import {
  createPrismaCostRecorder,
  createQueuedCostRecorder,
  type CostRecorder,
} from "../ai/cost-recorder.server";
import {
  createOpenRouterDecisionClient,
  openRouterModelsFromEnv,
  sharedOpenRouterPool,
} from "../ai/openrouter.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import { createFindStep, findSetSizeFromEnv } from "./find.server";
import {
  judgeCallTimeoutMsFromEnv,
  judgeDeadlineMsFromEnv,
  judgeGiveUpMsFromEnv,
  judgeRowCharsFromEnv,
} from "./judge-step.server";
import {
  createSearchOrchestrator,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type SearchOrchestrator,
  type SearchPaging,
  type SearchResponse,
} from "./orchestrator.server";
import {
  extractionGraceMsFromEnv,
  priceNearPercentFromEnv,
  tierFrontSizeFromEnv,
  type CodeLabelTemplate,
  type RemovedChip,
  type WishChipField,
} from "./wishes.server";

/**
 * The storefront search contract (YOY-46): parsing for the JSON the widget
 * sends through the app proxy and serialization of the exact JSON it gets
 * back. Everything here is shopper-facing and shopper-anonymous — the
 * serializers re-map every field explicitly so nothing beyond the contract
 * (no tokens, no diagnostics, no internal error details) can leak into a
 * response body, whatever the orchestrator's own response type grows.
 */

/**
 * One applied-constraint chip, exactly as the widget renders it: one kept
 * stated fact (YOY-149 AC-14); a price chip carries the shopper's own
 * `currency` when they stated one.
 */
export interface ProxyChip {
  field: WishChipField;
  value: string;
  currency?: string;
}

/** The JSON body the widget POSTs through the proxy. */
export interface ProxySearchBody {
  /** Raw shopper query text. */
  query: string;
  /** Widget-generated session correlation ID (used by later milestones). */
  sessionId: string;
  /**
   * Every chip the shopper removed from a response in this search
   * (YOY-149 AC-15): the facts they name are not applied and their chips
   * are absent. A JSON array of `{ field, value }`.
   */
  removedChips?: RemovedChip[];
  /**
   * The `carry` of the previous response in this chain (YOY-150
   * AC-1): the search refines or replaces it. At most
   * `MAX_PREVIOUS_QUERY_CHARS` characters; absent on a fresh search.
   */
  previousQuery?: string;
  /**
   * "preview" marks a keystroke preview (YOY-68): classic-only results,
   * zero LLM calls, no throttle budget, no SearchEvent. "classic" marks a
   * SUBMITTED classic-only search (YOY-96 AC-9) — the widget's rescue of a
   * search that timed out on its side: the same zero-LLM keyword path, no
   * throttle budget, but logged as a real SearchEvent (route "classic",
   * routeReason "client-timeout-rescue") with an attributable searchId.
   * Absent on ordinary submitted searches, which run the full pipeline.
   * Both modes are bare classic fetches, so neither combines with
   * `previousQuery`.
   */
  mode?: ProxySearchMode;
  /**
   * The requested page (YOY-145 AC-4), present when the request carried
   * `page` or `pageSize`: `page` is 1-based (anything else becomes 1) and
   * `pageSize` 1 to 48 (anything else becomes 24). Absent means today's
   * unpaged response (AC-5).
   */
  paging?: SearchPaging;
}

/** The classic-only wire modes; see `ProxySearchBody.mode`. */
export type ProxySearchMode = "preview" | "classic";

const SEARCH_MODES: ReadonlySet<string> = new Set(["preview", "classic"]);

/**
 * The longest `previousQuery` accepted (YOY-150 AC-1): a carry holds at most
 * three sentences, so anything longer is not one the server answered.
 */
export const MAX_PREVIOUS_QUERY_CHARS = 2_000;

/**
 * Validate a proxy request body. Returns null on any violation — the route
 * answers 400 without detail, so parsing is strict rather than forgiving.
 */
export function parseProxySearchBody(value: unknown): ProxySearchBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { query, sessionId } = record;
  if (typeof query !== "string" || query.trim() === "") {
    return null;
  }
  if (typeof sessionId !== "string" || sessionId === "") {
    return null;
  }

  const body: ProxySearchBody = { query, sessionId };

  if (record.mode !== undefined && record.mode !== null) {
    if (typeof record.mode !== "string" || !SEARCH_MODES.has(record.mode)) {
      return null;
    }
    // A preview — and the classic rescue (YOY-96 AC-9) — is a bare classic
    // fetch (YOY-68 AC-1): refinement context belongs to the full submitted
    // pipeline, so combining them is a contract violation, not a request to
    // guess about.
    if (record.previousQuery != null) {
      return null;
    }
    body.mode = record.mode as ProxySearchMode;
  }

  if (record.page !== undefined || record.pageSize !== undefined) {
    body.paging = parsePaging(record.page, record.pageSize);
  }

  if (record.removedChips !== undefined && record.removedChips !== null) {
    const removed = parseRemovedChips(record.removedChips);
    if (removed === null) {
      return null;
    }
    body.removedChips = removed;
  }

  if (record.previousQuery !== undefined && record.previousQuery !== null) {
    if (
      typeof record.previousQuery !== "string" ||
      record.previousQuery.length > MAX_PREVIOUS_QUERY_CHARS
    ) {
      return null;
    }
    if (record.previousQuery.trim() !== "") {
      body.previousQuery = record.previousQuery;
    }
  }

  return body;
}

const WISH_CHIP_FIELDS: ReadonlySet<string> = new Set<WishChipField>([
  "priceMax",
  "priceMin",
  "size",
  "availability",
  "exclude",
]);

/**
 * Validate `removedChips` (YOY-149 AC-15): an array of at most 20 chips, each
 * a known Engine v2 field and a string value of at most 200 characters.
 */
function parseRemovedChips(value: unknown): RemovedChip[] | null {
  if (!Array.isArray(value) || value.length > 20) {
    return null;
  }
  const chips: RemovedChip[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const { field, value: chipValue } = entry as Record<string, unknown>;
    if (
      typeof field !== "string" ||
      !WISH_CHIP_FIELDS.has(field) ||
      typeof chipValue !== "string" ||
      chipValue.length > 200
    ) {
      return null;
    }
    chips.push({ field, value: chipValue });
  }
  return chips;
}

/**
 * Normalize page parameters (YOY-145 AC-4). Lenient by contract, unlike the
 * rest of the body: a page that is not a positive whole number is the first
 * page, and a page size outside 1 to 48 is 24. Accepts numbers (the JSON
 * body) and decimal strings (query parameters).
 */
export function parsePaging(page: unknown, pageSize: unknown): SearchPaging {
  const whole = (value: unknown): number | null => {
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : Number.NaN;
    return Number.isSafeInteger(number) ? number : null;
  };
  const pageNumber = whole(page);
  const size = whole(pageSize);
  return {
    page: pageNumber !== null && pageNumber >= 1 ? pageNumber : 1,
    pageSize: size !== null && size >= 1 && size <= MAX_PAGE_SIZE ? size : DEFAULT_PAGE_SIZE,
  };
}

/**
 * Parse a search request from GET query parameters — the transport the
 * widget actually uses (YOY-60 AC-1: the proxy edge rejects browser POSTs,
 * which carry `Origin`; GET forwards). Object-valued fields travel as JSON
 * inside their parameter, mirroring the widget's `buildSearchParams`;
 * validation is delegated to `parseProxySearchBody` so both transports
 * enforce the identical contract. Shopify's own signed proxy parameters
 * (shop, timestamp, signature, …) ride the same query string and are
 * simply not read here.
 */
export function parseProxySearchParams(
  params: URLSearchParams,
): ProxySearchBody | null {
  const query = params.get("query");
  const sessionId = params.get("sessionId");
  if (query === null || sessionId === null) {
    return null;
  }
  const record: Record<string, unknown> = { query, sessionId };
  const mode = params.get("mode");
  if (mode !== null) {
    record.mode = mode;
  }
  // Page parameters (YOY-145 AC-4).
  for (const key of ["page", "pageSize"] as const) {
    const value = params.get(key);
    if (value !== null) {
      record[key] = value;
    }
  }
  const removedChips = params.get("removedChips");
  if (removedChips !== null) {
    try {
      record.removedChips = JSON.parse(removedChips);
    } catch {
      return null;
    }
  }
  // A plain string parameter (YOY-150 AC-1), not JSON.
  const previousQuery = params.get("previousQuery");
  if (previousQuery !== null) {
    record.previousQuery = previousQuery;
  }
  return parseProxySearchBody(record);
}

/** The JSON body the widget's click beacon POSTs through the proxy (YOY-47). */
export interface ClickBeaconBody {
  /** The searchId of the response whose result was clicked. */
  searchId: string;
  /** Widget-generated session correlation ID. */
  sessionId: string;
  /** Clicked product. */
  productId: string;
  /** Zero-based position of the card in the rendered results. */
  position: number;
}

/** Validate a click-beacon body; null on any violation (the route answers 400). */
export function parseClickBeaconBody(value: unknown): ClickBeaconBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { searchId, sessionId, productId, position } = value as Record<
    string,
    unknown
  >;
  if (
    typeof searchId !== "string" ||
    searchId === "" ||
    typeof sessionId !== "string" ||
    sessionId === "" ||
    typeof productId !== "string" ||
    productId === "" ||
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0
  ) {
    return null;
  }
  return { searchId, sessionId, productId, position };
}

/** A labels request (YOY-148 AC-8): which search and which page. */
export interface LabelsRequest {
  searchId: string;
  page: number;
}

/**
 * Parse a labels request from GET query parameters (YOY-148 AC-8): a
 * non-empty `searchId` of at most 200 characters and a whole `page` of 1 or
 * more. Anything else is null.
 */
export function parseLabelsParams(params: URLSearchParams): LabelsRequest | null {
  const searchId = params.get("searchId");
  const page = params.get("page");
  if (searchId === null || searchId.trim() === "" || searchId.length > 200 || page === null) {
    return null;
  }
  const parsed = Number(page);
  if (page.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return { searchId, page: parsed };
}

/** The labels endpoint's body (YOY-148 AC-8, AC-9): labels by product id, never an order. */
export interface ProxyLabelsResponse {
  labels: Record<string, ProxyLabel | null>;
}

export function serializeLabels(
  labels: Record<string, { template: ProxyLabel["template"]; values: readonly string[] } | null>,
): ProxyLabelsResponse {
  return {
    labels: Object.fromEntries(
      Object.entries(labels).map(([productId, label]) => [
        productId,
        label === null ? null : { template: label.template, values: [...label.values] },
      ]),
    ),
  };
}

/**
 * Parse a click beacon from GET query parameters (YOY-60): the mirror of
 * the widget's `buildClickParams`, delegating validation to
 * `parseClickBeaconBody`. `position` travels as a decimal string; anything
 * that is not a whole non-negative number fails validation there.
 */
export function parseClickBeaconParams(
  params: URLSearchParams,
): ClickBeaconBody | null {
  const searchId = params.get("searchId");
  const sessionId = params.get("sessionId");
  const productId = params.get("productId");
  const position = params.get("position");
  if (
    searchId === null ||
    sessionId === null ||
    productId === null ||
    position === null ||
    position.trim() === ""
  ) {
    return null;
  }
  return parseClickBeaconBody({
    searchId,
    sessionId,
    productId,
    position: Number(position),
  });
}

/**
 * The judge's label on the wire (YOY-147 AC-9): `fact-differs` with the
 * product's value then the asked one, or `close-match` with none.
 */
export interface ProxyLabel {
  /** The judge's templates (YOY-147) and the code-computed ones (YOY-149 AC-12). */
  template: "fact-differs" | "close-match" | CodeLabelTemplate;
  values: string[];
}

/** One result card on the wire — the exact keys of the contract, no more. */
export interface ProxyResult {
  productId: string;
  title: string;
  /** Server-resolved product link, or null (YOY-87); rendered verbatim. */
  url: string | null;
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  /**
   * The judge's label or null (YOY-147 AC-9), on every submitted-search
   * result; absent on classic results. The verdict never reaches the
   * storefront (AC-12).
   */
  label?: ProxyLabel | null;
}

/** The response body the proxy endpoint answers with (YOY-46 AC-3). */
export interface ProxySearchResponse {
  searchId: string;
  route: "classic" | "ai";
  degraded: boolean;
  results: ProxyResult[];
  chips: ProxyChip[];
  /**
   * On a judged page with a match, the page's `close` products (YOY-166
   * AC-1), rendered under the "Close matches" heading; absent otherwise.
   */
  closeMatches?: ProxyResult[];
  /** The page `results` holds (YOY-145 AC-4); present on paged responses only. */
  page?: number;
  /** Results across every page; present exactly when `page` is. */
  totalCount?: number;
  /**
   * Present (true) only when the judge missed its deadline and runs on
   * (YOY-148 AC-7): the page's labels can be fetched from the labels endpoint.
   */
  labelsPending?: true;
  /**
   * What the client sends as `previousQuery` on its next search (YOY-150
   * AC-3); present on find-path responses only.
   */
  carry?: string;
  /**
   * A second reading of the search (YOY-150 AC-7), rendered as the chip
   * "{reading} instead?"; present only when a page-1 product fits it.
   */
  otherReading?: string;
}

function serializeCard(card: {
  productId: string;
  title: string;
  url: string | null;
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  label?: ProxyLabel | null;
}): ProxyResult {
  return {
    productId: card.productId,
    title: card.title,
    url: card.url,
    imageUrl: card.imageUrl,
    priceMin: card.priceMin,
    priceMax: card.priceMax,
    currencyCode: card.currencyCode,
    available: card.available,
    ...(card.label !== undefined
      ? {
          label:
            card.label === null
              ? null
              : { template: card.label.template, values: [...card.label.values] },
        }
      : {}),
  };
}

/**
 * Whether a judge provider writes the merchant-fact label ("in grey, not
 * black") on an `other-variant` product (YOY-157 AC-27). The Flash-Lite
 * judge does. The Jev decision judge writes no text, so its `other-variant`
 * card carries the generic `close-match` label (PRD v3.4 §3) and reads to a
 * shopper exactly like a `close` one.
 */
export function judgeWritesFactLabel(provider: JudgeProvider): boolean {
  return provider === "gemini";
}

/**
 * A judged page's close products, apart from its matches (YOY-166 AC-1):
 * when the page holds at least one match, its close products go under the
 * "Close matches" divider, each group in the order it was served. A match
 * is `exact`, and `other-variant` too when the judge writes its fact label;
 * under a judge that writes none (Jev), an `other-variant` card is a close
 * one (YOY-157 AC-27). Null — every card stays inline — on any other page:
 * one with no match (the reject-all rule, YOY-147 AC-8), one with no close
 * product, or one served without verdicts (find order, a judge timeout).
 * A stand-in verdict (YOY-159) is no judgment and never moves a card.
 */
export function splitCloseVerdicts<
  T extends { verdict?: string; standIn?: true },
>(hits: readonly T[], provider: JudgeProvider): { matched: T[]; close: T[] } | null {
  const variantMatches = judgeWritesFactLabel(provider);
  const judged = (hit: T) => hit.standIn !== true;
  const isMatch = (hit: T) =>
    judged(hit) && (hit.verdict === "exact" || (variantMatches && hit.verdict === "other-variant"));
  const isClose = (hit: T) =>
    judged(hit) && (hit.verdict === "close" || (!variantMatches && hit.verdict === "other-variant"));
  if (!hits.some(isMatch) || !hits.some(isClose)) {
    return null;
  }
  return {
    matched: hits.filter((hit) => !isClose(hit)),
    close: hits.filter(isClose),
  };
}

/**
 * Map an orchestrator response onto the wire contract. Explicit re-mapping
 * is the AC-5 guarantee: fields the contract does not name (routeReason and
 * anything added later) cannot reach a shopper.
 */
export function serializeProxySearchResponse(
  response: SearchResponse,
  // The provider that judged the page: the one the orchestrator was built
  // with, unless a caller names it (YOY-157 AC-27).
  judgeProvider: JudgeProvider = judgeProviderFromEnv(process.env),
): ProxySearchResponse {
  const body: ProxySearchResponse = {
    searchId: response.searchId,
    route: response.route,
    degraded: response.degraded,
    results: response.hits.map(serializeCard),
    chips: response.chips.map((chip) => ({
      field: chip.field,
      value: chip.value,
      ...(chip.currency !== undefined ? { currency: chip.currency } : {}),
    })),
  };
  const split = splitCloseVerdicts(response.hits, judgeProvider);
  if (split !== null) {
    body.results = split.matched.map(serializeCard);
    body.closeMatches = split.close.map(serializeCard);
  }
  // Only a paged response carries the page keys, so an unpaged one stays
  // byte-identical to the pre-paging contract (YOY-145 AC-5).
  if (response.page !== undefined && response.totalCount !== undefined) {
    body.page = response.page;
    body.totalCount = response.totalCount;
  }
  if (response.labelsPending === true) {
    body.labelsPending = true;
  }
  if (response.carry !== undefined) {
    body.carry = response.carry;
  }
  if (response.otherReading !== undefined) {
    body.otherReading = response.otherReading;
  }
  return body;
}

/**
 * The orchestrator wired for production storefront traffic: configured
 * Gemini models metered through the Prisma cost ledger, over the pgvector
 * and pg_trgm stores. Requires GEMINI_API_KEY — construct only outside the
 * default offline test run (tests mock this module).
 */
export function createProxySearchOrchestrator(
  db: PrismaClient,
  {
    // The ledger write leaves the hot path (YOY-64 AC-1): every metered call
    // resolves as soon as its row is queued; a failed insert is logged. A
    // caller that reads the ledger afterwards passes its own queued recorder
    // and flushes it first (the score run, YOY-141 AC-10).
    costRecorder = createQueuedCostRecorder(createPrismaCostRecorder(db)),
    // A per-call timeout on the judge and the wish extraction; the score
    // runner sets 30 s (YOY-149 runner guard). Unset keeps each client's own.
    requestTimeoutMs,
  }: { costRecorder?: CostRecorder; requestTimeoutMs?: number } = {},
): SearchOrchestrator {
  const models = geminiModelsFromEnv();
  const openRouterModels = openRouterModelsFromEnv();
  const embeddings = createGeminiEmbeddingClient({
    modelId: models.embeddingModel,
    dimension: models.embeddingDimension,
    costRecorder,
  });
  const classicStore = createPgTrgmClassicStore(db);
  return createSearchOrchestrator({
    db,
    classicStore,
    // The find step (YOY-145).
    find: createFindStep({
      db,
      embeddings,
      classicStore,
      findSetSize: findSetSizeFromEnv(),
    }),
    // The judge (YOY-147): one call per page inside the find set,
    // through the one factory — `JUDGE_PROVIDER` picks the client, and the
    // model is the provider's own config (AC-1). Built only for the
    // selected provider; `jev` is the decision-model challenger over
    // OpenRouter (YOY-152 AC-1).
    judge: createJudge({
      provider: judgeProviderFromEnv(process.env),
      clients: {
        gemini: () =>
          createGeminiLlmClient({
            modelId: models.judgeModel,
            costRecorder,
            thinkingLevel: models.judgeThinkingLevel,
            ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
          }),
        jev: () => {
          // The page's 24 calls share one keep-alive pool (YOY-159 AC-3),
          // warmed once the client exists — that is, once the key is set.
          const pool = sharedOpenRouterPool();
          const client = createOpenRouterDecisionClient({
            modelId: openRouterModels.judgeModel,
            costRecorder,
            fetchImpl: pool.fetch,
            ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
          });
          void pool.warm();
          return client;
        },
      },
      // The answer-cache key names the model (YOY-148 AC-1).
      modelIds: { gemini: models.judgeModel, jev: openRouterModels.judgeModel },
      maxRowChars: judgeRowCharsFromEnv(),
      // A straggler is read as not relevant past this, under the deadline (YOY-159 AC-3).
      callTimeoutMs: judgeCallTimeoutMsFromEnv(),
    }),
    judgeDeadlineMs: judgeDeadlineMsFromEnv(),
    judgeGiveUpMs: judgeGiveUpMsFromEnv(),
    // The wish extraction (YOY-149 AC-1): Flash-Lite, operation
    // `extract`, in parallel with find.
    wishExtractor: createWishExtractor({
      // The extraction-cache key names the model (YOY-149 AC-18).
      modelId: models.extractModel,
      llm: createGeminiLlmClient({
        modelId: models.extractModel,
        costRecorder,
        thinkingLevel: models.extractThinkingLevel,
        ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      }),
    }),
    extractionGraceMs: extractionGraceMsFromEnv(),
    priceNearPercent: priceNearPercentFromEnv(),
    tierFrontSize: tierFrontSizeFromEnv(),
  });
}

let orchestratorSingleton: SearchOrchestrator | undefined;

/**
 * The production orchestrator as a module singleton (YOY-67 AC-7): its
 * clients — the judge's shared keep-alive pool among them (YOY-159 AC-3) —
 * are per-instance, so per-request construction would throw them away on
 * every search. A construction failure caches nothing, so a missing GEMINI_API_KEY
 * stays a per-request 500 rather than a poisoned process. The `factory`
 * parameter exists for tests, which memoize their fake builds through the
 * same code path production takes.
 */
export function getProxySearchOrchestrator(
  db: PrismaClient,
  factory: (db: PrismaClient) => SearchOrchestrator = createProxySearchOrchestrator,
): SearchOrchestrator {
  return (orchestratorSingleton ??= factory(db));
}

/** Drop the memoized orchestrator so tests can install a fresh build. */
export function resetProxySearchOrchestrator(): void {
  orchestratorSingleton = undefined;
}
