import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient, LlmClient } from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeRoute } from "../testing/fake-store.server";
import { createFakeStore } from "../testing/fake-store.server";
import { createTestDb } from "../testing/helpers.server";
import {
  CRAWL_EXPECTED_SKUS,
  CRAWL_ORIGIN,
  crawlStoreRoutes,
  html,
  simpleProductHtml,
} from "./fixtures/crawl/crawl-store";
import { ingestPublicCatalog } from "./ingest-public.server";
import { runIngestPublicCli } from "./ingest-public-cli.server";
import {
  createJsonLdCrawlSource,
  JSONLD_CRAWL_SOURCE_KIND,
} from "./jsonld-crawl-source.server";
import {
  extractCanonicalUrl,
  extractJsonLdBlocks,
  extractProductsFromPage,
  findProductNodes,
  readOffers,
} from "./jsonld.server";
import { createPoliteFetch } from "./polite-fetch.server";
import {
  discoverSitemapUrls,
  isProductishUrl,
  parseSitemap,
  prioritizeUrls,
  readSitemapBody,
  sitemapsFromRobots,
} from "./sitemap.server";

// The extractor is a pass-through spy so one test can make a single page's
// extraction throw (YOY-96 AC-7); every other call runs the real function.
vi.mock("./jsonld.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jsonld.server")>();
  return { ...actual, extractProductsFromPage: vi.fn(actual.extractProductsFromPage) };
});

// Sitemap → JSON-LD crawler (YOY-89): every test runs against the in-memory
// crawl fixture store — robots with a Sitemap: line, an index, two child
// sitemaps (one gzipped), WooCommerce / Magento / ProductGroup / priceless /
// duplicate / no-product / PDF pages. No network anywhere; the live smoke
// test lives in jsonld-crawl-live.test.ts behind LIVE_CRAWL_TESTS=1.

const polite = (routes: Record<string, FakeRoute>, options: { maxInFlightPerHost?: number } = {}) => {
  const store = createFakeStore(routes);
  const fetch = createPoliteFetch({
    contactUrl: "https://playground.example",
    fetch: store.fetch,
    maxInFlightPerHost: options.maxInFlightPerHost ?? 4,
    minSpacingMs: 0,
  });
  return { store, fetch };
};

const paths = (store: ReturnType<typeof createFakeStore>) =>
  store.requests.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`);

describe("sitemap discovery and expansion (AC-1)", () => {
  it("reads Sitemap: lines from robots.txt and parses indexes and urlsets, CDATA and entities included", () => {
    expect(sitemapsFromRobots("User-agent: *\nDisallow: /x\nSitemap: https://a.example/s1.xml\nsitemap: https://a.example/s2.xml.gz # comment"))
      .toEqual(["https://a.example/s1.xml", "https://a.example/s2.xml.gz"]);
    const index = parseSitemap(`<sitemapindex><sitemap><loc>https://a.example/p.xml</loc></sitemap></sitemapindex>`);
    expect(index).toEqual({ sitemaps: ["https://a.example/p.xml"], urls: [] });
    const urlset = parseSitemap(
      `<urlset><url><loc><![CDATA[https://a.example/p/1]]></loc></url><url><loc>https://a.example/p/2?a=1&amp;b=2</loc><lastmod>x</lastmod></url><url></url></urlset>`,
    );
    expect(urlset).toEqual({ sitemaps: [], urls: ["https://a.example/p/1", "https://a.example/p/2?a=1&b=2"] });
  });

  it("discovers robots → index → two child sitemaps (one gzipped) → 12 URLs (verify step 2)", async () => {
    const { store, fetch } = polite(crawlStoreRoutes());
    const discovery = await discoverSitemapUrls({ origin: CRAWL_ORIGIN, fetch });
    expect(discovery.sitemaps).toEqual([
      `${CRAWL_ORIGIN}/sitemap-index.xml`,
      `${CRAWL_ORIGIN}/sitemap-products.xml`,
      `${CRAWL_ORIGIN}/sitemap-pages.xml.gz`,
    ]);
    expect(discovery.urls).toHaveLength(12);
    expect(discovery.urls).toContain(`${CRAWL_ORIGIN}/about`);
    expect(discovery.urls).toContain(`${CRAWL_ORIGIN}/item/hat-7?color=red&size=m`);
    // robots.txt is read by the polite helper (its rules) and by discovery
    // (Sitemap: lines) — twice, then never again for this host.
    expect(paths(store).filter((p) => p === "/robots.txt")).toHaveLength(2);
  });

  it("falls back to /sitemap.xml without robots Sitemap: lines, and inflates gzip by magic bytes", async () => {
    const { store, fetch } = polite({
      "/robots.txt": "User-agent: *\nDisallow:\n",
      "/sitemap.xml": new Response(`<urlset><url><loc>https://a.example/p/1</loc></url></urlset>`, {
        headers: { "Content-Type": "text/xml" },
      }),
    });
    const discovery = await discoverSitemapUrls({ origin: "https://a.example", fetch });
    expect(discovery.urls).toEqual(["https://a.example/p/1"]);
    expect(paths(store)).toEqual(["/robots.txt", "/robots.txt", "/sitemap.xml"]);

    const { gzipSync } = await import("node:zlib");
    const gz = new Response(gzipSync(Buffer.from("<urlset><url><loc>https://a.example/z</loc></url></urlset>")), {
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(parseSitemap(await readSitemapBody(gz, "https://a.example/plain-name"))).toEqual({
      sitemaps: [],
      urls: ["https://a.example/z"],
    });
  });
});

