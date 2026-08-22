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
 *
 * That transaction carries an explicit budget (YOY-96 AC-17). Before
 * YOY-105 these reads were single `$queryRawUnsafe` calls with no
 * client-side ceiling; a Prisma interactive transaction silently adds one —
 * `maxWait` 2 s to acquire a pooled connection, `timeout` 5 s of lifetime —
 * and past it Prisma rejects ("Transaction already closed" / "Unable to
 * start a transaction in the given time") where a slow scan used to return
 * late results. The values below are deliberate, not Prisma's defaults:
 *
 * - `TENANT_VECTOR_SCAN_TIMEOUT_MS` (15 s): the whole embed + retrieve +
 *   hydrate stage measures 0.9–1.6 s on the live deployment and the PRD's
 *   search target is < 2 s (YOY-64), so a healthy scan finishes in a small
 *   fraction of this. The ceiling is not the latency budget — the
 *   orchestrator degrades to classic on a retrieval error, so a too-tight
 *   ceiling would turn a slow-but-correct scan into a degraded answer. It
 *   exists to bound how long a wedged scan holds a pooled connection,
 *   roughly ten times the observed stage, well inside the 60 s intent-call
 *   abort that bounds the AI path above it.
 * - `TENANT_VECTOR_SCAN_MAX_WAIT_MS` (5 s): the pool on the free-tier
 *   deployment is small and shared with every other query of the search,
 *   so a connection wait of a few seconds under a burst is a queue, not a
 *   fault.
 */
export const HNSW_ITERATIVE_SCAN = "relaxed_order";

/** Time allowed to acquire a pooled connection for the scan transaction. */
export const TENANT_VECTOR_SCAN_MAX_WAIT_MS = 5_000;
/** Lifetime ceiling of the scan transaction. */
export const TENANT_VECTOR_SCAN_TIMEOUT_MS = 15_000;

export interface TenantVectorScanOptions {
  /** Overrides `TENANT_VECTOR_SCAN_MAX_WAIT_MS`. */
  maxWait?: number;
  /** Overrides `TENANT_VECTOR_SCAN_TIMEOUT_MS`. */
  timeout?: number;
}

/**
 * Run `read` inside a transaction that has iterative HNSW scans enabled and
 * the explicit budget above. Use for any vector query carrying a tenant
 * predicate.
 */
export async function withTenantVectorScan<T>(
  db: PrismaClient,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TenantVectorScanOptions = {},
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL hnsw.iterative_scan = ${HNSW_ITERATIVE_SCAN}`,
      );
      return read(tx);
    },
    {
      maxWait: options.maxWait ?? TENANT_VECTOR_SCAN_MAX_WAIT_MS,
      timeout: options.timeout ?? TENANT_VECTOR_SCAN_TIMEOUT_MS,
    },
  );
}
