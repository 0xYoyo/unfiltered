import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import type { ImageFetch } from "./images.server";
import { hashImageBytes, syncProductImages } from "./images.server";
import { MAX_PRODUCT_IMAGES } from "./mapping.server";
import type { ProductWebhookPayload } from "./webhook-sync.server";
import {
  deleteProductFromWebhook,
  syncProductFromWebhook,
} from "./webhook-sync.server";

// Image capture (YOY-120 AC-1, AC-2) on the embedded PGlite DB with a fixture
// byte server — no network anywhere. Bytes are hashed and discarded: the
// only thing that lands is the row.

const SHOP = "test-shop.myshopify.com";
const OTHER_SHOP = "other-shop.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";

/**
 * Deterministic bytes per URL; `failing` URLs answer 404, `throwing` ones
 * reject; `sameBytes` maps a URL to the URL whose bytes it serves (a CDN
 * suffix variant of one asset).
 */
function imageServer(
  options: { failing?: string[]; throwing?: string[]; sameBytes?: Record<string, string> } = {},
) {
  const calls: string[] = [];
  const bytesFor = (url: string) =>
    new TextEncoder().encode(`bytes-of:${options.sameBytes?.[url] ?? url}`);
  const fetchImage: ImageFetch = async (url) => {
    calls.push(url);
    if (options.throwing?.includes(url)) {
      throw new Error(`network down: ${url}`);
    }
    if (options.failing?.includes(url)) {
      return new Response("gone", { status: 404 });
    }
    return new Response(bytesFor(url), { headers: { "Content-Type": "image/jpeg" } });
  };
  const hashOf = (url: string) => createHash("sha256").update(bytesFor(url)).digest("hex");
  return { fetchImage, calls, hashOf };
}