describe("URL prioritization (AC-2)", () => {
  it("fetches product-ish paths first, stable within each group", () => {
    expect(isProductishUrl("https://a.example/products/x")).toBe(true);
    expect(isProductishUrl("https://a.example/P/x")).toBe(true);
    expect(isProductishUrl("https://a.example/blog/x")).toBe(false);
    expect(prioritizeUrls(["https://a.example/about", "https://a.example/shop/1", "https://a.example/blog", "https://a.example/item/2"]))
      .toEqual(["https://a.example/shop/1", "https://a.example/item/2", "https://a.example/about", "https://a.example/blog"]);
  });
});

describe("JSON-LD extraction (AC-3, AC-4)", () => {
  const woo = crawlStoreRoutes()["/product/woo-dress"] as Response;

  it("WooCommerce shape: one Product with an Offer, brand node, image array, HTML description stripped", async () => {
    const page = extractProductsFromPage(await woo.clone().text(), `${CRAWL_ORIGIN}/product/woo-dress`);
    expect(page.skippedNoPrice).toBe(0);
    expect(page.products).toEqual([
      {
        sourceId: "WOO-DRESS-1",
        title: "Woo Evening Dress",
        description: "A black evening dress in silk. Fully lined.",
        tags: ["dress", "evening", "black"],
        vendor: "Woo Fashion",
        productType: "Dresses",
        priceMin: 599,
        priceMax: 599,
        currencyCode: "ILS",
        available: true,
        imageAltTexts: [],
        imageUrl: `${CRAWL_ORIGIN}/img/woo-dress-1.jpg`,
        imageUrls: [`${CRAWL_ORIGIN}/img/woo-dress-1.jpg`, `${CRAWL_ORIGIN}/img/woo-dress-2.jpg`],
        url: `${CRAWL_ORIGIN}/product/woo-dress`,
        sourceUpdatedAt: null,
      },
    ]);
  });

  it("Magento shape: @graph, @type array, AggregateOffer low/high, ImageObject, Thing category, OutOfStock", async () => {
    const magento = crawlStoreRoutes()["/product/magento-shirt"] as Response;
    const page = extractProductsFromPage(await magento.text(), `${CRAWL_ORIGIN}/product/magento-shirt`);
    expect(page.products).toHaveLength(1);
    expect(page.products[0]).toMatchObject({
      sourceId: "MAG-SHIRT",
      title: "Magento Linen Shirt",
      vendor: "Magento House",
      productType: "Shirts",
      priceMin: 180,
      priceMax: 220,
      currencyCode: "ILS",
      available: false,
      imageUrl: `${CRAWL_ORIGIN}/img/magento-shirt.jpg`,
      // No JSON-LD url: the canonical.
      url: `${CRAWL_ORIGIN}/product/magento-shirt`,
    });
  });

  it("ProductGroup with variants at 90/120/150 collapses to one product, priceMin 90 priceMax 150, available (verify step 3)", async () => {
    const group = crawlStoreRoutes()["/product/group-sneaker"] as Response;
    const htmlBody = await group.text();
    // The three variant nodes are the group's, not separate products.
    expect(findProductNodes(extractJsonLdBlocks(htmlBody))).toHaveLength(1);
    const page = extractProductsFromPage(htmlBody, `${CRAWL_ORIGIN}/product/group-sneaker`);
    expect(page.products).toHaveLength(1);
    expect(page.products[0]).toMatchObject({
      sourceId: "GRP-SNK",
      title: "Group Runner Sneaker",
      vendor: "Group Sport",
      productType: "Sneakers",
      priceMin: 90,
      priceMax: 150,
      currencyCode: "ILS",
      available: true,
      // The group has no image; the first variant image is used.
      imageUrl: `${CRAWL_ORIGIN}/img/group-sneaker-38.jpg`,
    });
    // All variants out of stock → not available.
    const allOut = htmlBody.replace("https://schema.org/InStock", "https://schema.org/OutOfStock");
    expect(extractProductsFromPage(allOut, `${CRAWL_ORIGIN}/product/group-sneaker`).products[0].available).toBe(false);
  });

  it("a Product with no price is skipped and counted; a page with two Products sharing a sku counts once; malformed blocks are ignored (AC-4)", async () => {
    const priceless = crawlStoreRoutes()["/product/priceless-scarf"] as Response;
    const p = extractProductsFromPage(await priceless.text(), `${CRAWL_ORIGIN}/product/priceless-scarf`);
    expect(p).toEqual({ products: [], skippedNoPrice: 1 });
    // A price without a currency is a skip too.
    const noCurrency = simpleProductHtml({ canonicalPath: "/x", sku: "X", name: "X", price: 10 }).replace(
      '"priceCurrency":"ILS",',
      "",
    );
    expect(extractProductsFromPage(noCurrency, `${CRAWL_ORIGIN}/x`)).toEqual({ products: [], skippedNoPrice: 1 });

    const dupe = crawlStoreRoutes()["/product/dupe-page"] as Response;
    const d = extractProductsFromPage(await dupe.text(), `${CRAWL_ORIGIN}/product/dupe-page`);
    expect(d.products.map((product) => product.sourceId)).toEqual(["DUP-1"]);
    expect(d.products[0].title).toBe("Duplicate Belt");
    expect(d.skippedNoPrice).toBe(0);
  });

  it("an unparseable JSON-LD url falls back to the canonical and an unparseable image yields null — no throw (YOY-96 AC-7)", () => {
    const bad = simpleProductHtml({ canonicalPath: "/item/bad-urls", sku: "BAD-1", name: "Bad Urls", price: 20 })
      .replace(`"url":"${CRAWL_ORIGIN}/item/bad-urls"`, '"url":"http://[bad"')
      .replace(`"image":"${CRAWL_ORIGIN}/img/bad-1.jpg"`, '"image":"http://[bad-img"');
    // The fixture really carries the malformed values (both throw in `new URL`).
    expect(bad).toContain('"url":"http://[bad"');
    expect(bad).toContain('"image":"http://[bad-img"');
    expect(() => new URL("http://[bad", `${CRAWL_ORIGIN}/item/bad-urls`)).toThrow();

    const page = extractProductsFromPage(bad, `${CRAWL_ORIGIN}/item/bad-urls?ref=1`);
    expect(page.skippedNoPrice).toBe(0);
    expect(page.products).toHaveLength(1);
    expect(page.products[0]).toMatchObject({
      sourceId: "BAD-1",
      title: "Bad Urls",
      url: `${CRAWL_ORIGIN}/item/bad-urls`,
      imageUrl: null,
      priceMin: 20,
    });
    // Without a canonical the fetched URL is the fallback.
    const noCanonical = bad.replace(/<link rel="canonical"[^>]*>/, "");
    expect(extractProductsFromPage(noCanonical, `${CRAWL_ORIGIN}/item/bad-urls?ref=1`).products[0].url).toBe(
      `${CRAWL_ORIGIN}/item/bad-urls?ref=1`,
    );
  });

  it("a page without a Product node contributes nothing (AC-3)", async () => {
    const about = crawlStoreRoutes()["/about"] as Response;
    expect(extractProductsFromPage(await about.text(), `${CRAWL_ORIGIN}/about`)).toEqual({
      products: [],
      skippedNoPrice: 0,
    });
    expect(extractProductsFromPage("<html><body>no json-ld</body></html>", `${CRAWL_ORIGIN}/blog`).products).toEqual([]);
  });

  it("sourceId is deterministic per page: sku → productID → @id → canonical URL; url is JSON-LD url → canonical → fetched URL", () => {
    const base = { pageUrl: `${CRAWL_ORIGIN}/item/x?ref=1`, canonicalUrl: `${CRAWL_ORIGIN}/item/x` };
    const offers = { "@type": "Offer", price: "10", priceCurrency: "ILS" };
    const nodeHtml = (node: Record<string, unknown>, canonical = true) =>
      `<html><head>${canonical ? `<link rel="canonical" href="${base.canonicalUrl}">` : ""}<script type="application/ld+json">${JSON.stringify(
        { "@context": "https://schema.org", "@type": "Product", name: "X", offers, ...node },
      )}</script></head></html>`;
    expect(extractProductsFromPage(nodeHtml({ sku: "S", productID: "P", "@id": "#i" }), base.pageUrl).products[0]).toMatchObject({
      sourceId: "S",
      url: base.canonicalUrl,
    });
    expect(extractProductsFromPage(nodeHtml({ productID: "P", "@id": "#i" }), base.pageUrl).products[0].sourceId).toBe("P");
    expect(extractProductsFromPage(nodeHtml({ "@id": "#i" }), base.pageUrl).products[0].sourceId).toBe("#i");
    expect(extractProductsFromPage(nodeHtml({}), base.pageUrl).products[0].sourceId).toBe(base.canonicalUrl);
    // Without a canonical, the fetched URL is both the id and the link.
    expect(extractProductsFromPage(nodeHtml({}, false), base.pageUrl).products[0]).toMatchObject({
      sourceId: base.pageUrl,
      url: base.pageUrl,
    });
    // A JSON-LD url wins over the canonical; relative urls resolve against the page.
    expect(extractProductsFromPage(nodeHtml({ url: "/item/x-canon" }), base.pageUrl).products[0].url).toBe(
      `${CRAWL_ORIGIN}/item/x-canon`,
    );
    expect(extractCanonicalUrl(`<link href="/rel" rel="canonical">`, base.pageUrl)).toBe(`${CRAWL_ORIGIN}/rel`);
    expect(extractCanonicalUrl(`<link rel="stylesheet" href="/x.css">`, base.pageUrl)).toBeNull();
    // Offer parsing handles nested offers, PriceSpecification, and PreOrder.
    expect(
      readOffers([{ "@type": "AggregateOffer", offers: [{ price: "5", priceCurrency: "USD" }, { price: "9", availability: "https://schema.org/PreOrder" }] }]),
    ).toEqual({ priceMin: 5, priceMax: 9, currency: "USD", available: true });
    expect(readOffers({ priceSpecification: { price: 12.5, priceCurrency: "EUR" } })).toEqual({
      priceMin: 12.5,
      priceMax: 12.5,
      currency: "EUR",
      available: false,
    });
  });
});

