import type { Intent } from "@unfiltered/engine";

import { PLAYGROUND_RESULT_LIMIT } from "../playground/api.server";
import type { SearchOrchestrator, SearchResponse } from "./orchestrator.server";

/**
 * The playground's one search call (YOY-140 AC-6): the mode-to-request
 * mapping and the timed orchestrator run that `/api/playground/search`
 * performs, extracted so the score runner searches exactly the way the
 * playground does. Guards, logging, and serialization stay in the route —
 * they are the endpoint's, not the search's.
 */
export interface PlaygroundSearchInput {
  query: string;
  /** Tenant key of the catalog searched. */
  storeKey: string;
  /** Primary-hit cap; the playground's own cap when absent. */
  limit?: number;
  /** Keystroke preview: classic-only, zero LLM calls. */
  preview?: boolean;
  /** Classic rescue of a search that timed out client-side. */
  classic?: boolean;
  /** A playground guard tripped: forced classic, no AI spend. */
  limited?: boolean;
  /** Chip removal: search with this intent as-is. */
  resolvedIntent?: Intent;
  /** Refinement: the session's previous intent. */
  previousIntent?: Intent;
}

export interface PlaygroundSearchResult {
  response: SearchResponse;
  latencyMs: number;
}

export async function runPlaygroundSearch(
  orchestrator: SearchOrchestrator,
  input: PlaygroundSearchInput,
): Promise<PlaygroundSearchResult> {
  const startedAt = Date.now();
  const response = await orchestrator.runSearch({
    query: input.query,
    shopDomain: input.storeKey,
    limit: input.limit ?? PLAYGROUND_RESULT_LIMIT,
    ...(input.preview === true
      ? { preview: true }
      : input.classic === true
        ? { forceClassic: true, forceClassicReason: "client-timeout-rescue" }
        : input.limited === true
          ? { forceClassic: true }
          : input.resolvedIntent !== undefined
            ? { resolvedIntent: input.resolvedIntent }
            : input.previousIntent !== undefined
              ? { previousIntent: input.previousIntent }
              : {}),
  });
  return { response, latencyMs: Date.now() - startedAt };
}
