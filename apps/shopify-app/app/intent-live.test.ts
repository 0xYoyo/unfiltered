import type { PrismaClient } from "@prisma/client";
import { createIntentExtractor, parseIntent } from "@unfiltered/engine";
import {
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import { createTestDb } from "./testing/helpers.server";

// Live intent extraction round-trip against the real Gemini API (AC-2 of
// YOY-25). Never run by default and never in CI: requires LIVE_LLM_TESTS=1
// and a valid GEMINI_API_KEY, e.g. LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm test
const live = process.env.LIVE_LLM_TESTS === "1";

// The AC-3 queries: EN with price cap + color exclusion, the HE equivalent,
// mixed EN/HE, and soft-attributes-only.
const queries = [
  "elegant summer wedding dress, not black, under 400",
  "שמלה אלגנטית לחתונה בקיץ, לא שחור, עד 400",
  "שמלת מקסי elegant לחתונה בקיץ במידה M",
  "something cozy and warm for rainy winter evenings",
];

describe.runIf(live)("live intent extraction (ledger-backed)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("extracts schema-valid intents with the configured accuracy-tier model and meters every call", async () => {
    const shopDomain = "live-test-shop.myshopify.com";
    const extractor = createIntentExtractor({
      llm: createGeminiLlmClient({
        modelId: geminiModelsFromEnv().intentModel,
        costRecorder: createPrismaCostRecorder(db),
      }),
    });

    for (const query of queries) {
      const intent = await extractor.extract(query, { shopDomain });
      // extract() already validated; re-parsing proves the round-tripped
      // object satisfies the schema contract on its own.
      expect(parseIntent(intent), query).not.toBeNull();
    }

    const ledger = await db.aiCall.findMany({
      where: { operation: "intent" },
    });
    expect(ledger.length).toBeGreaterThanOrEqual(queries.length);
    for (const row of ledger) {
      expect(row.costUsd).toBeGreaterThan(0);
    }
  }, 120_000);
});
