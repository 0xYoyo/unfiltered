import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient, LlmClient } from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CardWriter } from "../catalog/card.server";
import type { FakeRoute } from "../testing/fake-store.server";
import { createFakeStore } from "../testing/fake-store.server";
import { createTestDb } from "../testing/helpers.server";
import {
  FIXTURE_META,
  FIXTURE_ORIGIN,
  FIXTURE_PAGE_1,
  FIXTURE_PAGE_2,
} from "./fixtures/shopify-public-products";
import { DEFAULT_MAX_PRODUCTS } from "./ingest-public.server";
import { DEFAULT_CRAWL_PAGE_BUDGET } from "./jsonld-crawl-source.server";
import {
  detectCatalogSource,
  IngestPublicUsageError,
  parseIngestPublicArgs,
  runIngestPublicCli,
} from "./ingest-public-cli.server";
import { createPoliteFetch } from "./polite-fetch.server";
import { PRODUCTS_JSON_PAGE_SIZE } from "./shopify-public-source.server";

// `npm run ingest:public` (YOY-88 AC-6/AC-7) end to end, offline: argument
// parsing, source detection, the unsupported-URL exit, the robots abort, the
// run report, and --delete — all against the fake store and PGlite.

const page = (n: number) => `/products.json?limit=${PRODUCTS_JSON_PAGE_SIZE}&page=${n}`;

const fixtureRoutes = () => ({
  "/robots.txt": "",
  "/products.json?limit=1": { products: [FIXTURE_PAGE_1[0]] },
  [page(1)]: { products: FIXTURE_PAGE_1 },
  [page(2)]: { products: FIXTURE_PAGE_2 },
  [page(3)]: { products: [] },
  "/meta.json": FIXTURE_META,
});

const fixtureAsks = (prefix: string) => Array.from({ length: 10 }, (_, i) => `${prefix} ${i + 1}`);

/** Fixture AI clients: no ledger rows here — the CLI's cost line is proven at $0. */
const fixtureAi = (): {
  llm: LlmClient;
  vision: LlmClient;
  embeddings: EmbeddingClient;
  cards: CardWriter;
} => ({
  // The card writer (YOY-143), used only on --cards.
  cards: {
    modelId: "fixture-card-model",
    llm: {
      async completeStructured() {
        return {
          facts: "A dress.",
          look: "Black.",
          read: "Evening wear.",
          summary: "A black evening dress.",
          asks: { en: fixtureAsks("black dress"), he: fixtureAsks("שמלה שחורה") },
        };
      },
    },
  },
  vision: {
    // The fixture store serves no image bytes, so no ProductImage row
    // exists and the vision pass never reaches the model (YOY-121 AC-6).
    async completeStructured() {
      throw new Error("vision must not be called without images");
    },
  },
  llm: {
    async completeStructured() {
      return {
        category: "dress",
        colors: [],
        primaryColor: "",
        occasions: [],
        fit: "regular",
        styleTags: [],
        seasons: [],
      };
    },
  },
  embeddings: {
    dimension: 3,
    async embed({ texts }) {
      return texts.map((_, i) => [0.1 * (i + 1), 0.2, 0.3]);
    },
  },
});

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.aiCall.deleteMany();
  await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
  await db.productEnrichment.deleteMany();
  await db.productImage.deleteMany();
  await db.productCard.deleteMany();
  await db.catalogProduct.deleteMany();
  await db.playgroundCatalog.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

