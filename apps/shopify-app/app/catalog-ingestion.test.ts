import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AdminGraphql } from "./catalog/ingest.server";
import { PRODUCTS_QUERY, ingestCatalog } from "./catalog/ingest.server";
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
