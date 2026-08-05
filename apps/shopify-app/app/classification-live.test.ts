import type { PrismaClient } from "@prisma/client";
import { createQueryClassifier } from "@unfiltered/engine";
import {
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import { createTestDb } from "./testing/helpers.server";

// Live classification round-trip against the real Gemini API (AC-5 of
// YOY-24). Never run by default and never in CI: requires LIVE_LLM_TESTS=1
// and a valid GEMINI_API_KEY, e.g. LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm test
const live = process.env.LIVE_LLM_TESTS === "1";

describe.runIf(live)("live query classification (ledger-backed)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("classifies a natural-language Hebrew query with the configured model and meters the call", async () => {
    const shopDomain = "live-test-shop.myshopify.com";
    const classifier = createQueryClassifier({
      llm: createGeminiLlmClient({
        modelId: geminiModelsFromEnv().classificationModel,
        costRecorder: createPrismaCostRecorder(db),
      }),
      // Generous timeout for a live round-trip; the default is tuned for
      // production fail-safety, not real network latency in a test.
      timeoutMs: 30_000,
    });

    const decision = await classifier.classify(
      "שמלה אלגנטית לחתונה בקיץ לא שחור",
      { shopDomain },
    );
    expect(decision).toEqual({ route: "ai", reason: "model" });

    const ledger = await db.aiCall.findMany({
      where: { operation: "classification" },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.costUsd).toBeGreaterThan(0);
  });
});
