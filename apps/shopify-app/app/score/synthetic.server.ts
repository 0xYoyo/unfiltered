import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { CostRecorder, LlmClient } from "@unfiltered/engine";

import {
  createReplayEmbeddingClient,
  createReplayLlmClient,
  type LlmRecording,
} from "../eval/replay.server";
import { runPlaygroundSearch } from "../search/playground-search.server";
import { createPgTrgmClassicStore } from "../search/classic-store.server";
import { createFindStep } from "../search/find.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
} from "../search/orchestrator.server";
import { encodeVector, type ScoreFixture } from "./fixture.server";
import { GRADED_RESULTS, SCORE_GRADE_OPERATION } from "./grade.server";
import { SCORE_RESULT_LIMIT } from "./run.server";
import {
  SCORE_FILLER_OPERATION,
  SCORE_LANGUAGES,
  SEARCHES_PER_LANGUAGE,
  type ScoreSetEntry,
} from "./set.server";

/**
 * The synthetic score tenant (YOY-140): a made-up catalog, a made-up search
 * log and replay recordings for every model call the score tooling makes —
 * so the builder, the runner and their tests run end to end offline at $0.
 * Nothing here is real shopper data (NG-1).
 */

export const SYNTHETIC_STORE_KEY = "playground:score-synthetic";
const SYNTHETIC_MODEL_ID = "synthetic-replay";
const SYNTHETIC_DIMENSION = 4;

const noCost: CostRecorder = { record: async () => {} };

/** The synthetic search log: en, he and ru only — ar, fr and es stay model-written. */
export const SYNTHETIC_LOG_QUERIES = [
  "linen shirt",
  "black dress",
  "Linen  Shirt",
  "warm wool sweater for winter",
  "שמלה שחורה",
  "חולצת פשתן",
  "льняная рубашка",
];

const SYNTHETIC_PRODUCTS = [
  { productId: "syn-1", title: "Linen Shirt", productType: "Shirt", category: "shirt", colors: ["white"] },
  { productId: "syn-2", title: "Black Dress", productType: "Dress", category: "dress", colors: ["black"] },
  { productId: "syn-3", title: "Wool Sweater", productType: "Sweater", category: "sweater", colors: ["grey"] },
  { productId: "syn-4", title: "Linen Trousers", productType: "Trousers", category: "trousers", colors: ["beige"] },
  { productId: "syn-5", title: "Black Linen Shirt", productType: "Shirt", category: "shirt", colors: ["black"] },
  { productId: "syn-6", title: "Summer Dress", productType: "Dress", category: "dress", colors: ["yellow"] },
  { productId: "syn-7", title: "Shirt Dress", productType: "Dress", category: "dress", colors: ["blue"] },
];

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The synthetic catalog as a score fixture. */
export function buildSyntheticFixture(): ScoreFixture {
  const sourceUpdatedAt = "2026-09-01T00:00:00.000Z";
  return {
    version: 1,
    storeKey: SYNTHETIC_STORE_KEY,
    ingestedAt: sourceUpdatedAt,
    products: SYNTHETIC_PRODUCTS.map((product, index) => ({
      shopDomain: SYNTHETIC_STORE_KEY,
      productId: product.productId,
      title: product.title,
      description: `${product.title} from the synthetic score catalog.`,
      tags: [product.category],
      vendor: "Synthetic",
      productType: product.productType,
      priceMin: 40 + index * 10,
      priceMax: 40 + index * 10,
      currencyCode: "EUR",
      available: true,
      status: "ACTIVE",
      publishedAt: sourceUpdatedAt,
      imageAltTexts: [],
      handle: product.productId,
      featuredImageUrl: null,
      familyKey: "",
      url: `https://synthetic.example/products/${product.productId}`,
      sourceUpdatedAt,
      contentHash: hashOf(product.title),
    })),
    enrichments: SYNTHETIC_PRODUCTS.map((product) => ({
      shopDomain: SYNTHETIC_STORE_KEY,
      productId: product.productId,
      contentHash: hashOf(product.title),
      status: "enriched",
      category: product.category,
      colors: product.colors,
      occasions: [],
      fit: null,
      styleTags: [],
      seasons: [],
      primaryColor: product.colors[0] ?? null,
      enrichmentVersion: 0,
      sleeveLength: null,
      neckline: null,
      garmentLength: null,
      pattern: null,
      materialAppearance: null,
      visionImageHashes: [],
      visionStatus: "none",
      textAttributes: null,
      visionAttributes: null,
    })),
    embeddings: SYNTHETIC_PRODUCTS.map((product, index) => ({
      productId: product.productId,
      contentHash: hashOf(product.title),
      vector: encodeVector(
        Array.from({ length: SYNTHETIC_DIMENSION }, (_, axis) => (axis === index % SYNTHETIC_DIMENSION ? 1 : 0.1)),
      ),
    })),
  };
}

