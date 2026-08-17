import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient, LlmClient } from "@unfiltered/engine";

import type { EmbedResult } from "../catalog/embed.server";
import { embedCatalog } from "../catalog/embed.server";
import type { EnrichResult } from "../catalog/enrich.server";
import { enrichCatalog } from "../catalog/enrich.server";
import type { SnapshotProduct } from "../catalog/mapping.server";
import { computeContentHash } from "../catalog/mapping.server";
import type {
  CatalogSource,
  SourceProduct,
  SourceProgress,
} from "./catalog-source.server";

/**
 * Generic public-catalog ingestion (YOY-88 AC-3): `SourceProduct`s from any
 * `CatalogSource` become `CatalogProduct` rows under the playground tenant
 * key `playground:<slug>`, then the existing enrichment and embedding steps
 * run for that key exactly as they do for a Shopify shop, and the registry
 * row is upserted. Idempotent by content hash like the Shopify ingest:
 * unchanged rows are untouched, changed rows updated, rows gone from the
 * source deleted together with their enrichment and embedding rows in one
 * transaction — a second run over an unchanged source makes zero LLM and
 * embedding calls. Nothing here names a commerce platform.
 */

export const PLAYGROUND_STORE_KEY_PREFIX = "playground:";
export const DEFAULT_MAX_PRODUCTS = 2000;
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Whether `slug` is a valid playground catalog slug (`[a-z0-9-]{1,40}`). */
export function isValidCatalogSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** The tenant key value every row of a playground catalog carries. */
export function playgroundStoreKey(slug: string): string {
  if (!isValidCatalogSlug(slug)) {
    throw new Error(
      `invalid playground catalog slug "${slug}": expected [a-z0-9-]{1,40}`,
    );
  }
  return `${PLAYGROUND_STORE_KEY_PREFIX}${slug}`;
}

/** Outcome counts of the snapshot step of one public ingest. */
export interface PublicIngestCounts {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Source products beyond `maxProducts`, not ingested (AC-7). */
  skippedOverMax: number;
  /**
   * Source products with no title or no price — or a repeated `sourceId`,
   * which the unique row key could not hold — not ingested (AC-7).
   */
  skippedInvalid: number;
}

export interface PublicIngestResult {
  storeKey: string;
  ingest: PublicIngestCounts;
  enrich: EnrichResult;
  embed: EmbedResult;
}

/**
 * Whether a source product can become a snapshot row: a title and a finite
 * price are the minimum a result card and a price filter need.
 */
export function isIngestableSourceProduct(product: SourceProduct): boolean {
  return (
    product.title.trim() !== "" &&
    Number.isFinite(product.priceMin) &&
    Number.isFinite(product.priceMax)
  );
}

/**
 * Pure source → snapshot mapping: `productId = sourceId`, `handle = ""` (no
 * storefront handle exists outside a platform adapter; the card link is the
 * source-resolved `url`), `publishedAt = now` (a public catalog is public by
 * construction), `contentHash` over the searchable fields exactly as the
 * Shopify mapping computes it, so enrichment and embedding caching behave
 * identically.
 */
export function mapSourceProduct(
  product: SourceProduct,
  now: Date = new Date(),
): SnapshotProduct {
  const withoutHash = {
    productId: product.sourceId,
    title: product.title,
    description: product.description,
    tags: product.tags,
    vendor: product.vendor,
    productType: product.productType,
    priceMin: product.priceMin,
    priceMax: product.priceMax,
    currencyCode: product.currencyCode,
    available: product.available,
    imageAltTexts: product.imageAltTexts,
  };
  return {
    ...withoutHash,
    handle: "",
    featuredImageUrl: product.imageUrl,
    url: product.url,
    publishedAt: now,
    sourceUpdatedAt: product.sourceUpdatedAt ?? now,
    contentHash: computeContentHash(withoutHash),
  };
}

/**
 * Snapshot step only: upsert the mapped rows under `storeKey`, delete the
 * stale ones with their enrichment/embedding rows. Shared by the full
 * pipeline below; exported so tests can drive it without AI clients.
 */
