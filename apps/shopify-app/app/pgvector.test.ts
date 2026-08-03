import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "./testing/helpers.server";

describe("embedded test database", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("has the pgvector extension queryable", async () => {
    const rows = await db.$queryRawUnsafe<{ v: string }[]>(
      "SELECT '[1,2,3]'::vector::text AS v",
    );
    expect(rows).toEqual([{ v: "[1,2,3]" }]);
  });

  it("computes vector distance", async () => {
    const rows = await db.$queryRawUnsafe<{ d: number }[]>(
      "SELECT '[0,0]'::vector <-> '[3,4]'::vector AS d",
    );
    expect(rows[0].d).toBeCloseTo(5);
  });
});
