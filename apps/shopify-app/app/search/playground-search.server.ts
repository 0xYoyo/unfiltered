import { PLAYGROUND_RESULT_LIMIT } from "../playground/api.server";
import type { SearchOrchestrator, SearchPaging, SearchResponse } from "./orchestrator.server";
import type { RemovedChip } from "./wishes.server";

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
  /** A playground guard tripped: find order, no judge spend. */
  limited?: boolean;
  /** One page of results (YOY-145 AC-4); `limit` is then ignored. */
  paging?: SearchPaging;
  /** Chips removed from a previous response (YOY-149 AC-15). */
  removedChips?: RemovedChip[];
  /** The previous response's `carry` (YOY-150 AC-1). */
  previousQuery?: string;
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
    ...(input.paging !== undefined ? { paging: input.paging } : {}),
    ...(input.removedChips !== undefined && input.preview !== true && input.classic !== true
      ? { removedChips: input.removedChips }
      : {}),
    ...(input.previousQuery !== undefined && input.preview !== true && input.classic !== true
      ? { previousQuery: input.previousQuery }
      : {}),
    ...(input.preview === true
      ? { preview: true }
      : input.classic === true
        ? { forceClassic: true, forceClassicReason: "client-timeout-rescue" }
        : input.limited === true
          ? { forceClassic: true }
          : {}),
  });
  return { response, latencyMs: Date.now() - startedAt };
}
