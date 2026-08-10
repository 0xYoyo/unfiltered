import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  constraintsFromIntent,
  createIntentExtractor,
  createQueryClassifier,
  createRetriever,
  expandCategoryConstraint,
  type Intent,
} from "@unfiltered/engine";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { embedCatalog } from "../catalog/embed.server";
import { enrichCatalog } from "../catalog/enrich.server";
import { computeContentHash } from "../catalog/mapping.server";
import { createPgTrgmClassicStore } from "../search/classic-store.server";
import {
  createSearchOrchestrator,
  type ProductCard,
} from "../search/orchestrator.server";
import { createPgVectorRetrievalStore } from "../search/retrieval-store.server";
import {
  createReplayEmbeddingClient,
  createReplayLlmClient,
  type EmbeddingRecording,
  type LlmRecording,
} from "./replay.server";

/**
 * The sparse-catalog eval harness (YOY-27): indexes the fixture catalog
 * (enrichment → embedding) from recorded LLM/embedding outputs, then runs
 * every golden query through the hybrid search orchestrator end to end
 * (YOY-45 AC-8) — classification, intent, retrieval, and the classic keyword
 * engine behind one call — entirely offline and deterministic, and scores
 * each golden against its expectations.
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
  /** Route the classifier must resolve; absent means "ai" (YOY-41 AC-6). */
  expectedRoute?: "classic" | "ai";
  hardConstraints: GoldenConstraints;
  expectedProductIds: string[];
}

/**
 * One refinement golden (YOY-42): the intent from the shopper's previous
 * query, the follow-up query, and the constraint outcome the extractor must
 * produce for it. `outcome` documents which behavior the golden pins — a
 * refinement of the previous intent, or a fresh intent after a topic change.
 */
export interface RefinementGolden {
  id: string;
  language: "en" | "he" | "mixed";
  /** What this golden demonstrates, for the scorecard and review. */
  note: string;
  previousIntent: Intent;
  query: string;
  outcome: "refinement" | "fresh";
  expectedConstraints: GoldenConstraints;
  /**
   * Comparative-tightening bounds (YOY-52 AC-15). When present, the named
   * price field is scored as an inequality against the previous intent's
   * bound — "cheaper" must land strictly below, "more expensive" strictly
   * above — instead of the exact `expectedConstraints` value, because a live
   * model's exact figure is its own choice; only the direction is the
   * contract.
   */
  expectedPriceMaxBelow?: number;
  expectedPriceMinAbove?: number;
  /** Expected size constraint, when the follow-up states or preserves one. */
  expectedSize?: string;
  /** Soft attributes the merged intent must carry, in order. */
  expectedSoftAttributes: string[];
}

/** The scorecard row for one refinement golden. */
export interface RefinementScore {
  golden: RefinementGolden;
  intent: Intent | null;
  /** Constraint outcomes that missed the golden's expectation (empty is clean). */
  violations: string[];
  costUsd: number;
}

/** The scorecard row for one golden query. */
export interface QueryScore {
  golden: Golden;
  route: string;
  routeReason: string;
  intent: Intent | null;
  hits: ProductCard[];
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
  /** One row per refinement golden (YOY-42). */
  perRefinement: RefinementScore[];
  /** Constraint-outcome misses across every refinement golden. */
  refinementViolationCount: number;
  /** True when any replayed intent recording is hand-written, not live. */
  synthesizedIntentRecordings: boolean;
  /** Fraction of goldens with an expected product in the top 10. */
  hitRate: number;
  /** Total constraint violations across every query's top 10. */
  violationCount: number;
  /** One-time indexing cost: enrichment + catalog embedding, USD. */
  oneTimeCostUsd: number;
  /** Blended per-search cost projected per 1,000 searches, USD. */
  perSearchCostPer1000Usd: number;
  /**
   * The blended figure's denominator (YOY-52 AC-2): AI-routed goldens that
   * ran the full per-search path. Refinement goldens run an intent call
   * only, so they are excluded from the blend and reported separately.
   */
  blendedAiSearchCount: number;
  /** Intent-only refinement cost projected per 1,000 follow-ups, USD. */
  refinementCostPer1000Usd: number;
}

export function loadCatalog(): EvalProduct[] {
  return readJson<EvalProduct[]>("catalog.json");
}

export function loadGoldens(): Golden[] {
  return readJson<Golden[]>("goldens.json");
}

export function loadRefinementGoldens(): RefinementGolden[] {
  return readJson<RefinementGolden[]>("refinement-goldens.json");
}

/**
 * Score one refinement golden: the merged intent's hard constraints — the
 * ones retrieval would filter on — against the outcome the golden documents.
 * Soft attributes are not filters and are asserted by the harness tests, not
 * counted here.
 */
