import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import type { FakeRoute } from "../../../testing/fake-store.server";

/**
 * The crawl fixture store (YOY-89 AC-6): `https://shop.example`, whose
 * robots.txt names a sitemap index → two child sitemaps (one gzipped) →
 * 12 URLs, of which 9 pages carry priced Product JSON-LD (WooCommerce
 * shape, Magento `@graph`, a `ProductGroup` with variants, a page emitting
 * the same sku twice, and five simple product pages under the product-ish
 * paths `/products/`, `/p/`, `/item/`, `/shop/`), one carries a priceless
 * Product, one is a non-product page, and one is a PDF. `privateSection`
 * adds a 13th, robots-disallowed product page.
 */
export const CRAWL_ORIGIN = "https://shop.example";

const file = (name: string): string =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

export const html = (body: string): Response =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

const xml = (body: string): Response =>
  new Response(body, { headers: { "Content-Type": "application/xml" } });

/** A minimal custom-store product page: canonical + one priced Product. */
export function simpleProductHtml({
  canonicalPath,
  sku,
  name,
  price,
  available = true,
  withJsonLdUrl = true,
}: {
  canonicalPath: string;
  sku: string;
  name: string;
  price: number;
  available?: boolean;
  withJsonLdUrl?: boolean;
}): string {
  const canonical = `${CRAWL_ORIGIN}${canonicalPath}`;
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    sku,
    name,
    description: `${name} description.`,
    image: `${CRAWL_ORIGIN}/img/${sku.toLowerCase()}.jpg`,
    brand: { "@type": "Brand", name: "Simple Co" },
    offers: {
      "@type": "Offer",
      price: String(price),
      priceCurrency: "ILS",
      availability: available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };
  if (withJsonLdUrl) {
    node.url = canonical;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<link rel="canonical" href="${canonical}">
<script type="application/ld+json">${JSON.stringify(node)}</script>
</head><body><h1>${name}</h1></body></html>`;
}

/** The nine priced products the fixture store yields (skus). */
export const CRAWL_EXPECTED_SKUS = [
  "WOO-DRESS-1",
  "MAG-SHIRT",
  "GRP-SNK",
  "DUP-1",
  "SIMPLE-5",
  "SIMPLE-6",
  "SIMPLE-7",
  "SIMPLE-9",
  "SIMPLE-8",
];

export function crawlStoreRoutes({
  privateSection = false,
}: {
  /** Add `/private/vip-dress` (a real product page) to the pages sitemap; robots disallows `/private/`. */
  privateSection?: boolean;
} = {}): Record<string, FakeRoute> {
  const pagesSitemap = privateSection
    ? file("sitemap-pages.xml").replace(
        "</urlset>",
        `  <url><loc>${CRAWL_ORIGIN}/private/vip-dress</loc></url>\n</urlset>`,
      )
    : file("sitemap-pages.xml");
  return {
    "/robots.txt": [
      "User-agent: *",
      "Disallow: /private/",
      `Sitemap: ${CRAWL_ORIGIN}/sitemap-index.xml`,
      "",
    ].join("\n"),
    "/sitemap-index.xml": xml(file("sitemap-index.xml")),
    "/sitemap-products.xml": xml(file("sitemap-products.xml")),
    "/sitemap-pages.xml.gz": new Response(gzipSync(Buffer.from(pagesSitemap, "utf8")), {
      headers: { "Content-Type": "application/x-gzip" },
    }),
    "/product/woo-dress": html(file("woo-dress.html")),
    "/product/magento-shirt": html(file("magento-shirt.html")),
    "/product/group-sneaker": html(file("group-sneaker.html")),
    "/product/priceless-scarf": html(file("priceless-scarf.html")),
    "/product/dupe-page": html(file("dupe-page.html")),
    "/products/tee-5": html(
      simpleProductHtml({ canonicalPath: "/products/tee-5", sku: "SIMPLE-5", name: "Simple Tee", price: 80 }),
    ),
    "/p/cap-6": html(
      simpleProductHtml({ canonicalPath: "/p/cap-6", sku: "SIMPLE-6", name: "Simple Cap", price: 60, available: false }),
    ),
    // The sitemap URL carries a query string; the canonical does not.
    "/item/hat-7?color=red&size=m": html(
      simpleProductHtml({ canonicalPath: "/item/hat-7", sku: "SIMPLE-7", name: "Simple Hat", price: 95, withJsonLdUrl: false }),
    ),
    "/products/coat-8": html(
      simpleProductHtml({ canonicalPath: "/products/coat-8", sku: "SIMPLE-8", name: "Simple Coat", price: 450 }),
    ),
    // No JSON-LD `url` on this one either: canonical resolves the product link.
    "/shop/bag-9?utm=sitemap": html(
      simpleProductHtml({ canonicalPath: "/shop/bag-9", sku: "SIMPLE-9", name: "Simple Bag", price: 210, withJsonLdUrl: false }),
    ),
    "/about": html(file("about.html")),
    "/catalog.pdf": new Response("%PDF-1.4 fake", { headers: { "Content-Type": "application/pdf" } }),
    "/private/vip-dress": html(
      simpleProductHtml({ canonicalPath: "/private/vip-dress", sku: "VIP-1", name: "VIP Dress", price: 999 }),
    ),
  };
}
