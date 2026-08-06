import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  createIntentExtractor,
  createQueryClassifier,
  createRetriever,
  type Intent,
  type RetrievalHit,
} from "@unfiltered/engine";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { embedCatalog } from "../catalog/embed.server";
import { enrichCatalog } from "../catalog/enrich.server";
import { computeContentHash } from "../catalog/mapping.server";
import { createPgVectorRetrievalStore } from "../search/retrieval-store.server";
import {
  createReplayEmbeddingClient,
  createReplayLlmClient,
  type EmbeddingRecording,
  type LlmRecording,
} from "./replay.server";

/**
 * The sparse-catalog eval harness (YOY-27): runs the full pipeline —
 * enrichment → embedding → classification → intent → retrieval — over the
 * fixture catalog from recorded LLM/embedding outputs, entirely offline and
 * deterministic, and scores every golden query against its expectations.
 */

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(fixturesDir, ...segments), "utf8")) as T;
}

/** One sparse fixture product, as checked into catalog.json. */
export interface EvalProduct {
  productId: string;
  title: string;
  description: string;
  tags: string[];
  vendor: string;
  productType: string;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  imageAltTexts: string[];
  sourceUpdatedAt: string;
}

/** The hard constraints a golden query's results are checked against. */
export interface GoldenConstraints {
  category: string | null;
  priceMin: number | null;
  priceMax: number | null;
  colorsInclude: string[];
  colorsExclude: string[];
  occasion: string | null;
  availabilityRequired: boolean;
}

/** One golden query, as checked into goldens.json. */
export interface Golden {
  id: string;
  language: "en" | "he" | "mixed";
  query: string;
  hardConstraints: GoldenConstraints;
  expectedProductIds: string[];
}

/** The scorecard row for one golden query. */
export interface QueryScore {
  golden: Golden;
  route: string;
  routeReason: string;
  intent: Intent | null;
  hits: RetrievalHit[];
  /** 1-based rank of the first expected product in the top 10, or null. */
  firstExpectedRank: number | null;
  /** Constraint violations found in the top 10 (empty means clean). */
  violations: string[];
  costUsd: number;
}

/** The outcome of one full eval run. */
export interface EvalRunResult {
  catalogSize: number;
  perQuery: QueryScore[];
  /** Fraction of goldens with an expected product in the top 10. */
  hitRate: number;
  /** Total constraint violations across every query's top 10. */
  violationCount: number;
  /** One-time indexing cost: enrichment + catalog embedding, USD. */
  oneTimeCostUsd: number;
  /** Blended per-search cost projected per 1,000 searches, USD. */
  perSearchCostPer1000Usd: number;
}

export function loadCatalog(): EvalProduct[] {
  return readJson<EvalProduct[]>("catalog.json");
}

export function loadGoldens(): Golden[] {
  return readJson<Golden[]>("goldens.json");
}

/** Check one returned product against a golden's hard constraints. Exported
 * for the harness's own scoring tests (YOY-29 AC-11). */
export function findViolations(
  golden: Golden,
  productId: string,
  products: Map<string, EvalProduct>,
  enrichments: Map<
    string,
    { category: string | null; colors: string[]; occasions: string[] }
  >,
): string[] {
  const constraints = golden.hardConstraints;
  const product = products.get(productId);
  if (product === undefined) {
    return [`${productId}: not in the fixture catalog`];
  }
  const enrichment = enrichments.get(productId);
  const violations: string[] = [];
  if (constraints.priceMax !== null && product.priceMin > constraints.priceMax) {
    violations.push(`${productId}: price ${product.priceMin} > cap ${constraints.priceMax}`);
  }
  if (constraints.priceMin !== null && product.priceMax < constraints.priceMin) {
    violations.push(`${productId}: price ${product.priceMax} < floor ${constraints.priceMin}`);
  }
  if (constraints.availabilityRequired && !product.available) {
    violations.push(`${productId}: unavailable despite availability requirement`);
  }
  if (constraints.category !== null) {
    const category = enrichment?.category?.toLowerCase() ?? null;
    if (category !== constraints.category.toLowerCase()) {
      violations.push(`${productId}: category "${category}" ≠ "${constraints.category}"`);
    }
  }
  if (constraints.occasion !== null) {
    const occasions = (enrichment?.occasions ?? []).map((occasion) =>
      occasion.toLowerCase(),
    );
    if (!occasions.includes(constraints.occasion.toLowerCase())) {
      violations.push(
        `${productId}: occasions [${occasions.join(", ")}] miss "${constraints.occasion}"`,
      );
    }
  }
  const colors = new Set(
    (enrichment?.colors ?? []).map((color) => color.toLowerCase()),
  );
  for (const excluded of constraints.colorsExclude) {
    if (colors.has(excluded.toLowerCase())) {
      violations.push(`${productId}: carries excluded color "${excluded}"`);
    }
  }
  if (
    constraints.colorsInclude.length > 0 &&
    !constraints.colorsInclude.some((color) => colors.has(color.toLowerCase()))
  ) {
    violations.push(`${productId}: carries none of the required colors`);
  }
  return violations;
}