describe("the crawl source (AC-1, AC-2, AC-4)", () => {
  it("crawls the fixture store: 9 products with canonical urls, priceless/non-html/no-product counted, product-ish URLs first (verify steps 2, 6)", async () => {
    const { store, fetch } = polite(crawlStoreRoutes());
    const source = createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch });
    expect(source.kind).toBe(JSONLD_CRAWL_SOURCE_KIND);
    const products = await source.fetchProducts({ maxProducts: 2000 });
    expect(products.map((product) => product.sourceId).sort()).toEqual([...CRAWL_EXPECTED_SKUS].sort());
    // Every url is the page's canonical (the query-string sitemap URLs resolve to their canonicals).
    expect(products.find((product) => product.sourceId === "SIMPLE-7")?.url).toBe(`${CRAWL_ORIGIN}/item/hat-7`);
    expect(products.find((product) => product.sourceId === "SIMPLE-9")?.url).toBe(`${CRAWL_ORIGIN}/shop/bag-9`);
    for (const product of products) {
      expect(product.url).toMatch(new RegExp(`^${CRAWL_ORIGIN}/`));
      expect(product.url).not.toContain("?");
    }
    expect(source.stats).toEqual({
      sitemapsRead: 3,
      urlsDiscovered: 12,
      pagesFetched: 12,
      productsFound: 9,
      skippedNoPrice: 1,
      skippedNonHtml: 1,
      skippedOutsidePrefix: 0,
      skippedRobots: 0,
      fetchErrors: 0,
      extractErrors: 0,
      budgetExhausted: false,
    });
    // Product-ish URLs were requested before /about and /catalog.pdf.
    const pagePaths = paths(store).filter((p) => !p.startsWith("/robots") && !p.startsWith("/sitemap"));
    const firstNonProductish = pagePaths.findIndex((p) => p === "/about" || p === "/catalog.pdf");
    expect(firstNonProductish).toBe(10);
  });

  it("--path-prefix fetches only pages under the prefix and counts the rest as outside prefix (YOY-117 AC-4)", async () => {
    const { store, fetch } = polite(crawlStoreRoutes());
    const source = createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch, pathPrefix: "/product" });
    const products = await source.fetchProducts({ maxProducts: 2000 });
    const pagePaths = paths(store).filter((p) => !p.startsWith("/robots") && !p.startsWith("/sitemap"));
    // Sitemap discovery is unchanged (3 sitemaps, 12 URLs); only the five
    // /product/… pages are fetched; /products/…, /p/…, /item/…, /shop/…,
    // /about and /catalog.pdf are never requested.
    expect(pagePaths.every((p) => p.startsWith("/product/"))).toBe(true);
    expect(pagePaths).toHaveLength(5);
    expect(source.stats.sitemapsRead).toBe(3);
    expect(source.stats.urlsDiscovered).toBe(12);
    expect(source.stats.skippedOutsidePrefix).toBe(7);
    expect(source.stats.pagesFetched).toBe(5);
    expect(products.every((product) => product.url?.startsWith(`${CRAWL_ORIGIN}/product/`))).toBe(true);
  });

  it("stops at the page budget: --pages 5 → exactly 5 page fetches, product-ish first, budget exhausted (verify step 4)", async () => {
    const { store, fetch } = polite(crawlStoreRoutes());
    const source = createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch, pageBudget: 5 });
    const products = await source.fetchProducts({ maxProducts: 2000 });
    const pagePaths = paths(store).filter((p) => !p.startsWith("/robots") && !p.startsWith("/sitemap"));
    expect(pagePaths).toHaveLength(5);
    expect(pagePaths.every((p) => /^\/(product|products|p|item|shop)\//.test(p))).toBe(true);
    expect(source.stats.pagesFetched).toBe(5);
    expect(source.stats.budgetExhausted).toBe(true);
    expect(products.length).toBeGreaterThan(0);
    expect(products.length).toBeLessThanOrEqual(5);
  });

  it("stops once maxProducts are in hand, and reports progress lines", async () => {
    const { fetch } = polite(crawlStoreRoutes());
    const source = createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch, concurrency: 1 });
    const stages: string[] = [];
    const products = await source.fetchProducts({
      maxProducts: 3,
      onProgress: ({ stage }) => stages.push(stage),
    });
    expect(products).toHaveLength(3);
    expect(source.stats.pagesFetched).toBe(3);
    expect(source.stats.budgetExhausted).toBe(false);
    expect(stages.at(-1)).toMatch(/^pages 3 fetched \/ products 3 found \/ skipped 0$/);
  });

  it("robots Disallow skips a section without fetching it, and the crawl continues", async () => {
    const { store, fetch } = polite(crawlStoreRoutes({ privateSection: true }));
    const source = createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch });
    const products = await source.fetchProducts({ maxProducts: 2000 });
    expect(products.map((product) => product.sourceId)).not.toContain("VIP-1");
    expect(products).toHaveLength(9);
    expect(source.stats.skippedRobots).toBe(1);
    expect(source.stats.urlsDiscovered).toBe(13);
    expect(paths(store)).not.toContain("/private/vip-dress");
  });

  it("a site with no sitemap at all fails loudly; fetch failures are counted, not fatal", async () => {
    const empty = polite({ "/robots.txt": "User-agent: *\n" });
    await expect(
      createJsonLdCrawlSource({ storeUrl: "https://a.example", fetch: empty.fetch }).fetchProducts({ maxProducts: 10 }),
    ).rejects.toThrow(/no sitemap URLs found/);

    const flaky = polite({
      "/robots.txt": "",
      "/sitemap.xml": new Response(
        `<urlset><url><loc>https://a.example/p/ok</loc></url><url><loc>https://a.example/p/gone</loc></url></urlset>`,
        { headers: { "Content-Type": "application/xml" } },
      ),
      "/p/ok": html(simpleProductHtml({ canonicalPath: "/p/ok", sku: "OK", name: "Ok", price: 1 })),
    });
    const source = createJsonLdCrawlSource({ storeUrl: "https://a.example", fetch: flaky.fetch });
    expect((await source.fetchProducts({ maxProducts: 10 })).map((product) => product.sourceId)).toEqual(["OK"]);
    expect(source.stats.fetchErrors).toBe(1);
  });

  it("a page whose extraction throws is counted in extractErrors; every other page's products are still returned (YOY-96 AC-7)", async () => {
    const actual = await vi.importActual<typeof import("./jsonld.server")>("./jsonld.server");
    const spy = vi.mocked(extractProductsFromPage);
    spy.mockImplementation((pageHtml, pageUrl) => {
      if (pageUrl === `${CRAWL_ORIGIN}/product/woo-dress`) {
        throw new Error("fixture: extraction exploded on this page");
      }
      return actual.extractProductsFromPage(pageHtml, pageUrl);
    });
    try {
      const { fetch } = polite(crawlStoreRoutes());
      const source = createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch });
      const stages: string[] = [];
      const products = await source.fetchProducts({
        maxProducts: 2000,
        onProgress: ({ stage }) => stages.push(stage),
      });
      // The run completes: only the exploding page's product is missing.
      expect(products.map((product) => product.sourceId).sort()).toEqual(
        CRAWL_EXPECTED_SKUS.filter((sku) => sku !== "WOO-DRESS-1").sort(),
      );
      expect(source.stats).toMatchObject({
        pagesFetched: 12,
        productsFound: 8,
        fetchErrors: 0,
        extractErrors: 1,
        budgetExhausted: false,
      });
      // The progress line's skipped total includes it.
      expect(stages.at(-1)).toMatch(/^pages 12 fetched \/ products 8 found \/ skipped 3$/);
    } finally {
      spy.mockImplementation(actual.extractProductsFromPage);
    }
  });

  it("keeps at most 4 page requests in flight per host through the polite helper (AC-1)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const routes = crawlStoreRoutes();
    const store = createFakeStore(routes);
    const gated = async (input: string, init?: Parameters<typeof store.fetch>[1]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      try {
        return await store.fetch(input, init);
      } finally {
        inFlight -= 1;
      }
    };
    const fetch = createPoliteFetch({ contactUrl: "https://playground.example", fetch: gated, maxInFlightPerHost: 4 });
    const source = createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch, concurrency: 8 });
    await source.fetchProducts({ maxProducts: 2000 });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});

