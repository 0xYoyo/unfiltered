import { createHash } from "node:crypto";

import type {
  CostRecorder,
  DecisionAnswer,
  DecisionClient,
  DecisionRequest,
  EmbeddingClient,
  InlineImage,
  LlmClient,
} from "@unfiltered/engine";

/**
 * Replay clients for the eval harness: they answer every port call from the
 * recorded fixture outputs in fixtures/recorded/ and meter each answered call
 * through the cost ledger with the recorded model ID and token counts — so an
 * eval run is fully deterministic and offline, yet lands the same ledger rows
 * a live run would (AC-2, AC-4).
 *
 * Recordings are keyed by stable content extracted from each request — the
 * product title for enrichment, the query line for classification and intent,
 * the exact text for embeddings — so prompt-wording changes don't orphan
 * recordings. A missing recording always throws: silently skipping a call
 * would hide a coverage gap in the fixtures.
 */

/** One recorded LLM completion — or a recorded failure (YOY-116). */
export interface RecordedCompletion {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  /**
   * The live call failed with this error name (a timeout, say) after every
   * retry; replaying it throws the same way instead of answering, so the
   * lite-first ladder's `lite-error` escalation is scored on what the
   * model actually did. Recorded only for the lite tier; `output` is null.
   */
  error?: string;
}

/** One operation's recorded completions, keyed by extracted request content. */
export interface LlmRecording {
  modelId: string;
  /**
   * Where the outputs came from: `"live"` (recorded from the real model by
   * the regenerate flow) or `"synthesized"` (hand-written in the vocabulary
   * the prompts request, pending a live regeneration). Absent means live.
   */
  provenance?: "live" | "synthesized";
  entries: Record<string, RecordedCompletion>;
}

/** Recorded embedding vectors, keyed by the exact embedded text. */
export interface EmbeddingRecording {
  modelId: string;
  dimension: number;
  vectors: Record<string, number[]>;
}

const PROVIDER = "google";

/** Extract the recording key from a prompt: enrichment prompts carry a
 * `Title:` line, classification and intent prompts a `Query:` line. */
export function recordingKeyFromPrompt(prompt: string): string {
  const match = /^(?:Title|Query): (.*)$/m.exec(prompt);
  if (match === null) {
    throw new Error(
      `eval replay: prompt carries no Title/Query line to key a recording by:\n${prompt.slice(0, 200)}`,
    );
  }
  return match[1]!;
}

/**
 * The recording key for one completion request. A text-only request keys by
 * its `Title:`/`Query:` line exactly as before; a request that carries images
 * (the vision pass) appends a digest of the ordered image bytes (YOY-125
 * AC-14).
 *
 * Keying vision answers by the bare title let two catalog products with the
 * same title but different photos share one recorded answer — the second
 * scored on the first product's image. The builder hit exactly that collision
 * regenerating the PR #128 fixtures and worked around it by renaming two
 * products; the digest makes the collision impossible instead. The recorder
 * and the replay client both call this, so the two can never disagree.
 */
export function recordingKeyFromRequest(request: {
  prompt: string;
  images?: readonly InlineImage[];
}): string {
  const title = recordingKeyFromPrompt(request.prompt);
  const images = request.images ?? [];
  if (images.length === 0) {
    return title;
  }
  const digest = createHash("sha256");
  for (const image of images) {
    digest.update(image.data);
  }
  // Short digest: enough to separate distinct image sets, short enough to
  // keep the fixture file readable.
  return `${title}#${digest.digest("hex").slice(0, 16)}`;
}

