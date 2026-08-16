import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCatalogEmbeddingClient,
  embedCatalog,
  similarProducts,
} from "./catalog/embed.server";
import { mapProductNode } from "./catalog/mapping.server";
import { productNode } from "./catalog/mapping.test";
import { createTestDb } from "./testing/helpers.server";

// Live embedding round-trip against the real Gemini API (AC-5 of YOY-23).
// Never run by default and never in CI: requires LIVE_LLM_TESTS=1 and a valid
// GEMINI_API_KEY, e.g. LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm test
const live = process.env.LIVE_LLM_TESTS === "1";

describe.runIf(live)("live catalog embedding (ledger-backed)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("embeds one real product with the configured model, meters the call, and finds it by similarity", async () => {
    const shopDomain = "live-test-shop.myshopify.com";
    await db.catalogProduct.create({
      data: {
        shopDomain,
        ...mapProductNode(
          productNode({
            id: "gid://shopify/Product/1",
            title: "שמלת ערב שחורה",
            description: "שמלת מקסי אלגנטית לאירועי ערב",
          }),
        ),
      },
    });

    const embeddings = createCatalogEmbeddingClient(db);
    const result = await embedCatalog({ db, shopDomain, embeddings });
    expect(result).toEqual({ embedded: 1, cached: 0, deleted: 0 });

    const [queryVector] = await embeddings.embed({
      texts: ["elegant black evening dress"],
      storeId: shopDomain,
    });
    const hits = await similarProducts({
      db,
      shopDomain,
      vector: queryVector!,
    });
    expect(hits.map((hit) => hit.productId)).toEqual([
      "gid://shopify/Product/1",
    ]);

    const ledger = await db.aiCall.findMany({
      where: { operation: "embedding" },
    });
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    for (const row of ledger) {
      expect(row.costUsd).toBeGreaterThan(0);
    }
  });
});
