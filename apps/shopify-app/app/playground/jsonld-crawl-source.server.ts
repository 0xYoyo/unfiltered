import type { CatalogSource, SourceProduct } from "./catalog-source.server";
import { extractProductsFromPage } from "./jsonld.server";
import type { PoliteFetch } from "./polite-fetch.server";
import { RobotsDisallowedError } from "./polite-fetch.server";
import { discoverSitemapUrls, prioritizeUrls } from "./sitemap.server";

/**
 * Generic public-catalog source (YOY-89): sitemap → product pages →
 * schema.org Product JSON-LD. The truly platform-free source behind the
 * catalog-source port: WooCommerce, Magento, and custom stores have no feed,
 * but publish product pages with Product JSON-LD and list them in a sitemap.
 * Pages are read through the shared polite fetch helper (which the CLI
 * configures with 4 in flight per host and ≥250 ms spacing for this
 * source), product-ish URLs first, until the page budget is spent or
 * `maxProducts` products are in hand. No JavaScript rendering, no
 * microdata/OpenGraph fallback, no crawl state between runs (NG-1..NG-3).
 */

export const JSONLD_CRAWL_SOURCE_KIND = "jsonld-crawl";
export const DEFAULT_CRAWL_PAGE_BUDGET = 3000;
export const CRAWL_CONCURRENCY = 4;
export const CRAWL_MIN_SPACING_MS = 250;
const PROGRESS_EVERY_PAGES = 100;

/** Counters of the last crawl, for the operator report (AC-5). */
export interface CrawlStats {
  sitemapsRead: number;
  urlsDiscovered: number;
  pagesFetched: number;
  productsFound: number;
  /** Product nodes skipped for a missing price or currency (AC-4). */
  skippedNoPrice: number;
  /** Responses that were not HTML, skipped without parsing (AC-2). */
  skippedNonHtml: number;
  /** URLs robots.txt disallowed, never fetched. */
  skippedRobots: number;
  /** Fetch failures (network, timeout, non-2xx) — skipped and counted. */
  fetchErrors: number;
  /**
   * Pages whose JSON-LD extraction threw — skipped and counted, never fatal
   * to the crawl (YOY-96 AC-7).
   */
  extractErrors: number;
  /** The page budget ran out with sitemap URLs still unread. */
  budgetExhausted: boolean;
}

/** Thrown when the site offers nothing to crawl (no sitemap URLs at all). */
export class CrawlSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlSetupError";
  }
}

export interface JsonLdCrawlSource extends CatalogSource {
  /** Stats of the most recent `fetchProducts` run. */
  readonly stats: CrawlStats;
}

const emptyStats = (): CrawlStats => ({
  sitemapsRead: 0,
  urlsDiscovered: 0,
  pagesFetched: 0,
  productsFound: 0,
  skippedNoPrice: 0,
  skippedNonHtml: 0,
  skippedRobots: 0,
  fetchErrors: 0,
  extractErrors: 0,
  budgetExhausted: false,
});

const isHtml = (response: Response): boolean =>
  /text\/html|application\/xhtml\+xml/i.test(response.headers.get("Content-Type") ?? "");

/**
 * The source. `pageBudget` bounds page fetches (`--pages`, default 3000);
 * `concurrency` workers pull from the prioritized URL list — the polite
 * fetch helper is what actually gates per-host concurrency and spacing, so
 * the worker count only needs to be ≥ the helper's limit to keep it busy.
 */
export function createJsonLdCrawlSource({
  storeUrl,
  fetch,
  pageBudget = DEFAULT_CRAWL_PAGE_BUDGET,
  concurrency = CRAWL_CONCURRENCY,
}: {
  storeUrl: string;
  fetch: PoliteFetch;
  pageBudget?: number;
  concurrency?: number;
}): JsonLdCrawlSource {
  const origin = originOf(storeUrl);
  const stats = emptyStats();
  const source: JsonLdCrawlSource = {
    kind: JSONLD_CRAWL_SOURCE_KIND,
    get stats() {
      return stats;
    },
    async fetchProducts({ maxProducts, onProgress }) {
      Object.assign(stats, emptyStats());
      const discovery = await discoverSitemapUrls({ origin, fetch });
      stats.sitemapsRead = discovery.sitemaps.length;
      stats.urlsDiscovered = discovery.urls.length;
      if (discovery.urls.length === 0) {
        throw new CrawlSetupError(
          `JSON-LD crawl: no sitemap URLs found for ${origin} (robots.txt Sitemap: lines and /sitemap.xml) — nothing to crawl`,
        );
      }
      const queue = prioritizeUrls(discovery.urls);
      const products: SourceProduct[] = [];
      const seenIds = new Set<string>();
      let cursor = 0;
      let started = 0;
      let lastReported = 0;

      const report = (force: boolean): void => {
        if (!force && stats.pagesFetched - lastReported < PROGRESS_EVERY_PAGES) {
          return;
        }
        lastReported = stats.pagesFetched;
        onProgress?.({
          fetched: products.length,
          stage: `pages ${stats.pagesFetched} fetched / products ${products.length} found / skipped ${
            stats.skippedNoPrice +
            stats.skippedNonHtml +
            stats.skippedRobots +
            stats.fetchErrors +
            stats.extractErrors
          }`,
        });
      };

      // The budget counts fetches actually made (attempted); robots skips
      // are refunded below because nothing was fetched.
      const done = (): boolean => products.length >= maxProducts || started >= pageBudget;

      const worker = async (): Promise<void> => {
        while (cursor < queue.length && !done()) {
          const url = queue[cursor];
          cursor += 1;
          started += 1;
          await crawlOne(url);
          report(false);
        }
      };

      const crawlOne = async (url: string): Promise<void> => {
        let response: Response;
        try {
          response = await fetch.fetch(url);
        } catch (error) {
          if (error instanceof RobotsDisallowedError) {
            // Never fetched: does not consume the page budget.
            stats.skippedRobots += 1;
            started -= 1;
          } else {
            stats.fetchErrors += 1;
          }
          return;
        }
        stats.pagesFetched += 1;
        if (!response.ok) {
          stats.fetchErrors += 1;
          return;
        }
        if (!isHtml(response)) {
          stats.skippedNonHtml += 1;
          return;
        }
        let html: string;
        try {
          html = await response.text();
        } catch {
          // A body that cannot be read is a fetch failure, not a crawl failure.
          stats.fetchErrors += 1;
          return;
        }
        let extracted: ReturnType<typeof extractProductsFromPage>;
        try {
          extracted = extractProductsFromPage(html, url);
        } catch {
          // One page's bad markup never aborts the run: count it and move on
          // (YOY-96 AC-7). The worker's Promise.all would otherwise reject
          // after possibly thousands of fetched pages.
          stats.extractErrors += 1;
          return;
        }
        stats.skippedNoPrice += extracted.skippedNoPrice;
        for (const product of extracted.products) {
          if (seenIds.has(product.sourceId)) {
            continue;
          }
          seenIds.add(product.sourceId);
          products.push(product);
          stats.productsFound += 1;
        }
      };

      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
      stats.budgetExhausted =
        started >= pageBudget && cursor < queue.length && products.length < maxProducts;
      report(true);
      return products;
    },
  };
  return source;
}

function originOf(storeUrl: string): string {
  return new URL(storeUrl.includes("://") ? storeUrl : `https://${storeUrl}`).origin;
}