/** Run the full eval and print the per-query scorecard (AC-6). */
export async function runEval(db: PrismaClient): Promise<EvalRunResult> {
  const shopDomain = "eval-shop.example.com";
  const catalog = loadCatalog();
  const goldens = loadGoldens();
  const recordings: Record<string, LlmRecording> = {
    enrichment: readJson<LlmRecording>("recorded", "enrichment.json"),
    classification: readJson<LlmRecording>("recorded", "classification.json"),
    intent: readJson<LlmRecording>("recorded", "intent.json"),
  };
  const embeddingRecording = readJson<EmbeddingRecording>(
    "recorded",
    "embeddings.json",
  );

  const costRecorder = createPrismaCostRecorder(db);
  const llm = createReplayLlmClient({ recordings, costRecorder });
  const embeddings = createReplayEmbeddingClient({
    recording: embeddingRecording,
    costRecorder,
  });

  // Index the sparse catalog exactly the way production does: seed the
  // snapshot, then run the real enrichment and embedding pipelines.
  for (const { sourceUpdatedAt, ...product } of catalog) {
    await db.catalogProduct.create({
      data: {
        ...product,
        shopDomain,
        sourceUpdatedAt: new Date(sourceUpdatedAt),
        contentHash: computeContentHash(product),
      },
    });
  }
  const enrichResult = await enrichCatalog({ db, shopDomain, llm });
  if (enrichResult.failed > 0) {
    throw new Error(`eval enrichment failed for ${enrichResult.failed} products`);
  }
  await embedCatalog({ db, shopDomain, embeddings });

  const classifier = createQueryClassifier({ llm });
  const extractor = createIntentExtractor({ llm });
  const retriever = createRetriever({
    embeddings,
    store: createPgVectorRetrievalStore(db),
  });

  const products = new Map(catalog.map((product) => [product.productId, product]));
  const enrichmentRows = await db.productEnrichment.findMany({
    where: { shopDomain },
  });
  const enrichments = new Map(
    enrichmentRows.map((row) => [
      row.productId,
      { category: row.category, colors: row.colors, occasions: row.occasions },
    ]),
  );

  const perQuery: QueryScore[] = [];
  for (const golden of goldens) {
    const searchId = golden.id;
    const decision = await classifier.classify(golden.query, {
      shopDomain,
      searchId,
    });

    let intent: Intent | null = null;
    let hits: RetrievalHit[] = [];
    if (decision.route === "ai") {
      intent = await extractor.extract(golden.query, { shopDomain, searchId });
      hits = (
        await retriever.retrieve({ intent, shopDomain, limit: 10, searchId })
      ).hits;
    }

    const rankIndex = hits.findIndex((hit) =>
      golden.expectedProductIds.includes(hit.productId),
    );
    const violations = hits.flatMap((hit) =>
      findViolations(golden, hit.productId, products, enrichments),
    );
    const ledger = await db.aiCall.findMany({ where: { searchId } });
    perQuery.push({
      golden,
      route: decision.route,
      routeReason: decision.reason,
      intent,
      hits,
      firstExpectedRank: rankIndex === -1 ? null : rankIndex + 1,
      violations,
      costUsd: ledger.reduce((sum, row) => sum + row.costUsd, 0),
    });
  }

  // Cost split (AC-4): rows with a searchId serve one search (classification,
  // intent, query embedding); rows without one are the one-time indexing cost
  // (enrichment, catalog embedding).
  const allRows = await db.aiCall.findMany();
  const oneTimeCostUsd = allRows
    .filter((row) => row.searchId === null)
    .reduce((sum, row) => sum + row.costUsd, 0);
  const perSearchTotal = allRows
    .filter((row) => row.searchId !== null)
    .reduce((sum, row) => sum + row.costUsd, 0);
  const perSearchCostPer1000Usd = (perSearchTotal / goldens.length) * 1000;

  const hitCount = perQuery.filter((score) => score.firstExpectedRank !== null).length;
  const result: EvalRunResult = {
    catalogSize: catalog.length,
    perQuery,
    hitRate: hitCount / goldens.length,
    violationCount: perQuery.reduce((sum, score) => sum + score.violations.length, 0),
    oneTimeCostUsd,
    perSearchCostPer1000Usd,
  };
  printScorecard(result);
  return result;
}

/** Per-query scorecard (AC-6): rank, violations, and cost per golden. */
function printScorecard(result: EvalRunResult): void {
  const lines = [
    "",
    "eval scorecard — sparse catalog quality harness",
    "query                                     | lang  | route      | rank | viol | cost USD",
    "------------------------------------------+-------+------------+------+------+---------",
  ];
  for (const score of result.perQuery) {
    const query =
      score.golden.query.length > 40
        ? `${score.golden.query.slice(0, 39)}…`
        : score.golden.query.padEnd(40);
    lines.push(
      [
        query.padEnd(41),
        score.golden.language.padEnd(5),
        `${score.route}/${score.routeReason}`.padEnd(10),
        String(score.firstExpectedRank ?? "MISS").padStart(4),
        String(score.violations.length).padStart(4),
        score.costUsd.toFixed(6),
      ].join(" | "),
    );
    for (const violation of score.violations) {
      lines.push(`  VIOLATION: ${violation}`);
    }
  }
  lines.push(
    "",
    `hit rate (expected product in top 10): ${(result.hitRate * 100).toFixed(0)}% (bar: ≥80%)`,
    `hard-constraint violations in any top 10: ${result.violationCount} (bar: 0)`,
    `one-time indexing cost (enrichment + embedding, ${result.catalogSize} products): $${result.oneTimeCostUsd.toFixed(4)}`,
    `blended per-search cost per 1,000 AI searches: $${result.perSearchCostPer1000Usd.toFixed(2)} (bar: ≤ $2.00)`,
    "",
  );
  console.log(lines.join("\n"));
}
