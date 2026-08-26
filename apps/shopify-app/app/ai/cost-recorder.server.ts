import type { PrismaClient } from "@prisma/client";
import type { AiCallUsage, CostRecorder } from "@unfiltered/engine";

import { computeCostUsd } from "./pricing.server";

// The CostRecorder port lives in the engine's public API so provider adapter
// packages can depend on it without knowing this app; re-exported here for
// app-side consumers.
export type { AiCallUsage, CostRecorder };

/**
 * A CostRecorder whose writes leave the hot path (YOY-64 AC-1): `record`
 * resolves as soon as the row is queued, the insert runs in the background,
 * and a failed insert is logged — never thrown into the search. `flush`
 * awaits every queued write (tests, and anything that must read the ledger
 * right after a call). Rows still land in order per recorder.
 */
export interface QueuedCostRecorder extends CostRecorder {
  flush(): Promise<void>;
  /** Writes queued but not yet settled (diagnostic). */
  pending(): number;
}

/**
 * Wrap a CostRecorder so the search never waits on the ledger insert. The
 * usage is validated synchronously — an unknown model id still throws at
 * `record`, before anything is queued, because a call that cannot be priced
 * must stay a loud failure — and only the database write is deferred. Each
 * write is chained behind the previous one, so a burst of calls lands in
 * ledger order and a slow database never fans out into many open inserts.
 */
export function createQueuedCostRecorder(
  inner: CostRecorder,
  options: {
    /** Validate the usage before queuing; defaults to pricing it. */
    validate?: (usage: AiCallUsage) => void;
    log?: (message: string, error: unknown) => void;
  } = {},
): QueuedCostRecorder {
  const validate =
    options.validate ??
    ((usage: AiCallUsage) => {
      computeCostUsd(usage.modelId, usage.inputTokens, usage.outputTokens);
    });
  const log =
    options.log ?? ((message, error) => console.error(message, error));
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    async record(usage) {
      validate(usage);
      pending += 1;
      chain = chain
        .then(() => inner.record(usage))
        .catch((error: unknown) => {
          log(
            `[ai-cost] ledger write failed for ${usage.operation} on ${usage.modelId} (search ${usage.searchId ?? "-"}); the call happened but is not in the ledger`,
            error,
          );
        })
        .finally(() => {
          pending -= 1;
        });
    },
    flush() {
      return chain;
    },
    pending: () => pending,
  };
}

/**
 * Prisma-backed CostRecorder: computes the call's USD cost from the committed
 * price table and appends one ledger row. Throws on unknown model IDs before
 * writing anything. Synchronous with the caller — production wraps it in
 * `createQueuedCostRecorder` so the search never waits on the insert.
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
          shopDomain: usage.storeId ?? null,
          searchId: usage.searchId ?? null,
        },
      });
    },
  };
}
