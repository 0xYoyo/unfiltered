import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { webhookRequest } from "../testing/helpers.server";

// Route the whole app (shopify.server included) at a throwaway test DB.
vi.mock("../db.server", async () => {
  const { createTestDb } = await import("../testing/helpers.server");
  return { default: await createTestDb() };
});

import db from "../db.server";
import type { ProductWebhookPayload } from "../catalog/webhook-sync.server";
import { syncProductFromWebhook } from "../catalog/webhook-sync.server";
import { action as createAction } from "./webhooks.products.create";
import { action as deleteAction } from "./webhooks.products.delete";
import { action as updateAction } from "./webhooks.products.update";

const SHOP = "test-shop.myshopify.com";
const PRODUCT_GID = "gid://shopify/Product/1096001";

const actionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as never;

/** REST-style product payload the way Shopify delivers product webhooks. */
function productPayload(
  overrides: Partial<ProductWebhookPayload> = {},
): Record<string, unknown> {
  return {
    id: 1096001,
    admin_graphql_api_id: PRODUCT_GID,
    title: "Linen overshirt",
    body_html: "<p>Breathable &amp; light</p>",
    vendor: "Unfiltered",
    product_type: "Shirts",
    tags: "linen, summer",
    updated_at: "2026-08-01T10:00:00Z",
    variants: [
      {
        price: "129.00",
        inventory_quantity: 5,
        inventory_policy: "deny",
        inventory_management: "shopify",
      },
      {
        price: "139.00",
        inventory_quantity: 0,
        inventory_policy: "deny",
        inventory_management: "shopify",
      },
    ],
    images: [{ alt: "Model wearing linen overshirt" }, { alt: null }],
    image: { src: "https://cdn.example.com/overshirt.jpg" },
    handle: "linen-overshirt",
    ...overrides,
  };
}

const snapshotRow = () =>
  db.catalogProduct.findUnique({
    where: {
      shopDomain_productId: { shopDomain: SHOP, productId: PRODUCT_GID },
    },
  });

/**
 * A db whose first read observes the snapshot row as absent even though it
 * exists, reproducing the moment a concurrent first delivery wins the create
 * race between this delivery's read and its create.
 */
function raceLosingDb(): typeof db {
  let missedFirstRead = false;
  return {
    catalogProduct: {
      findUnique: (...args: Parameters<typeof db.catalogProduct.findUnique>) => {
        if (!missedFirstRead) {
          missedFirstRead = true;
          return Promise.resolve(null);
        }
        return db.catalogProduct.findUnique(...args);
      },
      create: (...args: Parameters<typeof db.catalogProduct.create>) =>
        db.catalogProduct.create(...args),
      update: (...args: Parameters<typeof db.catalogProduct.update>) =>
        db.catalogProduct.update(...args),
    },
  } as unknown as typeof db;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await db.catalogProduct.deleteMany();
  logSpy?.mockRestore();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("products/create webhook", () => {
  it("inserts a snapshot row mapped through the shared Shopify→snapshot mapping", async () => {
    const response = await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );

    expect(response.status).toBe(200);
    const row = await snapshotRow();
    expect(row).toMatchObject({
      shopDomain: SHOP,
      productId: PRODUCT_GID,
      title: "Linen overshirt",
      description: "Breathable & light",
      tags: ["linen", "summer"],
      vendor: "Unfiltered",
      productType: "Shirts",
      priceMin: 129,
      priceMax: 139,
      available: true,
      imageAltTexts: ["Model wearing linen overshirt"],
      sourceUpdatedAt: new Date("2026-08-01T10:00:00Z"),
    });
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recovers when a concurrent first delivery wins the create race", async () => {
    // Simulate the race deterministically: the winner's delivery has already
    // created the row, but this delivery's first read still observed it as
    // absent, so its create hits the unique constraint and must fall through
    // to the update path instead of failing the webhook.
    await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );
    const winner = await snapshotRow();

    const outcome = await syncProductFromWebhook({
      db: raceLosingDb(),
      shopDomain: SHOP,
      payload: productPayload() as unknown as ProductWebhookPayload,
    });

    expect(outcome).toBe("unchanged");
    expect(await snapshotRow()).toEqual(winner);
  });

  it("applies a newer racing payload through the update path after losing the create race", async () => {
    await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );

    const outcome = await syncProductFromWebhook({
      db: raceLosingDb(),
      shopDomain: SHOP,
      payload: productPayload({
        title: "Linen overshirt — natural",
        updated_at: "2026-08-01T11:00:00Z",
      }) as unknown as ProductWebhookPayload,
    });

    expect(outcome).toBe("updated");
    const row = await snapshotRow();
    expect(row?.title).toBe("Linen overshirt — natural");
    expect(row?.sourceUpdatedAt).toEqual(new Date("2026-08-01T11:00:00Z"));
  });

  it("is idempotent: redelivering the same payload leaves the row untouched", async () => {
    await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );
    const first = await snapshotRow();

    await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );
    const second = await snapshotRow();

    expect(second).toEqual(first);
  });
});