describe("pipeline + CLI integration on the hermetic DB (AC-5)", () => {
  let db: PrismaClient;
  const fixtureAi = (): { llm: LlmClient; embeddings: EmbeddingClient } => ({
    llm: {
      async completeStructured() {
        return { category: "dress", colors: [], occasions: [], fit: "regular", styleTags: [], seasons: [] };
      },
    },
    embeddings: {
      dimension: 3,
      async embed({ texts }) {
        return texts.map((_, i) => [0.1 * (i + 1), 0.2, 0.3]);
      },
    },
  });

  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
    await db.productEnrichment.deleteMany();
    await db.productImage.deleteMany();
    await db.catalogProduct.deleteMany();
    await db.playgroundCatalog.deleteMany();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("crawled products become rows under playground:<slug> with the page canonicals as url", async () => {
    const { fetch } = polite(crawlStoreRoutes());
    const result = await ingestPublicCatalog({
      db,
      slug: "crawl-demo",
      name: "Crawl Demo",
      source: createJsonLdCrawlSource({ storeUrl: CRAWL_ORIGIN, fetch }),
      sourceUrl: CRAWL_ORIGIN,
      imageFetch: (imageUrl) => fetch.fetch(imageUrl),
      ...fixtureAi(),
    });
    expect(result.ingest).toMatchObject({ created: 9, skippedInvalid: 0 });
    const rows = await db.catalogProduct.findMany({ where: { shopDomain: "playground:crawl-demo" }, orderBy: { productId: "asc" } });
    expect(rows.map((row) => row.productId).sort()).toEqual([...CRAWL_EXPECTED_SKUS].sort());
    expect(rows.find((row) => row.productId === "SIMPLE-7")?.url).toBe(`${CRAWL_ORIGIN}/item/hat-7`);
    expect(rows.find((row) => row.productId === "GRP-SNK")).toMatchObject({ priceMin: 90, priceMax: 150, available: true });
    expect(await db.playgroundCatalog.findUniqueOrThrow({ where: { slug: "crawl-demo" } })).toMatchObject({
      sourceKind: "jsonld-crawl",
      productCount: 9,
    });
  });

  it("the CLI selects jsonld-crawl for a non-Shopify URL without --source and prints the crawl report (verify step 5)", async () => {
    const { fetch } = polite(crawlStoreRoutes());
    const out: string[] = [];
    const err: string[] = [];
    const code = await runIngestPublicCli({
      argv: ["--url", CRAWL_ORIGIN, "--slug", "crawl-cli", "--pages", "5"],
      db,
      fetch,
      aiClients: fixtureAi,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(
      expect.arrayContaining([
        `source: jsonld-crawl at ${CRAWL_ORIGIN}`,
        "name: shop.example",
        expect.stringMatching(
          /^crawl: sitemaps 3, urls 12, pages fetched 5 \(budget 5\), products found \d, .*, fetch errors 0, extract errors 0 — page budget exhausted, more pages remain$/,
        ),
      ]),
    );
    expect((await db.playgroundCatalog.findUniqueOrThrow({ where: { slug: "crawl-cli" } })).sourceKind).toBe("jsonld-crawl");
  });
});
