import { describe, expect, it } from "vitest";

import type { FakeRoute } from "../testing/fake-store.server";
import { createFakeStore } from "../testing/fake-store.server";
import { htmlToPlainText } from "./catalog-source.server";
import {
  FIXTURE_META,
  FIXTURE_ORIGIN,
  FIXTURE_PAGE_1,
  FIXTURE_PAGE_2,
} from "./fixtures/shopify-public-products";
import { createPoliteFetch } from "./polite-fetch.server";
import {
  createShopifyPublicSource,
  detectShopifyPublicStore,
  fetchShopifyPublicStoreMeta,
  mapShopifyPublicProduct,
  PRODUCTS_JSON_PAGE_SIZE,
  SHOPIFY_PUBLIC_SOURCE_KIND,
} from "./shopify-public-source.server";

// Shopify public `/products.json` adapter (YOY-88 AC-4): fixture pages
// through the fake store — no live storefront call anywhere.

const page = (n: number) => `/products.json?limit=${PRODUCTS_JSON_PAGE_SIZE}&page=${n}`;

function fixtureStore(overrides: Record<string, FakeRoute> = {}) {
  return createFakeStore({
    "/robots.txt": "",
    "/products.json?limit=1": { products: [FIXTURE_PAGE_1[0]] },
    [page(1)]: { products: FIXTURE_PAGE_1 },
    [page(2)]: { products: FIXTURE_PAGE_2 },
    [page(3)]: { products: [] },
    "/meta.json": FIXTURE_META,
    ...(overrides),
  });
}

const polite = (fetch: ReturnType<typeof createFakeStore>["fetch"]) =>
  createPoliteFetch({ contactUrl: "https://playground.example", fetch });

describe("mapping (AC-4)", () => {
  it("maps a feed product: HTML → text, price range, availability, images, url, tags", () => {
    const mapped = mapShopifyPublicProduct(FIXTURE_PAGE_1[0], {
      origin: FIXTURE_ORIGIN,
      currency: "ILS",
    });
    expect(mapped).toEqual({
      sourceId: "7001",
      title: "Black Evening Dress",
      description: "An elegant black dress. Perfect for evenings & galas. Silk",
      tags: ["dress", "evening", "black"],
      vendor: "Demo Couture",
      productType: "Dress",
      priceMin: 599,
      priceMax: 649,
      currencyCode: "ILS",
      available: true,
      imageAltTexts: ["Front view", "Silk detail"],
      imageUrl: `${FIXTURE_ORIGIN}/cdn/black-dress-front.jpg`,
      url: `${FIXTURE_ORIGIN}/products/black-evening-dress`,
      sourceUpdatedAt: new Date("2026-08-01T10:00:00Z"),
    });
  });

  it("normalizes nulls, comma-string tags, unavailable variants, and missing prices", () => {
    const tee = mapShopifyPublicProduct(FIXTURE_PAGE_1[1], {
      origin: FIXTURE_ORIGIN,
      currency: "ILS",
    });
    expect(tee).toMatchObject({
      description: "",
      vendor: "",
      productType: "",
      available: false,
      imageAltTexts: [],
      imageUrl: null,
      priceMin: 89.9,
      priceMax: 89.9,
    });
    const sneaker = mapShopifyPublicProduct(FIXTURE_PAGE_2[0], {
      origin: FIXTURE_ORIGIN,
      currency: "USD",
    });
    expect(sneaker.tags).toEqual(["sneaker", "running", "sport"]);
    expect(sneaker.currencyCode).toBe("USD");
    expect(sneaker.sourceUpdatedAt).toBeNull();
    const giftCard = mapShopifyPublicProduct(FIXTURE_PAGE_2[1], {
      origin: FIXTURE_ORIGIN,
      currency: "ILS",
    });
    expect(Number.isNaN(giftCard.priceMin)).toBe(true);
  });

  it("strips HTML to plain text", () => {
    expect(htmlToPlainText("<p>Hello<br/>world &amp; &#8217;more&#8217;</p><script>x()</script>")).toBe(
      "Hello world & ’more’",
    );
    expect(htmlToPlainText(null)).toBe("");
  });
});

describe("store meta (AC-4)", () => {
  it("reads name and currency from meta.json", async () => {
    const store = fixtureStore();
    await expect(fetchShopifyPublicStoreMeta(FIXTURE_ORIGIN, polite(store.fetch))).resolves.toEqual({
      name: "Demo Store",
      currency: "ILS",
    });
    expect(store.requests.map((r) => new URL(r.url).pathname)).not.toContain("/cart.js");
  });

  it("falls back to cart.js for the currency, and fails loudly when neither answers", async () => {
    const withCart = fixtureStore({
      "/meta.json": new Response("Not found", { status: 404 }),
      "/cart.js": { token: "x", currency: "EUR" },
    });
    await expect(fetchShopifyPublicStoreMeta(FIXTURE_ORIGIN, polite(withCart.fetch))).resolves.toEqual({
      name: null,
      currency: "EUR",
    });
    const neither = fixtureStore({
      "/meta.json": new Response("Not found", { status: 404 }),
    });
    await expect(
      fetchShopifyPublicStoreMeta(FIXTURE_ORIGIN, polite(neither.fetch)),
    ).rejects.toThrow(/no currency/);
  });
});

