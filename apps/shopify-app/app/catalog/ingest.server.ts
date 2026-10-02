import type { PrismaClient } from "@prisma/client";

import type { ImageFetch, ImageSyncCounts } from "./images.server";
import {
  addImageSyncCounts,
  emptyImageSyncCounts,
  globalImageFetch,
  syncProductImages,
} from "./images.server";
import type { ShopifyProductNode } from "./mapping.server";
import {
  mapProductNode,
  MAX_PRODUCT_IMAGES,
  snapshotImageUrls,
  snapshotVariants,
} from "./mapping.server";
import type { VariantSyncCounts } from "./variants.server";
import {
  addVariantSyncCounts,
  emptyVariantSyncCounts,
  syncProductVariants,
} from "./variants.server";

/**
 * The slice of the Admin GraphQL client the ingestion needs — matches the
 * `admin.graphql` function of `@shopify/shopify-app-react-router`, so a route
 * action can pass it straight through, and tests can pass a fixture-backed
 * stub. No live Shopify call happens in any test.
 */
export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export const PRODUCTS_PAGE_SIZE = 100;

/**
 * Explicit bound on the `available` flag (YOY-29 AC-2): availability is
 * derived from the first `VARIANTS_SAMPLE_SIZE` variants per product —
 * Shopify's maximum page size — not from nested pagination. A product whose
 * first 100 variants are all unavailable while a later variant is purchasable
 * would be misreported as unavailable. Accepted as a documented bound:
 * Shopify itself caps products at 100 variants unless the shop has opted into
 * the higher-variant-limit beta, so the sample covers the whole variant list
 * for the target catalogs.
 */
export const VARIANTS_SAMPLE_SIZE = 100;

/**
 * The products query. Variants are read whole (YOY-142 AC-2) — id, position,
 * verbatim `selectedOptions`, price, availability, updated-at — and, unless
 * `withQuantity` is false, `inventoryQuantity`: the fallback form the ingest
 * retries with when the Admin API refuses that field under the app's
 * scopes, so the run still succeeds with `quantity` null.
 */
export function productsQuery({ withQuantity }: { withQuantity: boolean }): string {
  return `#graphql
  query CatalogIngestProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        description
        tags
        vendor
        productType
        status
        publishedAt
        updatedAt
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: ${VARIANTS_SAMPLE_SIZE}) {
          nodes {
            id
            position
            selectedOptions { name value }
            price
            availableForSale
            ${withQuantity ? "inventoryQuantity" : ""}
            updatedAt
          }
        }
        images(first: ${MAX_PRODUCT_IMAGES}) {
          nodes { url altText }
        }
        featuredImage { url }
        onlineStoreUrl
      }
    }
  }
`;
}

export const PRODUCTS_QUERY = productsQuery({ withQuantity: true });
export const PRODUCTS_QUERY_WITHOUT_QUANTITY = productsQuery({ withQuantity: false });

/**
 * Whether a products-query error is the Admin API refusing
 * `inventoryQuantity` under the app's scopes (YOY-142 AC-2) — the one error
 * the ingest answers by re-asking without the field.
 */
export function isInventoryQuantityRefusal(errors: unknown): boolean {
  if (errors === undefined || errors === null) {
    return false;
  }
  return /inventoryQuantity|ACCESS_DENIED|read_inventory/i.test(JSON.stringify(errors));
}

interface ProductsPage {
  data?: {
    products?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ShopifyProductNode[];
    };
  };
  errors?: unknown;
}

/** Outcome counts of one ingestion run. */
export interface IngestResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Image capture over every snapshotted product (YOY-120 AC-2). */
  images: ImageSyncCounts;
  /** Variant capture over every snapshotted product (YOY-142 AC-8). */
  variants: VariantSyncCounts;
}

async function fetchAllProducts(graphql: AdminGraphql): Promise<ShopifyProductNode[]> {
  const nodes: ShopifyProductNode[] = [];
  let after: string | null = null;
  let query = PRODUCTS_QUERY;
  for (;;) {
    const response = await graphql(query, {
      variables: { first: PRODUCTS_PAGE_SIZE, after },
    });
    const payload = (await response.json()) as ProductsPage;
    const page = payload.data?.products;
    if (!page && query === PRODUCTS_QUERY && isInventoryQuantityRefusal(payload.errors)) {
      // The Admin API refused `inventoryQuantity` (YOY-142 AC-2): re-ask
      // this page, and every later one, without it — quantity stays null
      // and the run succeeds. A partial answer (data plus a field error)
      // needs no retry: the refused field is simply null on every node.
      query = PRODUCTS_QUERY_WITHOUT_QUANTITY;
      continue;
    }
    if (!page) {
      throw new Error(
        `Catalog ingestion: products query returned no data: ${JSON.stringify(payload.errors ?? payload)}`,
      );
    }
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) {
      return nodes;
    }
    after = page.pageInfo.endCursor;
  }
}