/** Seed the synthetic search log and register the tenant as a playground catalog. */
export async function seedSyntheticSearchLog(
  db: PrismaClient,
  queries: readonly string[] = SYNTHETIC_LOG_QUERIES,
): Promise<void> {
  await db.playgroundCatalog.create({
    data: {
      slug: "score-synthetic",
      name: "Synthetic score catalog",
      storeKey: SYNTHETIC_STORE_KEY,
      sourceUrl: "https://synthetic.example",
      sourceKind: "synthetic",
    },
  });
  for (const [index, query] of queries.entries()) {
    await db.searchEvent.create({
      data: {
        searchId: `syn-search-${index}`,
        shopDomain: SYNTHETIC_STORE_KEY,
        sessionId: "syn-session",
        query,
        route: "classic",
        degraded: false,
        latencyMs: 100,
        resultCount: 1,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
      },
    });
  }
}

/** Replay filler: every language × shape × count the builder can ask for. */
export function createSyntheticFillerLlm(): LlmClient {
  const entries: LlmRecording["entries"] = {};
  for (const language of SCORE_LANGUAGES) {
    for (const shape of ["short", "medium", "long"] as const) {
      for (let count = 1; count <= SEARCHES_PER_LANGUAGE; count += 1) {
        entries[`filler ${language} ${shape} ${count}`] = {
          output: {
            searches: Array.from(
              { length: count },
              (_, index) => `${language} ${shape} synthetic search ${index + 1}`,
            ),
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      }
    }
  }
  return createReplayLlmClient({
    recordings: { [SCORE_FILLER_OPERATION]: { modelId: SYNTHETIC_MODEL_ID, provenance: "synthesized", entries } },
    costRecorder: noCost,
  });
}

/**
 * The search side over replay clients: no query vector is recorded, so the
 * find step's embedding fails and every search is served in the keyword
 * order over the seeded catalog (YOY-145 AC-8) — the playground's real
 * search path with no model behind it. No judge and no extraction are wired.
 */
export function createSyntheticOrchestrator(db: PrismaClient): SearchOrchestrator {
  const classicStore = createPgTrgmClassicStore(db);
  return createSearchOrchestrator({
    db,
    classicStore,
    find: createFindStep({
      db,
      embeddings: createReplayEmbeddingClient({
        recording: { modelId: SYNTHETIC_MODEL_ID, dimension: SYNTHETIC_DIMENSION, vectors: {} },
        costRecorder: noCost,
      }),
      classicStore,
    }),
  });
}

/**
 * Replay grades for the set: the synthetic orchestrator is deterministic,
 * so each search's result count is read off one dry run, and each recording
 * answers exactly that many grades — a stable 3, 2, 1, 0, … pattern.
 */
export async function createSyntheticGrader(
  orchestrator: SearchOrchestrator,
  set: readonly ScoreSetEntry[],
): Promise<LlmClient> {
  const entries: LlmRecording["entries"] = {};
  for (const entry of set) {
    let count = 0;
    try {
      const { response } = await runPlaygroundSearch(orchestrator, {
        query: entry.query,
        storeKey: SYNTHETIC_STORE_KEY,
        limit: SCORE_RESULT_LIMIT,
      });
      count = Math.min(response.hits.length, GRADED_RESULTS);
    } catch {
      count = 0;
    }
    entries[entry.query] = {
      output: { grades: Array.from({ length: count }, (_, index) => 3 - (index % 4)) },
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  return createReplayLlmClient({
    recordings: { [SCORE_GRADE_OPERATION]: { modelId: SYNTHETIC_MODEL_ID, provenance: "synthesized", entries } },
    costRecorder: noCost,
  });
}
