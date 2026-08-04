import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEnrichmentLlmClient, enrichCatalog } from "./catalog/enrich.server";
import { mapProductNode } from "./catalog/mapping.server";
import { productNode } from "./catalog/mapping.test";
import { createTestDb } from "./testing/helpers.server";

// Live enrichment round-trip against the real Gemini API (AC-5 of YOY-22).
// Never run by default and never in CI: requires LIVE_LLM_TESTS=1 and a valid
// GEMINI_API_KEY, e.g. LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm test
const live = process.env.LIVE_LLM_TESTS === "1";

describe.runIf(live)("live catalog enrichment (ledger-backed)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("enriches one real product with the configured model and meters the call", async () => {
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

    const result = await enrichCatalog({
      db,
      shopDomain,
      llm: createEnrichmentLlmClient(db),
    });

    expect(result).toEqual({ enriched: 1, cached: 0, failed: 0 });
    const row = await db.productEnrichment.findFirstOrThrow({
      where: { shopDomain },
    });
    expect(row.status).toBe("enriched");
    expect(row.category).not.toBe("");

    const ledger = await db.aiCall.findMany({
      where: { operation: "enrichment" },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.costUsd).toBeGreaterThan(0);
  });
});
