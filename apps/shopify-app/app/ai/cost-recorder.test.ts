import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  createPrismaCostRecorder,
  createQueuedCostRecorder,
  type AiCallUsage,
} from "./cost-recorder.server";

// The queued ledger (YOY-64 AC-1): a search never waits on the cost insert,
// rows still land, and a failing insert is logged rather than thrown.

const usage: AiCallUsage = {
  provider: "google",
  modelId: "gemini-3.5-flash-lite",
  operation: "intent",
  inputTokens: 100,
  outputTokens: 20,
  storeId: "s",
  searchId: "search-1",
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queued cost recorder", () => {
  // PGlite + migrations in the hook, as orchestrator.test.ts does: under a
  // fully parallel `npm test` the setup alone can approach the 5 s test
  // budget, and this test measures milliseconds.
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("a 500 ms insert adds ~0 ms to the caller, and the row exists after flush", async () => {
    const slow = createPrismaCostRecorder(db);
    const queued = createQueuedCostRecorder({
      async record(entry) {
        await sleep(500);
        await slow.record(entry);
      },
    });

    const startedAt = performance.now();
    await queued.record(usage);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(50);
    expect(queued.pending()).toBe(1);
    expect(await db.aiCall.count()).toBe(0);

    await queued.flush();
    expect(queued.pending()).toBe(0);
    const rows = await db.aiCall.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelId: usage.modelId, searchId: "search-1" });
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
  });

  it("a failing insert is logged and never fails the caller; later writes still land", async () => {
    const inner = createPrismaCostRecorder(db);
    const logged: string[] = [];
    let calls = 0;
    const queued = createQueuedCostRecorder(
      {
        async record(entry) {
          calls += 1;
          if (calls === 1) {
            throw new Error("database gone");
          }
          await inner.record(entry);
        },
      },
      { log: (message) => logged.push(message) },
    );

    await expect(queued.record(usage)).resolves.toBeUndefined();
    await expect(queued.record({ ...usage, searchId: "search-2" })).resolves.toBeUndefined();
    await queued.flush();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("ledger write failed");
    expect(logged[0]).toContain("search-1");
    const rows = await db.aiCall.findMany();
    expect(rows.map((row) => row.searchId)).toEqual(["search-2"]);
  });

  it("still refuses an unpriced model synchronously, before queuing anything", async () => {
    let inserts = 0;
    const queued = createQueuedCostRecorder({
      async record() {
        inserts += 1;
      },
    });
    await expect(queued.record({ ...usage, modelId: "made-up-model" })).rejects.toThrow(
      /made-up-model/,
    );
    await queued.flush();
    expect(inserts).toBe(0);
  });

  it("lands rows in call order even when the inner recorder is slow", async () => {
    const order: string[] = [];
    const queued = createQueuedCostRecorder({
      async record(entry) {
        await sleep(entry.searchId === "a" ? 30 : 1);
        order.push(entry.searchId!);
      },
    });
    await queued.record({ ...usage, searchId: "a" });
    await queued.record({ ...usage, searchId: "b" });
    await queued.flush();
    expect(order).toEqual(["a", "b"]);
  });
});
