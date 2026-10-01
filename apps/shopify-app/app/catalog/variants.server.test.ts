import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractProductsFromPage } from "../playground/jsonld.server";
import {
  deletePublicCatalog,
  playgroundStoreKey,
  snapshotPublicCatalog,
} from "../playground/ingest-public.server";
import type { ShopifyPublicProduct } from "../playground/shopify-public-source.server";
import { mapShopifyPublicProduct } from "../playground/shopify-public-source.server";
import { createTestDb } from "../testing/helpers.server";
import type { AdminGraphql } from "./ingest.server";
import {
  ingestCatalog,
  PRODUCTS_QUERY,
  PRODUCTS_QUERY_WITHOUT_QUANTITY,
} from "./ingest.server";
import type { ShopifyProductNode, ShopifyVariantNode } from "./mapping.server";
import { mapProductNode } from "./mapping.server";
import type { VariantRecord } from "./variants.server";
import { MAX_PRODUCT_VARIANTS, syncProductVariants } from "./variants.server";
import type { ProductWebhookPayload } from "./webhook-sync.server";
import {
  deleteProductFromWebhook,
  syncProductFromWebhook,
} from "./webhook-sync.server";

// Variant capture (YOY-142) on the embedded PGlite DB, every source from
// fixtures — no network anywhere. A fixture product with two options and
// three variants must land as three rows with the right pairs on every
// path; a re-run writes nothing; every product delete takes its variants.

const SHOP = "test-shop.myshopify.com";
const OTHER_SHOP = "other-shop.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.productVariant.deleteMany();
  await db.productImage.deleteMany();
  await db.catalogProduct.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The variant rows of one product, in position order, as plain facts. */
async function variantRows(shopDomain: string, productId: string) {
  const rows = await db.productVariant.findMany({
    where: { shopDomain, productId },
    orderBy: { position: "asc" },
  });
  return rows.map((row) => ({
    variantId: row.variantId,
    position: row.position,
    options: row.options,
    price: row.price,
    available: row.available,
    quantity: row.quantity,
  }));
}

function variant(id: number, options: Array<[string, string]>, extra: Partial<VariantRecord> = {}): VariantRecord {
  return {
    variantId: `v${id}`,
    position: id,
    options: options.map(([name, value]) => ({ name, value })),
    price: 100,
    available: true,
    quantity: null,
    sourceUpdatedAt: null,
    ...extra,
  };
}

