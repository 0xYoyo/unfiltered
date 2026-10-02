import type { PrismaClient } from "@prisma/client";
import {
  createEscalatingIntentExtractor,
  createIntentExtractor,
  DEFAULT_INTENT_ESCALATION_THRESHOLD,
  DEFAULT_INTENT_HEDGE_AFTER_MS,
  createQueryClassifier,
  createRetriever,
  parseIntent,
  type AppliedConstraint,
  type Intent,
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
import { createPgTrgmClassicStore } from "./classic-store.server";
import { createFindStep, findSetSizeFromEnv } from "./find.server";
import {
  createSearchOrchestrator,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type SearchOrchestrator,
  type SearchPaging,
  type SearchResponse,
} from "./orchestrator.server";
import { createPgVectorRetrievalStore } from "./retrieval-store.server";

/**
 * The storefront search contract (YOY-46): parsing for the JSON the widget
 * sends through the app proxy and serialization of the exact JSON it gets
 * back. Everything here is shopper-facing and shopper-anonymous — the
 * serializers re-map every field explicitly so nothing beyond the contract
 * (no tokens, no diagnostics, no internal error details) can leak into a
 * response body, whatever the orchestrator's own response type grows.
 */

/** One applied-constraint chip, exactly as the widget renders it. */
export interface ProxyChip {
  field: AppliedConstraint["field"];
  value: string;
}

/** The JSON body the widget POSTs through the proxy. */
export interface ProxySearchBody {
  /** Raw shopper query text. */
  query: string;
  /** Widget-generated session correlation ID (used by later milestones). */
  sessionId: string;
  /** The `intent` of the previous response, echoed back for refinement. */
  previousIntent?: Intent;
  /** Chip the shopper dismissed; requires `previousIntent` to adjust. */
  removeChip?: ProxyChip;
  /**
   * "preview" marks a keystroke preview (YOY-68): classic-only results,
   * zero LLM calls, no throttle budget, no SearchEvent. "classic" marks a
   * SUBMITTED classic-only search (YOY-96 AC-9) — the widget's rescue of a
   * search that timed out on its side: the same zero-LLM keyword path, no
   * throttle budget, but logged as a real SearchEvent (route "classic",
   * routeReason "client-timeout-rescue") with an attributable searchId.
   * Absent on ordinary submitted searches, which run the full pipeline.
   * Both modes are bare classic fetches, so neither combines with
   * `previousIntent` or `removeChip`.
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

const CHIP_FIELDS: ReadonlySet<string> = new Set([
  "category",
  "priceMin",
  "priceMax",
  "colorsInclude",
  "colorsExclude",
  "attributesExclude",
  "attributesInclude",
  "occasion",
  "availability",
]);

/**
 * Validate a proxy request body. Returns null on any violation — the route
 * answers 400 without detail, so parsing is strict rather than forgiving.
 * `previousIntent` goes through the engine's own `parseIntent`, which
 * normalizes the nulls the serialized wire format carries back to undefined.
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
    if (record.previousIntent != null || record.removeChip != null) {
      return null;
    }
    body.mode = record.mode as ProxySearchMode;
  }

  if (record.page !== undefined || record.pageSize !== undefined) {
    body.paging = parsePaging(record.page, record.pageSize);
  }

  if (record.previousIntent !== undefined && record.previousIntent !== null) {
    const intent = parseIntent(record.previousIntent);
    if (intent === null) {
      return null;
    }
    body.previousIntent = intent;
  }

  if (record.removeChip !== undefined && record.removeChip !== null) {
    const chip = record.removeChip as Record<string, unknown>;
    if (
      typeof chip !== "object" ||
      typeof chip.field !== "string" ||
      !CHIP_FIELDS.has(chip.field) ||
      typeof chip.value !== "string"
    ) {
      return null;
    }
    if (body.previousIntent === undefined) {
      // A chip only exists as part of a previous response's intent; removal
      // without that intent has nothing to recompute from.
      return null;
    }
    body.removeChip = {
      field: chip.field as AppliedConstraint["field"],
      value: chip.value,
    };
  }

  return body;
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
  // Page parameters (YOY-145 AC-4). `engine` is deliberately not read: the
  // storefront proxy ignores it (AC-6); only the playground route honours it.
  for (const key of ["page", "pageSize"] as const) {
    const value = params.get(key);
    if (value !== null) {
      record[key] = value;
    }
  }
  const previousIntent = params.get("previousIntent");
  if (previousIntent !== null) {
    try {
      record.previousIntent = JSON.parse(previousIntent);
    } catch {
      return null;
    }
  }
  const removeChip = params.get("removeChip");
  if (removeChip !== null) {
    try {
      record.removeChip = JSON.parse(removeChip);
    } catch {
      return null;
    }
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
 * Drop one dismissed chip's constraint from an intent (YOY-46 AC-4). Pure
 * intent surgery — no model involved, which is what keeps the chip-removal
 * round-trip LLM-free.
 */
export function removeChipFromIntent(intent: Intent, chip: ProxyChip): Intent {
  const next: Intent = {
    ...intent,
    colorsInclude: [...intent.colorsInclude],
    colorsExclude: [...intent.colorsExclude],
    attributesExclude: [...intent.attributesExclude],
    attributesInclude: [...intent.attributesInclude],
    softAttributes: [...intent.softAttributes],
  };
  switch (chip.field) {
    case "category":
      delete next.category;
      break;
    case "priceMin":
      delete next.priceMin;
      break;
    case "priceMax":
      delete next.priceMax;
      break;
    case "colorsInclude":
      next.colorsInclude = next.colorsInclude.filter(
        (color) => color !== chip.value,
      );
      break;
    case "colorsExclude":
      next.colorsExclude = next.colorsExclude.filter(
        (color) => color !== chip.value,
      );
      break;
    case "attributesExclude":
      next.attributesExclude = next.attributesExclude.filter(
        (word) => word !== chip.value,
      );
      break;
    case "attributesInclude":
      next.attributesInclude = next.attributesInclude.filter(
        (word) => word !== chip.value,
      );
      break;
    case "occasion":
      delete next.occasion;
      break;
    case "availability":
      next.availabilityRequired = false;
      break;
  }
  return next;
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
   * Passed a positive color constraint on unknown-passes leniency, not on
   * evidence (YOY-67 AC-5): the widget de-emphasizes and labels such cards.
   * False whenever no positive color constraint was applied.
   */
  colorUnknown: boolean;
}

/** The intent on the wire: every field present, absent optionals as null. */
export interface ProxyIntent {
  category: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  colorsInclude: string[];
  colorsExclude: string[];
  /** Negated attribute words (YOY-133); always present, possibly empty. */
  attributesExclude: string[];
  /** Required category-like attributes (YOY-133); always present, possibly empty. */
  attributesInclude: string[];
  occasion: string | null;
  size: string | null;
  availabilityRequired: boolean;
  softAttributes: string[];
}

/** The response body the proxy endpoint answers with (YOY-46 AC-3). */
export interface ProxySearchResponse {
  searchId: string;
  route: "classic" | "ai";
  degraded: boolean;
  results: ProxyResult[];
  chips: ProxyChip[];
  /** For the client to echo back as `previousIntent` on a follow-up. */
  intent: ProxyIntent | null;
  /** Classic near-misses; present only on AI zero-hit responses. */
  closeMatches?: ProxyResult[];
  /**
   * The constraints relaxed to fill `closeMatches` (YOY-111 AC-2), in
   * order; present exactly when `closeMatches` is, `[]` when the matches
   * came without relaxing anything.
   */
  closeMatchesRelaxed?: string[];
  /** The page `results` holds (YOY-145 AC-4); present on paged responses only. */
  page?: number;
  /** Results across every page; present exactly when `page` is. */
  totalCount?: number;
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
  colorUnknown: boolean;
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
    colorUnknown: card.colorUnknown,
  };
}

function serializeIntent(intent: Intent): ProxyIntent {
  return {
    category: intent.category ?? null,
    priceMin: intent.priceMin ?? null,
    priceMax: intent.priceMax ?? null,
    currency: intent.currency ?? null,
    colorsInclude: intent.colorsInclude,
    colorsExclude: intent.colorsExclude,
    attributesExclude: intent.attributesExclude,
    attributesInclude: intent.attributesInclude,
    occasion: intent.occasion ?? null,
    size: intent.size ?? null,
    availabilityRequired: intent.availabilityRequired,
    softAttributes: intent.softAttributes,
  };
}

/**
 * Map an orchestrator response onto the wire contract. Explicit re-mapping
 * is the AC-5 guarantee: fields the contract does not name (routeReason and
 * anything added later) cannot reach a shopper.
 */
export function serializeProxySearchResponse(
  response: SearchResponse,
): ProxySearchResponse {
  const body: ProxySearchResponse = {
    searchId: response.searchId,
    route: response.route,
    degraded: response.degraded,
    results: response.hits.map(serializeCard),
    chips: response.chips.map((chip) => ({
      field: chip.field,
      value: chip.value,
    })),
    intent: response.intent === null ? null : serializeIntent(response.intent),
  };
  if (response.closeMatches.length > 0) {
    body.closeMatches = response.closeMatches.map(serializeCard);
    body.closeMatchesRelaxed = [...response.closeMatchesRelaxed];
  }
  // Only a paged response carries the page keys, so an unpaged one stays
  // byte-identical to the pre-paging contract (YOY-145 AC-5).
  if (response.page !== undefined && response.totalCount !== undefined) {
    body.page = response.page;
    body.totalCount = response.totalCount;
  }
  return body;
}

/** Env var naming the lite-tier confidence floor (YOY-116 AC-2). */
export const INTENT_ESCALATION_THRESHOLD_ENV = "INTENT_ESCALATION_THRESHOLD";

/**
 * The confidence below which a lite intent answer escalates to the accuracy
 * tier: `INTENT_ESCALATION_THRESHOLD`, a number in [0, 1]; unset means the
 * engine's committed default. A malformed value is a misconfiguration and
 * fails here, at construction, rather than silently routing everything to
 * one tier.
 */
export function intentEscalationThresholdFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[INTENT_ESCALATION_THRESHOLD_ENV];
  if (raw === undefined) {
    return DEFAULT_INTENT_ESCALATION_THRESHOLD;
  }
  const threshold = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `${INTENT_ESCALATION_THRESHOLD_ENV} must be a number within [0, 1], got ${JSON.stringify(raw)}`,
    );
  }
  return threshold;
}

