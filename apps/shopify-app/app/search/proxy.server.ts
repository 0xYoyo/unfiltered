import type { PrismaClient } from "@prisma/client";
import {
  createIntentExtractor,
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

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
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
}

const CHIP_FIELDS: ReadonlySet<string> = new Set([
  "category",
  "priceMin",
  "priceMax",
  "colorsInclude",
  "colorsExclude",
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
  handle: string;
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
}

function serializeCard(card: {
  productId: string;
  title: string;
  handle: string;
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
    handle: card.handle,
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
): SearchOrchestrator {
  const models = geminiModelsFromEnv();
  const costRecorder = createPrismaCostRecorder(db);
  return createSearchOrchestrator({
    db,
    classifier: createQueryClassifier({
      llm: createGeminiLlmClient({
        modelId: models.classificationModel,
        costRecorder,
      }),
    }),
    extractor: createIntentExtractor({
      llm: createGeminiLlmClient({
        modelId: models.intentModel,
        costRecorder,
      }),
    }),
    retriever: createRetriever({
      embeddings: createGeminiEmbeddingClient({
        modelId: models.embeddingModel,
        dimension: models.embeddingDimension,
        costRecorder,
      }),
      store: createPgVectorRetrievalStore(db),
    }),
    classicStore: createPgTrgmClassicStore(db),
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
