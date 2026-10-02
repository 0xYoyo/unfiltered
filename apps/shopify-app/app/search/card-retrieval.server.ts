import type { PrismaClient } from "@prisma/client";

import { withTenantVectorScan } from "../catalog/hnsw.server";
import { FAMILY_OVERSCAN } from "./retrieval-store.server";

/**
 * Card vectors per product the candidate scan absorbs before a product may
 * be under-counted (YOY-144 AC-3, AC-5): a product holds a prose vector and
 * one per ask language — three with the default en + he — and several of
 * them can sit near one query. The card scan therefore reads `limit *
 * FAMILY_OVERSCAN * CARD_SECTION_OVERSCAN` rows, so collapsing first by
 * product and then by family still leaves `limit` families, while the bound
 * keeps the scan index-driven (the YOY-125 AC-10 rule).
 */
export const CARD_SECTION_OVERSCAN = 3;

/** One hit of the card index: a product and its best distance (lower is nearer). */
export interface CardIndexHit {
  productId: string;
  distance: number;
}

/**
 * Nearest products to one query vector over the card index (YOY-144 AC-3 to
 * AC-7). Not wired into search yet (NG-1): the find step of a later issue
 * calls it.
 *
 * - Best section per product (AC-3): a product's distance is that of its
 *   nearest card vector — prose or any language's asks.
 * - Raw-text fallback in the same query (AC-4): a product with no card
 *   vector is read from its `ProductEmbedding` row, compared by the same
 *   cosine distance, so the two kinds rank on one scale.
 * - Product first, then family (AC-5): the candidates collapse to one row
 *   per product, then to one per family (`familyKey`, as in the retrieval
 *   store); the family's representative is its nearest member.
 * - The only product filters are the store, `status = 'ACTIVE'` and
 *   `publishedAt IS NOT NULL` (AC-7): price, stock, category and the rest
 *   are later steps' business. Which vector table speaks for a product —
 *   its card vectors when it has any, else its raw-text row — is not a
 *   filter on the product.
 *
 * Both scans run under iterative HNSW scans (`withTenantVectorScan`), each
 * bounded and inside a MATERIALIZED CTE re-ranked outside it, so a small
 * tenant beside a large one still gets its exact nearest products (AC-6).
 * Vector comparisons cast both sides through the query vector's dimension,
 * so stored vectors of another dimension fail loudly.
 */
export async function queryCardIndex({
  db,
  shopDomain,
  vector,
  limit = 10,
}: {
  db: PrismaClient;
  shopDomain: string;
  vector: number[];
  limit?: number;
}): Promise<CardIndexHit[]> {
  const dimension = vector.length;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new RangeError(`query vector dimension must be a positive integer, got ${dimension}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
  const productScan = limit * FAMILY_OVERSCAN;
  const cardScan = productScan * CARD_SECTION_OVERSCAN;
  const distance = (alias: string): string =>
    `((${alias}."embedding")::vector(${dimension}) <=> $2::vector(${dimension}))::float8`;
  const productFilters = `p."status" = 'ACTIVE'
           AND p."publishedAt" IS NOT NULL`;

  const rows = await withTenantVectorScan(db, (tx) =>
    tx.$queryRawUnsafe<Array<{ productId: string; distance: number }>>(
      `WITH card_scan AS MATERIALIZED (
         SELECT ce."productId", ${distance("ce")} AS distance
         FROM "CardEmbedding" ce
         JOIN "CatalogProduct" p
           ON p."shopDomain" = ce."shopDomain" AND p."productId" = ce."productId"
         WHERE ce."shopDomain" = $1
           AND ${productFilters}
         ORDER BY distance ASC
         LIMIT ${cardScan}
       ),
       raw_scan AS MATERIALIZED (
         SELECT e."productId", ${distance("e")} AS distance
         FROM "ProductEmbedding" e
         JOIN "CatalogProduct" p
           ON p."shopDomain" = e."shopDomain" AND p."productId" = e."productId"
         WHERE e."shopDomain" = $1
           AND ${productFilters}
           AND NOT EXISTS (SELECT 1 FROM "CardEmbedding" c
             WHERE c."shopDomain" = e."shopDomain" AND c."productId" = e."productId")
         ORDER BY distance ASC
         LIMIT ${productScan}
       ),
       products AS (
         SELECT DISTINCT ON ("productId") "productId", distance
         FROM (SELECT * FROM card_scan UNION ALL SELECT * FROM raw_scan) hits
         ORDER BY "productId", distance ASC
       ),
       families AS (
         SELECT DISTINCT ON ("family") *
         FROM (SELECT pr."productId", pr.distance,
                      COALESCE(NULLIF(p."familyKey", ''), p."productId") AS "family"
               FROM products pr
               JOIN "CatalogProduct" p
                 ON p."shopDomain" = $1 AND p."productId" = pr."productId") members
         ORDER BY "family", distance ASC, "productId" ASC
       )
       SELECT "productId", distance FROM families
       ORDER BY distance ASC, "productId" ASC
       LIMIT ${limit}`,
      shopDomain,
      `[${vector.join(",")}]`,
    ),
  );
  return rows.map((row) => ({ productId: row.productId, distance: row.distance }));
}
