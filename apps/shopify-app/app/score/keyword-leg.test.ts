import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { StructuredCompletionRequest } from "@unfiltered/engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPrismaCostRecorder, createQueuedCostRecorder } from "../ai/cost-recorder.server";
import { resetPendingLabels } from "../search/judge-step.server";
import { runPlaygroundSearch } from "../search/playground-search.server";
import { createProxySearchOrchestrator } from "../search/proxy.server";
import { createTestDb } from "../testing/helpers.server";
import { createRunnerOrchestrator, keywordLegFromEnv } from "./cli.server";
import { SCORE_RESULT_LIMIT } from "./run.server";

// The runner-only keyword-leg switch (YOY-176 AC-2): `FIND_KEYWORD_LEG=off`
// takes the find step's keyword half away on the score runner's
// orchestrator, and the proxy factory ignores it. Offline and $0: the
// Gemini clients are fakes, and `JUDGE_PROVIDER=none` builds no judge.
//
// Every card vector sits nearest to p1, so the vector half orders
// p1, p2, p3. "Dear Dress" is p3's exact title: only the keyword half
// (a strong title match leads the merged order) can put p3 first.

const DIMENSION = 3;
const SHOP = "keyword-leg-shop.myshopify.com";

vi.mock("@unfiltered/provider-gemini", async (importActual) => {
  const actual = await importActual<typeof import("@unfiltered/provider-gemini")>();
  return {
    ...actual,
    createGeminiEmbeddingClient: () => ({
      dimension: DIMENSION,
      embed: async ({ texts }: { texts: string[] }) => texts.map(() => [1, 0, 0]),
    }),
    createGeminiLlmClient: () => ({
      async completeStructured(request: StructuredCompletionRequest) {
        if (request.operation === "extract") {
          return { excluded: [] };
        }
        throw new Error(`unexpected ${request.operation} call`);
      },
    }),
  };
});

async function seed(db: PrismaClient, products: { productId: string; title: string }[]) {
  for (const [index, product] of products.entries()) {
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: product.productId,
        title: product.title,
        description: "",
        tags: [],
        vendor: "fixture",
        productType: "",
        priceMin: 50,
        priceMax: 50,
        currencyCode: "USD",
        available: true,
        imageAltTexts: [],
        sourceUpdatedAt: new Date(),
        contentHash: `hash-${product.productId}`,
      },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
       VALUES ($1, $2, $3, 'prose', 'h', $4::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
      randomUUID(),
      SHOP,
      product.productId,
      `[1,${(index + 1) / 10},0]`,
    );
  }
}

describe("keywordLegFromEnv (YOY-176 AC-2)", () => {
  it("is on when unset or on, off only for off, and refuses anything else", () => {
    expect(keywordLegFromEnv({})).toBe(true);
    expect(keywordLegFromEnv({ FIND_KEYWORD_LEG: "on" })).toBe(true);
    expect(keywordLegFromEnv({ FIND_KEYWORD_LEG: "off" })).toBe(false);
    expect(() => keywordLegFromEnv({ FIND_KEYWORD_LEG: "no" })).toThrow(/FIND_KEYWORD_LEG/);
  });
});

describe("FIND_KEYWORD_LEG on the runner's orchestrator and the proxy factory (YOY-176 AC-2)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db, [
      { productId: "p1", title: "Linen Dress" },
      { productId: "p2", title: "Near Dress" },
      { productId: "p3", title: "Dear Dress" },
    ]);
  });

  beforeEach(() => {
    resetPendingLabels();
    vi.stubEnv("JUDGE_PROVIDER", "none");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const ledger = () => createQueuedCostRecorder(createPrismaCostRecorder(db));

  async function servedOrder(orchestrator: Parameters<typeof runPlaygroundSearch>[0]) {
    const { response } = await runPlaygroundSearch(orchestrator, {
      query: "Dear Dress",
      storeKey: SHOP,
      limit: SCORE_RESULT_LIMIT,
    });
    return response.hits.map((hit) => hit.productId);
  }

  it("the runner with the switch unset keeps the keyword half: the exact title leads", async () => {
    expect(await servedOrder(await createRunnerOrchestrator(db, ledger(), {}))).toEqual([
      "p3",
      "p1",
      "p2",
    ]);
  });

  it("the runner with FIND_KEYWORD_LEG=off serves the vector half alone", async () => {
    expect(
      await servedOrder(await createRunnerOrchestrator(db, ledger(), { FIND_KEYWORD_LEG: "off" })),
    ).toEqual(["p1", "p2", "p3"]);
  });

  it("the proxy factory ignores FIND_KEYWORD_LEG=off: the deployed proxy keeps the keyword half", async () => {
    vi.stubEnv("FIND_KEYWORD_LEG", "off");
    expect(await servedOrder(createProxySearchOrchestrator(db, { costRecorder: ledger() }))).toEqual([
      "p3",
      "p1",
      "p2",
    ]);
  });
});
