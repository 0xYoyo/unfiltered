import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { RetrievalConstraints } from "@unfiltered/engine";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import { createPgVectorRetrievalStore } from "./retrieval-store.server";

/**
 * Multi-tenant recall on the shared HNSW index (YOY-105 AC-2).
 *
 * Every tenant's vectors live in one `ProductEmbedding` table under one
 * cosine index, and HNSW post-filters: it yields `hnsw.ef_search` candidates
 * table-wide and only then applies the `shopDomain` predicate. A small tenant
 * beside a large one therefore loses hits it genuinely owns.
 *
 * The fixture makes that asymmetry total and deterministic: EVERY large-
 * tenant vector is nearer to the query than EVERY small-tenant vector, so a
 * non-iterative index scan spends its whole candidate budget on the large
 * tenant and returns the small tenant nothing. The store's iterative scan
 * (`hnsw.iterative_scan = relaxed_order`) keeps scanning until the FILTERED
 * set fills, so the small tenant gets its full top-k in exact distance order.
 *
 * Runs on the hermetic PGlite database — its pgvector is 0.8.1, which
 * supports iterative scans, so no real-Postgres lane is needed.
 */

const SMALL = "small-tenant.myshopify.com";
const LARGE = "large-tenant.myshopify.com";
const SMALL_ROWS = 400;
const LARGE_ROWS = 2_400;
const DIMENSION = 3;
const QUERY_VECTOR = [1, 0, 0];
const TOP_K = 10;

/**
 * Cosine distance from `[1, y, 0]` to the query `[1, 0, 0]` rises
 * monotonically with y, so a tenant's row index IS its rank. The small
 * tenant's ys start at 0.5 (distance ≈ 0.106); the large tenant's stay under
 * 0.34 (distance ≤ 0.054) — strictly nearer, every one of them. The large
 * tenant's ys start at 0.1 rather than 0 so that consecutive distances stay
 * well clear of float64 ties and its own ranking is unambiguous too.
 */
const smallVectorY = (index: number): number => 0.5 + index * 0.001;
const largeVectorY = (index: number): number => 0.1 + index * 0.0001;

function noConstraints(): RetrievalConstraints {
  return {
    category: undefined,
    priceMin: undefined,
    priceMax: undefined,
    colorsInclude: [],
    colorsExclude: [],
    attributesExclude: [],
    attributesInclude: [],
    occasion: undefined,
    availableOnly: false,
  };
}

const productId = (prefix: string, index: number): string =>
  `${prefix}-${String(index).padStart(4, "0")}`;

/** Bulk seed via raw SQL — thousands of rows through the ORM is too slow. */
async function seedTenant(
  db: PrismaClient,
  shopDomain: string,
  prefix: string,
  count: number,
  vectorY: (index: number) => number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = productId(prefix, index);
    await db.$executeRawUnsafe(
      `INSERT INTO "CatalogProduct"
         ("id", "shopDomain", "productId", "title", "description", "tags",
          "vendor", "productType", "priceMin", "priceMax", "currencyCode",
          "available", "status", "publishedAt", "imageAltTexts",
          "sourceUpdatedAt", "contentHash", "updatedAt")
       VALUES ($1, $2, $3, $3, '', '{}', 'fixture', '', 100, 100, 'ILS',
               true, 'ACTIVE', CURRENT_TIMESTAMP, '{}',
               CURRENT_TIMESTAMP, $4, CURRENT_TIMESTAMP)`,
      randomUUID(),
      shopDomain,
      id,
      `hash-${id}`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "ProductEmbedding"
         ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
      randomUUID(),
      shopDomain,
      id,
      `hash-${id}`,
      `[1,${vectorY(index)},0]`,
    );
  }
}

describe("small-tenant recall on the shared HNSW index (YOY-105 AC-2)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    await seedTenant(db, LARGE, "large", LARGE_ROWS, largeVectorY);
    await seedTenant(db, SMALL, "small", SMALL_ROWS, smallVectorY);
    // The same expression index the pipeline builds (catalog/embed.server.ts).
    await db.$executeRawUnsafe(
      `CREATE INDEX "ProductEmbedding_cosine_${DIMENSION}_idx"
       ON "ProductEmbedding"
       USING hnsw ((("embedding")::vector(${DIMENSION})) vector_cosine_ops)`,
    );
    await db.$executeRawUnsafe(`ANALYZE`);
    // Force the HNSW index scan the production planner picks at real catalog
    // scale (AC-2). Two knobs are needed, not one: `enable_seqscan = off`
    // alone leaves the planner the cheap fixture-scale plan of pre-filtering
    // through "ProductEmbedding_shopDomain_idx" and sorting exactly — correct
    // recall, but the wrong plan to test. `enable_sort = off` removes that
    // escape, so the ORDER BY must come from the vector index itself. On the
    // un-fixed query this plan reports `Rows Removed by Filter: 40` and
    // returns the small tenant zero rows.
    //
    // Session-scoped rather than SET LOCAL because the store opens its own
    // transaction; PGlite is a single in-process backend, so both settings
    // reach it.
    await db.$executeRawUnsafe(`SET enable_seqscan = off`);
    await db.$executeRawUnsafe(`SET enable_sort = off`);
  }, 120_000);

  it("returns the small tenant its full top-k in exact distance order", async () => {
    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: SMALL,
      constraints: noConstraints(),
      vector: QUERY_VECTOR,
      limit: TOP_K,
    });

    // Without iterative scans this set is truncated — the candidate budget is
    // exhausted by the large tenant before the shopDomain predicate applies.
    expect(hits).toHaveLength(TOP_K);
    expect(hits.map((hit) => hit.productId)).toEqual(
      Array.from({ length: TOP_K }, (_, index) => productId("small", index)),
    );
    const distances = hits.map((hit) => hit.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("never leaks the nearer large-tenant rows into the small tenant", async () => {
    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: SMALL,
      constraints: noConstraints(),
      vector: QUERY_VECTOR,
      limit: TOP_K,
    });

    // Length asserted here too, so this stays a real check rather than a
    // vacuous one on the truncated (empty) un-fixed result.
    expect(hits).toHaveLength(TOP_K);
    expect(hits.every((hit) => hit.productId.startsWith("small-"))).toBe(true);
  });

  it("still serves the large tenant its own nearest rows", async () => {
    const hits = await createPgVectorRetrievalStore(db).query({
      storeId: LARGE,
      constraints: noConstraints(),
      vector: QUERY_VECTOR,
      limit: TOP_K,
    });

    expect(hits.map((hit) => hit.productId)).toEqual(
      Array.from({ length: TOP_K }, (_, index) => productId("large", index)),
    );
  });
});