describe("detection (AC-6)", () => {
  it("recognizes a products.json feed and rejects HTML, other JSON, and 404", async () => {
    expect(await detectShopifyPublicStore(FIXTURE_ORIGIN, polite(fixtureStore().fetch))).toBe(true);
    // Host without scheme is accepted too.
    expect(await detectShopifyPublicStore("demo-store.example", polite(fixtureStore().fetch))).toBe(true);
    const html = createFakeStore({ "/products.json?limit=1": "<html>Not a feed</html>" });
    expect(await detectShopifyPublicStore(FIXTURE_ORIGIN, polite(html.fetch))).toBe(false);
    const other = createFakeStore({ "/products.json?limit=1": { items: [] } });
    expect(await detectShopifyPublicStore(FIXTURE_ORIGIN, polite(other.fetch))).toBe(false);
    const missing = createFakeStore({});
    expect(await detectShopifyPublicStore(FIXTURE_ORIGIN, polite(missing.fetch))).toBe(false);
  });
});

describe("paging (AC-4)", () => {
  it("pages limit=250 until the empty page and maps every product", async () => {
    const store = fixtureStore();
    const source = createShopifyPublicSource({ storeUrl: FIXTURE_ORIGIN, fetch: polite(store.fetch) });
    expect(source.kind).toBe(SHOPIFY_PUBLIC_SOURCE_KIND);
    const progress: number[] = [];
    const products = await source.fetchProducts({
      maxProducts: 2000,
      onProgress: ({ fetched }) => progress.push(fetched),
    });
    expect(products.map((p) => p.sourceId)).toEqual(["7001", "7002", "7003", "7004", "7005"]);
    expect(products.every((p) => p.currencyCode === "ILS")).toBe(true);
    expect(progress).toEqual([2, 5]);
    const paths = store.requests.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`);
    expect(paths).toEqual(["/robots.txt", "/meta.json", page(1), page(2), page(3)]);
  });

  it("--path-prefix reads the feed and composes product URLs under <origin><prefix>; meta stays at the origin (YOY-117 AC-4)", async () => {
    // The localised storefront answers under /uk; the root feed is absent so
    // a request there would be a 404 in the fake store.
    const store = createFakeStore({
      "/robots.txt": "",
      "/uk/products.json?limit=1": { products: [FIXTURE_PAGE_1[0]] },
      [`/uk${page(1)}`]: { products: FIXTURE_PAGE_1 },
      [`/uk${page(2)}`]: { products: [] },
      "/meta.json": FIXTURE_META,
    });
    const fetch = polite(store.fetch);
    expect(await detectShopifyPublicStore(FIXTURE_ORIGIN, fetch, { pathPrefix: "/uk" })).toBe(true);
    const source = createShopifyPublicSource({ storeUrl: FIXTURE_ORIGIN, fetch, pathPrefix: "/uk" });
    const products = await source.fetchProducts({ maxProducts: 2000 });
    expect(products.map((p) => p.sourceId)).toEqual(["7001", "7002"]);
    for (const product of products) {
      expect(product.url).toMatch(new RegExp(`^${FIXTURE_ORIGIN}/uk/products/`));
    }
    const paths = store.requests.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`);
    expect(paths).toEqual([
      "/robots.txt",
      "/uk/products.json?limit=1",
      "/meta.json",
      `/uk${page(1)}`,
      `/uk${page(2)}`,
    ]);
  });

  it("stops paging once maxProducts are in hand and fails loudly on a non-JSON page", async () => {
    const store = fixtureStore();
    const source = createShopifyPublicSource({
      storeUrl: FIXTURE_ORIGIN,
      fetch: polite(store.fetch),
      meta: FIXTURE_META,
    });
    const products = await source.fetchProducts({ maxProducts: 2 });
    expect(products).toHaveLength(2);
    const paths = store.requests.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`);
    expect(paths).toEqual(["/robots.txt", page(1)]);

    const broken = fixtureStore({ [page(2)]: "<html>maintenance</html>" });
    const brokenSource = createShopifyPublicSource({
      storeUrl: FIXTURE_ORIGIN,
      fetch: polite(broken.fetch),
      meta: FIXTURE_META,
    });
    await expect(brokenSource.fetchProducts({ maxProducts: 2000 })).rejects.toThrow(
      /did not answer a products array|Unexpected token|JSON/,
    );
  });
});
