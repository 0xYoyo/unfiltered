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
 *   npx tsx scripts/evidence.mts vision             # visionStatus coverage
 *   npx tsx scripts/evidence.mts attributes ID...   # enrichment of given products
 *   npx tsx scripts/evidence.mts variants ID        # one product's variants
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

/**
 * Vision-enrichment coverage for the store (YOY-124 AC-7): one row per
 * `visionStatus` value plus the percentage of the store's products that
 * reached `enriched`. `none` means no images or never run; `failed` means
 * two attempts failed and the product is retried only when its image
 * hashes change (schema.prisma, ProductEnrichment).
 */
async function vision(): Promise<void> {
  const [products, grouped] = await Promise.all([
    db.catalogProduct.count({ where: { shopDomain: SHOP } }),
    db.productEnrichment.groupBy({
      by: ["visionStatus"],
      where: { shopDomain: SHOP },
      _count: { _all: true },
    }),
  ]);
  const byStatus = new Map(
    grouped.map((row) => [row.visionStatus, row._count._all]),
  );
  // The three documented values always appear, so a zero reads as a zero
  // rather than as a missing row; any other value the column has grown to
  // hold appears after them rather than vanishing from the total.
  const statuses = [
    ...["enriched", "none", "failed"],
    ...[...byStatus.keys()].filter(
      (status) => !["enriched", "none", "failed"].includes(status),
    ),
  ];
  console.table(
    statuses.map((status) => ({
      shop: SHOP,
      visionStatus: status,
      count: byStatus.get(status) ?? 0,
    })),
  );
  const enriched = byStatus.get("enriched") ?? 0;
  const pct = products === 0 ? 0 : (enriched / products) * 100;
  console.log(
    `vision coverage: ${enriched}/${products} products enriched (${pct.toFixed(1)}%)`,
  );
}

/**
 * The enrichment a product actually carries (YOY-124 AC-7): the five
 * vision-only coverage attributes plus the primary colour and the vision
 * status, for the product ids a live-run step read off the result cards
 * (`results[].productId` in the playground contract). Products are printed
 * in the order given, so a top-5 check reads down the table.
 */
async function attributes(productIds: string[]): Promise<void> {
  const rows = await db.productEnrichment.findMany({
    where: { shopDomain: SHOP, productId: { in: productIds } },
  });
  const byId = new Map(rows.map((row) => [row.productId, row]));
  const snapshots = await db.catalogProduct.findMany({
    where: { shopDomain: SHOP, productId: { in: productIds } },
    select: { productId: true, title: true },
  });
  const titleById = new Map(
    snapshots.map((row) => [row.productId, row.title]),
  );
  console.table(
    productIds.map((productId) => {
      const row = byId.get(productId);
      return {
        productId,
        title: (titleById.get(productId) ?? "—").slice(0, 40),
        visionStatus: row?.visionStatus ?? "—",
        primaryColor: row?.primaryColor ?? "—",
        sleeveLength: row?.sleeveLength ?? "—",
        neckline: row?.neckline ?? "—",
        garmentLength: row?.garmentLength ?? "—",
        pattern: row?.pattern ?? "—",
        materialAppearance: row?.materialAppearance ?? "—",
      };
    }),
  );
  // The merged columns above are what search reads; the two source answers
  // are what a contamination check must inspect, because a footwear or
  // jewelry attribute leaking in from an accessory in the photo shows up in
  // `visionAttributes` even when the merge dropped it.
  for (const productId of productIds) {
    const row = byId.get(productId);
    if (!row) {
      console.log(`${productId}: no enrichment row`);
      continue;
    }
    console.log(`${productId} visionAttributes: ${JSON.stringify(row.visionAttributes)}`);
  }
}

/**
 * One product's variants (YOY-142 AC-9): each variant's option pairs, price,
 * availability and stock quantity, in the merchant's order — the evidence
 * that sizes and per-size stock survived ingestion. Quantity prints "—"
 * when the source does not expose it.
 */
async function variants(productId: string): Promise<void> {
  const [product, rows] = await Promise.all([
    db.catalogProduct.findUnique({
      where: { shopDomain_productId: { shopDomain: SHOP, productId } },
      select: { title: true, currencyCode: true },
    }),
    db.productVariant.findMany({
      where: { shopDomain: SHOP, productId },
      orderBy: { position: "asc" },
    }),
  ]);
  console.log(
    `${productId}: ${product?.title ?? "no snapshot row"} — ${rows.length} variant(s)`,
  );
  console.table(
    rows.map((row) => ({
      options: (row.options as Array<{ name: string; value: string }>)
        .map(({ name, value }) => `${name}: ${value}`)
        .join(" / "),
      price: `${row.price} ${product?.currencyCode ?? ""}`.trim(),
      available: row.available,
      quantity: row.quantity ?? "—",
    })),
  );
}

const [mode, argument, ...rest] = process.argv.slice(2);
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
    case "vision":
      await vision();
      break;
    case "attributes":
      if (!argument) {
        throw new Error("usage: evidence.mts attributes PRODUCT_ID [PRODUCT_ID...]");
      }
      await attributes([argument, ...rest]);
      break;
    case "variants":
      if (!argument) {
        throw new Error("usage: evidence.mts variants PRODUCT_ID");
      }
      await variants(argument);
      break;
    default:
      throw new Error(
        "usage: evidence.mts counts | searches [limit] | costs SEARCH_ID | clicks [limit] | vision | attributes PRODUCT_ID... | variants PRODUCT_ID",
      );
  }
} finally {
  await db.$disconnect();
}
