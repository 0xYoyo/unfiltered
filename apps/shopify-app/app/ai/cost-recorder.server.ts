import type { PrismaClient } from "@prisma/client";

import { computeCostUsd } from "./pricing.server";

/**
 * Usage of a single AI call, expressed provider-agnostically: adapters map
 * their vendor SDK's response into this shape before recording.
 */
export interface AiCallUsage {
  /** Provider name, e.g. "google". */
  provider: string;
  /** Provider model ID, e.g. "gemini-2.5-flash". Must exist in the price table. */
  modelId: string;
  /** What the call was for, e.g. "classification", "intent", "enrichment", "embedding". */
  operation: string;
  inputTokens: number;
  outputTokens: number;
  /** Shop the call was made on behalf of, when known. */
  shopDomain?: string;
  /** Correlation ID tying together every call serving one search. */
  searchId?: string;
}

/**
 * Port through which every AI call is metered. Provider adapters depend on
 * this interface only — never on the persistence behind it.
 */
export interface CostRecorder {
  record(usage: AiCallUsage): Promise<void>;
}

/**
 * Prisma-backed CostRecorder: computes the call's USD cost from the committed
 * price table and appends one ledger row. Throws on unknown model IDs before
 * writing anything.
 */
export function createPrismaCostRecorder(db: PrismaClient): CostRecorder {
  return {
    async record(usage: AiCallUsage): Promise<void> {
      const costUsd = computeCostUsd(
        usage.modelId,
        usage.inputTokens,
        usage.outputTokens,
      );
      await db.aiCall.create({
        data: {
          provider: usage.provider,
          modelId: usage.modelId,
          operation: usage.operation,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd,
          shopDomain: usage.shopDomain ?? null,
          searchId: usage.searchId ?? null,
        },
      });
    },
  };
}