export function refinementViolations(
  golden: RefinementGolden,
  intent: Intent,
): string[] {
  const expected = golden.expectedConstraints;
  const actual = constraintsFromIntent(intent);
  const violations: string[] = [];
  const compare = (field: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got ?? null) !== JSON.stringify(want ?? null)) {
      violations.push(
        `${golden.id}: ${field} ${JSON.stringify(got ?? null)} ≠ expected ${JSON.stringify(want ?? null)}`,
      );
    }
  };
  const bound = (
    field: string,
    got: number | null | undefined,
    check: (value: number) => boolean,
    want: string,
  ): void => {
    if (got === null || got === undefined || !check(got)) {
      violations.push(
        `${golden.id}: ${field} ${JSON.stringify(got ?? null)} ≠ expected ${want}`,
      );
    }
  };
  compare("category", actual.category, expected.category);
  if (golden.expectedPriceMinAbove !== undefined) {
    const above = golden.expectedPriceMinAbove;
    bound("priceMin", actual.priceMin, (value) => value > above, `> ${above}`);
  } else {
    compare("priceMin", actual.priceMin, expected.priceMin);
  }
  if (golden.expectedPriceMaxBelow !== undefined) {
    const below = golden.expectedPriceMaxBelow;
    bound("priceMax", actual.priceMax, (value) => value < below, `< ${below}`);
  } else {
    compare("priceMax", actual.priceMax, expected.priceMax);
  }
  compare("colorsInclude", actual.colorsInclude, expected.colorsInclude);
  compare("colorsExclude", actual.colorsExclude, expected.colorsExclude);
  compare("occasion", actual.occasion, expected.occasion);
  compare("availableOnly", actual.availableOnly, expected.availabilityRequired);
  compare("size", intent.size, golden.expectedSize);
  return violations;
}

