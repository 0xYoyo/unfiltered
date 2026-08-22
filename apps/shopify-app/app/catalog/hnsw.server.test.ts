import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  HNSW_ITERATIVE_SCAN,
  TENANT_VECTOR_SCAN_MAX_WAIT_MS,
  TENANT_VECTOR_SCAN_TIMEOUT_MS,
  withTenantVectorScan,
} from "./hnsw.server";

// The tenant vector-scan wrapper (YOY-105, budget per YOY-96 AC-17): one
// transaction, iterative scans switched on inside it, and an explicit
// `{ maxWait, timeout }` instead of Prisma's implicit defaults. Stubbed
// Prisma client — the real-database behavior of the scan itself is covered
// by retrieval-tenant-recall.test.ts.

interface Recorded {
  options: unknown;
  statements: string[];
  order: string[];
}

function stubDb(): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { options: undefined, statements: [], order: [] };
  const tx = {
    $executeRawUnsafe: async (sql: string) => {
      recorded.statements.push(sql);
      recorded.order.push("set-local");
      return 0;
    },
  } as unknown as Prisma.TransactionClient;
  const db = {
    $transaction: async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: unknown,
    ) => {
      recorded.options = options;
      return fn(tx);
    },
  } as unknown as PrismaClient;
  return { db, recorded };
}

describe("withTenantVectorScan", () => {
  it("passes the named default budget to $transaction, sets iterative scans once before the read, and returns the read's value", async () => {
    const { db, recorded } = stubDb();

    const value = await withTenantVectorScan(db, async () => {
      recorded.order.push("read");
      return ["row-1", "row-2"];
    });

    expect(value).toEqual(["row-1", "row-2"]);
    expect(recorded.options).toEqual({
      maxWait: TENANT_VECTOR_SCAN_MAX_WAIT_MS,
      timeout: TENANT_VECTOR_SCAN_TIMEOUT_MS,
    });
    expect(recorded.statements).toEqual([
      `SET LOCAL hnsw.iterative_scan = ${HNSW_ITERATIVE_SCAN}`,
    ]);
    expect(recorded.order).toEqual(["set-local", "read"]);
  });

  it("forwards caller overrides for either bound, keeping the other default", async () => {
    const { db, recorded } = stubDb();
    await withTenantVectorScan(db, async () => null, { timeout: 1_000 });
    expect(recorded.options).toEqual({
      maxWait: TENANT_VECTOR_SCAN_MAX_WAIT_MS,
      timeout: 1_000,
    });
  });

  it("the defaults are deliberate, not Prisma's implicit 2 s / 5 s", () => {
    expect(TENANT_VECTOR_SCAN_MAX_WAIT_MS).toBe(5_000);
    expect(TENANT_VECTOR_SCAN_TIMEOUT_MS).toBe(15_000);
  });
});
