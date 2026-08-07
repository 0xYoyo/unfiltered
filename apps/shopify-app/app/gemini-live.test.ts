import type { PrismaClient } from "@prisma/client";
import {
  createGeminiEmbeddingClient,
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import { createTestDb } from "./testing/helpers.server";

// Live round-trips against the real Gemini API (AC-6 of YOY-19). Never run by
// default and never in CI: requires LIVE_LLM_TESTS=1 and a valid
// GEMINI_API_KEY in the environment, e.g.
//   LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm test
const live = process.env.LIVE_LLM_TESTS === "1";

// Real accuracy-tier calls legitimately exceed vitest's 5s default timeout
// (YOY-28): give every live round-trip a generous minute.
const LIVE_TEST_TIMEOUT_MS = 60_000;

describe.runIf(live)("live Gemini round-trips (ledger-backed)", () => {
  const models = geminiModelsFromEnv();
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const structuredCases = [
    ["classification", () => models.classificationModel],
    ["intent", () => models.intentModel],
  ] as const;

  it.each(structuredCases)(
    "completes one structured %s call and lands it in the cost ledger",
    async (operation, modelOf) => {
      const modelId = modelOf();
      const client = createGeminiLlmClient({
        modelId,
        costRecorder: createPrismaCostRecorder(db),
      });

      const result = (await client.completeStructured({
        prompt:
          'Classify the product "black evening dress" into exactly one of: clothing, shoes, accessories. Answer as JSON.',
        schema: {
          type: "object",
          properties: { category: { type: "string" } },
          required: ["category"],
        },
        operation,
      })) as { category: string };

      expect(typeof result.category).toBe("string");

      const rows = await db.aiCall.findMany({
        where: { operation, modelId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.inputTokens).toBeGreaterThan(0);
      expect(rows[0]!.costUsd).toBeGreaterThan(0);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it("embeds one batch and lands it in the cost ledger", async () => {
    const client = createGeminiEmbeddingClient({
      modelId: models.embeddingModel,
      dimension: models.embeddingDimension,
      costRecorder: createPrismaCostRecorder(db),
    });

    const vectors = await client.embed({
      texts: ["black evening dress", "שמלת ערב שחורה"],
    });

    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(models.embeddingDimension);
    }

    const rows = await db.aiCall.findMany({ where: { operation: "embedding" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.modelId).toBe(models.embeddingModel);
    expect(rows[0]!.inputTokens).toBeGreaterThan(0);
  }, LIVE_TEST_TIMEOUT_MS);
});