/** Env var naming the class-escalation hedge delay, in milliseconds (YOY-64 AC-6). */
export const INTENT_HEDGE_AFTER_MS_ENV = "INTENT_HEDGE_AFTER_MS";

/**
 * How long a class-escalated accuracy-tier intent call may run before the
 * lite tier is fired alongside it and the first valid answer wins:
 * `INTENT_HEDGE_AFTER_MS`, a positive number of milliseconds; unset means
 * the engine's committed default. A malformed value fails at construction.
 */
export function intentHedgeAfterMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[INTENT_HEDGE_AFTER_MS_ENV];
  if (raw === undefined) {
    return DEFAULT_INTENT_HEDGE_AFTER_MS;
  }
  const ms = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `${INTENT_HEDGE_AFTER_MS_ENV} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/** Env var naming the exact-query intent reuse window, in minutes (YOY-64 AC-4). */
export const INTENT_REUSE_WINDOW_MINUTES_ENV = "INTENT_REUSE_WINDOW_MINUTES";
/**
 * Default reuse window: an hour covers a demo's repeated "Try:" examples and
 * a shopper re-running a search, while a catalog change still reaches a
 * repeated query within the hour (the intent is reused, retrieval is not).
 */
export const DEFAULT_INTENT_REUSE_WINDOW_MINUTES = 60;

/**
 * The reuse window in milliseconds from `INTENT_REUSE_WINDOW_MINUTES`; unset
 * means the committed default, `0` disables reuse, and a malformed value
 * fails at construction.
 */
export function intentReuseWindowMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[INTENT_REUSE_WINDOW_MINUTES_ENV];
  if (raw === undefined) {
    return DEFAULT_INTENT_REUSE_WINDOW_MINUTES * 60_000;
  }
  const minutes = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(minutes) || minutes < 0) {
    throw new Error(
      `${INTENT_REUSE_WINDOW_MINUTES_ENV} must be a non-negative number of minutes, got ${JSON.stringify(raw)}`,
    );
  }
  return minutes * 60_000;
}

/** Env var switching the default engine to v2 (YOY-145 AC-1). */
export const ENGINE_V2_ENV = "ENGINE_V2";

/**
 * Whether Engine v2 is the default: `ENGINE_V2=1`. Anything else — unset,
 * empty, `0` — is the old engine (NG-3: off by default).
 */
export function engineV2FromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ENGINE_V2_ENV]?.trim() === "1";
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
  }: { costRecorder?: CostRecorder } = {},
): SearchOrchestrator {
  const models = geminiModelsFromEnv();
  const reuseWindowMs = intentReuseWindowMsFromEnv();
  const embeddings = createGeminiEmbeddingClient({
    modelId: models.embeddingModel,
    dimension: models.embeddingDimension,
    costRecorder,
  });
  const classicStore = createPgTrgmClassicStore(db);
  return createSearchOrchestrator({
    ...(reuseWindowMs > 0 ? { intentReuse: { windowMs: reuseWindowMs } } : {}),
    db,
    classifier: createQueryClassifier({
      llm: createGeminiLlmClient({
        modelId: models.classificationModel,
        costRecorder,
      }),
    }),
    // Lite-first intent extraction (YOY-116): the lite tier answers first
    // and the accuracy tier takes over on low confidence or a known-weak
    // query class. Two metered clients, one searchId, each its own model id
    // in the ledger.
    extractor: createEscalatingIntentExtractor({
      lite: createIntentExtractor({
        llm: createGeminiLlmClient({
          modelId: models.intentLiteModel,
          costRecorder,
          // Explicit thinking on the lite call too (YOY-109 lesson): never
          // the model default.
          thinkingLevel: models.intentLiteThinkingLevel,
          // A hung lite call escalates to the accuracy tier; it must give
          // up fast (gemini-3.5-flash-lite hangs on some refinement prompts).
          requestTimeoutMs: models.intentLiteTimeoutMs,
        }),
      }),
      accuracy: createIntentExtractor({
        llm: createGeminiLlmClient({
          modelId: models.intentModel,
          costRecorder,
          // Low thinking on the intent call (YOY-109): the model default's
          // queue tail and hangs were the live degraded-with-intent-null
          // failures.
          thinkingLevel: models.intentThinkingLevel,
          // A hung accuracy call degrades to classic inside the widget's
          // budget (YOY-64 AC-3) instead of the adapter's 60 s default.
          requestTimeoutMs: models.intentTimeoutMs,
        }),
      }),
      threshold: intentEscalationThresholdFromEnv(),
      // A class match's accuracy call is hedged with the lite tier past this
      // delay (YOY-64 AC-6): the accuracy model's occasion-class tail — and
      // its hangs to the deadline — no longer decide the AI p95 alone.
      hedgeAfterMs: intentHedgeAfterMsFromEnv(),
      // One budget for the whole ladder (YOY-64 AC-3): a hung upstream
      // degrades to classic at GEMINI_INTENT_TIMEOUT_MS, not at the lite
      // timeout plus the accuracy timeout in series.
      deadlineMs: models.intentTimeoutMs,
    }),
    retriever: createRetriever({
      embeddings,
      store: createPgVectorRetrievalStore(db),
    }),
    classicStore,
    // Engine v2's find step (YOY-145), behind ENGINE_V2 (NG-3); the
    // playground may still ask for either engine per request (AC-6).
    find: createFindStep({
      db,
      embeddings,
      classicStore,
      findSetSize: findSetSizeFromEnv(),
    }),
    engineV2: engineV2FromEnv(),
  });
}

let orchestratorSingleton: SearchOrchestrator | undefined;

/**
 * The production orchestrator as a module singleton (YOY-67 AC-7): the
 * classifier's decision cache and the retriever's query-embedding cache are
 * per-instance, so per-request construction threw them away on every search
 * — observed live as the same normalized query taking opposite routes 1.6s
 * apart despite temperature 0. Memoizing the first successful construction
 * makes the caches the cross-request determinism layer they were designed to
 * be. A construction failure caches nothing, so a missing GEMINI_API_KEY
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