describe("products/update webhook", () => {
  beforeEach(async () => {
    await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );
  });

  it("applies a newer payload and changes the content hash when searchable fields change", async () => {
    const before = await snapshotRow();

    await updateAction(
      actionArgs(
        webhookRequest({
          topic: "products/update",
          shop: SHOP,
          payload: productPayload({
            title: "Linen overshirt — natural",
            updated_at: "2026-08-01T11:00:00Z",
          }),
        }),
      ),
    );

    const after = await snapshotRow();
    expect(after?.title).toBe("Linen overshirt — natural");
    expect(after?.sourceUpdatedAt).toEqual(new Date("2026-08-01T11:00:00Z"));
    expect(after?.contentHash).not.toBe(before?.contentHash);
  });

  it("keeps the content hash when only updated_at changes, but advances sourceUpdatedAt", async () => {
    const before = await snapshotRow();

    await updateAction(
      actionArgs(
        webhookRequest({
          topic: "products/update",
          shop: SHOP,
          payload: productPayload({ updated_at: "2026-08-01T12:00:00Z" }),
        }),
      ),
    );

    const after = await snapshotRow();
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.sourceUpdatedAt).toEqual(new Date("2026-08-01T12:00:00Z"));
  });

  it("ignores an out-of-order payload whose updated_at is older than the stored row", async () => {
    await updateAction(
      actionArgs(
        webhookRequest({
          topic: "products/update",
          shop: SHOP,
          payload: productPayload({
            title: "Stale title from an old delivery",
            updated_at: "2026-08-01T09:00:00Z",
          }),
        }),
      ),
    );

    const row = await snapshotRow();
    expect(row?.title).toBe("Linen overshirt");
    expect(row?.sourceUpdatedAt).toEqual(new Date("2026-08-01T10:00:00Z"));
  });

  it("stores handle and featuredImageUrl from the payload (YOY-44 AC-3)", async () => {
    const row = await snapshotRow();
    expect(row?.handle).toBe("linen-overshirt");
    expect(row?.featuredImageUrl).toBe("https://cdn.example.com/overshirt.jpg");
  });

  it("updates the row when only the featured image changes, with unchanged contentHash (YOY-44 AC-3/AC-4)", async () => {
    const before = await snapshotRow();

    await updateAction(
      actionArgs(
        webhookRequest({
          topic: "products/update",
          shop: SHOP,
          payload: productPayload({
            image: { src: "https://cdn.example.com/overshirt-v2.jpg" },
            updated_at: "2026-08-01T11:00:00Z",
          }),
        }),
      ),
    );

    const after = await snapshotRow();
    expect(after?.featuredImageUrl).toBe(
      "https://cdn.example.com/overshirt-v2.jpg",
    );
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.sourceUpdatedAt).toEqual(new Date("2026-08-01T11:00:00Z"));
  });

  it("updates the row when only the handle changes, with unchanged contentHash (YOY-44 AC-3/AC-4)", async () => {
    const before = await snapshotRow();

    await updateAction(
      actionArgs(
        webhookRequest({
          topic: "products/update",
          shop: SHOP,
          payload: productPayload({
            handle: "linen-overshirt-natural",
            updated_at: "2026-08-01T11:00:00Z",
          }),
        }),
      ),
    );

    const after = await snapshotRow();
    expect(after?.handle).toBe("linen-overshirt-natural");
    expect(after?.contentHash).toBe(before?.contentHash);
  });

  it("still drops a stale delivery even when its display fields differ", async () => {
    await updateAction(
      actionArgs(
        webhookRequest({
          topic: "products/update",
          shop: SHOP,
          payload: productPayload({
            handle: "stale-handle",
            image: { src: "https://cdn.example.com/stale.jpg" },
            updated_at: "2026-08-01T09:00:00Z",
          }),
        }),
      ),
    );

    const row = await snapshotRow();
    expect(row?.handle).toBe("linen-overshirt");
    expect(row?.featuredImageUrl).toBe("https://cdn.example.com/overshirt.jpg");
  });

  it("preserves the ingested currency code, which webhook payloads never carry", async () => {
    await db.catalogProduct.update({
      where: {
        shopDomain_productId: { shopDomain: SHOP, productId: PRODUCT_GID },
      },
      data: { currencyCode: "ILS" },
    });

    await updateAction(
      actionArgs(
        webhookRequest({
          topic: "products/update",
          shop: SHOP,
          payload: productPayload({
            title: "Linen overshirt — natural",
            updated_at: "2026-08-01T11:00:00Z",
          }),
        }),
      ),
    );

    expect((await snapshotRow())?.currencyCode).toBe("ILS");
  });
});

