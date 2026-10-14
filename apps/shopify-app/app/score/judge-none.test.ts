import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { StructuredCompletionRequest } from "@unfiltered/engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPrismaCostRecorder, createQueuedCostRecorder } from "../ai/cost-recorder.server";
import { awaitLatePage, resetPendingLabels } from "../search/judge-step.server";
import { runPlaygroundSearch } from "../search/playground-search.server";
import { createProxySearchOrchestrator } from "../search/proxy.server";
import { createTestDb } from "../testing/helpers.server";
import { RUNNER_CALL_TIMEOUT_MS } from "./cli.server";
import { SCORE_RESULT_LIMIT } from "./run.server";

// `judge=none` on the score runner's orchestrator (YOY-172 AC-3, AC-4): the
// production factory the runner builds, with JUDGE_PROVIDER=none. Offline
// and $0: every Gemini client is a scripted fake that records each call's
// operation, and the OpenRouter decision client counts its constructions.

const DIMENSION = 3;
const SHOP = "judge-none-shop.myshopify.com";

const recorded = vi.hoisted(() => ({
  operations: [] as string[],
  decisionClients: 0,
}));

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
        recorded.operations.push(request.operation);
        if (request.operation === "extract") {
          return { priceMax: 100, currency: "USD", excluded: [] };
        }
        throw new Error(`unexpected ${request.operation} call`);
      },
    }),
  };
});

vi.mock("../ai/openrouter.server", async (importActual) => {
  const actual = await importActual<typeof import("../ai/openrouter.server")>();
  return {
    ...actual,
    createOpenRouterDecisionClient: () => {
      recorded.decisionClients += 1;
      throw new Error("no decision client is built for judge=none");
    },
  };
});

async function seed(db: PrismaClient, products: { productId: string; title: string; price: number }[]) {
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
        priceMin: product.price,
        priceMax: product.price,
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

describe("judge=none on the runner's orchestrator (YOY-172 AC-3, AC-4)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db, [
      { productId: "p1", title: "Linen Dress", price: 80 },
      { productId: "p2", title: "Near Dress", price: 105 },
      { productId: "p3", title: "Dear Dress", price: 300 },
    ]);
  });

  beforeEach(() => {
    recorded.operations.length = 0;
    recorded.decisionClients = 0;
    resetPendingLabels();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  /** The orchestrator exactly as the runner builds it (cli.server.ts). */
  function runnerOrchestrator() {
    return createProxySearchOrchestrator(db, {
      costRecorder: createQueuedCostRecorder(createPrismaCostRecorder(db)),
      requestTimeoutMs: RUNNER_CALL_TIMEOUT_MS,
    });
  }

  it("serves the composed find order with reason find-only: no judge call, no late page, no pending labels", async () => {
    vi.stubEnv("JUDGE_PROVIDER", "none");
    // No OpenRouter key is needed.
    vi.stubEnv("OPENROUTER_API_KEY", undefined);

    const { response } = await runPlaygroundSearch(runnerOrchestrator(), {
      query: "dress under 100",
      storeKey: SHOP,
      limit: SCORE_RESULT_LIMIT,
    });

    expect(recorded.operations).not.toContain("judge");
    expect(recorded.operations).toContain("extract");
    expect(recorded.decisionClients).toBe(0);
    expect(response.routeReason).toBe("find-only");
    expect(response.labelsPending).toBeUndefined();
    expect(await awaitLatePage(SHOP, response.searchId, 1)).toBeNull();
    expect(response.judgeCalls).toBeUndefined();

    // The stated price cap still composes: its chip, its tiers and the
    // code-computed labels.
    expect(response.extractionInTime).toBe(true);
    expect(response.chips).toEqual([expect.objectContaining({ field: "priceMax", value: "100" })]);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3"]);
    expect(response.hits.map((hit) => hit.label?.template ?? null)).toEqual([
      null,
      "price-near",
      "price-far",
    ]);
  });

  it("still calls the judge when a provider is named — the fakes see a judge call", async () => {
    vi.stubEnv("JUDGE_PROVIDER", "gemini");
    // The fake judge throws; the step's find-order fallback warns.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { response } = await runPlaygroundSearch(runnerOrchestrator(), {
      query: "dress under 100",
      storeKey: SHOP,
      limit: SCORE_RESULT_LIMIT,
    });

    expect(recorded.operations).toContain("judge");
    expect(response.routeReason).not.toBe("find-only");
  });
});