/** Replay LlmClient over per-operation recordings. */
export function createReplayLlmClient({
  recordings,
  costRecorder,
}: {
  recordings: Record<string, LlmRecording>;
  costRecorder: CostRecorder;
}): LlmClient {
  return {
    async completeStructured(request) {
      const recording = recordings[request.operation];
      if (recording === undefined) {
        throw new Error(
          `eval replay: no recording file for operation "${request.operation}"`,
        );
      }
      const key = recordingKeyFromRequest(request);
      const entry = recording.entries[key];
      if (entry === undefined) {
        throw new Error(
          `eval replay: no recorded ${request.operation} completion for key "${key}" — regenerate the eval fixtures`,
        );
      }
      await costRecorder.record({
        provider: PROVIDER,
        modelId: recording.modelId,
        operation: request.operation,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        storeId: request.storeId,
        searchId: request.searchId,
      });
      if (entry.error !== undefined) {
        // A recorded failure replays as the failure it was — the ledger row
        // above matches a live hung call, which is metered by nothing.
        const error = new Error(`eval replay: recorded ${entry.error} for key "${key}"`);
        error.name = entry.error;
        throw error;
      }
      return structuredClone(entry.output);
    },
  };
}

/** Replay EmbeddingClient over recorded vectors, metered like the real
 * adapter: one ledger row per embed() call with ~4-chars-per-token input. */
export function createReplayEmbeddingClient({
  recording,
  costRecorder,
}: {
  recording: EmbeddingRecording;
  costRecorder: CostRecorder;
}): EmbeddingClient {
  return {
    dimension: recording.dimension,
    async embed(request) {
      const vectors = request.texts.map((text) => {
        const vector = recording.vectors[text];
        if (vector === undefined) {
          throw new Error(
            `eval replay: no recorded embedding for text "${text.slice(0, 80)}" — regenerate the eval fixtures`,
          );
        }
        return vector;
      });
      const chars = request.texts.reduce((sum, text) => sum + text.length, 0);
      await costRecorder.record({
        provider: PROVIDER,
        modelId: recording.modelId,
        operation: request.operation ?? "embedding",
        inputTokens: Math.ceil(chars / 4),
        outputTokens: 0,
        storeId: request.storeId,
        searchId: request.searchId,
      });
      return vectors;
    },
  };
}

/** One recorded decision-model answer (YOY-153 AC-2): the typed answers per question key. */
export interface RecordedDecision {
  answers: Record<string, DecisionAnswer>;
  inputTokens: number;
  outputTokens: number;
}

/** A decision model's recorded answers (the Jev judge), keyed by `decisionRecordingKey`. */
export interface DecisionRecording {
  modelId: string;
  /** The ledger provider the live adapter meters under ("openrouter"). */
  provider: string;
  entries: Record<string, RecordedDecision>;
}

/**
 * The recording key for one decision request (YOY-153 AC-2): the search
 * text, for a readable fixture, plus a digest of the whole request — the
 * state (search, product row, any previous search) and the questions — so
 * a changed product row or question set is a missing recording, never a
 * stale answer. The recorder and the replay client both call this.
 */
export function decisionRecordingKey(request: Pick<DecisionRequest, "state" | "questions">): string {
  const search =
    typeof request.state === "string"
      ? request.state
      : typeof request.state.search === "string"
        ? request.state.search
        : "";
  const digest = createHash("sha256")
    .update(JSON.stringify({ state: request.state, questions: request.questions }))
    .digest("hex")
    .slice(0, 16);
  return `${search}#${digest}`;
}

/** Replay DecisionClient over recorded answers, metered like the live adapter. */
export function createReplayDecisionClient({
  recording,
  costRecorder,
}: {
  recording: DecisionRecording;
  costRecorder: CostRecorder;
}): DecisionClient {
  return {
    async decide(request) {
      const key = decisionRecordingKey(request);
      const entry = recording.entries[key];
      if (entry === undefined) {
        throw new Error(
          `eval replay: no recorded ${request.operation} decision for key "${key}" — regenerate the eval fixtures`,
        );
      }
      await costRecorder.record({
        provider: recording.provider,
        modelId: recording.modelId,
        operation: request.operation,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        storeId: request.storeId,
        searchId: request.searchId,
      });
      return structuredClone(entry.answers);
    },
  };
}
