import type {
  CostRecorder,
  EmbeddingClient,
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
      const key = recordingKeyFromPrompt(request.prompt);
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
