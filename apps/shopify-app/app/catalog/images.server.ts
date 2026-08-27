import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { MAX_PRODUCT_IMAGES } from "./mapping.server";

/**
 * Product-image capture (YOY-120 AC-1, AC-2): keep up to MAX_PRODUCT_IMAGES
 * `ProductImage` rows per product — position, URL, and the SHA-256 of the
 * image bytes — so vision enrichment can be keyed on image content. Bytes
 * are fetched, hashed, and discarded; nothing is stored or resized (NG-2).
 *
 * Idempotent by URL: a position whose stored URL equals the source URL makes
 * no fetch at all, so a re-run over an unchanged catalog costs zero image
 * requests. A changed URL is fetched and re-hashed; a position the source
 * no longer lists is deleted. A fetch failure is counted and never fails
 * the product — the stale row at that position (if any) is removed so no
 * hash from a different image survives, and the next run tries again.
 */

/** The fetch slice image capture needs: the global `fetch`, or a polite fetcher's `.fetch`. */
export type ImageFetch = (url: string) => Promise<Response>;

/** Outcome counts of one image-capture pass. */
export interface ImageSyncCounts {
  /** Images fetched and hashed (new or changed URL). */
  fetched: number;
  /** Positions whose URL was unchanged: no fetch. */
  unchanged: number;
  /** Fetches that failed (non-2xx, thrown, timed out); no row kept. */
  failed: number;
}

export function emptyImageSyncCounts(): ImageSyncCounts {
  return { fetched: 0, unchanged: 0, failed: 0 };
}

export function addImageSyncCounts(
  total: ImageSyncCounts,
  delta: ImageSyncCounts,
): ImageSyncCounts {
  total.fetched += delta.fetched;
  total.unchanged += delta.unchanged;
  total.failed += delta.failed;
  return total;
}

/** SHA-256 of the bytes, hex — the `ProductImage.contentHash` rule. */
export function hashImageBytes(bytes: ArrayBuffer | Uint8Array): string {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

/** The default fetcher: the platform `fetch`, resolved at call time so tests can stub it. */
export const globalImageFetch: ImageFetch = (url) => fetch(url);

async function fetchImageHash(
  fetchImage: ImageFetch,
  url: string,
): Promise<string | null> {
  try {
    const response = await fetchImage(url);
    if (!response.ok) {
      return null;
    }
    return hashImageBytes(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Bring one product's `ProductImage` rows in line with `imageUrls` (source
 * order; anything past MAX_PRODUCT_IMAGES is ignored). Every write is
 * scoped to `shopDomain` + `productId`.
 */
export async function syncProductImages({
  db,
  shopDomain,
  productId,
  imageUrls,
  fetchImage = globalImageFetch,
  now = new Date(),
}: {
  db: PrismaClient;
  shopDomain: string;
  productId: string;
  imageUrls: string[];
  fetchImage?: ImageFetch;
  now?: Date;
}): Promise<ImageSyncCounts> {
  const counts = emptyImageSyncCounts();
  const wanted = imageUrls.slice(0, MAX_PRODUCT_IMAGES);
  const existing = await db.productImage.findMany({
    where: { shopDomain, productId },
    select: { position: true, url: true },
  });
  const byPosition = new Map(existing.map((row) => [row.position, row.url]));

  for (const [position, url] of wanted.entries()) {
    if (byPosition.get(position) === url) {
      counts.unchanged += 1;
      continue;
    }
    const contentHash = await fetchImageHash(fetchImage, url);
    if (contentHash === null) {
      counts.failed += 1;
      if (byPosition.has(position)) {
        await db.productImage.deleteMany({ where: { shopDomain, productId, position } });
      }
      continue;
    }
    counts.fetched += 1;
    await db.productImage.upsert({
      where: { shopDomain_productId_position: { shopDomain, productId, position } },
      create: { shopDomain, productId, position, url, contentHash, fetchedAt: now },
      update: { url, contentHash, fetchedAt: now },
    });
  }

  // Positions the source no longer lists (the product lost an image, or
  // the list shrank below a previously captured position).
  const stale = existing
    .map((row) => row.position)
    .filter((position) => position >= wanted.length);
  if (stale.length > 0) {
    await db.productImage.deleteMany({
      where: { shopDomain, productId, position: { in: stale } },
    });
  }
  return counts;
}
