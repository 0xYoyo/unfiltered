import type { PrismaClient } from "@prisma/client";

/**
 * Product-variant capture (YOY-142): every variant as the merchant defined
 * it — option name/value pairs verbatim in the merchant's order (AC-6),
 * per-variant price, availability, and stock quantity when the source
 * exposes it. Every ingestion path (Admin ingest, product webhooks,
 * `ingest:public` over `products.json`, the JSON-LD crawler) maps its own
 * shape to `VariantRecord`s and hands them to `syncProductVariants`, so the
 * write rule is applied once, identically. Outside the product's
 * contentHash (NG-4): a variant change never re-enriches or re-embeds.
 */

/** At most this many variants per product (NG-3): Shopify's own page cap. */
export const MAX_PRODUCT_VARIANTS = 100;

/** One option pair, verbatim: `{ name: "Size", value: "M" }`. */
export interface VariantOption {
  name: string;
  value: string;
}

/** One variant as a source hands it over, before persistence. */
export interface VariantRecord {
  /** The source's own stable variant identifier. */
  variantId: string;
  /** 1-based position among the product's variants, in source order. */
  position: number;
  /** Option pairs in the merchant's order; [] when the source names none. */
  options: VariantOption[];
  price: number;
  available: boolean;
  /** Stock on hand; null when the source does not expose it. */
  quantity: number | null;
  /** The source's updated-at for this variant; null when it carries none. */
  sourceUpdatedAt: Date | null;
}

/** Outcome counts of one variant-capture pass. */
export interface VariantSyncCounts {
  /** Rows created or rewritten because a stored field differed. */
  written: number;
  /** Rows already identical to the source: no write. */
  unchanged: number;
  /** Rows for variants the source no longer lists. */
  deleted: number;
}

export function emptyVariantSyncCounts(): VariantSyncCounts {
  return { written: 0, unchanged: 0, deleted: 0 };
}

export function addVariantSyncCounts(
  total: VariantSyncCounts,
  delta: VariantSyncCounts,
): VariantSyncCounts {
  total.written += delta.written;
  total.unchanged += delta.unchanged;
  total.deleted += delta.deleted;
  return total;
}

/** Whether a stored option list equals the source's, pair by pair, in order. */
function sameOptions(stored: unknown, options: VariantOption[]): boolean {
  if (!Array.isArray(stored) || stored.length !== options.length) {
    return false;
  }
  return options.every((option, index) => {
    const row = stored[index] as { name?: unknown; value?: unknown } | null;
    return row !== null && row.name === option.name && row.value === option.value;
  });
}

/**
 * Bring one product's `ProductVariant` rows in line with `variants` — the
 * source's whole ordered list, of which the first MAX_PRODUCT_VARIANTS are
 * kept (NG-3); a repeated `variantId` keeps its first occurrence, since the
 * row key could not hold two. Idempotent (AC-8): a variant whose stored row
 * already carries every field unchanged is not written, and a stored
 * variant the source no longer lists is deleted. A source without per-variant
 * data passes [] and leaves the product with zero rows. Every write is
 * scoped to `shopDomain` + `productId`.
 */
export async function syncProductVariants({
  db,
  shopDomain,
  productId,
  variants,
}: {
  db: PrismaClient;
  shopDomain: string;
  productId: string;
  variants: VariantRecord[];
}): Promise<VariantSyncCounts> {
  const counts = emptyVariantSyncCounts();
  const kept: VariantRecord[] = [];
  const seen = new Set<string>();
  for (const variant of variants.slice(0, MAX_PRODUCT_VARIANTS)) {
    if (seen.has(variant.variantId)) {
      continue;
    }
    seen.add(variant.variantId);
    kept.push(variant);
  }

  const existing = await db.productVariant.findMany({
    where: { shopDomain, productId },
    select: {
      variantId: true,
      position: true,
      options: true,
      price: true,
      available: true,
      quantity: true,
      sourceUpdatedAt: true,
    },
  });
  const byId = new Map(existing.map((row) => [row.variantId, row]));

  for (const variant of kept) {
    const row = byId.get(variant.variantId);
    if (
      row !== undefined &&
      row.position === variant.position &&
      sameOptions(row.options, variant.options) &&
      row.price === variant.price &&
      row.available === variant.available &&
      row.quantity === variant.quantity &&
      (row.sourceUpdatedAt?.getTime() ?? null) ===
        (variant.sourceUpdatedAt?.getTime() ?? null)
    ) {
      counts.unchanged += 1;
      continue;
    }
    const data = {
      position: variant.position,
      options: variant.options.map(({ name, value }) => ({ name, value })),
      price: variant.price,
      available: variant.available,
      quantity: variant.quantity,
      sourceUpdatedAt: variant.sourceUpdatedAt,
    };
    await db.productVariant.upsert({
      where: {
        shopDomain_productId_variantId: {
          shopDomain,
          productId,
          variantId: variant.variantId,
        },
      },
      create: { shopDomain, productId, variantId: variant.variantId, ...data },
      update: data,
    });
    counts.written += 1;
  }

  const stale = existing
    .map((row) => row.variantId)
    .filter((variantId) => !seen.has(variantId));
  if (stale.length > 0) {
    const { count } = await db.productVariant.deleteMany({
      where: { shopDomain, productId, variantId: { in: stale } },
    });
    counts.deleted += count;
  }
  return counts;
}
