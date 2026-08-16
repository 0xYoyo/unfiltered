import { readFile } from "node:fs/promises";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AdminGraphql } from "./catalog/ingest.server";
import {
  PRODUCTS_QUERY,
  VARIANTS_SAMPLE_SIZE,
  ingestCatalog,
} from "./catalog/ingest.server";
import type { ShopifyProductNode } from "./catalog/mapping.server";
import { productNode } from "./catalog/mapping.test";
import { createTestDb } from "./testing/helpers.server";

// Ingestion tests run against the embedded PGlite DB with fixture GraphQL
// payloads only — no live Shopify call anywhere (AC-4). Test file lives
// outside app/routes/ per the architecture rule.

/**
 * Fixture-backed AdminGraphql stub: serves the given nodes in pages of
 * `pageSize` and records every request's variables.
 */
function graphqlStub(nodes: ShopifyProductNode[], pageSize = 2) {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const graphql: AdminGraphql = async (query, options) => {
    expect(query).toBe(PRODUCTS_QUERY);
    calls.push(options?.variables);
    const after = (options?.variables?.after as string | null) ?? null;
    const start = after === null ? 0 : Number(after);
    const page = nodes.slice(start, start + pageSize);
    const endCursor = String(start + page.length);
    return new Response(
      JSON.stringify({
        data: {
          products: {
            pageInfo: {
              hasNextPage: start + page.length < nodes.length,
              endCursor,
            },
            nodes: page,
          },
        },
      }),
    );
  };
  return { graphql, calls };
}

const SHOP = "test-shop.myshopify.com";
const OTHER_SHOP = "other-shop.myshopify.com";