describe("products/delete webhook", () => {
  it("removes the snapshot row and tolerates redelivery", async () => {
    await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );

    const deletePayload = { id: 1096001 };
    const first = await deleteAction(
      actionArgs(
        webhookRequest({ topic: "products/delete", shop: SHOP, payload: deletePayload }),
      ),
    );
    expect(first.status).toBe(200);
    expect(await snapshotRow()).toBeNull();

    const redelivery = await deleteAction(
      actionArgs(
        webhookRequest({ topic: "products/delete", shop: SHOP, payload: deletePayload }),
      ),
    );
    expect(redelivery.status).toBe(200);
  });

  it("removes the product's enrichment record with it (YOY-29 AC-5)", async () => {
    await db.productEnrichment.deleteMany();
    await createAction(
      actionArgs(
        webhookRequest({ topic: "products/create", shop: SHOP, payload: productPayload() }),
      ),
    );
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: PRODUCT_GID,
        contentHash: (await snapshotRow())!.contentHash,
        status: "enriched",
        category: "shirt",
        colors: ["beige"],
        occasions: [],
        fit: null,
        styleTags: [],
        seasons: [],
      },
    });

    const response = await deleteAction(
      actionArgs(
        webhookRequest({ topic: "products/delete", shop: SHOP, payload: { id: 1096001 } }),
      ),
    );

    expect(response.status).toBe(200);
    expect(
      await db.productEnrichment.count({
        where: { shopDomain: SHOP, productId: PRODUCT_GID },
      }),
    ).toBe(0);
  });
});

describe("product webhook HMAC verification", () => {
  const cases = [
    ["products/create", createAction],
    ["products/update", updateAction],
    ["products/delete", deleteAction],
  ] as const;

  it.each(cases)("rejects an invalid HMAC on %s with 401 and writes nothing", async (topic, action) => {
    let thrown: unknown;
    try {
      await action(
        actionArgs(
          webhookRequest({
            topic,
            shop: SHOP,
            payload: productPayload(),
            secret: "wrong-secret",
          }),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
    expect(await db.catalogProduct.findMany()).toHaveLength(0);
  });

  it.each(cases)("rejects a missing HMAC header on %s with 400", async (topic, action) => {
    let thrown: unknown;
    try {
      await action(
        actionArgs(
          webhookRequest({
            topic,
            shop: SHOP,
            payload: productPayload(),
            omitHmac: true,
          }),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(400);
    expect(await db.catalogProduct.findMany()).toHaveLength(0);
  });
});

// Keep the module-level test client from leaking file handles.
afterAll(async () => {
  await db.$disconnect();
});
