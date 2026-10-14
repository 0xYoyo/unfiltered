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
import { createFindStep, type FindStep } from "../search/find.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
} from "../search/orchestrator.server";
import { encodeVector, type ScoreFixture } from "./fixture.server";
import { GRADED_RESULTS, SCORE_GRADE_OPERATION } from "./grade.server";
import { SCORE_RESULT_LIMIT } from "./run.server";
import {
  SCORE_FILLER_OPERATION,
  HARD_KINDS,
  HARD_LANGUAGES,
  HARD_SEARCHES_PER_LANGUAGE,
  HEBREW_SEARCHES,
  SCORE_LANGUAGES,
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

/**
 * Replay filler: every language × shape × count the simple-set builder can
 * ask for (up to Hebrew's 75), and every hard-set language × kind × count
 * (YOY-175).
 */
export function createSyntheticFillerLlm(): LlmClient {
  const entries: LlmRecording["entries"] = {};
  const answer = (searches: string[]) => ({ output: { searches }, inputTokens: 0, outputTokens: 0 });
  for (const language of SCORE_LANGUAGES) {
    for (const shape of ["short", "medium", "long"] as const) {
      for (let count = 1; count <= HEBREW_SEARCHES; count += 1) {
        entries[`filler ${language} ${shape} ${count}`] = answer(
          Array.from({ length: count }, (_, index) => `${language} ${shape} synthetic search ${index + 1}`),
        );
      }
    }
  }
  for (const language of HARD_LANGUAGES) {
    for (const kind of HARD_KINDS) {
      for (let count = 1; count <= HARD_SEARCHES_PER_LANGUAGE; count += 1) {
        entries[`hard ${language} ${kind} ${count}`] = answer(
          Array.from({ length: count }, (_, index) => `${language} ${kind} synthetic hard search ${index + 1}`),
        );
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
  return createSearchOrchestrator({
    db,
    classicStore: createPgTrgmClassicStore(db),
    find: createSyntheticFindStep(db),
  });
}

/**
 * The synthetic find step: replay embeddings with no recorded vector, so
 * every search falls back to the keyword order (YOY-145 AC-8) and has no
 * find set. It is also the find step `score-recall --synthetic` measures
 * (YOY-174 AC-4).
 */
export function createSyntheticFindStep(db: PrismaClient): FindStep {
  return createFindStep({
    db,
    embeddings: createReplayEmbeddingClient({
      recording: { modelId: SYNTHETIC_MODEL_ID, dimension: SYNTHETIC_DIMENSION, vectors: {} },
      costRecorder: noCost,
    }),
    classicStore: createPgTrgmClassicStore(db),
  });
}

/**
 * The recall truth grader for `--synthetic` (YOY-174 AC-4): no model behind
 * it. Each result line of the prompt grades 3 when its title holds a word of
 * the query, else 0, so the truth build runs offline at $0.
 */
export function createSyntheticRecallGrader(): LlmClient {
  return {
    async completeStructured({ prompt }) {
      const query = /^Query: (.*)$/m.exec(prompt)?.[1] ?? "";
      const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
      const titles = [...prompt.matchAll(/^\d+\. (.*)$/gm)].map((match) => match[1]!.toLowerCase());
      return {
        grades: titles.map((title) => (words.some((word) => title.includes(word)) ? 3 : 0)),
      };
    },
  };
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
