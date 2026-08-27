import type { PrismaClient } from "@prisma/client";
import type { CostRecorder, LlmClient } from "@unfiltered/engine";
import { createQueryClassifier } from "@unfiltered/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import { createTestDb } from "./testing/helpers.server";

// Ledger-backed classification test on the embedded PGlite DB with a fixture
// LLM stub — no network call in the default run (AC-5 of YOY-24). Live
// classification lives in classification-live.test.ts behind LIVE_LLM_TESTS=1.

const SHOP = "test-shop.myshopify.com";

/**
 * Fixture-backed LlmClient stub that — like the real adapter contract —
 * meters every call through the given CostRecorder before answering.
 */
function meteredLlmStub(costRecorder: CostRecorder): LlmClient {
  return {
    async completeStructured(request) {
      await costRecorder.record({
        provider: "google",
        modelId: "gemini-3.5-flash-lite",
        operation: request.operation,
        inputTokens: 100,
        outputTokens: 10,
        storeId: request.storeId,
      });
      return { route: "ai" };
    },
  };
}

describe("classification cost ledger", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("lands one classification ledger row per LLM call through a metered client", async () => {
    const classifier = createQueryClassifier({
      llm: meteredLlmStub(createPrismaCostRecorder(db)),
    });

    // Escalated query: one metered call. Cached repeat: no new row.
    await classifier.classify("שמלה אלגנטית בקיץ לא שחור", {
      storeId: SHOP,
    });
    await classifier.classify("שמלה אלגנטית בקיץ לא שחור", {
      storeId: SHOP,
    });
    // Heuristic fast path: no LLM call, no row.
    await classifier.classify("nike air max 90", { storeId: SHOP });

    const rows = await db.aiCall.findMany({
      where: { operation: "classification" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shopDomain).toBe(SHOP);
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
  });
});
