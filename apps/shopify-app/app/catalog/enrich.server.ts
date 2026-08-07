import type { PrismaClient } from "@prisma/client";
import type { JsonSchema, LlmClient } from "@unfiltered/engine";
import {
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
  normalizeCategory,
  normalizeOccasion,
} from "@unfiltered/engine";
import {
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";

/**
 * Structured attribute record the enrichment step derives per product
 * (YOY-22). Vendor-free: nothing here is Shopify- or Gemini-specific, so the
 * retrieval layer can consume it as-is.
 */
export interface ProductAttributes {
  category: string;
  colors: string[];
  occasions: string[];
  fit: string;
  styleTags: string[];
  seasons: string[];
}

/**
 * JSON Schema every enrichment completion must satisfy. Passed to the LLM
 * port as the response schema and enforced again locally by
 * `parseEnrichment` — the model's promise to follow a schema is not trusted.
 */
export const ENRICHMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    // category and occasions are pinned to the canonical taxonomy (YOY-31):
    // an out-of-set answer violates the response schema and takes the
    // existing retry/failed path instead of landing free text in the store.
    category: { type: "string", enum: [...CANONICAL_CATEGORIES] },
    colors: { type: "array", items: { type: "string" } },
    occasions: {
      type: "array",
      items: { type: "string", enum: [...CANONICAL_OCCASIONS] },
    },
    fit: { type: "string" },
    styleTags: { type: "array", items: { type: "string" } },
    seasons: { type: "array", items: { type: "string" } },
  },
  required: ["category", "colors", "occasions", "fit", "styleTags", "seasons"],
};

/** The snapshot fields enrichment reads; a subset of one CatalogProduct row. */
export interface EnrichableProduct {
  productId: string;
  title: string;
  description: string;
  tags: string[];
  productType: string;
  imageAltTexts: string[];
  contentHash: string;
}

/**
 * Prompt over exactly the issue-specified source fields: title, description,
 * tags, product type, and image alt texts. Products may be in any language
 * (e.g. Hebrew); attribute values are normalized to lowercase English so
 * downstream hard filters compare a single vocabulary.
 */
export function buildEnrichmentPrompt(product: EnrichableProduct): string {
  return [
    "Extract structured attributes for this fashion e-commerce product.",
    "The product text may be in any language; answer with lowercase English",
    "attribute values.",
    `- category must be one of: ${CANONICAL_CATEGORIES.join(", ")}. Use`,
    '  "other" when none fits.',
    `- occasions may only contain: ${CANONICAL_OCCASIONS.join(", ")}.`,
    "Use empty strings/arrays for the other attributes when the text gives",
    "no evidence for them. Answer as JSON.",
    "",
    `Title: ${product.title}`,
    `Description: ${product.description}`,
    `Tags: ${product.tags.join(", ")}`,
    `Product type: ${product.productType}`,
    `Image alt texts: ${product.imageAltTexts.join(", ")}`,
  ].join("\n");
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Validate one model completion against the attribute schema and normalize
 * category/occasions into the canonical taxonomy (YOY-31 AC-4) before
 * anything is stored: in-set-but-messy answers ("Dresses", "gala") converge
 * onto canonical tokens; unmappable values become "other" — never free text,
 * so the retrieval side's hard filters always compare one vocabulary.
 * Returns null on any shape violation — the caller owns retry/failure
 * bookkeeping.
 */
export function parseEnrichment(value: unknown): ProductAttributes | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.category !== "string" ||
    typeof record.fit !== "string" ||
    !isStringArray(record.colors) ||
    !isStringArray(record.occasions) ||
    !isStringArray(record.styleTags) ||
    !isStringArray(record.seasons)
  ) {
    return null;
  }
  return {
    category: normalizeCategory(record.category) ?? "other",
    colors: record.colors,
    occasions: [
      ...new Set(
        record.occasions.map(
          (occasion) => normalizeOccasion(occasion) ?? "other",
        ),
      ),
    ],
    fit: record.fit,
    styleTags: record.styleTags,
    seasons: record.seasons,
  };
}

/** Outcome counts of one enrichment run. */
export interface EnrichResult {
  enriched: number;
  cached: number;
  failed: number;
}

/**
 * Enrich one shop's catalog snapshot: for every CatalogProduct row whose
 * contentHash has no matching ProductEnrichment row, complete the attribute
 * record through the engine's LLM port and upsert it.
 *
 * Cached by snapshot content hash (AC-3): a product whose hash already has an
 * enrichment row — enriched or failed — is skipped, so re-running over an
 * unchanged catalog performs zero LLM calls. A failed row retries only after
 * the product's content changes.
 *
 * Invalid output (schema-violating JSON, or a per-call adapter error) is
 * retried once, then the product is marked failed without blocking the batch
 * (AC-2). Every call goes through `llm` with operation "enrichment", so a
 * metered adapter lands one cost-ledger row per call (AC-4).
 */
export async function enrichCatalog({
  db,
  shopDomain,
  llm,
}: {
  db: PrismaClient;
  shopDomain: string;
  llm: LlmClient;
}): Promise<EnrichResult> {
  const products = await db.catalogProduct.findMany({
    where: { shopDomain },
    orderBy: { productId: "asc" },
  });
  const existing = await db.productEnrichment.findMany({
    where: { shopDomain },
    select: { productId: true, contentHash: true },
  });
  const enrichedHashes = new Map(
    existing.map((row) => [row.productId, row.contentHash]),
  );

  const result: EnrichResult = { enriched: 0, cached: 0, failed: 0 };

  for (const product of products) {
    if (enrichedHashes.get(product.productId) === product.contentHash) {
      result.cached += 1;
      continue;
    }

    let attributes: ProductAttributes | null = null;
    for (let attempt = 0; attempt < 2 && attributes === null; attempt += 1) {
      try {
        attributes = parseEnrichment(
          await llm.completeStructured({
            prompt: buildEnrichmentPrompt(product),
            schema: ENRICHMENT_SCHEMA,
            operation: "enrichment",
            shopDomain,
          }),
        );
      } catch {
        // A per-call failure (unparseable response, transient API error) is
        // treated like invalid output: retry once, then mark failed.
        attributes = null;
      }
    }

    const data =
      attributes === null
        ? {
            status: "failed",
            category: null,
            colors: [],
            occasions: [],
            fit: null,
            styleTags: [],
            seasons: [],
          }
        : { status: "enriched", ...attributes };
    await db.productEnrichment.upsert({
      where: {
        shopDomain_productId: { shopDomain, productId: product.productId },
      },
      create: {
        shopDomain,
        productId: product.productId,
        contentHash: product.contentHash,
        ...data,
      },
      update: { contentHash: product.contentHash, ...data },
    });
    result[attributes === null ? "failed" : "enriched"] += 1;
  }

  return result;
}

/**
 * LLM port wired for enrichment: the configured classification/enrichment
 * model (AC-1) metered through the Prisma cost ledger. Requires
 * GEMINI_API_KEY — construct only outside the default offline test run.
 */
export function createEnrichmentLlmClient(db: PrismaClient): LlmClient {
  return createGeminiLlmClient({
    modelId: geminiModelsFromEnv().classificationModel,
    costRecorder: createPrismaCostRecorder(db),
  });
}