/** Check one returned product against a golden's hard constraints. Exported
 * for the harness's own scoring tests (YOY-29 AC-11). Mirrors the retrieval
 * filter's semantics (YOY-35 AC-2): empty enrichment occasions/colors are
 * unknown, not violations of positive constraints — only stated-and-mismatched
 * values violate — and a category constraint admits its taxonomy group's
 * members (AC-5), the same expansion retrieval filters through. */
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
    const admitted = expandCategoryConstraint(constraints.category);
    if (category === null || !admitted.includes(category)) {
      violations.push(`${productId}: category "${category}" ∉ [${admitted.join(", ")}]`);
    }
  }
  if (constraints.occasion !== null) {
    const occasions = (enrichment?.occasions ?? []).map((occasion) =>
      occasion.toLowerCase(),
    );
    if (
      occasions.length > 0 &&
      !occasions.includes(constraints.occasion.toLowerCase())
    ) {
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
    colors.size > 0 &&
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
  const refinementGoldens = loadRefinementGoldens();
  // Refinement extractions are ordinary "intent" port calls, so their
  // recordings merge into the intent recording the replay client looks up.
  // They live in their own file to keep their provenance visible (YOY-42): a
  // key present in both would silently replay the wrong answer, so a
  // collision is an error rather than a precedence rule.
  const intentRecording = readJson<LlmRecording>("recorded", "intent.json");
  const refinementRecording = readJson<LlmRecording>(
    "recorded",
    "intent-refinement.json",
  );
  const collisions = Object.keys(refinementRecording.entries).filter(
    (key) => key in intentRecording.entries,
  );
  if (collisions.length > 0) {
    throw new Error(
      `eval: refinement recordings collide with base intent recordings on ${collisions.join(", ")}`,
    );
  }
  const recordings: Record<string, LlmRecording> = {
    enrichment: readJson<LlmRecording>("recorded", "enrichment.json"),
    classification: readJson<LlmRecording>("recorded", "classification.json"),
    intent: {
      modelId: intentRecording.modelId,
      entries: { ...intentRecording.entries, ...refinementRecording.entries },
    },
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
  // Goldens run through the orchestrator end to end (YOY-45 AC-8): the same
  // routing and fallback ladder production takes, over the replay ports.
  const orchestrator = createSearchOrchestrator({
    db,
    classifier,
    extractor,
    retriever: createRetriever({
      embeddings,
      store: createPgVectorRetrievalStore(db),
    }),
    classicStore: createPgTrgmClassicStore(db),
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
    const response = await orchestrator.runSearch({
      query: golden.query,
      shopDomain,
      searchId,
      limit: 10,
    });
    // The eval is offline and deterministic: a degraded response means a
    // replay recording is missing or broken, and the silent fallback would
    // otherwise let classic results masquerade as the AI path's quality.
    if (response.degraded) {
      throw new Error(
        `eval: golden ${golden.id} degraded to classic — a replay recording is missing or failed`,
      );
    }

    const hits = response.hits;
    const rankIndex = hits.findIndex((hit) =>
      golden.expectedProductIds.includes(hit.productId),
    );
    const violations = hits.flatMap((hit) =>
      findViolations(golden, hit.productId, products, enrichments),
    );
    const ledger = await db.aiCall.findMany({ where: { searchId } });
    perQuery.push({
      golden,
      route: response.route,
      routeReason: response.routeReason,
      intent: response.intent,
      hits,
      firstExpectedRank: rankIndex === -1 ? null : rankIndex + 1,
      violations,
      costUsd: ledger.reduce((sum, row) => sum + row.costUsd, 0),
    });
  }

  // Refinement goldens (YOY-42): one intent call each, with the previous
  // intent supplied by the golden — no classification or retrieval, because a
  // follow-up is scored on the constraints it merges, not on ranking.
  const perRefinement: RefinementScore[] = [];
  for (const golden of refinementGoldens) {
    const intent = await extractor.extract(golden.query, {
      shopDomain,
      searchId: golden.id,
      previousIntent: golden.previousIntent,
    });
    const ledger = await db.aiCall.findMany({ where: { searchId: golden.id } });
    perRefinement.push({
      golden,
      intent,
      violations: refinementViolations(golden, intent),
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
  // Refinement goldens run an intent call only — no classification, no query
  // embedding, no retrieval — so blending them in would understate what a
  // production follow-up search costs (YOY-52 AC-2). The blend covers only
  // the AI-routed goldens that ran the full per-search path; refinement cost
  // is reported as its own line. Classic-routed goldens spend nothing by
  // construction (YOY-41 AC-5), so counting them in the denominator would
  // understate the cost of the searches that do pay.
  const refinementSearchIds = new Set(
    refinementGoldens.map((golden) => golden.id),
  );
  const perSearchTotal = allRows
    .filter(
      (row) => row.searchId !== null && !refinementSearchIds.has(row.searchId),
    )
    .reduce((sum, row) => sum + row.costUsd, 0);
  const refinementTotal = allRows
    .filter(
      (row) => row.searchId !== null && refinementSearchIds.has(row.searchId),
    )
    .reduce((sum, row) => sum + row.costUsd, 0);
  const blendedAiSearchCount = perQuery.filter(
    (score) => score.route === "ai",
  ).length;
  const perSearchCostPer1000Usd =
    blendedAiSearchCount === 0
      ? 0
      : (perSearchTotal / blendedAiSearchCount) * 1000;
  const refinementCostPer1000Usd =
    refinementGoldens.length === 0
      ? 0
      : (refinementTotal / refinementGoldens.length) * 1000;

  const hitCount = perQuery.filter((score) => score.firstExpectedRank !== null).length;
  const result: EvalRunResult = {
    catalogSize: catalog.length,
    perQuery,
    perRefinement,
    refinementViolationCount: perRefinement.reduce(
      (sum, score) => sum + score.violations.length,
      0,
    ),
    synthesizedIntentRecordings:
      intentRecording.provenance === "synthesized" ||
      refinementRecording.provenance === "synthesized",
    hitRate: hitCount / goldens.length,
    violationCount: perQuery.reduce((sum, score) => sum + score.violations.length, 0),
    oneTimeCostUsd,
    perSearchCostPer1000Usd,
    blendedAiSearchCount,
    refinementCostPer1000Usd,
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
    "refinement goldens — follow-up query merged into the previous intent",
    "id  | lang  | outcome    | viol | cost USD | what it pins",
    "----+-------+------------+------+----------+-------------",
  );
  for (const score of result.perRefinement) {
    lines.push(
      [
        score.golden.id.padEnd(3),
        score.golden.language.padEnd(5),
        score.golden.outcome.padEnd(10),
        String(score.violations.length).padStart(4),
        score.costUsd.toFixed(6).padStart(8),
        score.golden.note,
      ].join(" | "),
    );
    for (const violation of score.violations) {
      lines.push(`  VIOLATION: ${violation}`);
    }
  }
  if (result.synthesizedIntentRecordings) {
    lines.push(
      "",
      "NOTE: some replayed intent recordings are synthesized, not live model",
      "output — regenerate them (LIVE_LLM_TESTS=1) before trusting these rows",
      "as evidence of model behavior.",
    );
  }
  lines.push(
    "",
    `hit rate (expected product in top 10): ${(result.hitRate * 100).toFixed(0)}% (bar: ≥80%)`,
    `refinement constraint misses: ${result.refinementViolationCount} (bar: 0)`,
    `hard-constraint violations in any top 10: ${result.violationCount} (bar: 0)`,
    `one-time indexing cost (enrichment + embedding, ${result.catalogSize} products): $${result.oneTimeCostUsd.toFixed(4)}`,
    `blended per-search cost per 1,000 AI searches (${result.blendedAiSearchCount} full-path searches): $${result.perSearchCostPer1000Usd.toFixed(2)} (bar: ≤ $2.00)`,
    `refinement-only intent cost per 1,000 follow-ups (reported separately, not blended): $${result.refinementCostPer1000Usd.toFixed(2)}`,
    "",
  );
  console.log(lines.join("\n"));
}
