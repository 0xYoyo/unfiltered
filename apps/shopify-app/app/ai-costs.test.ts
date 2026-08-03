import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route the app (db.server included) at a throwaway embedded test DB, the
// same way webhooks.test.ts does. Route tests live outside app/routes/ per
// the architecture rule (AC-6).
vi.mock("./db.server", async () => {
  const { createTestDb } = await import("./testing/helpers.server");
  return { default: await createTestDb() };
});

import { aggregateCosts } from "./ai/cost-aggregates.server";
import { createPrismaCostRecorder } from "./ai/cost-recorder.server";
import db from "./db.server";
import { loader as costsLoader } from "./routes/internal.costs";

const TOKEN = "test-admin-token";

const loaderArgs = (url: string) =>
  ({ request: new Request(url), params: {}, context: {} }) as never;

const costsRequest = (token?: string) =>
  loaderArgs(
    token === undefined
      ? "https://test-app.example.com/internal/costs"
      : `https://test-app.example.com/internal/costs?token=${token}`,
  );

async function seedFixtureLedger(client: PrismaClient) {
  const recorder = createPrismaCostRecorder(client);
  // Two calls serving search-1, one for search-2, one uncorrelated.
  await recorder.record({
    provider: "google",
    modelId: "gemini-3.5-flash-lite",
    operation: "classification",
    inputTokens: 1000,
    outputTokens: 500,
    shopDomain: "test-shop.myshopify.com",
    searchId: "search-1",
  });
  await recorder.record({
    provider: "google",
    modelId: "gemini-embedding-001",
    operation: "embedding",
    inputTokens: 1_000_000,
    outputTokens: 0,
    searchId: "search-1",
  });
  await recorder.record({
    provider: "google",
    modelId: "gemini-3.5-flash-lite",
    operation: "intent",
    inputTokens: 1000,
    outputTokens: 500,
    searchId: "search-2",
  });
  await recorder.record({
    provider: "google",
    modelId: "gemini-3.5-flash-lite",
    operation: "enrichment",
    inputTokens: 1000,
    outputTokens: 500,
  });
}

beforeEach(async () => {
  await db.aiCall.deleteMany();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

// AC-1 + AC-3: the Prisma-backed recorder persists one ledger row per call
// with the cost computed from the price table.
describe("Prisma cost recorder", () => {
  it("records one row per call with computed USD cost", async () => {
    const recorder = createPrismaCostRecorder(db);
    await recorder.record({
      provider: "google",
      modelId: "gemini-3.5-flash-lite",
      operation: "classification",
      inputTokens: 1000,
      outputTokens: 500,
      shopDomain: "test-shop.myshopify.com",
      searchId: "search-1",
    });

    const rows = await db.aiCall.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.provider).toBe("google");
    expect(row.modelId).toBe("gemini-3.5-flash-lite");
    expect(row.operation).toBe("classification");
    expect(row.inputTokens).toBe(1000);
    expect(row.outputTokens).toBe(500);
    expect(row.costUsd).toBeCloseTo(0.00155, 10);
    expect(row.shopDomain).toBe("test-shop.myshopify.com");
    expect(row.searchId).toBe("search-1");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("stores null for omitted shop domain and search ID", async () => {
    const recorder = createPrismaCostRecorder(db);
    await recorder.record({
      provider: "google",
      modelId: "gemini-3.5-flash-lite",
      operation: "enrichment",
      inputTokens: 10,
      outputTokens: 10,
    });

    const row = (await db.aiCall.findMany())[0]!;
    expect(row.shopDomain).toBeNull();
    expect(row.searchId).toBeNull();
  });

  it("refuses to record a call for an unknown model and writes nothing", async () => {
    const recorder = createPrismaCostRecorder(db);
    await expect(
      recorder.record({
        provider: "google",
        modelId: "made-up-model",
        operation: "classification",
        inputTokens: 10,
        outputTokens: 10,
      }),
    ).rejects.toThrow(/made-up-model/);
    expect(await db.aiCall.findMany()).toHaveLength(0);
  });
});

// AC-4: aggregate queries over fixture rows.
describe("cost aggregates", () => {
  it("totals the ledger by model, operation, and search", async () => {
    await seedFixtureLedger(db);

    const aggregates = await aggregateCosts(db);
    const flashCallCost = 0.00155; // (1000*0.30 + 500*2.50) / 1e6
    const embeddingCost = 0.15; // 1M input tokens at $0.15/MTok

    expect(aggregates.totalCalls).toBe(4);
    expect(aggregates.totalCostUsd).toBeCloseTo(3 * flashCallCost + embeddingCost, 10);

    expect(aggregates.byModel).toEqual([
      expect.objectContaining({ key: "gemini-3.5-flash-lite", calls: 3 }),
      expect.objectContaining({ key: "gemini-embedding-001", calls: 1 }),
    ]);

    expect(aggregates.byOperation.map((group) => group.key)).toEqual([
      "classification",
      "embedding",
      "enrichment",
      "intent",
    ]);

    // Only rows sharing a search ID count toward cost per search.
    expect(aggregates.perSearch).toEqual([
      expect.objectContaining({ key: "search-1", calls: 2 }),
      expect.objectContaining({ key: "search-2", calls: 1 }),
    ]);
    expect(aggregates.perSearch[0]!.costUsd).toBeCloseTo(
      flashCallCost + embeddingCost,
      10,
    );
    expect(aggregates.avgCostPerSearchUsd).toBeCloseTo(
      (2 * flashCallCost + embeddingCost) / 2,
      10,
    );
  });

  it("reports an empty ledger as zero with no per-search mean", async () => {
    const aggregates = await aggregateCosts(db);
    expect(aggregates.totalCalls).toBe(0);
    expect(aggregates.totalCostUsd).toBe(0);
    expect(aggregates.byModel).toEqual([]);
    expect(aggregates.perSearch).toEqual([]);
    expect(aggregates.avgCostPerSearchUsd).toBeNull();
  });
});

// AC-4 + AC-5: the route renders aggregates only for the exact ADMIN_TOKEN
// and is otherwise indistinguishable from a nonexistent route.
describe("/internal/costs route", () => {
  const expect404 = async (args: never) => {
    let thrown: unknown;
    try {
      await costsLoader(args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect(await (thrown as Response).text()).toBe("Not Found");
  };

  it("returns aggregates from seeded fixture rows with the correct token", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    await seedFixtureLedger(db);

    const aggregates = await costsLoader(costsRequest(TOKEN));
    expect(aggregates.totalCalls).toBe(4);
    expect(aggregates.byModel.map((group) => group.key)).toContain(
      "gemini-3.5-flash-lite",
    );
  });

  it("responds 404 with no token", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    await expect404(costsRequest());
  });

  it("responds 404 with a wrong token", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    await expect404(costsRequest("wrong-token"));
  });

  it("responds 404 when ADMIN_TOKEN is unset, even with a token presented", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    delete process.env.ADMIN_TOKEN;
    await expect404(costsRequest(TOKEN));
  });
});