export async function snapshotPublicCatalog({
  db,
  storeKey,
  products,
  maxProducts,
  now = new Date(),
}: {
  db: PrismaClient;
  storeKey: string;
  products: SourceProduct[];
  maxProducts: number;
  now?: Date;
}): Promise<PublicIngestCounts> {
  const result: PublicIngestCounts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    skippedOverMax: Math.max(0, products.length - maxProducts),
    skippedInvalid: 0,
  };
  const bounded = products.slice(0, maxProducts);
  const snapshot: SnapshotProduct[] = [];
  const seenIds = new Set<string>();
  for (const product of bounded) {
    if (!isIngestableSourceProduct(product) || seenIds.has(product.sourceId)) {
      result.skippedInvalid += 1;
      continue;
    }
    seenIds.add(product.sourceId);
    snapshot.push(mapSourceProduct(product, now));
  }

  const existing = await db.catalogProduct.findMany({
    where: { shopDomain: storeKey },
    select: {
      productId: true,
      contentHash: true,
      featuredImageUrl: true,
      url: true,
    },
  });
  const existingRows = new Map(existing.map((row) => [row.productId, row]));

  for (const product of snapshot) {
    const known = existingRows.get(product.productId);
    if (known === undefined) {
      await db.catalogProduct.create({
        data: { shopDomain: storeKey, ...product },
      });
      result.created += 1;
    } else if (known.contentHash !== product.contentHash) {
      await db.catalogProduct.update({
        where: {
          shopDomain_productId: {
            shopDomain: storeKey,
            productId: product.productId,
          },
        },
        data: product,
      });
      result.updated += 1;
    } else {
      // Searchable content unchanged: refresh only the display-only fields
      // when they drifted, without dirtying the hash (same rule as the
      // Shopify ingest — YOY-44 AC-4 / YOY-87 AC-1).
      if (
        known.featuredImageUrl !== product.featuredImageUrl ||
        known.url !== product.url
      ) {
        await db.catalogProduct.update({
          where: {
            shopDomain_productId: {
              shopDomain: storeKey,
              productId: product.productId,
            },
          },
          data: { featuredImageUrl: product.featuredImageUrl, url: product.url },
        });
      }
      result.unchanged += 1;
    }
  }

  const stale = existing
    .map((row) => row.productId)
    .filter((productId) => !seenIds.has(productId));
  if (stale.length > 0) {
    // Enrichment and embedding rows are keyed by tenant+productId with no FK
    // cascade: they go in the same transaction as the product, exactly like
    // the Shopify ingest, so no orphan vector keeps a gone product retrievable.
    const [, , { count }] = await db.$transaction([
      db.productEnrichment.deleteMany({
        where: { shopDomain: storeKey, productId: { in: stale } },
      }),
      db.productEmbedding.deleteMany({
        where: { shopDomain: storeKey, productId: { in: stale } },
      }),
      db.catalogProduct.deleteMany({
        where: { shopDomain: storeKey, productId: { in: stale } },
      }),
    ]);
    result.deleted = count;
  }
  return result;
}

/**
 * The full pipeline: read the source, snapshot, enrich, embed, register.
 * `llm` and `embeddings` are the engine ports the existing steps already
 * take — the CLI passes the metered Gemini clients, tests pass fixtures, so
 * no AI call ever happens in the default test run.
 */
export async function ingestPublicCatalog({
  db,
  slug,
  name,
  source,
  sourceUrl,
  maxProducts = DEFAULT_MAX_PRODUCTS,
  llm,
  embeddings,
  onProgress,
  now = new Date(),
}: {
  db: PrismaClient;
  slug: string;
  name: string;
  source: CatalogSource;
  sourceUrl: string;
  maxProducts?: number;
  llm: LlmClient;
  embeddings: EmbeddingClient;
  onProgress?: SourceProgress;
  now?: Date;
}): Promise<PublicIngestResult> {
  const storeKey = playgroundStoreKey(slug);
  const products = await source.fetchProducts({ maxProducts, onProgress });
  const ingest = await snapshotPublicCatalog({
    db,
    storeKey,
    products,
    maxProducts,
    now,
  });
  const enrich = await enrichCatalog({ db, shopDomain: storeKey, llm });
  const embed = await embedCatalog({ db, shopDomain: storeKey, embeddings });
  const productCount = await db.catalogProduct.count({
    where: { shopDomain: storeKey },
  });
  await db.playgroundCatalog.upsert({
    where: { slug },
    create: {
      slug,
      name,
      storeKey,
      sourceUrl,
      sourceKind: source.kind,
      productCount,
      lastIngestedAt: now,
    },
    update: {
      name,
      sourceUrl,
      sourceKind: source.kind,
      productCount,
      lastIngestedAt: now,
    },
  });
  return { storeKey, ingest, enrich, embed };
}

/** Rows removed by `deletePublicCatalog`, per table. */
export interface PublicCatalogDeletion {
  storeKey: string;
  products: number;
  enrichments: number;
  embeddings: number;
  registry: number;
}

/**
 * Remove one playground catalog entirely — its products, enrichment,
 * embeddings, and registry row — and nothing else: every delete is scoped
 * to the catalog's own tenant key, in one transaction (AC-6 `--delete`).
 */
export async function deletePublicCatalog({
  db,
  slug,
}: {
  db: PrismaClient;
  slug: string;
}): Promise<PublicCatalogDeletion> {
  const storeKey = playgroundStoreKey(slug);
  const [enrichments, embeddings, products, registry] = await db.$transaction([
    db.productEnrichment.deleteMany({ where: { shopDomain: storeKey } }),
    db.productEmbedding.deleteMany({ where: { shopDomain: storeKey } }),
    db.catalogProduct.deleteMany({ where: { shopDomain: storeKey } }),
    db.playgroundCatalog.deleteMany({ where: { slug } }),
  ]);
  return {
    storeKey,
    products: products.count,
    enrichments: enrichments.count,
    embeddings: embeddings.count,
    registry: registry.count,
  };
}
