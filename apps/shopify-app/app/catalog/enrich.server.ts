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
  /**
   * The product's primary/displayed colour (YOY-110): the colour named by
   * the title's colourway designator, else the first colour the text states
   * in reading order, else null. Lowercase English. Colour exclusions apply
   * to this alone; `colors` keeps every stated colourway.
   */
  primaryColor: string | null;
  occasions: string[];
  fit: string;
  styleTags: string[];
  seasons: string[];
}

/**
 * The enrichment rule set's version (YOY-110 AC-2), stored on every row.
 * Bump it whenever the prompt, schema, or parse rule changes what a row
 * holds: rows at an older version re-enrich on the next run even when their
 * content is unchanged. Version 1 introduced `primaryColor`.
 */
export const ENRICHMENT_VERSION = 1;

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
    // The primary colour as a plain string: "" when the text states no
    // colour. A nullable member is avoided because not every structured-
    // output validator honours `nullable`; parseEnrichment maps "" to null.
    primaryColor: { type: "string" },
    occasions: {
      type: "array",
      items: { type: "string", enum: [...CANONICAL_OCCASIONS] },
    },
    fit: { type: "string" },
    styleTags: { type: "array", items: { type: "string" } },
    seasons: { type: "array", items: { type: "string" } },
  },
  required: [
    "category",
    "colors",
    "primaryColor",
    "occasions",
    "fit",
    "styleTags",
    "seasons",
  ],
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
    "attribute values — always translate non-English words into English",
    "(for example שחור → black, ורוד → pink, אפור → gray).",
    `- category must be one of: ${CANONICAL_CATEGORIES.join(", ")}. Use`,
    '  "other" when none fits.',
    `- occasions may only contain: ${CANONICAL_OCCASIONS.join(", ")}. Include`,
    "  an occasion only when the product text itself states or clearly",
    "  implies it; when the text gives no evidence, occasions must be [].",
    "- colors: only colors the product text itself states, each as a plain",
    '  lowercase English color word (e.g. "black", not "noir"). Never invent',
    "  or infer a color; when the text states no color, colors must be [].",
    "- primaryColor: the product's primary/displayed color, chosen by this",
    "  rule: (a) the color named by the title's colorway designator —",
    '  "in <Color>", "- <Color>", "/ <Color>", "(<Color>)" — else (b) the',
    "  first color the product text states in reading order (title, then",
    "  description, then tags). Write it exactly as it appears in colors.",
    '  When the text states no color, primaryColor must be "".',
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
 * The colourway designator shapes a title carries (YOY-110 AC-1 rule a):
 * `Mesh Over Dress in Pink`, `Linen Shirt - Sand`, `Court Sneaker / White`,
 * `Wool Beanie (Black)`. Each captures the designator text after the marker,
 * up to the end of the title (or the closing paren).
 */
const DESIGNATOR_PATTERNS: RegExp[] = [
  /\bin\s+([^\-/()]+?)\s*$/i,
  /\s[-–—]\s*([^\-/()]+?)\s*$/,
  /\s\/\s*([^\-/()]+?)\s*$/,
  /\(([^()]+)\)\s*$/,
];

/**
 * The colour a title's colourway designator names, when it names one of the
 * stated colours (YOY-110 AC-1 rule a). A designator that is not a stated
 * colour ("Dress in Linen") is not a colour designator and yields null, so
 * the fallback rule decides. Lowercase; case-insensitive against `colors`.
 */
export function primaryColorFromTitle(
  title: string,
  colors: string[],
): string | null {
  const stated = colors.map((color) => color.trim().toLowerCase());
  for (const pattern of DESIGNATOR_PATTERNS) {
    const match = pattern.exec(title);
    if (match === null) {
      continue;
    }
    const designator = match[1]!.trim().toLowerCase();
    if (designator === "") {
      continue;
    }
    // Exact colour first ("in Pink"), then a colour the designator contains
    // ("in Dusty Pink" → pink) so a modifier does not hide the colour.
    const exact = stated.find((color) => color === designator);
    if (exact !== undefined) {
      return exact;
    }
    const contained = stated.find(
      (color) =>
        color !== "" && new RegExp(`\\b${escapeRegExp(color)}\\b`).test(designator),
    );
    if (contained !== undefined) {
      return contained;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-validate the model's primary colour against the rule (YOY-110 AC-1):
 * the title's colourway designator wins when it names a stated colour; else
 * the model's answer stands when it is one of the stated colours; else the
 * first stated colour; else null. Never a colour the text does not state.
 */
export function resolvePrimaryColor(
  title: string,
  colors: string[],
  answered: string,
): string | null {
  const fromTitle = primaryColorFromTitle(title, colors);
  if (fromTitle !== null) {
    return fromTitle;
  }
  const stated = colors.map((color) => color.trim().toLowerCase());
  const candidate = answered.trim().toLowerCase();
  if (candidate !== "" && stated.includes(candidate)) {
    return candidate;
  }
  return stated.find((color) => color !== "") ?? null;
}

/**
 * Validate one model completion against the attribute schema and normalize
 * category/occasions into the canonical taxonomy (YOY-31 AC-4) before
 * anything is stored: in-set-but-messy answers ("Dresses", "gala") converge
 * onto canonical tokens; unmappable values become "other" — never free text,
 * so the retrieval side's hard filters always compare one vocabulary.
 * Returns null on any shape violation — the caller owns retry/failure
 * bookkeeping.
 *
 * `primaryColor` is re-validated against the product title (YOY-110 AC-1):
 * see `resolvePrimaryColor`. The title is the only source field the rule
 * reads, so callers pass `{ title }`.
 */
export function parseEnrichment(
  value: unknown,
  source: Pick<EnrichableProduct, "title">,
): ProductAttributes | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.category !== "string" ||
    typeof record.fit !== "string" ||
    typeof record.primaryColor !== "string" ||
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
    primaryColor: resolvePrimaryColor(
      source.title,
      record.colors,
      record.primaryColor,
    ),
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
 * Versioned (YOY-110 AC-2): the cache hit also requires the row's
 * `enrichmentVersion` to equal ENRICHMENT_VERSION, so a rule change re-runs
 * every row once — including rows written before versioning, which carry 0.
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
    select: { productId: true, contentHash: true, enrichmentVersion: true },
  });
  const current = new Map(
    existing
      .filter((row) => row.enrichmentVersion === ENRICHMENT_VERSION)
      .map((row) => [row.productId, row.contentHash]),
  );

  const result: EnrichResult = { enriched: 0, cached: 0, failed: 0 };

  for (const product of products) {
    if (current.get(product.productId) === product.contentHash) {
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
            storeId: shopDomain,
          }),
          product,
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
            primaryColor: null,
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
        enrichmentVersion: ENRICHMENT_VERSION,
        ...data,
      },
      update: {
        contentHash: product.contentHash,
        enrichmentVersion: ENRICHMENT_VERSION,
        ...data,
      },
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
