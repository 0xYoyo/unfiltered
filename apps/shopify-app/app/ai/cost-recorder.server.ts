import type { PrismaClient } from "@prisma/client";
import type { AiCallUsage, CostRecorder } from "@unfiltered/engine";

import { computeCostUsd } from "./pricing.server";

// The CostRecorder port lives in the engine's public API so provider adapter
// packages can depend on it without knowing this app; re-exported here for
// app-side consumers.
export type { AiCallUsage, CostRecorder };

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
