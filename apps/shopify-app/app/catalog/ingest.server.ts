import type { PrismaClient } from "@prisma/client";

import type { ShopifyProductNode } from "./mapping.server";
import { mapProductNode } from "./mapping.server";

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

export const PRODUCTS_QUERY = `#graphql
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
          nodes { availableForSale }
        }
        images(first: 20) {
          nodes { altText }
        }
        featuredImage { url }
      }
    }
  }
`;

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
}

async function fetchAllProducts(graphql: AdminGraphql): Promise<ShopifyProductNode[]> {
  const nodes: ShopifyProductNode[] = [];
  let after: string | null = null;
  for (;;) {
    const response = await graphql(PRODUCTS_QUERY, {
      variables: { first: PRODUCTS_PAGE_SIZE, after },
    });
    const payload = (await response.json()) as ProductsPage;
    const page = payload.data?.products;
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
}: {
  db: PrismaClient;
  shopDomain: string;
  graphql: AdminGraphql;
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
    .map(mapProductNode);

  const existing = await db.catalogProduct.findMany({
    where: { shopDomain },
    select: {
      productId: true,
      contentHash: true,
      handle: true,
      featuredImageUrl: true,
      publishedAt: true,
    },
  });
  const existingRows = new Map(existing.map((row) => [row.productId, row]));

  const result: IngestResult = { created: 0, updated: 0, unchanged: 0, deleted: 0 };

  for (const product of snapshot) {
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
      // featuredImageUrl) and the publication timestamp (YOY-67 AC-4) sit
      // outside contentHash, so refresh them here when they drifted — this
      // is also how a repeat full ingest backfills rows created before the
      // fields existed (YOY-44 AC-5), and how the migration's
      // assumed-published backfill is replaced with the real value — without
      // dirtying the hash or triggering re-enrichment.
      if (
        known.handle !== product.handle ||
        known.featuredImageUrl !== product.featuredImageUrl ||
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
            publishedAt: product.publishedAt,
          },
        });
      }
      result.unchanged += 1;
    }
  }

  const seen = new Set(snapshot.map((product) => product.productId));
  const stale = existing
    .map((row) => row.productId)
    .filter((productId) => !seen.has(productId));
  if (stale.length > 0) {
    // Enrichment and embedding rows are keyed by shopDomain+productId with no
    // FK cascade, so they must go in the same operation as the product
    // (YOY-29 AC-5, YOY-61 AC-2 — a leftover embedding row would keep a
    // deleted or non-active product retrievable).
    const [, , { count }] = await db.$transaction([
      db.productEnrichment.deleteMany({
        where: { shopDomain, productId: { in: stale } },
      }),
      db.productEmbedding.deleteMany({
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