function harness(routes: Record<string, FakeRoute> = fixtureRoutes()) {
  const store = createFakeStore(routes);
  const fetch = createPoliteFetch({ contactUrl: "https://playground.example", fetch: store.fetch });
  const out: string[] = [];
  const err: string[] = [];
  let aiBuilt = 0;
  const run = (argv: string[]) =>
    runIngestPublicCli({
      argv,
      db,
      fetch,
      aiClients: () => {
        aiBuilt += 1;
        return fixtureAi();
      },
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
  return { store, run, out, err, aiBuilt: () => aiBuilt };
}

describe("argument parsing (AC-6)", () => {
  it("parses --url/--slug/--name/--max and --delete", () => {
    expect(
      parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s", "--name", "My Store", "--max", "50"]),
    ).toEqual({
      url: "https://s.example",
      slug: "s",
      name: "My Store",
      max: 50,
      delete: false,
      source: null,
      pages: DEFAULT_CRAWL_PAGE_BUDGET,
      pathPrefix: null,
      // YOY-143: cards are opt-in (NG-3).
      cards: false,
    });
    expect(
      parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s", "--cards"]),
    ).toMatchObject({ cards: true });
    // YOY-117 AC-4: the locale hint, normalised to /prefix with no trailing slash.
    expect(
      parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s", "--path-prefix", "/uk/"]),
    ).toMatchObject({ pathPrefix: "/uk" });
    expect(
      parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s", "--path-prefix", "/en-gb"]),
    ).toMatchObject({ pathPrefix: "/en-gb" });
    for (const bad of ["uk", "/", "/uk?x=1", "https://s.example/uk"]) {
      expect(() =>
        parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s", "--path-prefix", bad]),
      ).toThrow(IngestPublicUsageError);
    }
    expect(parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s"])).toMatchObject({
      max: DEFAULT_MAX_PRODUCTS,
      name: null,
    });
    expect(parseIngestPublicArgs(["--delete", "--slug", "s"])).toMatchObject({ delete: true, url: null });
    // YOY-89 AC-5: forced source and the crawler's page budget.
    expect(
      parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s", "--source", "jsonld-crawl", "--pages", "5"]),
    ).toMatchObject({ source: "jsonld-crawl", pages: 5 });
    expect(
      parseIngestPublicArgs(["--url", "https://s.example", "--slug", "s", "--source", "shopify-public"]),
    ).toMatchObject({ source: "shopify-public" });
    for (const argv of [
      ["--url", "https://s.example", "--slug", "s", "--source", "rss"],
      ["--url", "https://s.example", "--slug", "s", "--pages", "0"],
    ]) {
      expect(() => parseIngestPublicArgs(argv)).toThrow(IngestPublicUsageError);
    }
  });

  it("rejects a missing slug, a bad slug, a missing url, a bad --max, and an unknown flag", () => {
    for (const argv of [
      ["--url", "https://s.example"],
      ["--url", "https://s.example", "--slug", "Bad Slug"],
      ["--slug", "s"],
      ["--url", "https://s.example", "--slug", "s", "--max", "0"],
      ["--url", "https://s.example", "--slug", "s", "--max", "ten"],
      ["--url", "https://s.example", "--slug", "s", "--bogus"],
      ["--url"],
    ]) {
      expect(() => parseIngestPublicArgs(argv)).toThrow(IngestPublicUsageError);
    }
    expect(() => parseIngestPublicArgs(["--slug"])).toThrow(/usage: npm run ingest:public/);
  });
});

describe("detection (AC-6)", () => {
  it("detects a Shopify feed and takes the store name from meta.json when the CLI gives none", async () => {
    const store = createFakeStore(fixtureRoutes());
    const fetch = createPoliteFetch({ contactUrl: "https://playground.example", fetch: store.fetch });
    const detected = await detectCatalogSource({ url: FIXTURE_ORIGIN, fetch, name: null });
    expect(detected?.source.kind).toBe("shopify-public");
    expect(detected?.name).toBe("Demo Store");
    const named = await detectCatalogSource({ url: FIXTURE_ORIGIN, fetch, name: "Given" });
    expect(named?.name).toBe("Given");
  });

  it("falls back to the JSON-LD crawler for a non-Shopify URL; a forced source wins; forcing shopify-public on a non-Shopify URL is unsupported (YOY-89 AC-5)", async () => {
    const store = createFakeStore({ "/products.json?limit=1": "<html>Welcome</html>" });
    const fetch = createPoliteFetch({ contactUrl: "https://playground.example", fetch: store.fetch });
    const detected = await detectCatalogSource({ url: "https://example.invalid", fetch, name: null });
    expect(detected?.source.kind).toBe("jsonld-crawl");
    expect(detected?.name).toBe("example.invalid");
    expect(
      await detectCatalogSource({ url: "https://example.invalid", fetch, name: null, force: "shopify-public" }),
    ).toBeNull();
    // Forcing the crawler skips Shopify detection even on a Shopify feed.
    const shopify = createFakeStore(fixtureRoutes());
    const shopifyFetch = createPoliteFetch({ contactUrl: "https://playground.example", fetch: shopify.fetch });
    const forced = await detectCatalogSource({ url: FIXTURE_ORIGIN, fetch: shopifyFetch, name: null, force: "jsonld-crawl" });
    expect(forced?.source.kind).toBe("jsonld-crawl");
    expect(shopify.requests.map((r) => new URL(r.url).pathname)).not.toContain("/products.json");
  });
});

describe("runIngestPublicCli", () => {
  it("usage errors exit 1 with the usage text and touch nothing", async () => {
    const { run, err, aiBuilt } = harness();
    expect(await run(["--url", "https://x.example"])).toBe(1);
    expect(err[0]).toMatch(/--slug is required[\s\S]*usage: npm run ingest:public/);
    expect(aiBuilt()).toBe(0);
  });

  it("`--source shopify-public` on a non-Shopify URL exits 1 with `no supported catalog source for <url>` (verify step 5)", async () => {
    const { run, err, aiBuilt } = harness({ "*": "<html>Not a store</html>" });
    expect(
      await run(["--url", "https://example.invalid", "--slug", "x", "--source", "shopify-public"]),
    ).toBe(1);
    expect(err).toEqual(["no supported catalog source for https://example.invalid"]);
    expect(await db.playgroundCatalog.count()).toBe(0);
    expect(aiBuilt()).toBe(0);
  });

  it("a non-Shopify URL without any sitemap aborts the crawl with a clear message and writes no rows", async () => {
    const { run, err } = harness({ "*": "<html>Not a store</html>" });
    expect(await run(["--url", "https://example.invalid", "--slug", "x"])).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/ingest aborted: JSON-LD crawl: no sitemap URLs found for https:\/\/example\.invalid/);
    expect(await db.playgroundCatalog.count()).toBe(0);
    expect(await db.catalogProduct.count()).toBe(0);
  });

  it("robots.txt disallowing the feed aborts with a robots message and writes no rows (verify step 6)", async () => {
    const { run, err, store } = harness({
      ...fixtureRoutes(),
      "/robots.txt": "User-agent: *\nDisallow: /products.json\n",
    });
    expect(await run(["--url", FIXTURE_ORIGIN, "--slug", "demo"])).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/ingest aborted: robots\.txt disallows .*products\.json.*nothing was written/);
    // The feed was never requested.
    expect(store.requests.map((r) => new URL(r.url).pathname)).toEqual(["/robots.txt"]);
    expect(await db.catalogProduct.count()).toBe(0);
    expect(await db.playgroundCatalog.count()).toBe(0);
  });

  it("ingests, prints the counts, the skips, and the AI cost, and re-runs idempotently", async () => {
    const { run, out } = harness();
    expect(await run(["--url", FIXTURE_ORIGIN, "--slug", "demo", "--max", "4"])).toBe(0);
    expect(out).toEqual(
      expect.arrayContaining([
        "catalog: demo (playground:demo)",
        `source: shopify-public at ${FIXTURE_ORIGIN}`,
        "name: Demo Store",
        "ingest: created 3, updated 0, unchanged 0, deleted 0",
        // Image capture reads through the polite fetcher (YOY-120 AC-2);
        // the fixture store routes no /cdn/ path, so every fetch fails —
        // counted, never fatal.
        expect.stringMatching(/^images: fetched \d+, unchanged \d+, failed \d+$/),
        expect.stringMatching(/^skipped 1 product\(s\) beyond --max 4/),
        "skipped 1 product(s) with no title or no price",
        "enrich: enriched 3, cached 0, failed 0",
        // The vision report line (YOY-121 AC-6): no product has an image
        // row, so nothing is analysed, cached, or failed.
        "vision: analysed 0, cached 0, failed 0, cost $0.000000",
        // Cards are opt-in (YOY-143 NG-3): without --cards none is written.
        "cards: written 0, cached 0, failed 0, cost $0.000000 (off: pass --cards to write cards)",
        "embed: embedded 3, cached 0, deleted 0",
        expect.stringMatching(/^ai cost this run: \$0\.000000 over 0 call\(s\)$/),
        expect.stringMatching(/^requests: \d+, retries: 0, robots-skipped: 0$/),
      ]),
    );
    expect(await db.playgroundCatalog.findUniqueOrThrow({ where: { slug: "demo" } })).toMatchObject({
      name: "Demo Store",
      productCount: 3,
      sourceKind: "shopify-public",
      sourceUrl: FIXTURE_ORIGIN,
    });

    const second = harness();
    expect(await second.run(["--url", FIXTURE_ORIGIN, "--slug", "demo", "--name", "Renamed"])).toBe(0);
    expect(second.out).toEqual(
      expect.arrayContaining([
        "name: Renamed",
        "ingest: created 0, updated 0, unchanged 3, deleted 0",
        "enrich: enriched 0, cached 3, failed 0",
        "vision: analysed 0, cached 0, failed 0, cost $0.000000",
        "embed: embedded 0, cached 3, deleted 0",
      ]),
    );
    expect(second.out.some((line) => line.startsWith("skipped") && line.includes("beyond --max"))).toBe(false);
    expect((await db.playgroundCatalog.findUniqueOrThrow({ where: { slug: "demo" } })).name).toBe("Renamed");
  });

  it("--cards writes a card per product, then caches them on the re-run (YOY-143 AC-9)", async () => {
    const { run, out } = harness();
    expect(await run(["--url", FIXTURE_ORIGIN, "--slug", "demo", "--max", "4", "--cards"])).toBe(0);
    expect(out).toContain("cards: written 3, cached 0, failed 0, cost $0.000000");
    expect(await db.productCard.count({ where: { shopDomain: "playground:demo", status: "written" } })).toBe(3);

    const second = harness();
    expect(await second.run(["--url", FIXTURE_ORIGIN, "--slug", "demo", "--cards"])).toBe(0);
    expect(second.out).toContain("cards: written 0, cached 3, failed 0, cost $0.000000");
  });

  it("--delete removes the catalog and reports the counts (verify step 7)", async () => {
    const { run } = harness();
    await run(["--url", FIXTURE_ORIGIN, "--slug", "demo"]);
    const { run: runDelete, out, aiBuilt } = harness();
    expect(await runDelete(["--delete", "--slug", "demo"])).toBe(0);
    expect(out).toEqual([
      "deleted catalog demo (playground:demo): products 3, enrichments 3, embeddings 3, registry 1",
    ]);
    // No AI client is ever constructed for a delete (no GEMINI_API_KEY needed).
    expect(aiBuilt()).toBe(0);
    expect(await db.catalogProduct.count()).toBe(0);
    expect(await db.playgroundCatalog.count()).toBe(0);
  });
});