/**
 * Snapshot one shop's full catalog into CatalogProduct rows. Idempotent by
 * content hash: unchanged products are untouched, changed ones updated,
 * products gone from Shopify are deleted from the snapshot. Only ACTIVE
 * products are indexed (YOY-61 AC-2), and only products published to the
 * Online Store sales channel (YOY-67 AC-4 — status and publication are
 * independent axes; an ACTIVE product with `publishedAt: null` 404s on
 * click): anything else is excluded from the snapshot, so previously
 * ingested rows that no longer qualify fall into the stale set below and
 * are deleted — a shopper must never see a product whose storefront page is
 * a 404. All writes are scoped to `shopDomain`; other shops' rows are never
 * read or modified.
 */
export async function ingestCatalog({
  db,
  shopDomain,
  graphql,
  fetchImage = globalImageFetch,
}: {
  db: PrismaClient;
  shopDomain: string;
  graphql: AdminGraphql;
  /** Image-byte fetcher for `ProductImage` hashing (YOY-120); the platform fetch by default, a stub in tests. */
  fetchImage?: ImageFetch;
}): Promise<IngestResult> {
  const snapshot = (await fetchAllProducts(graphql))
    .filter(
      (node) =>
        (node.status === undefined || node.status === "ACTIVE") &&
        // Never published to the Online Store (YOY-67 AC-4): the storefront
        // page does not exist, however ACTIVE the product is. Absent means
        // a legacy fixture, treated as published.
        node.publishedAt !== null,
    )
    .map((node) => ({
      product: mapProductNode(node, { shopDomain }),
      imageUrls: snapshotImageUrls(node),
      variants: snapshotVariants(node),
    }));

  const existing = await db.catalogProduct.findMany({
    where: { shopDomain },
    select: {
      productId: true,
      contentHash: true,
      handle: true,
      featuredImageUrl: true,
      familyKey: true,
      url: true,
      publishedAt: true,
    },
  });
  const existingRows = new Map(existing.map((row) => [row.productId, row]));

  const result: IngestResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    images: emptyImageSyncCounts(),
    variants: emptyVariantSyncCounts(),
  };

  for (const { product, imageUrls, variants } of snapshot) {
    const known = existingRows.get(product.productId);
    if (known === undefined) {
      await db.catalogProduct.create({ data: { shopDomain, ...product } });
      result.created += 1;
    } else if (known.contentHash !== product.contentHash) {
      await db.catalogProduct.update({
        where: {
          shopDomain_productId: { shopDomain, productId: product.productId },
        },
        data: product,
      });
      result.updated += 1;
    } else {
      // Searchable content unchanged. The display-only fields (handle,
      // featuredImageUrl, url — YOY-87 AC-1) and the publication timestamp (YOY-67 AC-4) sit
      // outside contentHash, so refresh them here when they drifted — this
      // is also how a repeat full ingest backfills rows created before the
      // fields existed (YOY-44 AC-5), and how the migration's
      // assumed-published backfill is replaced with the real value — without
      // dirtying the hash or triggering re-enrichment.
      if (
        known.handle !== product.handle ||
        known.featuredImageUrl !== product.featuredImageUrl ||
        known.familyKey !== product.familyKey ||
        known.url !== product.url ||
        (known.publishedAt?.getTime() ?? null) !==
          (product.publishedAt?.getTime() ?? null)
      ) {
        await db.catalogProduct.update({
          where: {
            shopDomain_productId: { shopDomain, productId: product.productId },
          },
          data: {
            handle: product.handle,
            featuredImageUrl: product.featuredImageUrl,
            familyKey: product.familyKey,
            url: product.url,
            publishedAt: product.publishedAt,
          },
        });
      }
      result.unchanged += 1;
    }
    // Image capture rides outside the content hash (YOY-120 AC-2): an
    // unchanged product may still have new images, and an unchanged image
    // URL makes zero fetches, so this is cheap on every path.
    addImageSyncCounts(
      result.images,
      await syncProductImages({
        db,
        shopDomain,
        productId: product.productId,
        imageUrls,
        fetchImage,
      }),
    );
    // Variants ride outside the content hash too (YOY-142 NG-4): an
    // unchanged variant list writes nothing (AC-8).
    addVariantSyncCounts(
      result.variants,
      await syncProductVariants({
        db,
        shopDomain,
        productId: product.productId,
        variants,
      }),
    );
  }

  const seen = new Set(snapshot.map(({ product }) => product.productId));
  const stale = existing
    .map((row) => row.productId)
    .filter((productId) => !seen.has(productId));
  if (stale.length > 0) {
    // Enrichment and embedding rows are keyed by shopDomain+productId with no
    // FK cascade, so they must go in the same operation as the product
    // (YOY-29 AC-5, YOY-61 AC-2 — a leftover embedding row would keep a
    // deleted or non-active product retrievable).
    const [, , , , , , { count }] = await db.$transaction([
      db.productEnrichment.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
      db.productEmbedding.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
      db.productImage.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
      db.productVariant.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
      db.productCard.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
      db.cardEmbedding.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
      db.catalogProduct.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
    ]);
    result.deleted = count;
  }

  return result;
}
