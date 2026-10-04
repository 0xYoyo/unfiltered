import { readFileSync, writeFileSync } from "node:fs";

import {
  type AiCallUsage,
  type CostRecorder,
  type DecisionClient,
  type EmbeddingClient,
  type LlmClient,
} from "@unfiltered/engine";
import {
  createGeminiEmbeddingClient,
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";
import { describe, expect, it } from "vitest";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { createOpenRouterDecisionClient, openRouterModelsFromEnv } from "../ai/openrouter.server";
import { createTestDb } from "../testing/helpers.server";
import {
  runConstructorV2,
  V2_RECORDING_FILES,
  v2RecordingPath,
  type ConstructorV2Ports,
} from "./constructor-v2.server";
import {
  createReplayLlmClient,
  decisionRecordingKey,
  recordingKeyFromRequest,
  type DecisionRecording,
  type EmbeddingRecording,
  type LlmRecording,
  type RecordedCompletion,
  type RecordedDecision,
} from "./replay.server";
import { assertEngineSourceExecution } from "./source-guard.server";

// Recording the Engine v2 Constructor suite (YOY-153 AC-2): one live run of
// the same v2 pipeline the replay suite runs, against Gemini (cards, wish
// extraction, card-section and query vectors) and OpenRouter's Jev (the
// judge's per-product decisions), writing fixtures/recorded/card.json,
// extract.json, judge-jev.json and embeddings-v2.json. The catalog index is
// replayed from the old engine's committed enrichment, vision and product
// vectors, so it is byte-identical to theirs and nothing of theirs is
// re-recorded (NG-2). Never runs by default and never in CI:
//
//   LIVE_LLM_TESTS=1 REGEN_SCOPE=constructor-v2 GEMINI_API_KEY=… OPENROUTER_API_KEY=… \
//     npx vitest run apps/shopify-app/app/eval/constructor-v2-regen.test.ts
//
// from the repository root (the root config resolves the engine from
// source). Then run `npm test`: the replay suite must clear its floor.
const live = process.env.LIVE_LLM_TESTS === "1" && process.env.REGEN_SCOPE === "constructor-v2";

if (live) {
  assertEngineSourceExecution();
}

const ATTEMPTS = 3;
const BACKOFF_MS = 5_000;

async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * attempt));
    }
  }
}

/** A recorder that keeps every metered usage of one call, for its recording. */
function usageSink(): { recorder: CostRecorder; usages: AiCallUsage[] } {
  const usages: AiCallUsage[] = [];
  return {
    usages,
    recorder: {
      async record(usage) {
        usages.push(usage);
      },
    },
  };
}

function readRecording<T>(file: string): T {
  return JSON.parse(readFileSync(v2RecordingPath(file), "utf8")) as T;
}

function write(file: string, value: unknown): void {
  writeFileSync(v2RecordingPath(file), `${JSON.stringify(value, null, 2)}\n`);
}

