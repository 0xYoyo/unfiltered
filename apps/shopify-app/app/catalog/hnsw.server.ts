import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Every tenant shares one `ProductEmbedding` table and one HNSW cosine index
 * (see catalog/embed.server.ts). pgvector's HNSW is a POST-filtering index:
 * it yields its `hnsw.ef_search` best candidates table-wide and only then
 * applies the `shopDomain` predicate. A small tenant sitting beside a large
 * one therefore loses hits it genuinely owns — the candidate budget is spent
 * on the large tenant's rows before the filter runs (YOY-105).
 *
 * pgvector 0.8's iterative index scans fix this: the index keeps scanning
 * until the FILTERED result set is full, so recall no longer depends on the
 * tenant-size ratio. `relaxed_order` (rather than `strict_order`) is chosen
 * for its far lower cost; it may return candidates slightly out of distance
 * order, which is why every caller re-ranks in SQL through a MATERIALIZED CTE
 * before returning rows.
 *
 * The setting is transaction-scoped on purpose: `SET LOCAL` needs no global
 * Postgres configuration, cannot leak into unrelated pooled sessions, and
 * keeps the behavior visible at the query site it applies to.
 */
export const HNSW_ITERATIVE_SCAN = "relaxed_order";

/**
 * Run `read` inside a transaction that has iterative HNSW scans enabled.
 * Use for any vector query carrying a tenant predicate.
 */
export async function withTenantVectorScan<T>(
  db: PrismaClient,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL hnsw.iterative_scan = ${HNSW_ITERATIVE_SCAN}`,
    );
    return read(tx);
  });
}
