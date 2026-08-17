import { describe, expect, it } from "vitest";

import { createJsonLdCrawlSource } from "./jsonld-crawl-source.server";
import { createPoliteFetch } from "./polite-fetch.server";

// Live crawl smoke test (YOY-89 AC-6): a tiny real crawl against a public
// store. Never run by default and never in CI: requires LIVE_CRAWL_TESTS=1
// and LIVE_CRAWL_URL, e.g.
//   LIVE_CRAWL_TESTS=1 LIVE_CRAWL_URL=https://store.example npm test
const live = process.env.LIVE_CRAWL_TESTS === "1" && (process.env.LIVE_CRAWL_URL ?? "") !== "";

describe.runIf(live)("live JSON-LD crawl smoke", () => {
  it("discovers a sitemap and extracts at least one priced product within a small page budget", async () => {
    const source = createJsonLdCrawlSource({
      storeUrl: process.env.LIVE_CRAWL_URL as string,
      fetch: createPoliteFetch({
        contactUrl: "https://github.com/0xYoyo/unfiltered",
        maxInFlightPerHost: 4,
        minSpacingMs: 250,
      }),
      pageBudget: 25,
    });
    const products = await source.fetchProducts({ maxProducts: 5 });
    expect(source.stats.urlsDiscovered).toBeGreaterThan(0);
    expect(products.length).toBeGreaterThan(0);
    for (const product of products) {
      expect(product.title).not.toBe("");
      expect(Number.isFinite(product.priceMin)).toBe(true);
      expect(product.currencyCode).not.toBe("");
    }
  }, 120_000);
});