const urls = (n: number, prefix = "https://cdn.example.com/p1") =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}.jpg`);

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.productImage.deleteMany();
  await db.catalogProduct.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

const rows = (shopDomain = SHOP, productId = PRODUCT) =>
  db.productImage.findMany({ where: { shopDomain, productId }, orderBy: { position: "asc" } });

describe("syncProductImages (YOY-120 AC-1, AC-2)", () => {
  it("hashes sha256 of the bytes into one row per position, capped at four (verify step 3)", async () => {
    const server = imageServer();
    const six = urls(6);

    const counts = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: six,
      fetchImage: server.fetchImage,
    });

    expect(counts).toEqual({ fetched: 4, unchanged: 0, failed: 0 });
    expect(server.calls).toEqual(six.slice(0, MAX_PRODUCT_IMAGES));
    const stored = await rows();
    expect(stored.map((row) => row.position)).toEqual([0, 1, 2, 3]);
    expect(stored.map((row) => row.url)).toEqual(six.slice(0, 4));
    for (const row of stored) {
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.contentHash).toBe(server.hashOf(row.url));
    }
    expect(hashImageBytes(new TextEncoder().encode("x"))).toBe(
      createHash("sha256").update("x").digest("hex"),
    );
  });

  it("re-hashes only a changed URL: an unchanged URL with an existing row makes zero fetches (AC-2)", async () => {
    const server = imageServer();
    const three = urls(3);
    await syncProductImages({ db, shopDomain: SHOP, productId: PRODUCT, imageUrls: three, fetchImage: server.fetchImage });
    const before = await rows();
    server.calls.length = 0;

    const rerun = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: three,
      fetchImage: server.fetchImage,
    });
    expect(rerun).toEqual({ fetched: 0, unchanged: 3, failed: 0 });
    expect(server.calls).toEqual([]);
    expect((await rows()).map((row) => row.contentHash)).toEqual(before.map((row) => row.contentHash));

    // One URL changes at position 1: exactly one fetch, that row re-hashed.
    const changed = [three[0]!, "https://cdn.example.com/p1-1-v2.jpg", three[2]!];
    const partial = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: changed,
      fetchImage: server.fetchImage,
    });
    expect(partial).toEqual({ fetched: 1, unchanged: 2, failed: 0 });
    expect(server.calls).toEqual([changed[1]]);
    const after = await rows();
    expect(after[1]).toMatchObject({ url: changed[1], contentHash: server.hashOf(changed[1]!) });
    expect(after[0]!.contentHash).toBe(before[0]!.contentHash);
  });

  it("deletes rows for images no longer present, and every row when the product has none", async () => {
    const server = imageServer();
    await syncProductImages({ db, shopDomain: SHOP, productId: PRODUCT, imageUrls: urls(4), fetchImage: server.fetchImage });

    const shrunk = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: urls(2),
      fetchImage: server.fetchImage,
    });
    expect(shrunk).toEqual({ fetched: 0, unchanged: 2, failed: 0 });
    expect((await rows()).map((row) => row.position)).toEqual([0, 1]);

    const none = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: [],
      fetchImage: server.fetchImage,
    });
    expect(none).toEqual({ fetched: 0, unchanged: 0, failed: 0 });
    expect(await rows()).toEqual([]);
  });

  it("counts a failed fetch (404 or thrown), keeps no row for it, and never throws (AC-2)", async () => {
    const three = urls(3);
    const server = imageServer({ failing: [three[1]!], throwing: [three[2]!] });

    const counts = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: three,
      fetchImage: server.fetchImage,
    });
    expect(counts).toEqual({ fetched: 1, unchanged: 0, failed: 2 });
    expect((await rows()).map((row) => row.position)).toEqual([0]);

    // A stale row at a failing position is removed: no hash of a different
    // image survives, and the next run retries the URL.
    const healthy = imageServer();
    await syncProductImages({ db, shopDomain: SHOP, productId: PRODUCT, imageUrls: three, fetchImage: healthy.fetchImage });
    expect((await rows()).map((row) => row.position)).toEqual([0, 1, 2]);
    const replaced = [three[0]!, "https://cdn.example.com/p1-1-v2.jpg", three[2]!];
    const failing = imageServer({ failing: [replaced[1]!] });
    const retry = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: replaced,
      fetchImage: failing.fetchImage,
    });
    expect(retry).toEqual({ fetched: 0, unchanged: 2, failed: 1 });
    // A failed URL holds no slot: the kept images are positioned in order.
    expect((await rows()).map((row) => [row.position, row.url])).toEqual([[0, three[0]], [1, three[2]]]);
  });

  it("de-duplicates by content: one row per distinct image, later URLs recorded as its duplicates, the cap counting pictures (binding note, item 4)", async () => {
    // Six URLs; 1–3 serve the bytes of 0 (a CDN's FF/FD/FB/MF suffixes), 5
    // serves the bytes of 4.
    const six = urls(6);
    const server = imageServer({
      sameBytes: { [six[1]!]: six[0]!, [six[2]!]: six[0]!, [six[3]!]: six[0]!, [six[5]!]: six[4]! },
    });

    const first = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: six,
      fetchImage: server.fetchImage,
    });
    expect(first).toEqual({ fetched: 6, unchanged: 0, failed: 0 });
    const stored = await rows();
    expect(stored.map((row) => [row.position, row.url, row.duplicateUrls])).toEqual([
      [0, six[0], [six[1], six[2], six[3]]],
      [1, six[4], [six[5]]],
    ]);
    expect(stored[0]!.contentHash).toBe(server.hashOf(six[0]!));

    // Re-run over the same list: every URL is known, so zero fetches.
    server.calls.length = 0;
    const second = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: six,
      fetchImage: server.fetchImage,
    });
    expect(second).toEqual({ fetched: 0, unchanged: 2, failed: 0 });
    expect(server.calls).toEqual([]);

    // A seventh, genuinely new picture is the only fetch on the next run.
    const seventh = "https://cdn.example.com/p1-6.jpg";
    const third = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: [...six, seventh],
      fetchImage: server.fetchImage,
    });
    expect(third).toEqual({ fetched: 1, unchanged: 2, failed: 0 });
    expect(server.calls).toEqual([seventh]);
    expect((await rows()).map((row) => row.url)).toEqual([six[0], six[4], seventh]);
  });

  it("stops at four distinct images: URLs past the cap are neither fetched nor stored", async () => {
    const server = imageServer();
    const six = urls(6, "https://cdn.example.com/d");
    const counts = await syncProductImages({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      imageUrls: six,
      fetchImage: server.fetchImage,
    });
    expect(counts).toEqual({ fetched: 4, unchanged: 0, failed: 0 });
    expect(server.calls).toEqual(six.slice(0, 4));
    expect((await rows()).map((row) => row.url)).toEqual(six.slice(0, 4));
  });

  it("scopes every write to the tenant and product", async () => {
    const server = imageServer();
    await syncProductImages({ db, shopDomain: OTHER_SHOP, productId: PRODUCT, imageUrls: urls(2, "https://cdn.example.com/o"), fetchImage: server.fetchImage });
    await syncProductImages({ db, shopDomain: SHOP, productId: "gid://shopify/Product/2", imageUrls: urls(1, "https://cdn.example.com/q"), fetchImage: server.fetchImage });

    await syncProductImages({ db, shopDomain: SHOP, productId: PRODUCT, imageUrls: [], fetchImage: server.fetchImage });

    expect(await rows(OTHER_SHOP)).toHaveLength(2);
    expect(await rows(SHOP, "gid://shopify/Product/2")).toHaveLength(1);
  });
});

describe("webhook sync writes and deletes ProductImage rows (YOY-120 AC-1)", () => {
  const payload = (overrides: Partial<ProductWebhookPayload> = {}): ProductWebhookPayload => ({
    id: 1,
    title: "Linen overshirt",
    handle: "linen-overshirt",
    body_html: "<p>Relaxed linen.</p>",
    vendor: "Test Vendor",
    product_type: "Shirt",
    tags: "linen, summer",
    updated_at: "2026-08-01T10:00:00Z",
    variants: [{ price: "120.00", inventory_quantity: 3, inventory_policy: "deny", inventory_management: "shopify" }],
    images: [
      { src: "https://cdn.example.com/w-0.jpg", alt: "Front" },
      { src: "https://cdn.example.com/w-1.jpg", alt: null },
      { src: "https://cdn.example.com/w-2.jpg", alt: null },
      { src: "https://cdn.example.com/w-3.jpg", alt: null },
      { src: "https://cdn.example.com/w-4.jpg", alt: null },
    ],
    image: { src: "https://cdn.example.com/w-0.jpg" },
    ...overrides,
  });

  it("captures images[].src (capped at four) on create, re-uses them on an unchanged redelivery, and drops them on delete", async () => {
    const server = imageServer();
    expect(
      await syncProductFromWebhook({ db, shopDomain: SHOP, payload: payload(), fetchImage: server.fetchImage }),
    ).toBe("created");
    expect(await rows()).toHaveLength(4);
    expect(server.calls).toHaveLength(4);

    server.calls.length = 0;
    expect(
      await syncProductFromWebhook({ db, shopDomain: SHOP, payload: payload(), fetchImage: server.fetchImage }),
    ).toBe("unchanged");
    expect(server.calls).toEqual([]);

    // A content change re-syncs images too (a new URL at position 3).
    const changed = payload({
      title: "Linen overshirt (new)",
      updated_at: "2026-08-02T10:00:00Z",
      images: [...payload().images.slice(0, 3), { src: "https://cdn.example.com/w-3-v2.jpg", alt: null }],
    });
    expect(
      await syncProductFromWebhook({ db, shopDomain: SHOP, payload: changed, fetchImage: server.fetchImage }),
    ).toBe("updated");
    expect(server.calls).toEqual(["https://cdn.example.com/w-3-v2.jpg"]);

    expect(await deleteProductFromWebhook({ db, shopDomain: SHOP, payload: { id: 1 } })).toBe("deleted");
    expect(await rows()).toEqual([]);
  });

  it("removes image rows when a product is archived or unpublished, and captures none for a stale delivery", async () => {
    const server = imageServer();
    await syncProductFromWebhook({ db, shopDomain: SHOP, payload: payload(), fetchImage: server.fetchImage });
    server.calls.length = 0;

    expect(
      await syncProductFromWebhook({
        db,
        shopDomain: SHOP,
        payload: payload({ updated_at: "2026-07-01T10:00:00Z", images: [{ src: "https://cdn.example.com/old.jpg", alt: null }] }),
        fetchImage: server.fetchImage,
      }),
    ).toBe("skipped_stale");
    expect(server.calls).toEqual([]);
    expect(await rows()).toHaveLength(4);

    expect(
      await syncProductFromWebhook({ db, shopDomain: SHOP, payload: payload({ status: "archived" }), fetchImage: server.fetchImage }),
    ).toBe("deleted");
    expect(await rows()).toEqual([]);
  });
});
