import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { webhookRequest } from "../testing/helpers.server";

// Route the whole app (shopify.server included) at a throwaway test DB.
vi.mock("../db.server", async () => {
  const { createTestDb } = await import("../testing/helpers.server");
  return { default: await createTestDb() };
});

import db from "../db.server";
import type { ProductWebhookPayload } from "../catalog/webhook-sync.server";
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
    ...overrides,
  };
}

const snapshotRow = () =>
  db.catalogProduct.findUnique({
    where: {
      shopDomain_productId: { shopDomain: SHOP, productId: PRODUCT_GID },
    },
  });

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
