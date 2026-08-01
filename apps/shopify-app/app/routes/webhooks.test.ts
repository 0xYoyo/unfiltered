import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { webhookRequest } from "../testing/helpers.server";

// Route the whole app (shopify.server included) at a throwaway test DB.
vi.mock("../db.server", async () => {
  const { createTestDb } = await import("../testing/helpers.server");
  return { default: await createTestDb() };
});

import db from "../db.server";
import { action as uninstalledAction } from "./webhooks.app.uninstalled";
import { action as dataRequestAction } from "./webhooks.customers.data_request";
import { action as customersRedactAction } from "./webhooks.customers.redact";
import { action as shopRedactAction } from "./webhooks.shop.redact";

const SHOP = "test-shop.myshopify.com";

async function seedSession(client: PrismaClient) {
  await client.session.create({
    data: {
      id: `offline_${SHOP}`,
      shop: SHOP,
      state: "",
      isOnline: false,
      scope: "write_products",
      accessToken: "shpat_test_token",
    },
  });
}

const actionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as never;

describe("webhook HMAC verification", () => {
  beforeEach(async () => {
    await db.session.deleteMany();
  });

  it("accepts a correctly signed app/uninstalled payload and deletes the shop's sessions", async () => {
    await seedSession(db);

    const response = await uninstalledAction(
      actionArgs(webhookRequest({ topic: "app/uninstalled", shop: SHOP })),
    );

    expect(response.status).toBe(200);
    expect(await db.session.findMany({ where: { shop: SHOP } })).toHaveLength(0);
  });

  it("rejects an invalid HMAC with 401 and never executes the handler", async () => {
    await seedSession(db);

    let thrown: unknown;
    try {
      await uninstalledAction(
        actionArgs(
          webhookRequest({
            topic: "app/uninstalled",
            shop: SHOP,
            secret: "wrong-secret",
          }),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
    // Handler body never ran: the seeded session row is untouched.
    expect(await db.session.findMany({ where: { shop: SHOP } })).toHaveLength(1);
  });

  it("rejects a missing HMAC header with 400 and never executes the handler", async () => {
    await seedSession(db);

    let thrown: unknown;
    try {
      await uninstalledAction(
        actionArgs(
          webhookRequest({ topic: "app/uninstalled", shop: SHOP, omitHmac: true }),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    // The auth library answers a wrong signature with 401 and an absent
    // X-Shopify-Hmac-Sha256 header with 400; both reject before the handler.
    expect((thrown as Response).status).toBe(400);
    expect(await db.session.findMany({ where: { shop: SHOP } })).toHaveLength(1);
  });
});

describe("mandatory GDPR webhook handlers", () => {
  const cases = [
    ["customers/data_request", dataRequestAction],
    ["customers/redact", customersRedactAction],
    ["shop/redact", shopRedactAction],
  ] as const;

  it.each(cases)("responds 200 to a signed %s webhook", async (topic, action) => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await action(
      actionArgs(webhookRequest({ topic, shop: SHOP })),
    );

    expect(response.status).toBe(200);
    // The auth library normalizes topics to their event-name form.
    const normalizedTopic = topic.toUpperCase().replace(/\//g, "_");
    expect(logSpy).toHaveBeenCalledWith(
      `Received ${normalizedTopic} webhook for ${SHOP}`,
    );
    logSpy.mockRestore();
  });

  it.each(cases)("rejects an unsigned %s webhook with 401", async (topic, action) => {
    let thrown: unknown;
    try {
      await action(
        actionArgs(webhookRequest({ topic, shop: SHOP, secret: "wrong-secret" })),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });
});

// Keep the module-level test client from leaking file handles.
afterAll(async () => {
  await db.$disconnect();
});
