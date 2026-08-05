import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  composeQueryText,
  createIntentExtractor,
  createQueryClassifier,
  normalizeQuery,
  parseIntent,
  type AiCallUsage,
  type CostRecorder,
  type LlmClient,
  type StructuredCompletionRequest,
} from "@unfiltered/engine";
import {
  createGeminiEmbeddingClient,
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { composeEmbeddingText } from "../catalog/embed.server";
import {
  buildEnrichmentPrompt,
  ENRICHMENT_SCHEMA,
  parseEnrichment,
} from "../catalog/enrich.server";
import { computeContentHash } from "../catalog/mapping.server";
import { createTestDb } from "../testing/helpers.server";
import { loadCatalog, loadGoldens } from "./harness.server";
import { recordingKeyFromPrompt } from "./replay.server";

// Fixture regeneration (AC-5 of YOY-27): re-records every eval fixture output
// — enrichments, classifications, intents, embeddings — against the live
// Gemini APIs and rewrites fixtures/recorded/*.json in place. Never runs by
// default and never in CI: requires LIVE_LLM_TESTS=1 and a local
// GEMINI_API_KEY. After a successful run, re-run `npm test` to prove the
// harness still clears the bar on fresh recordings, then commit the JSONs.
const live = process.env.LIVE_LLM_TESTS === "1";

const recordedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "recorded",
);

interface RecordedEntry {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
}

/** Wrap a CostRecorder so the last recorded usage is observable. */
function captureUsage(inner: CostRecorder): {
  recorder: CostRecorder;
  last: () => AiCallUsage;
} {
  let lastUsage: AiCallUsage | null = null;
  return {
    recorder: {
      async record(usage) {
        lastUsage = usage;
        await inner.record(usage);
      },
    },
    last: () => {
      if (lastUsage === null) {
        throw new Error("no usage captured — the live call never metered");
      }
      return lastUsage;
    },
  };
}

/** Wrap an LlmClient so each request/response lands in a recording map. */
function captureCompletions(
  inner: LlmClient,
  usage: () => AiCallUsage,
  entries: Record<string, RecordedEntry>,
): LlmClient {
  return {
    async completeStructured(request: StructuredCompletionRequest) {
      const response = await inner.completeStructured(request);
      const called = usage();
      entries[recordingKeyFromPrompt(request.prompt)] = {
        output: response,
        inputTokens: called.inputTokens,
        outputTokens: called.outputTokens,
      };
      return response;
    },
  };
}

function writeRecording(
  file: string,
  modelId: string,
  entries: Record<string, RecordedEntry>,
): void {
  writeFileSync(
    join(recordedDir, file),
    `${JSON.stringify({ modelId, entries }, null, 2)}\n`,
  );
}

describe.runIf(live)("eval fixture regeneration (live)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("re-records enrichments, classifications, intents, and embeddings", async () => {
    const models = geminiModelsFromEnv();
    const catalog = loadCatalog();
    const goldens = loadGoldens();
    const usage = captureUsage(createPrismaCostRecorder(db));

    // Enrichment: the classification-tier model over every sparse product.
    const enrichmentEntries: Record<string, RecordedEntry> = {};
    const enrichmentLlm = captureCompletions(
      createGeminiLlmClient({
        modelId: models.classificationModel,
        costRecorder: usage.recorder,
      }),
      usage.last,
      enrichmentEntries,
    );
    const attributesByProduct = new Map<string, ReturnType<typeof parseEnrichment>>();
    for (const { sourceUpdatedAt, ...product } of catalog) {
      void sourceUpdatedAt; // not part of the enrichment input
      const completion = await enrichmentLlm.completeStructured({
        prompt: buildEnrichmentPrompt({
          ...product,
          contentHash: computeContentHash(product),
        }),
        schema: ENRICHMENT_SCHEMA,
        operation: "enrichment",
      });
      const attributes = parseEnrichment(completion);
      expect(attributes, `enrichment for ${product.productId}`).not.toBeNull();
      attributesByProduct.set(product.productId, attributes);
    }
    writeRecording("enrichment.json", models.classificationModel, enrichmentEntries);

    // Classification: through the real classifier so heuristics and prompt
    // wording match the harness exactly; only model-answered queries record.
    const classificationEntries: Record<string, RecordedEntry> = {};
    const classifier = createQueryClassifier({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.classificationModel,
          costRecorder: usage.recorder,
        }),
        usage.last,
        classificationEntries,
      ),
      timeoutMs: 30_000,
    });
    for (const golden of goldens) {
      const decision = await classifier.classify(golden.query);
      expect(decision.reason, `${golden.id} must reach the model`).toBe("model");
      expect(
        classificationEntries[normalizeQuery(golden.query)],
        `${golden.id} classification recorded`,
      ).toBeDefined();
    }
    writeRecording(
      "classification.json",
      models.classificationModel,
      classificationEntries,
    );

    // Intent: the accuracy-tier model per golden query.
    const intentEntries: Record<string, RecordedEntry> = {};
    const extractor = createIntentExtractor({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.intentModel,
          costRecorder: usage.recorder,
        }),
        usage.last,
        intentEntries,
      ),
    });
    const intents = new Map<string, NonNullable<ReturnType<typeof parseIntent>>>();
    for (const golden of goldens) {
      intents.set(golden.id, await extractor.extract(golden.query));
      expect(intentEntries[golden.query], `${golden.id} intent recorded`).toBeDefined();
    }
    writeRecording("intent.json", models.intentModel, intentEntries);

    // Embeddings: every product composed text (with the fresh enrichment
    // attributes) and every query text derived from the fresh intents.
    const embeddings = createGeminiEmbeddingClient({
      modelId: models.embeddingModel,
      dimension: models.embeddingDimension,
      costRecorder: usage.recorder,
    });
    const texts = [
      ...catalog.map((product) =>
        composeEmbeddingText(
          product,
          attributesByProduct.get(product.productId) ?? null,
        ),
      ),
      ...goldens.map((golden) => composeQueryText(intents.get(golden.id)!)),
    ];
    const unique = [...new Set(texts)];
    const vectors: Record<string, number[]> = {};
    const BATCH = 100;
    for (let start = 0; start < unique.length; start += BATCH) {
      const batch = unique.slice(start, start + BATCH);
      const batchVectors = await embeddings.embed({ texts: batch });
      batch.forEach((text, index) => {
        vectors[text] = batchVectors[index]!;
      });
    }
    writeFileSync(
      join(recordedDir, "embeddings.json"),
      `${JSON.stringify(
        {
          modelId: models.embeddingModel,
          dimension: models.embeddingDimension,
          vectors,
        },
        null,
        2,
      )}\n`,
    );

    expect(Object.keys(enrichmentEntries)).toHaveLength(catalog.length);
    expect(Object.keys(intentEntries)).toHaveLength(goldens.length);
    expect(Object.keys(vectors)).toHaveLength(unique.length);
  }, 900_000);
});
