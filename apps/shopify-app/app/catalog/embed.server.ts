import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "@unfiltered/engine";
import {
  createGeminiEmbeddingClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";

/**
 * A vector's dimension disagreed with the embedding-model configuration.
 * Raised before anything is written: silently storing or comparing vectors of
 * mixed dimensions would corrupt similarity results.
 */
export class EmbeddingDimensionError extends Error {}

/** Characters of the product description included in the composed text. */
export const DESCRIPTION_EXCERPT_CHARS = 500;

/** Texts per embedding-port call, within the Gemini batch-request limit. */
const EMBED_BATCH_SIZE = 100;

/** The snapshot fields the composed embedding text reads. */
export interface EmbeddableProduct {
  productId: string;
  title: string;
  description: string;
  tags: string[];
  contentHash: string;
}

/** Enriched attribute values folded into the composed text, when available. */
export interface EmbeddableAttributes {
  category: string | null;
  colors: string[];
  occasions: string[];
  fit: string | null;
  styleTags: string[];
  seasons: string[];
}

/**
 * Deterministic composed text for one product (AC-1): title, then enriched
 * attribute values (when the product has a successful enrichment row), then a
 * description excerpt, then tags — fixed order, empty parts dropped, so the
 * same snapshot and enrichment always embed the same text.
 */
export function composeEmbeddingText(
  product: EmbeddableProduct,
  attributes: EmbeddableAttributes | null,
): string {
  const parts = [
    product.title,
    ...(attributes
      ? [
          attributes.category ?? "",
          attributes.fit ?? "",
          ...attributes.colors,
          ...attributes.occasions,
          ...attributes.styleTags,
          ...attributes.seasons,
        ]
      : []),
    product.description.slice(0, DESCRIPTION_EXCERPT_CHARS),
    ...product.tags,
  ];
  return parts.filter((part) => part !== "").join("\n");
}

function assertDimension(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new EmbeddingDimensionError(
      `Embedding dimension must be a positive integer, got ${dimension}`,
    );
  }
}

/**
 * Ensure the ANN index for the configured dimension exists. The column is
 * dimensionless, so the index is an expression index over a dimension-typed
 * cast; the dimension is part of the index name so a configuration change
 * builds a fresh index instead of silently reusing a stale one. Any index
 * built for a different dimension is dropped first — its cast expression
 * would reject every insert of the newly configured dimension. HNSW with
 * pgvector's default parameters — index tuning is out of scope (NG-3).
 */
