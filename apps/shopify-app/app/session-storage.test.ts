import type { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "./testing/helpers.server";

// AC-2: Prisma-backed session storage round-trips against a real (throwaway)
// SQLite database — store, load, delete.
describe("Prisma session storage", () => {
  let db: PrismaClient;
  let storage: PrismaSessionStorage<PrismaClient>;

  beforeAll(async () => {
    db = await createTestDb();
    storage = new PrismaSessionStorage(db);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const session = new Session({
    id: "offline_test-shop.myshopify.com",
    shop: "test-shop.myshopify.com",
    state: "",
    isOnline: false,
    scope: "write_products",
    accessToken: "shpat_test_token",
  });

  it("stores and loads a session round-trip", async () => {
    expect(await storage.storeSession(session)).toBe(true);

    const loaded = await storage.loadSession(session.id);
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.shop).toBe(session.shop);
    expect(loaded?.isOnline).toBe(false);
    expect(loaded?.accessToken).toBe("shpat_test_token");

    const rows = await db.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.shop).toBe("test-shop.myshopify.com");
  });

  it("deletes a session", async () => {
    expect(await storage.deleteSession(session.id)).toBe(true);
    expect(await storage.loadSession(session.id)).toBeUndefined();
    expect(await db.session.findMany()).toHaveLength(0);
  });
});
