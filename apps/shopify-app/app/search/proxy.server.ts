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