async function ensureEmbeddingIndex(
  db: PrismaClient,
  dimension: number,
): Promise<void> {
  const stale = await db.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'ProductEmbedding'
       AND indexname LIKE 'ProductEmbedding_cosine_%_idx'
       AND indexname <> $1`,
    `ProductEmbedding_cosine_${dimension}_idx`,
  );
  for (const row of stale) {
    await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "${row.indexname}"`);
  }
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "ProductEmbedding_cosine_${dimension}_idx"
     ON "ProductEmbedding"
     USING hnsw ((("embedding")::vector(${dimension})) vector_cosine_ops)`,
  );
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Freshness key stored per embedding row (YOY-29 AC-6): a hash of the exact
 * composed text that was embedded, so the key covers enrichment state as well
 * as snapshot content. An enrichment row landing or changing after the last
 * run changes the composed text and therefore re-embeds exactly the affected
 * products; an unchanged catalog+enrichment re-run still embeds nothing.
 */
function embeddedTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Outcome counts of one embedding run. */
export interface EmbedResult {
  embedded: number;
  cached: number;
  deleted: number;
}

/**
 * Embed one shop's catalog snapshot into pgvector, incrementally (AC-2):
 * only products whose composed-text hash (snapshot content plus enrichment
 * state — YOY-29 AC-6) differs from the stored ProductEmbedding row are
 * embedded, products that left the snapshot lose their vectors, and a re-run
 * over an unchanged catalog+enrichment performs zero embedding-port calls.
 *
 * Texts are embedded in batched calls through the engine's embedding port, so
 * a metered adapter lands one cost-ledger row per batch with the batch's
 * token counts (AC-3). Every returned vector must match the client's declared
 * dimension — a mismatch throws before anything is stored (loud failure).
 */
export async function embedCatalog({
  db,
  shopDomain,
  embeddings,
}: {
  db: PrismaClient;
  shopDomain: string;
  embeddings: EmbeddingClient;
}): Promise<EmbedResult> {
  const dimension = embeddings.dimension;
  assertDimension(dimension);
  await ensureEmbeddingIndex(db, dimension);

  const products = await db.catalogProduct.findMany({
    where: { shopDomain },
    orderBy: { productId: "asc" },
  });
  const enrichments = await db.productEnrichment.findMany({
    where: { shopDomain, status: "enriched" },
  });
  const attributesByProduct = new Map<string, EmbeddableAttributes>(
    enrichments.map((row) => [row.productId, row]),
  );
  const existing = await db.$queryRawUnsafe<
    Array<{ productId: string; contentHash: string }>
  >(
    `SELECT "productId", "contentHash" FROM "ProductEmbedding" WHERE "shopDomain" = $1`,
    shopDomain,
  );
  const existingHashes = new Map(
    existing.map((row) => [row.productId, row.contentHash]),
  );

  // Deleted products lose their vectors (AC-2).
  const liveProductIds = new Set(products.map((product) => product.productId));
  const stale = existing.filter((row) => !liveProductIds.has(row.productId));
  for (const row of stale) {
    await db.$executeRawUnsafe(
      `DELETE FROM "ProductEmbedding" WHERE "shopDomain" = $1 AND "productId" = $2`,
      shopDomain,
      row.productId,
    );
  }

  const composed = products.map((product) => {
    const text = composeEmbeddingText(
      product,
      attributesByProduct.get(product.productId) ?? null,
    );
    return { product, text, textHash: embeddedTextHash(text) };
  });
  const toEmbed = composed.filter(
    (entry) => existingHashes.get(entry.product.productId) !== entry.textHash,
  );

  for (let start = 0; start < toEmbed.length; start += EMBED_BATCH_SIZE) {
    const batch = toEmbed.slice(start, start + EMBED_BATCH_SIZE);
    const vectors = await embeddings.embed({
      texts: batch.map((entry) => entry.text),
      storeId: shopDomain,
    });
    if (vectors.length !== batch.length) {
      throw new EmbeddingDimensionError(
        `Embedding port returned ${vectors.length} vectors for ${batch.length} texts`,
      );
    }
    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== dimension) {
        throw new EmbeddingDimensionError(
          `Embedding for product ${batch[index]!.product.productId} has dimension ${vector.length}, configuration expects ${dimension}`,
        );
      }
      await db.$executeRawUnsafe(
        `INSERT INTO "ProductEmbedding"
           ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::vector(${dimension}), CURRENT_TIMESTAMP)
         ON CONFLICT ("shopDomain", "productId") DO UPDATE SET
           "contentHash" = EXCLUDED."contentHash",
           "embedding" = EXCLUDED."embedding",
           "updatedAt" = CURRENT_TIMESTAMP`,
        randomUUID(),
        shopDomain,
        batch[index]!.product.productId,
        batch[index]!.textHash,
        toVectorLiteral(vector),
      );
    }
  }

  return {
    embedded: toEmbed.length,
    cached: products.length - toEmbed.length,
    deleted: stale.length,
  };
}

/** One similarity hit: a product and its cosine distance (lower is nearer). */
export interface SimilarProduct {
  productId: string;
  distance: number;
}

/**
 * Nearest products to `vector` by cosine distance, strictly within one shop
 * (AC-4): the shopDomain predicate is part of the query itself, so no other
 * store's vectors can ever appear. Both sides of the comparison are cast
 * through the query vector's dimension — stored vectors of a different
 * dimension make the cast fail loudly instead of comparing garbage.
 */
export async function similarProducts({
  db,
  shopDomain,
  vector,
  limit = 10,
}: {
  db: PrismaClient;
  shopDomain: string;
  vector: number[];
  limit?: number;
}): Promise<SimilarProduct[]> {
  const dimension = vector.length;
  assertDimension(dimension);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
  const rows = await db.$queryRawUnsafe<
    Array<{ productId: string; distance: number }>
  >(
    `SELECT "productId",
            (("embedding")::vector(${dimension}) <=> $2::vector(${dimension}))::float8 AS distance
     FROM "ProductEmbedding"
     WHERE "shopDomain" = $1
     ORDER BY distance ASC
     LIMIT ${limit}`,
    shopDomain,
    toVectorLiteral(vector),
  );
  return rows.map((row) => ({
    productId: row.productId,
    distance: row.distance,
  }));
}

/**
 * Embedding port wired for the catalog pipeline: the configured embedding
 * model and dimension (AC-1) metered through the Prisma cost ledger.
 * Requires GEMINI_API_KEY — construct only outside the default offline test
 * run.
 */
export function createCatalogEmbeddingClient(db: PrismaClient): EmbeddingClient {
  const models = geminiModelsFromEnv();
  return createGeminiEmbeddingClient({
    modelId: models.embeddingModel,
    dimension: models.embeddingDimension,
    costRecorder: createPrismaCostRecorder(db),
  });
}