const fixtureCatalog = () => [
  productNode({ id: "gid://shopify/Product/1" }),
  productNode({
    id: "gid://shopify/Product/2",
    title: "שמלת ערב שחורה",
    description: null,
    tags: ["שמלה"],
  }),
  productNode({
    id: "gid://shopify/Product/3",
    title: "Plain tee",
    description: "",
    variants: { nodes: [{ availableForSale: false }] },
  }),
];

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.catalogProduct.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("catalog ingestion", () => {
  it("samples availability from an explicit, documented variant bound (YOY-29 AC-2)", () => {
    // The `available` flag reads at most VARIANTS_SAMPLE_SIZE variants; the
    // query must embed exactly that constant so the bound can never drift
    // silently away from its documentation.
    expect(PRODUCTS_QUERY).toContain(`variants(first: ${VARIANTS_SAMPLE_SIZE})`);
    expect(VARIANTS_SAMPLE_SIZE).toBe(100);
  });

  it("snapshots a paginated catalog into per-shop rows", async () => {
    const { graphql, calls } = graphqlStub(fixtureCatalog(), 2);

    const result = await ingestCatalog({ db, shopDomain: SHOP, graphql });

    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0, deleted: 0 });
    // 3 nodes at page size 2 → exactly two requests, cursor threaded through.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.after).toBe("2");

    const rows = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.shopDomain === SHOP)).toBe(true);
    expect(rows[1]?.title).toBe("שמלת ערב שחורה");
    expect(rows[1]?.description).toBe("");
    expect(rows[2]?.available).toBe(false);
  });

  it("stores the display snapshot: handle and featuredImageUrl (YOY-44 AC-2)", async () => {
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub([
        productNode({ id: "gid://shopify/Product/1" }),
        productNode({ id: "gid://shopify/Product/2", featuredImage: null }),
      ]).graphql,
    });

    const rows = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });
    expect(rows[0]?.handle).toBe("linen-summer-dress");
    expect(rows[0]?.featuredImageUrl).toBe(
      "https://cdn.example.com/linen-dress.jpg",
    );
    // A product with no featured image stores null, not "".
    expect(rows[1]?.featuredImageUrl).toBeNull();
  });

  it("stores the server-resolved url: onlineStoreUrl when present, else the storefront form (YOY-87 AC-2)", async () => {
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub([
        productNode({
          id: "gid://shopify/Product/1",
          onlineStoreUrl: "https://shop.example/products/linen-summer-dress",
        }),
        // Legacy fixture: no onlineStoreUrl field at all.
        productNode({ id: "gid://shopify/Product/2", handle: "second" }),
        // Explicit null (no storefront page): the composed form still applies.
        productNode({
          id: "gid://shopify/Product/3",
          handle: "third",
          onlineStoreUrl: null,
        }),
      ]).graphql,
    });

    const rows = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });
    expect(rows.map((row) => row.url)).toEqual([
      "https://shop.example/products/linen-summer-dress",
      `https://${SHOP}/products/second`,
      `https://${SHOP}/products/third`,
    ]);
  });

  it("refreshes a drifted url on repeat ingest without dirtying the hash or touching enrichment/embedding (YOY-87 AC-1)", async () => {
    await db.productEnrichment.deleteMany();
    await db.productEmbedding.deleteMany();
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub([productNode({ id: "gid://shopify/Product/1" })]).graphql,
    });
    const before = (await db.catalogProduct.findMany())[0]!;
    expect(before.url).toBe(`https://${SHOP}/products/linen-summer-dress`);
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: "gid://shopify/Product/1",
        contentHash: before.contentHash,
        status: "enriched",
        category: "dress",
        colors: [],
        occasions: [],
        fit: null,
        styleTags: [],
        seasons: [],
      },
    });
    const enrichmentBefore = await db.productEnrichment.findMany();

    // Only the url changes (the Admin API now resolves an onlineStoreUrl).
    const rerun = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub([
        productNode({
          id: "gid://shopify/Product/1",
          onlineStoreUrl: "https://shop.example/products/linen-summer-dress",
        }),
      ]).graphql,
    });

    expect(rerun).toEqual({ created: 0, updated: 0, unchanged: 1, deleted: 0 });
    const after = (await db.catalogProduct.findMany())[0]!;
    expect(after.id).toBe(before.id);
    expect(after.url).toBe("https://shop.example/products/linen-summer-dress");
    expect(after.contentHash).toBe(before.contentHash);
    expect(await db.productEnrichment.findMany()).toEqual(enrichmentBefore);
    expect(await db.productEmbedding.findMany()).toEqual([]);
    await db.productEnrichment.deleteMany();
  });

  it("migration backfills url for pre-existing rows with a handle (YOY-87 AC-1)", async () => {
    // Insert as a pre-migration row would have existed — with a handle and no
    // url — then replay the backfill statement the migration ships.
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: "gid://shopify/Product/legacy",
        title: "Legacy",
        description: "",
        tags: [],
        vendor: "",
        productType: "",
        priceMin: 1,
        priceMax: 1,
        currencyCode: "ILS",
        available: true,
        imageAltTexts: [],
        handle: "legacy-handle",
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: "legacy-hash",
      },
    });
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: "gid://shopify/Product/no-handle",
        title: "No handle",
        description: "",
        tags: [],
        vendor: "",
        productType: "",
        priceMin: 1,
        priceMax: 1,
        currencyCode: "ILS",
        available: true,
        imageAltTexts: [],
        sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: "no-handle-hash",
      },
    });
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20260816200000_catalog_product_url/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backfill = migration
      .split(";")
      .map((statement) => statement.trim())
      .find((statement) => statement.startsWith("UPDATE"));
    expect(backfill).toBeDefined();
    await db.$executeRawUnsafe(backfill!);

    const rows = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });
    expect(rows.map((row) => [row.productId, row.url])).toEqual([
      ["gid://shopify/Product/legacy", `https://${SHOP}/products/legacy-handle`],
      ["gid://shopify/Product/no-handle", null],
    ]);
  });

  it("backfills display fields on repeat ingest without re-enriching (YOY-44 AC-4/AC-5)", async () => {
    await db.productEnrichment.deleteMany();
    // First ingest predates the display fields: no handle, no image.
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub([
        productNode({
          id: "gid://shopify/Product/1",
          handle: "",
          featuredImage: null,
        }),
      ]).graphql,
    });
    const before = (await db.catalogProduct.findMany())[0]!;
    expect(before.handle).toBe("");
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: "gid://shopify/Product/1",
        contentHash: before.contentHash,
        status: "enriched",
        category: "dress",
        colors: [],
        occasions: [],
        fit: null,
        styleTags: [],
        seasons: [],
      },
    });
    const enrichmentBefore = await db.productEnrichment.findMany();

    // Repeat full ingest, now with the display fields present.
    const rerun = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub([productNode({ id: "gid://shopify/Product/1" })]).graphql,
    });

    // Searchable content unchanged: no update/create counted, no duplicates.
    expect(rerun).toEqual({ created: 0, updated: 0, unchanged: 1, deleted: 0 });
    const after = await db.catalogProduct.findMany();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before.id);
    // Display fields backfilled, contentHash identical.
    expect(after[0]?.handle).toBe("linen-summer-dress");
    expect(after[0]?.featuredImageUrl).toBe(
      "https://cdn.example.com/linen-dress.jpg",
    );
    expect(after[0]?.contentHash).toBe(before.contentHash);
    // Enrichment untouched: same rows, same hash, same updatedAt.
    expect(await db.productEnrichment.findMany()).toEqual(enrichmentBefore);
    await db.productEnrichment.deleteMany();
  });

  it("is idempotent: an unchanged catalog re-ingests with zero writes", async () => {
    const { graphql } = graphqlStub(fixtureCatalog());
    await ingestCatalog({ db, shopDomain: SHOP, graphql });
    const before = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });

    const rerun = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(fixtureCatalog()).graphql,
    });

    expect(rerun).toEqual({ created: 0, updated: 0, unchanged: 3, deleted: 0 });
    const after = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });
    // Untouched means untouched: same row identity and same updatedAt.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.updatedAt)).toEqual(
      before.map((row) => row.updatedAt),
    );
  });

  it("applies changes as update/delete/create with unchanged rows untouched", async () => {
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(fixtureCatalog()).graphql,
    });

    // Product 1 retitled, product 3 removed, product 4 added, product 2 as-is.
    const mutated = [
      productNode({ id: "gid://shopify/Product/1", title: "Renamed dress" }),
      productNode({
        id: "gid://shopify/Product/2",
        title: "שמלת ערב שחורה",
        description: null,
        tags: ["שמלה"],
      }),
      productNode({ id: "gid://shopify/Product/4", title: "New arrival" }),
    ];

    const result = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(mutated).graphql,
    });

    expect(result).toEqual({ created: 1, updated: 1, unchanged: 1, deleted: 1 });
    const rows = await db.catalogProduct.findMany({ orderBy: { productId: "asc" } });
    expect(rows.map((row) => [row.productId, row.title])).toEqual([
      ["gid://shopify/Product/1", "Renamed dress"],
      ["gid://shopify/Product/2", "שמלת ערב שחורה"],
      ["gid://shopify/Product/4", "New arrival"],
    ]);
  });

  it("prunes a stale product's enrichment record with it (YOY-29 AC-5)", async () => {
    await db.productEnrichment.deleteMany();
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(fixtureCatalog()).graphql,
    });
    for (const productId of ["gid://shopify/Product/1", "gid://shopify/Product/3"]) {
      await db.productEnrichment.create({
        data: {
          shopDomain: SHOP,
          productId,
          contentHash: "hash",
          status: "enriched",
          category: "dress",
          colors: [],
          occasions: [],
          fit: null,
          styleTags: [],
          seasons: [],
        },
      });
    }

    // Product 3 disappears from the catalog; its enrichment must go with it.
    const result = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(fixtureCatalog().slice(0, 2)).graphql,
    });

    expect(result.deleted).toBe(1);
    expect(
      await db.productEnrichment.count({
        where: { shopDomain: SHOP, productId: "gid://shopify/Product/3" },
      }),
    ).toBe(0);
    expect(
      await db.productEnrichment.count({
        where: { shopDomain: SHOP, productId: "gid://shopify/Product/1" },
      }),
    ).toBe(1);
  });

  it("indexes only ACTIVE products and deletes non-active rows on repeat ingest (YOY-61 AC-2)", async () => {
    await db.productEnrichment.deleteMany();
    await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
    // First sync: product 3 is still ACTIVE and gets indexed and enriched.
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(fixtureCatalog()).graphql,
    });
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: "gid://shopify/Product/3",
        contentHash: "hash",
        status: "enriched",
        category: "top",
        colors: [],
        occasions: [],
        fit: null,
        styleTags: [],
        seasons: [],
      },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO "ProductEmbedding"
         ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
       VALUES ('emb-3', $1, 'gid://shopify/Product/3', 'hash', $2::vector(3), CURRENT_TIMESTAMP)`,
      SHOP,
      "[1,0,0]",
    );

    // Mixed-status catalog: product 3 archived, a draft product appears.
    const mixed = [
      productNode({ id: "gid://shopify/Product/1", status: "ACTIVE" }),
      fixtureCatalog()[1]!,
      productNode({ id: "gid://shopify/Product/3", status: "ARCHIVED" }),
      productNode({ id: "gid://shopify/Product/4", status: "DRAFT" }),
    ];
    const result = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(mixed).graphql,
    });

    // The archived product is reported deleted; the draft one never lands.
    expect(result.deleted).toBe(1);
    expect(result.created).toBe(0);
    const rows = await db.catalogProduct.findMany({ where: { shopDomain: SHOP } });
    expect(rows.map((row) => row.productId).sort()).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
    ]);
    // Enrichment AND embedding rows go with the product (defense against a
    // leftover embedding keeping the product retrievable).
    expect(
      await db.productEnrichment.count({
        where: { shopDomain: SHOP, productId: "gid://shopify/Product/3" },
      }),
    ).toBe(0);
    const embeddings = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::int8 AS count FROM "ProductEmbedding"
        WHERE "shopDomain" = $1 AND "productId" = 'gid://shopify/Product/3'`,
      SHOP,
    );
    expect(Number(embeddings[0]!.count)).toBe(0);
  });

  it("indexes only Online-Store-published products and purges unpublished rows on repeat ingest (YOY-67 AC-4)", async () => {
    await db.productEnrichment.deleteMany();
    await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
    // First sync: product 3 is still published, indexed, enriched, embedded.
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(fixtureCatalog()).graphql,
    });
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: "gid://shopify/Product/3",
        contentHash: "hash",
        status: "enriched",
        category: "top",
        colors: [],
        occasions: [],
        fit: null,
        styleTags: [],
        seasons: [],
      },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO "ProductEmbedding"
         ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
       VALUES ('emb-pub-3', $1, 'gid://shopify/Product/3', 'hash', $2::vector(3), CURRENT_TIMESTAMP)`,
      SHOP,
      "[1,0,0]",
    );

    // Mixed publication: product 3 unpublished from the Online Store (still
    // ACTIVE — status and publication are independent axes), a new
    // never-published product appears. Both must be absent afterwards.
    const mixed = [
      productNode({
        id: "gid://shopify/Product/1",
        publishedAt: "2026-07-01T08:00:00Z",
      }),
      fixtureCatalog()[1]!,
      productNode({
        id: "gid://shopify/Product/3",
        status: "ACTIVE",
        publishedAt: null,
      }),
      productNode({ id: "gid://shopify/Product/5", publishedAt: null }),
    ];
    const result = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(mixed).graphql,
    });

    // The unpublished product is reported deleted; the new one never lands.
    expect(result.deleted).toBe(1);
    expect(result.created).toBe(0);
    const rows = await db.catalogProduct.findMany({
      where: { shopDomain: SHOP },
      orderBy: { productId: "asc" },
    });
    expect(rows.map((row) => row.productId)).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
    ]);
    // The real publication timestamp is persisted (YOY-67 AC-4), replacing
    // the assumed-published default older rows carry.
    expect(rows[0]?.publishedAt).toEqual(new Date("2026-07-01T08:00:00Z"));
    // Enrichment AND embedding rows go with the unpublished product.
    expect(
      await db.productEnrichment.count({
        where: { shopDomain: SHOP, productId: "gid://shopify/Product/3" },
      }),
    ).toBe(0);
    const embeddings = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::int8 AS count FROM "ProductEmbedding"
        WHERE "shopDomain" = $1 AND "productId" = 'gid://shopify/Product/3'`,
      SHOP,
    );
    expect(Number(embeddings[0]!.count)).toBe(0);
  });

  it("isolates shops: two ingested catalogs never cross-contaminate", async () => {
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub(fixtureCatalog()).graphql,
    });
    await ingestCatalog({
      db,
      shopDomain: OTHER_SHOP,
      graphql: graphqlStub([
        productNode({ id: "gid://shopify/Product/9", title: "Other shop only" }),
      ]).graphql,
    });

    const shopRows = await db.catalogProduct.findMany({
      where: { shopDomain: SHOP },
    });
    const otherRows = await db.catalogProduct.findMany({
      where: { shopDomain: OTHER_SHOP },
    });
    expect(shopRows).toHaveLength(3);
    expect(otherRows).toHaveLength(1);
    expect(shopRows.map((row) => row.title)).not.toContain("Other shop only");

    // Re-ingesting shop A with an emptied catalog deletes only shop A's rows.
    const wipe = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: graphqlStub([]).graphql,
    });
    expect(wipe).toEqual({ created: 0, updated: 0, unchanged: 0, deleted: 3 });
    expect(await db.catalogProduct.findMany({ where: { shopDomain: OTHER_SHOP } })).toHaveLength(1);
  });

  it("fails loudly when the products query returns errors instead of data", async () => {
    const graphql: AdminGraphql = async () =>
      new Response(JSON.stringify({ errors: [{ message: "shop is locked" }] }));

    await expect(
      ingestCatalog({ db, shopDomain: SHOP, graphql }),
    ).rejects.toThrow(/shop is locked/);
    expect(await db.catalogProduct.findMany()).toHaveLength(0);
  });
});
