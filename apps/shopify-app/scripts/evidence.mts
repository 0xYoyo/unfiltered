/**
 * Prisma-based evidence queries for the live-run runbooks (YOY-52 AC-8):
 * the psql-free way to read the same rows the runbook's SQL snippets show.
 * Reads DATABASE_URL from the environment (source apps/shopify-app/.env).
 *
 * Usage, from apps/shopify-app:
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/evidence.mts counts             # index size per store
 *   npx tsx scripts/evidence.mts searches [limit]   # latest SearchEvent rows
 *   npx tsx scripts/evidence.mts costs SEARCH_ID    # AiCall rows for one search
 *   npx tsx scripts/evidence.mts clicks [limit]     # latest ClickEvent rows
 */

import { PrismaClient } from "@prisma/client";

const SHOP = process.env.EVIDENCE_SHOP ?? "unfiltered-dev.myshopify.com";

const db = new PrismaClient();

async function counts(): Promise<void> {
  const [products, enriched, embedded] = await Promise.all([
    db.catalogProduct.count({ where: { shopDomain: SHOP } }),
    db.productEnrichment.count({
      where: { shopDomain: SHOP, status: "enriched" },
    }),
    db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "ProductEmbedding" WHERE "shopDomain" = $1`,
      SHOP,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
  ]);
  console.table([{ shop: SHOP, products, enriched, embedded }]);
}

async function searches(limit: number): Promise<void> {
  const rows = await db.searchEvent.findMany({
    where: { shopDomain: SHOP },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  console.table(
    rows.map((row) => ({
      searchId: row.searchId,
      query: row.query.slice(0, 40),
      route: row.route,
      degraded: row.degraded,
      resultCount: row.resultCount,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

async function costs(searchId: string): Promise<void> {
  const rows = await db.aiCall.findMany({
    where: { searchId },
    orderBy: { createdAt: "asc" },
  });
  console.table(
    rows.map((row) => ({
      operation: row.operation,
      modelId: row.modelId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd,
    })),
  );
  console.log(
    `total: $${rows.reduce((sum, row) => sum + row.costUsd, 0).toFixed(6)}`,
  );
}

async function clicks(limit: number): Promise<void> {
  const rows = await db.clickEvent.findMany({
    where: { shopDomain: SHOP },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  console.table(
    rows.map((row) => ({
      searchId: row.searchId,
      productId: row.productId,
      position: row.position,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

const [mode, argument] = process.argv.slice(2);
try {
  switch (mode) {
    case "counts":
      await counts();
      break;
    case "searches":
      await searches(Number(argument ?? 5));
      break;
    case "costs":
      if (!argument) {
        throw new Error("usage: evidence.mts costs SEARCH_ID");
      }
      await costs(argument);
      break;
    case "clicks":
      await clicks(Number(argument ?? 5));
      break;
    default:
      throw new Error(
        "usage: evidence.mts counts | searches [limit] | costs SEARCH_ID | clicks [limit]",
      );
  }
} finally {
  await db.$disconnect();
}
