import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { MAX_PRODUCT_IMAGES } from "./mapping.server";

/**
 * Product-image capture (YOY-120 AC-1, AC-2): keep up to MAX_PRODUCT_IMAGES
 * `ProductImage` rows per product — position, URL, and the SHA-256 of the
 * image bytes — so vision enrichment can be keyed on image content. Bytes
 * are fetched, hashed, and discarded; nothing is stored or resized (NG-2).
 * Rows hold distinct images: content-hash de-duplication keeps the cap
 * honest against a CDN that serves one asset under several URLs.
 *
 * Idempotent by URL: a URL the product carried before — as a row's `url`
 * or one of its `duplicateUrls` — is never fetched again, so a re-run over
 * an unchanged catalog costs zero image requests. A new URL is fetched and
 * hashed; a position past the kept images is deleted. A fetch failure is
 * counted and never fails the product; the next run tries the URL again.
 */

/** The fetch slice image capture needs: the global `fetch`, or a polite fetcher's `.fetch`. */
export type ImageFetch = (url: string) => Promise<Response>;

/** Outcome counts of one image-capture pass. */
export interface ImageSyncCounts {
  /** URLs fetched and hashed (never seen on this product before). */
  fetched: number;
  /** Kept images whose every URL was already known: no fetch. */
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

/**
 * The image's content hash, or null when the URL did not answer with an
 * image. A non-2xx fails as it always did; so does a 2xx whose `content-type`
 * is absent or is not `image/*` (YOY-125 AC-12) — a CDN that serves a gated
 * or missing image as a 200 HTML page (a password page after a followed 302,
 * a "not found" page served as 200) would otherwise store the hash of that
 * HTML as a `ProductImage.contentHash`: stable across products, and later
 * handed to the vision model as an image (YOY-121).
 */
async function fetchImageHash(
  fetchImage: ImageFetch,
  url: string,
): Promise<string | null> {
  try {
    const response = await fetchImage(url);
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type");
    if (contentType === null || !contentType.toLowerCase().startsWith("image/")) {
      return null;
    }
    return hashImageBytes(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Bring one product's `ProductImage` rows in line with `imageUrls` — the
 * source's whole ordered, usable list (`usableImageUrls`). Rows hold
 * DISTINCT images (YOY-120 binding note, item 4): the list is walked in
 * order, each URL's bytes are hashed, and a URL whose hash equals one
 * already kept in this pass is recorded as that row's duplicate instead of
 * a row of its own; the walk stops once MAX_PRODUCT_IMAGES distinct images
 * are kept. Positions are assigned to the kept images in order.
 *
 * Zero fetches on a re-run (AC-2): every stored row's `url` and
 * `duplicateUrls` map to its hash, so a URL seen before is never fetched
 * again — only a URL the product has not carried before is. Every write is
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
  const existing = await db.productImage.findMany({
    where: { shopDomain, productId },
    select: { position: true, url: true, duplicateUrls: true, contentHash: true },
  });
  const knownHash = new Map<string, string>();
  for (const row of existing) {
    knownHash.set(row.url, row.contentHash);
    for (const duplicate of row.duplicateUrls) {
      knownHash.set(duplicate, row.contentHash);
    }
  }

  // Walk the source list: known URLs reuse their hash, unknown ones are
  // fetched; the first URL per distinct hash becomes a kept image, later
  // ones its duplicates.
  const kept: Array<{ url: string; contentHash: string; duplicateUrls: string[]; fetched: boolean }> = [];
  const keptByHash = new Map<string, (typeof kept)[number]>();
  for (const url of imageUrls) {
    if (kept.length >= MAX_PRODUCT_IMAGES) {
      break;
    }
    let contentHash = knownHash.get(url);
    let fetched = false;
    if (contentHash === undefined) {
      const hashed = await fetchImageHash(fetchImage, url);
      if (hashed === null) {
        counts.failed += 1;
        continue;
      }
      contentHash = hashed;
      fetched = true;
      counts.fetched += 1;
    }
    const duplicateOf = keptByHash.get(contentHash);
    if (duplicateOf !== undefined) {
      duplicateOf.duplicateUrls.push(url);
      duplicateOf.fetched ||= fetched;
      continue;
    }
    const image = { url, contentHash, duplicateUrls: [], fetched };
    kept.push(image);
    keptByHash.set(contentHash, image);
  }

  // Write the kept images to their positions; a position whose row already
  // holds this exact image (same URL, hash, and duplicates) is untouched.
  const byPosition = new Map(existing.map((row) => [row.position, row]));
  for (const [position, image] of kept.entries()) {
    const row = byPosition.get(position);
    const same =
      row !== undefined &&
      row.url === image.url &&
      row.contentHash === image.contentHash &&
      row.duplicateUrls.length === image.duplicateUrls.length &&
      row.duplicateUrls.every((url, index) => url === image.duplicateUrls[index]);
    if (same) {
      counts.unchanged += 1;
      continue;
    }
    if (!image.fetched) {
      // A known image moved position or gained/lost a known duplicate.
      counts.unchanged += 1;
    }
    await db.productImage.upsert({
      where: { shopDomain_productId_position: { shopDomain, productId, position } },
      create: {
        shopDomain,
        productId,
        position,
        url: image.url,
        duplicateUrls: image.duplicateUrls,
        contentHash: image.contentHash,
        fetchedAt: now,
      },
      update: {
        url: image.url,
        duplicateUrls: image.duplicateUrls,
        contentHash: image.contentHash,
        ...(image.fetched ? { fetchedAt: now } : {}),
      },
    });
  }

  // Positions past the kept images (the product lost an image, the list
  // shrank, or duplicates collapsed) are deleted.
  const stale = existing
    .map((row) => row.position)
    .filter((position) => position >= kept.length);
  if (stale.length > 0) {
    await db.productImage.deleteMany({
      where: { shopDomain, productId, position: { in: stale } },
    });
  }
  return counts;
}