describe("syncProductVariants (AC-1, AC-6, AC-8)", () => {
  it("writes each variant once, then writes nothing over an unchanged list", async () => {
    const variants = [
      variant(1, [["Size", "S"], ["Colour", "Black"]]),
      variant(2, [["Size", "M"], ["Colour", "Black"]], { available: false, quantity: 0 }),
      variant(3, [["Size", "L"], ["Colour", "Black"]], { quantity: 4 }),
    ];
    expect(await syncProductVariants({ db, shopDomain: SHOP, productId: PRODUCT, variants })).toEqual({
      written: 3,
      unchanged: 0,
      deleted: 0,
    });
    const before = await db.productVariant.findMany({ orderBy: { position: "asc" } });

    expect(await syncProductVariants({ db, shopDomain: SHOP, productId: PRODUCT, variants })).toEqual({
      written: 0,
      unchanged: 3,
      deleted: 0,
    });
    // Untouched means untouched: same identity, same updatedAt.
    const after = await db.productVariant.findMany({ orderBy: { position: "asc" } });
    expect(after.map((row) => [row.id, row.updatedAt.getTime()])).toEqual(
      before.map((row) => [row.id, row.updatedAt.getTime()]),
    );
  });

  it("rewrites a changed variant and deletes a removed one", async () => {
    await syncProductVariants({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      variants: [variant(1, [["Size", "S"]]), variant(2, [["Size", "M"]]), variant(3, [["Size", "L"]])],
    });
    const counts = await syncProductVariants({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      variants: [variant(1, [["Size", "S"]]), variant(2, [["Size", "M"]], { available: false })],
    });
    expect(counts).toEqual({ written: 1, unchanged: 1, deleted: 1 });
    expect(await variantRows(SHOP, PRODUCT)).toEqual([
      { variantId: "v1", position: 1, options: [{ name: "Size", value: "S" }], price: 100, available: true, quantity: null },
      { variantId: "v2", position: 2, options: [{ name: "Size", value: "M" }], price: 100, available: false, quantity: null },
    ]);
  });

  it("stores option names and values verbatim, in the merchant's order (AC-6)", async () => {
    await syncProductVariants({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      variants: [variant(1, [["מידה", "XS / 34"], ["colour", "Dusty ROSE "], ["Title", "Default Title"]])],
    });
    expect((await variantRows(SHOP, PRODUCT))[0]!.options).toEqual([
      { name: "מידה", value: "XS / 34" },
      { name: "colour", value: "Dusty ROSE " },
      { name: "Title", value: "Default Title" },
    ]);
  });

  it(`keeps at most the first ${MAX_PRODUCT_VARIANTS} variants (NG-3), and a repeated id once`, async () => {
    const many = Array.from({ length: MAX_PRODUCT_VARIANTS + 5 }, (_, i) => variant(i + 1, [["Size", String(i)]]));
    const counts = await syncProductVariants({
      db,
      shopDomain: SHOP,
      productId: PRODUCT,
      variants: [many[0]!, ...many],
    });
    // The duplicate of v1 takes a slot of the 100 and is dropped as a repeat.
    expect(counts.written).toBe(MAX_PRODUCT_VARIANTS - 1);
    expect(await db.productVariant.count()).toBe(MAX_PRODUCT_VARIANTS - 1);
  });

  it("leaves a product with no per-variant data at zero rows, and scopes to its tenant", async () => {
    await syncProductVariants({ db, shopDomain: OTHER_SHOP, productId: PRODUCT, variants: [variant(1, [["Size", "S"]])] });
    expect(await syncProductVariants({ db, shopDomain: SHOP, productId: PRODUCT, variants: [] })).toEqual({
      written: 0,
      unchanged: 0,
      deleted: 0,
    });
    expect(await variantRows(SHOP, PRODUCT)).toEqual([]);
    expect(await variantRows(OTHER_SHOP, PRODUCT)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Admin ingest (AC-2)

function adminVariant(
  id: number,
  size: string,
  colour: string,
  extra: Partial<ShopifyVariantNode> = {},
): ShopifyVariantNode {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    position: id,
    selectedOptions: [
      { name: "Size", value: size },
      { name: "Colour", value: colour },
    ],
    price: "120.00",
    availableForSale: true,
    inventoryQuantity: 3,
    updatedAt: "2026-09-01T10:00:00Z",
    ...extra,
  };
}

function adminNode(id: number, variants: ShopifyVariantNode[]): ShopifyProductNode {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Dress ${id}`,
    handle: `dress-${id}`,
    description: "A dress",
    tags: [],
    vendor: "V",
    productType: "Dresses",
    status: "ACTIVE",
    publishedAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    priceRangeV2: {
      minVariantPrice: { amount: "120.00", currencyCode: "ILS" },
      maxVariantPrice: { amount: "120.00", currencyCode: "ILS" },
    },
    variants: { nodes: variants },
    images: { nodes: [] },
    featuredImage: null,
  };
}

const THREE_ADMIN_VARIANTS = [
  adminVariant(11, "S", "Black"),
  adminVariant(12, "M", "Black", { availableForSale: false, inventoryQuantity: 0 }),
  adminVariant(13, "L", "Black", { price: "130.00" }),
];

/** One-page Admin stub; `refuseQuantity` answers the quantity query the way a missing scope does. */
function adminStub(nodes: ShopifyProductNode[], { refuseQuantity = false } = {}) {
  const queries: string[] = [];
  const graphql: AdminGraphql = async (query) => {
    queries.push(query);
    if (refuseQuantity && query === PRODUCTS_QUERY) {
      return Response.json({
        errors: [
          {
            message: "Access denied for inventoryQuantity field. Required access: `read_inventory` access scope.",
            extensions: { code: "ACCESS_DENIED" },
            path: ["products", "nodes", 0, "variants", "nodes", 0, "inventoryQuantity"],
          },
        ],
      });
    }
    const withoutQuantity = query === PRODUCTS_QUERY_WITHOUT_QUANTITY;
    return Response.json({
      data: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: nodes.map((node) =>
            withoutQuantity
              ? {
                  ...node,
                  variants: {
                    nodes: node.variants.nodes.map((variantNode) => {
                      const copy = { ...variantNode };
                      delete copy.inventoryQuantity;
                      return copy;
                    }),
                  },
                }
              : node,
          ),
        },
      },
    });
  };
  return { graphql, queries };
}

describe("Admin ingest (AC-2, AC-7, AC-8)", () => {
  it("asks for every variant field the table needs", () => {
    for (const field of ["id", "position", "selectedOptions { name value }", "price", "availableForSale", "inventoryQuantity", "updatedAt"]) {
      expect(PRODUCTS_QUERY).toContain(field);
    }
    expect(PRODUCTS_QUERY_WITHOUT_QUANTITY).not.toContain("inventoryQuantity");
  });

  it("stores a two-option, three-variant product as three rows with the right pairs", async () => {
    const { graphql } = adminStub([adminNode(1, THREE_ADMIN_VARIANTS)]);
    const result = await ingestCatalog({ db, shopDomain: SHOP, graphql });
    expect(result.variants).toEqual({ written: 3, unchanged: 0, deleted: 0 });
    expect(await variantRows(SHOP, PRODUCT)).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/11",
        position: 11,
        options: [{ name: "Size", value: "S" }, { name: "Colour", value: "Black" }],
        price: 120,
        available: true,
        quantity: 3,
      },
      {
        variantId: "gid://shopify/ProductVariant/12",
        position: 12,
        options: [{ name: "Size", value: "M" }, { name: "Colour", value: "Black" }],
        price: 120,
        available: false,
        quantity: 0,
      },
      {
        variantId: "gid://shopify/ProductVariant/13",
        position: 13,
        options: [{ name: "Size", value: "L" }, { name: "Colour", value: "Black" }],
        price: 130,
        available: true,
        quantity: 3,
      },
    ]);
  });

  it("re-ingests an unchanged catalog with zero variant writes; a removed variant is deleted", async () => {
    await ingestCatalog({ db, shopDomain: SHOP, graphql: adminStub([adminNode(1, THREE_ADMIN_VARIANTS)]).graphql });
    const rerun = await ingestCatalog({ db, shopDomain: SHOP, graphql: adminStub([adminNode(1, THREE_ADMIN_VARIANTS)]).graphql });
    expect(rerun.variants).toEqual({ written: 0, unchanged: 3, deleted: 0 });

    const shrunk = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: adminStub([adminNode(1, THREE_ADMIN_VARIANTS.slice(0, 2))]).graphql,
    });
    expect(shrunk.variants).toEqual({ written: 0, unchanged: 2, deleted: 1 });
    expect((await variantRows(SHOP, PRODUCT)).map((row) => row.variantId)).toEqual([
      "gid://shopify/ProductVariant/11",
      "gid://shopify/ProductVariant/12",
    ]);
  });

  it("leaves the content hash alone when only a variant changes (NG-4)", async () => {
    const before = mapProductNode(adminNode(1, THREE_ADMIN_VARIANTS)).contentHash;
    const restocked = THREE_ADMIN_VARIANTS.map((v) => ({ ...v, inventoryQuantity: 9, position: (v.position ?? 0) + 1 }));
    expect(mapProductNode(adminNode(1, restocked)).contentHash).toBe(before);
  });

  it("succeeds with quantity null when the API refuses inventoryQuantity", async () => {
    const { graphql, queries } = adminStub([adminNode(1, THREE_ADMIN_VARIANTS)], { refuseQuantity: true });
    const result = await ingestCatalog({ db, shopDomain: SHOP, graphql });
    expect(result.created).toBe(1);
    expect(queries).toEqual([PRODUCTS_QUERY, PRODUCTS_QUERY_WITHOUT_QUANTITY]);
    const rows = await variantRows(SHOP, PRODUCT);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.quantity)).toEqual([null, null, null]);
  });

  it("deletes a product's variants with the product when it leaves the catalog", async () => {
    await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: adminStub([adminNode(1, THREE_ADMIN_VARIANTS), adminNode(2, [adminVariant(21, "S", "Red")])]).graphql,
    });
    const result = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: adminStub([adminNode(2, [adminVariant(21, "S", "Red")])]).graphql,
    });
    expect(result.deleted).toBe(1);
    expect(await variantRows(SHOP, PRODUCT)).toEqual([]);
    expect(await variantRows(SHOP, "gid://shopify/Product/2")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Webhook sync (AC-3, AC-7)

function webhookPayload(overrides: Partial<ProductWebhookPayload> = {}): ProductWebhookPayload {
  const restVariant = (id: number, size: string, quantity: number, price = "120.00") => ({
    id,
    admin_graphql_api_id: `gid://shopify/ProductVariant/${id}`,
    position: id - 10,
    option1: size,
    option2: "Black",
    option3: null,
    updated_at: "2026-09-01T10:00:00Z",
    price,
    inventory_quantity: quantity,
    inventory_policy: "deny",
    inventory_management: "shopify",
  });
  return {
    id: 1,
    admin_graphql_api_id: PRODUCT,
    title: "Dress 1",
    handle: "dress-1",
    body_html: "<p>A dress</p>",
    vendor: "V",
    product_type: "Dresses",
    tags: "",
    status: "active",
    published_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    options: [
      { name: "Size", position: 1 },
      { name: "Colour", position: 2 },
    ],
    variants: [restVariant(11, "S", 3), restVariant(12, "M", 0), restVariant(13, "L", 2, "130.00")],
    images: [],
    image: null,
    ...overrides,
  };
}

describe("webhook sync (AC-3, AC-7)", () => {
  it("pairs option1/2/3 with the product's option names; availability by the variantAvailable rule", async () => {
    expect(await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload() })).toBe("created");
    expect(await variantRows(SHOP, PRODUCT)).toEqual([
      { variantId: "gid://shopify/ProductVariant/11", position: 1, options: [{ name: "Size", value: "S" }, { name: "Colour", value: "Black" }], price: 120, available: true, quantity: 3 },
      // Tracked, deny-oversell, zero stock: not available.
      { variantId: "gid://shopify/ProductVariant/12", position: 2, options: [{ name: "Size", value: "M" }, { name: "Colour", value: "Black" }], price: 120, available: false, quantity: 0 },
      { variantId: "gid://shopify/ProductVariant/13", position: 3, options: [{ name: "Size", value: "L" }, { name: "Colour", value: "Black" }], price: 130, available: true, quantity: 2 },
    ]);
  });

  it("writes nothing on an unchanged redelivery and deletes a removed variant", async () => {
    await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload() });
    const before = await db.productVariant.findMany({ orderBy: { position: "asc" } });
    expect(await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload() })).toBe("unchanged");
    const after = await db.productVariant.findMany({ orderBy: { position: "asc" } });
    expect(after.map((row) => row.updatedAt.getTime())).toEqual(before.map((row) => row.updatedAt.getTime()));

    const payload = webhookPayload();
    payload.variants = payload.variants.slice(0, 1);
    await syncProductFromWebhook({ db, shopDomain: SHOP, payload });
    expect((await variantRows(SHOP, PRODUCT)).map((row) => row.variantId)).toEqual(["gid://shopify/ProductVariant/11"]);
  });

  it("removes the variants on products/delete", async () => {
    await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload() });
    expect(await deleteProductFromWebhook({ db, shopDomain: SHOP, payload: { id: 1 } })).toBe("deleted");
    expect(await variantRows(SHOP, PRODUCT)).toEqual([]);
  });

  it("removes the variants when the product is archived or unpublished", async () => {
    await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload() });
    expect(
      await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload({ status: "archived", updated_at: "2026-09-02T10:00:00Z" }) }),
    ).toBe("deleted");
    expect(await variantRows(SHOP, PRODUCT)).toEqual([]);

    await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload() });
    expect(
      await syncProductFromWebhook({ db, shopDomain: SHOP, payload: webhookPayload({ published_at: null }) }),
    ).toBe("deleted");
    expect(await variantRows(SHOP, PRODUCT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ingest:public over products.json (AC-4, AC-7, AC-8)

const FEED_PRODUCT: ShopifyPublicProduct = {
  id: 7001,
  title: "Linen Dress",
  handle: "linen-dress",
  body_html: "<p>Linen</p>",
  vendor: "V",
  product_type: "Dresses",
  tags: [],
  updated_at: "2026-09-01T10:00:00Z",
  options: [
    { name: "Size", position: 1 },
    { name: "Color", position: 2 },
  ],
  variants: [
    { id: 1, position: 1, option1: "S", option2: "Sand", option3: null, price: "99.00", available: true },
    { id: 2, position: 2, option1: "M", option2: "Sand", option3: null, price: "99.00", available: false },
    { id: 3, position: 3, option1: "L", option2: "Sand", option3: null, price: "109.00", available: true },
  ],
  images: [],
};

const PLAYGROUND = playgroundStoreKey("variants");

describe("ingest:public from products.json (AC-4, AC-7, AC-8)", () => {
  const source = (product: ShopifyPublicProduct) =>
    mapShopifyPublicProduct(product, { origin: "https://store.example", currency: "ILS" });

  it("maps option1/2/3 to the feed's option names, quantity null", () => {
    expect(source(FEED_PRODUCT).variants.map(({ variantId, options, price, available, quantity }) => ({ variantId, options, price, available, quantity }))).toEqual([
      { variantId: "1", options: [{ name: "Size", value: "S" }, { name: "Color", value: "Sand" }], price: 99, available: true, quantity: null },
      { variantId: "2", options: [{ name: "Size", value: "M" }, { name: "Color", value: "Sand" }], price: 99, available: false, quantity: null },
      { variantId: "3", options: [{ name: "Size", value: "L" }, { name: "Color", value: "Sand" }], price: 109, available: true, quantity: null },
    ]);
  });

  it("snapshots three rows, then writes nothing; a removed variant is deleted", async () => {
    const first = await snapshotPublicCatalog({ db, storeKey: PLAYGROUND, products: [source(FEED_PRODUCT)], maxProducts: 10 });
    expect(first.variants).toEqual({ written: 3, unchanged: 0, deleted: 0 });
    expect(await variantRows(PLAYGROUND, "7001")).toHaveLength(3);

    const second = await snapshotPublicCatalog({ db, storeKey: PLAYGROUND, products: [source(FEED_PRODUCT)], maxProducts: 10 });
    expect(second.variants).toEqual({ written: 0, unchanged: 3, deleted: 0 });

    const shrunk = { ...FEED_PRODUCT, variants: FEED_PRODUCT.variants.slice(1) };
    const third = await snapshotPublicCatalog({ db, storeKey: PLAYGROUND, products: [source(shrunk)], maxProducts: 10 });
    expect(third.variants).toEqual({ written: 0, unchanged: 2, deleted: 1 });
  });

  it("deletes a gone product's variants, and a whole catalog's on --delete", async () => {
    const other = { ...FEED_PRODUCT, id: 7002, handle: "other", title: "Other Dress" };
    await snapshotPublicCatalog({ db, storeKey: PLAYGROUND, products: [source(FEED_PRODUCT), source(other)], maxProducts: 10 });
    const result = await snapshotPublicCatalog({ db, storeKey: PLAYGROUND, products: [source(other)], maxProducts: 10 });
    expect(result.deleted).toBe(1);
    expect(await variantRows(PLAYGROUND, "7001")).toEqual([]);
    expect(await variantRows(PLAYGROUND, "7002")).toHaveLength(3);

    const deletion = await deletePublicCatalog({ db, slug: "variants" });
    expect(deletion.variants).toBe(3);
    expect(await db.productVariant.count({ where: { shopDomain: PLAYGROUND } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// JSON-LD crawler (AC-5)

const page = (jsonLd: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body></body></html>`;

describe("JSON-LD crawler (AC-5)", () => {
  it("reads a ProductGroup's variants: variesBy options, per-variant price and availability", () => {
    const html = page({
      "@context": "https://schema.org",
      "@type": "ProductGroup",
      name: "Wrap Dress",
      productGroupID: "WRAP",
      variesBy: ["https://schema.org/size", "https://schema.org/color"],
      hasVariant: [
        { "@type": "Product", sku: "WRAP-S", size: "S", color: "Navy", offers: { "@type": "Offer", price: "80.00", priceCurrency: "EUR", availability: "https://schema.org/InStock" } },
        { "@type": "Product", sku: "WRAP-M", size: "M", color: "Navy", offers: { "@type": "Offer", price: "80.00", priceCurrency: "EUR", availability: "https://schema.org/OutOfStock" } },
        { "@type": "Product", sku: "WRAP-L", size: "L", color: { "@type": "Thing", name: "Navy" }, offers: { "@type": "Offer", price: "85.00", priceCurrency: "EUR", availability: "https://schema.org/InStock" } },
      ],
    });
    const { products } = extractProductsFromPage(html, "https://shop.example/p/wrap");
    expect(products).toHaveLength(1);
    expect(products[0]!.variants).toEqual([
      { variantId: "WRAP-S", position: 1, options: [{ name: "size", value: "S" }, { name: "color", value: "Navy" }], price: 80, available: true, quantity: null, sourceUpdatedAt: null },
      { variantId: "WRAP-M", position: 2, options: [{ name: "size", value: "M" }, { name: "color", value: "Navy" }], price: 80, available: false, quantity: null, sourceUpdatedAt: null },
      { variantId: "WRAP-L", position: 3, options: [{ name: "size", value: "L" }, { name: "color", value: "Navy" }], price: 85, available: true, quantity: null, sourceUpdatedAt: null },
    ]);
  });

  it("reads one row per Offer when a Product lists several", () => {
    const html = page({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Tee",
      offers: [
        { "@type": "Offer", sku: "TEE-1", price: "20", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", sku: "TEE-2", price: "22", priceCurrency: "USD", availability: "https://schema.org/SoldOut" },
      ],
    });
    const [product] = extractProductsFromPage(html, "https://shop.example/p/tee").products;
    expect(product!.variants.map(({ variantId, options, price, available }) => ({ variantId, options, price, available }))).toEqual([
      { variantId: "TEE-1", options: [], price: 20, available: true },
      { variantId: "TEE-2", options: [], price: 22, available: false },
    ]);
  });

  it("yields zero variant rows, and no error, for a page with no per-variant data", async () => {
    const html = page({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Scarf",
      sku: "SCARF",
      offers: { "@type": "Offer", price: "30", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    });
    const { products } = extractProductsFromPage(html, "https://shop.example/p/scarf");
    expect(products[0]!.variants).toEqual([]);
    const counts = await snapshotPublicCatalog({ db, storeKey: PLAYGROUND, products, maxProducts: 10 });
    expect(counts.created).toBe(1);
    expect(counts.variants).toEqual({ written: 0, unchanged: 0, deleted: 0 });
  });
});
