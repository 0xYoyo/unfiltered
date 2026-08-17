import type { ShopifyPublicProduct } from "../shopify-public-source.server";

/**
 * Fixture pages of a Shopify storefront's public `/products.json` feed
 * (YOY-88): shaped exactly as the storefront answers — string prices,
 * `body_html`, tags as an array (page 1) and as the legacy comma string
 * (page 2), a product with no variants (no price → skipped), and one with an
 * empty title (skipped). Two pages plus the terminating empty page.
 */
export const FIXTURE_ORIGIN = "https://demo-store.example";

export const FIXTURE_META = { name: "Demo Store", currency: "ILS" };

export const FIXTURE_PAGE_1: ShopifyPublicProduct[] = [
  {
    id: 7001,
    title: "Black Evening Dress",
    handle: "black-evening-dress",
    body_html:
      "<p>An <strong>elegant</strong> black dress.<br>Perfect for evenings &amp; galas.</p><ul><li>Silk</li></ul>",
    vendor: "Demo Couture",
    product_type: "Dress",
    tags: ["dress", "evening", "black"],
    updated_at: "2026-08-01T10:00:00Z",
    variants: [
      { price: "599.00", available: true },
      { price: "649.00", available: false },
    ],
    images: [
      { src: `${FIXTURE_ORIGIN}/cdn/black-dress-front.jpg`, alt: "Front view" },
      { src: `${FIXTURE_ORIGIN}/cdn/black-dress-back.jpg`, alt: null },
      { src: `${FIXTURE_ORIGIN}/cdn/black-dress-detail.jpg`, alt: "Silk detail" },
    ],
  },
  {
    id: 7002,
    title: "חולצת טי לבנה",
    handle: "white-tee",
    body_html: null,
    vendor: null,
    product_type: null,
    tags: [],
    updated_at: "2026-08-02T10:00:00Z",
    variants: [{ price: "89.90", available: false }],
    images: [],
  },
];

export const FIXTURE_PAGE_2: ShopifyPublicProduct[] = [
  {
    id: 7003,
    title: "Runner Sneaker",
    handle: "runner-sneaker",
    body_html: "<div>Light &amp; fast.</div>",
    vendor: "Demo Sport",
    product_type: "Shoes",
    tags: "sneaker, running,  sport ",
    updated_at: null,
    variants: [{ price: 300, available: true }],
    images: [{ src: `${FIXTURE_ORIGIN}/cdn/runner.jpg`, alt: "Runner sneaker side" }],
  },
  {
    id: 7004,
    title: "Gift Card",
    handle: "gift-card",
    body_html: "<p>No variants, no price.</p>",
    vendor: "Demo",
    product_type: "Gift",
    tags: [],
    updated_at: "2026-08-03T10:00:00Z",
    variants: [],
    images: [],
  },
  {
    id: 7005,
    title: "",
    handle: "untitled",
    body_html: "",
    vendor: "Demo",
    product_type: "",
    tags: [],
    updated_at: "2026-08-03T10:00:00Z",
    variants: [{ price: "10.00", available: true }],
    images: [],
  },
];

/** The products the pipeline ingests from the two pages (title + price). */
export const FIXTURE_INGESTABLE_IDS = ["7001", "7002", "7003"];