describe.runIf(live)("Engine v2 Constructor recordings (live, YOY-153 AC-2)", () => {
  it(
    "records cards, extractions, Jev decisions and the new vectors from one live v2 run",
    async () => {
      const db = await createTestDb();
      const ledger = createPrismaCostRecorder(db);
      const models = geminiModelsFromEnv();
      const judgeModelId = openRouterModelsFromEnv().judgeModel;
      const indexEmbeddings = readRecording<EmbeddingRecording>("embeddings.json");

      // The catalog index replays the old engine's recordings byte for byte.
      const indexLlm = createReplayLlmClient({
        recordings: {
          enrichment: readRecording<LlmRecording>("enrichment.json"),
          vision: readRecording<LlmRecording>("vision.json"),
        },
        costRecorder: ledger,
      });
      const recorded: Record<"card" | "extract", Record<string, RecordedCompletion>> = {
        card: {},
        extract: {},
      };
      const liveModel = { card: models.cardModel, extract: models.extractModel } as const;
      const liveThinking = { card: models.cardThinkingLevel, extract: models.extractThinkingLevel } as const;
      const llm: LlmClient = {
        async completeStructured(request) {
          if (request.operation !== "card" && request.operation !== "extract") {
            return indexLlm.completeStructured(request);
          }
          const operation = request.operation;
          const sink = usageSink();
          const client = createGeminiLlmClient({
            modelId: liveModel[operation],
            thinkingLevel: liveThinking[operation],
            costRecorder: sink.recorder,
          });
          const output = await withRetry(() => client.completeStructured(request));
          const usage = sink.usages.at(-1)!;
          recorded[operation][recordingKeyFromRequest(request)] = {
            output,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          };
          await ledger.record(usage);
          return output;
        },
      };

      // Vectors the index already has replay; every new text — card
      // sections and the goldens' raw sentences — is embedded live with the
      // same model and dimension as the committed recording.
      expect(models.embeddingModel).toBe(indexEmbeddings.modelId);
      expect(models.embeddingDimension).toBe(indexEmbeddings.dimension);
      const liveEmbeddings = createGeminiEmbeddingClient({
        modelId: indexEmbeddings.modelId,
        dimension: indexEmbeddings.dimension,
        costRecorder: ledger,
      });
      const newVectors: Record<string, number[]> = {};
      const embeddings: EmbeddingClient = {
        dimension: indexEmbeddings.dimension,
        async embed(request) {
          const missing = [
            ...new Set(request.texts.filter((text) => !(text in indexEmbeddings.vectors) && !(text in newVectors))),
          ];
          if (missing.length > 0) {
            const vectors = await withRetry(() =>
              liveEmbeddings.embed({ ...request, texts: missing }),
            );
            missing.forEach((text, index) => {
              newVectors[text] = vectors[index]!;
            });
          }
          return request.texts.map((text) => indexEmbeddings.vectors[text] ?? newVectors[text]!);
        },
      };

      const decisionsRecorded: Record<string, RecordedDecision> = {};
      const decisionFailures: string[] = [];
      const decisions: DecisionClient = {
        async decide(request) {
          const sink = usageSink();
          const client = createOpenRouterDecisionClient({ modelId: judgeModelId, costRecorder: sink.recorder });
          try {
            const answers = await withRetry(() => client.decide(request));
            const usage = sink.usages.at(-1)!;
            decisionsRecorded[decisionRecordingKey(request)] = {
              answers,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            };
            await ledger.record(usage);
            return answers;
          } catch (error) {
            decisionFailures.push(`${decisionRecordingKey(request)}: ${String(error)}`);
            throw error;
          }
        },
      };

      const ports: ConstructorV2Ports = {
        llm,
        embeddings,
        decisions,
        judgeModelId,
        costRecorder: ledger,
      };
      const result = await runConstructorV2(db, ports);
      // A failed decision would replay as a missing recording: never commit
      // a partial set.
      expect(decisionFailures).toEqual([]);
      expect(result.scores).toHaveLength(30);

      const provenance = "live";
      write(V2_RECORDING_FILES.card, { modelId: models.cardModel, provenance, entries: recorded.card });
      write(V2_RECORDING_FILES.extract, { modelId: models.extractModel, provenance, entries: recorded.extract });
      const judge: DecisionRecording = { modelId: judgeModelId, provider: "openrouter", entries: decisionsRecorded };
      write(V2_RECORDING_FILES.judge, judge);
      const sortedVectors = Object.fromEntries(Object.entries(newVectors).sort(([a], [b]) => a.localeCompare(b)));
      const extra: EmbeddingRecording = {
        modelId: indexEmbeddings.modelId,
        dimension: indexEmbeddings.dimension,
        vectors: sortedVectors,
      };
      write(V2_RECORDING_FILES.embeddings, extra);

      // Live spend: the card, extraction and judge rows (the replayed index
      // meters at its recorded cost and is left out; new vectors are cents).
      const spend = await db.aiCall.aggregate({
        _sum: { costUsd: true },
        where: { operation: { in: ["card", "extract", "judge"] } },
      });
      console.log(
        `recorded ${Object.keys(recorded.card).length} cards, ${Object.keys(recorded.extract).length} extractions, ${Object.keys(decisionsRecorded).length} decisions, ${Object.keys(newVectors).length} vectors — live card + extraction + judge spend $${(spend._sum.costUsd ?? 0).toFixed(4)}`,
      );
    },
    3_600_000,
  );
});
