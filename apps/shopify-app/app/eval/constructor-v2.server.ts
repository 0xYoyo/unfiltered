import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  createDecisionJudge,
  createEscalatingIntentExtractor,
  createIntentExtractor,
  createQueryClassifier,
  createRetriever,
  createWishExtractor,
  type CostRecorder,
  type DecisionClient,
  type EmbeddingClient,
  type LlmClient,
} from "@unfiltered/engine";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { embedCatalogCards } from "../catalog/card-embed.server";
import { writeCatalogCards } from "../catalog/card.server";
import { createPgTrgmClassicStore } from "../search/classic-store.server";
import { createFindStep } from "../search/find.server";
import { createSearchOrchestrator } from "../search/orchestrator.server";
import { createPgVectorRetrievalStore } from "../search/retrieval-store.server";
import {
  CONSTRUCTOR_GROUPS,
  fixtureImageFetch,
  indexEvalCatalog,
  loadCatalog,
  loadConstructorGoldens,
  type ConstructorGolden,
  type ConstructorGroup,
} from "./harness.server";
import {
  createReplayDecisionClient,
  createReplayEmbeddingClient,
  createReplayLlmClient,
  type DecisionRecording,
  type EmbeddingRecording,
  type LlmRecording,
} from "./replay.server";

/**
 * The Constructor-bar set on Engine v2 (YOY-153 AC-2, AC-3): the 30
 * negation, price-cap and occasion-versus-category goldens, run through the
 * production v2 path — the card writer and card vectors, the find step, the
 * wish extraction and the default judge (`jev`) — over the eval catalog,
 * offline from recordings. The old engine's own Constructor run in
 * `runEval`, its floor fields and `baseline-hits.json` are untouched (NG-2).
 *
 * The v2 output is asserted three ways on page 1 (the first 24 results):
 * a negation golden's excluded products never appear; on a price-cap
 * golden an in-budget product precedes an over-budget one — the page leads
 * in budget, and within each judge verdict every in-budget product comes
 * before every over-budget one, the order the engine composes (verdict,
 * then price tier, then find order; `composeWishes`); and a guest-dress
 * query never leads with a bridal gown. "Over budget" is the engine's own
 * reading: the code-computed `price-near` / `price-far` label, against the
 * cap the extraction read in the shopper's currency ("bag under $100").
 * The per-group hit rate and `mustNot` leak (top 10, as the old engine is
 * scored) are held to the v2 floor in `constructor-floor.json`.
 */

const SHOP_DOMAIN = "eval-v2-shop.example.com";

/** Results scored per golden: page 1 at the default page size. */
export const V2_PAGE_SIZE = 24;

/** Generous deadlines: the run measures judgment, never speed or timing. */
const V2_EVAL_DEADLINE_MS = 120_000;

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const recordedDir = join(fixturesDir, "recorded");

/** The v2 recording files, beside the old engine's in fixtures/recorded/. */
export const V2_RECORDING_FILES = {
  card: "card.json",
  extract: "extract.json",
  judge: "judge-jev.json",
  embeddings: "embeddings-v2.json",
} as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function v2RecordingPath(file: string): string {
  return join(recordedDir, file);
}

/** Whether every v2 recording file is committed. */
export function v2RecordingsPresent(): boolean {
  return Object.values(V2_RECORDING_FILES).every((file) => existsSync(v2RecordingPath(file)));
}

/** The ports one v2 run speaks to: replayed by default, live when recording. */
export interface ConstructorV2Ports {
  /** Enrichment, vision, card and extraction completions. */
  llm: LlmClient;
  /** Product, card-section and query vectors. */
  embeddings: EmbeddingClient;
  /** The Jev judge's per-product decisions. */
  decisions: DecisionClient;
  /** The judge identity the answer cache is keyed by. */
  judgeModelId: string;
  costRecorder: CostRecorder;
}

/**
 * The replay ports over the committed recordings: the old engine's
 * enrichment, vision and product-vector recordings index the catalog, the
 * v2 files answer everything after. A key recorded in both embedding files
 * must carry the same vector — otherwise the run would depend on merge order.
 */
export function replayConstructorV2Ports(db: PrismaClient): ConstructorV2Ports {
  const costRecorder = createPrismaCostRecorder(db);
  const read = <T>(file: string): T => readJson<T>(v2RecordingPath(file));
  const enrichment = read<LlmRecording>("enrichment.json");
  const vision = read<LlmRecording>("vision.json");
  const base = read<EmbeddingRecording>("embeddings.json");
  const extra = read<EmbeddingRecording>(V2_RECORDING_FILES.embeddings);
  if (base.modelId !== extra.modelId || base.dimension !== extra.dimension) {
    throw new Error(
      `eval v2: ${V2_RECORDING_FILES.embeddings} was recorded with ${extra.modelId}/${extra.dimension}, embeddings.json with ${base.modelId}/${base.dimension}`,
    );
  }
  const conflicts = Object.keys(extra.vectors).filter(
    (text) => text in base.vectors && JSON.stringify(base.vectors[text]) !== JSON.stringify(extra.vectors[text]),
  );
  if (conflicts.length > 0) {
    throw new Error(`eval v2: embedding recordings disagree on ${conflicts.length} texts, e.g. ${JSON.stringify(conflicts[0])}`);
  }
  const judge = read<DecisionRecording>(V2_RECORDING_FILES.judge);
  return {
    llm: createReplayLlmClient({
      recordings: {
        enrichment,
        vision,
        card: read<LlmRecording>(V2_RECORDING_FILES.card),
        extract: read<LlmRecording>(V2_RECORDING_FILES.extract),
      },
      costRecorder,
    }),
    embeddings: createReplayEmbeddingClient({
      recording: { ...base, vectors: { ...base.vectors, ...extra.vectors } },
      costRecorder,
    }),
    decisions: createReplayDecisionClient({ recording: judge, costRecorder }),
    judgeModelId: judge.modelId,
    costRecorder,
  };
}

/** One served result on page 1. */
export interface V2PageEntry {
  productId: string;
  /** The judge's verdict, or null where it gave none. */
  verdict: string | null;
  /** Carries the code's over-budget label (`price-near` / `price-far`). */
  overBudget: boolean;
}

/** One golden's v2 outcome. */
export interface ConstructorV2Score {
  golden: ConstructorGolden;
  /** The response's route reason: "judged" when the judge answered. */
  routeReason: string;
  /** Page 1's product ids, in served order. */
  pageIds: string[];
  /** Page 1 with each result's verdict and budget standing. */
  page: V2PageEntry[];
  /** The price cap the extraction read (its `priceMax` chip), or null. */
  priceCap: string | null;
  /** 1-based rank of the first expected product in the top 10, or null. */
  firstExpectedRank: number | null;
  /** `mustNotProductIds` in the top 10 — the leak the floor caps. */
  mustNotInTop10: string[];
  /** The three v2 assertions (AC-2): every breach, empty when the golden holds. */
  breaches: string[];
}

export interface ConstructorV2GroupResult {
  hits: number;
  total: number;
  hitRatePercent: number;
  mustNotViolations: number;
  breaches: number;
}

export interface ConstructorV2Result {
  catalogSize: number;
  cardsWritten: number;
  scores: ConstructorV2Score[];
  byGroup: Record<ConstructorGroup, ConstructorV2GroupResult>;
  /** The run's judge ledger rows, per provider and model. */
  judgeLedger: Array<{ provider: string; modelId: string; calls: number }>;
}

/** The per-group v2 floor (AC-3), beside the old engine's fields. */
export interface ConstructorV2Floor {
  recordedAt: string;
  judge: string;
  byGroup: Record<ConstructorGroup, { hitRatePercent: number; mustNotViolationsMax: number }>;
}

/** The committed v2 floor: the `v2` object of constructor-floor.json (AC-3). */
export function loadConstructorV2Floor(): ConstructorV2Floor {
  const floor = readJson<{ v2?: ConstructorV2Floor }>(join(fixturesDir, "constructor-floor.json")).v2;
  if (floor === undefined) {
    throw new Error("eval v2: constructor-floor.json carries no v2 floor");
  }
  return floor;
}

/** The three v2 assertions over one golden's page 1 (AC-2). */
export function v2Breaches(
  golden: ConstructorGolden,
  page: readonly V2PageEntry[],
  priceCap: string | null,
): string[] {
  const breaches: string[] = [];
  const pageIds = page.map((entry) => entry.productId);
  if (golden.group === "negation") {
    for (const productId of pageIds.filter((id) => golden.mustNotProductIds.includes(id))) {
      breaches.push(`${productId}: excluded by the query, yet on page 1`);
    }
  }
  if (golden.group === "priceCap") {
    if (priceCap === null) {
      breaches.push("no price cap was read from the query");
    }
    const first = page[0];
    if (first !== undefined && first.overBudget) {
      breaches.push(`${first.productId}: over budget, yet it leads the page`);
    }
    page.forEach((entry, index) => {
      const overtaken = page
        .slice(index + 1)
        .find((later) => later.verdict === entry.verdict && !later.overBudget);
      if (entry.overBudget && overtaken !== undefined) {
        breaches.push(
          `${entry.productId}: over budget at rank ${index + 1}, ahead of in-budget ${overtaken.productId} with the same verdict (${entry.verdict ?? "none"})`,
        );
      }
    });
  }
  if (golden.group === "occasionVsCategory" && isGuestDressGolden(golden)) {
    const first = pageIds[0];
    if (first !== undefined && golden.mustNotProductIds.includes(first)) {
      breaches.push(`${first}: a bridal gown leads a guest-dress query`);
    }
  }
  return breaches;
}

/** The bridal gowns of the eval catalog (YOY-118). */
const BRIDAL_GOWNS = ["p67", "p68"];

/** A guest-dress golden: an occasion query whose forbidden products are the bridal gowns. */
export function isGuestDressGolden(golden: ConstructorGolden): boolean {
  return (
    golden.group === "occasionVsCategory" &&
    BRIDAL_GOWNS.every((id) => golden.mustNotProductIds.includes(id))
  );
}

/** Per-group hit rate, top-10 `mustNot` leak and assertion breaches. */
export function summarizeV2(scores: readonly ConstructorV2Score[]): Record<ConstructorGroup, ConstructorV2GroupResult> {
  return Object.fromEntries(
    CONSTRUCTOR_GROUPS.map((group) => {
      const slice = scores.filter((score) => score.golden.group === group);
      const hits = slice.filter((score) => score.firstExpectedRank !== null).length;
      return [
        group,
        {
          hits,
          total: slice.length,
          hitRatePercent: slice.length === 0 ? 0 : Math.floor((hits / slice.length) * 100),
          mustNotViolations: slice.reduce((sum, score) => sum + score.mustNotInTop10.length, 0),
          breaches: slice.reduce((sum, score) => sum + score.breaches.length, 0),
        },
      ];
    }),
  ) as Record<ConstructorGroup, ConstructorV2GroupResult>;
}

/**
 * Run the Constructor-bar set through Engine v2 on a fresh database: index
 * the eval catalog, write and embed its cards, then search every golden
 * with the v2 orchestrator production builds — find, wish extraction and
 * the Jev decision judge — and score page 1.
 */
export async function runConstructorV2(
  db: PrismaClient,
  ports: ConstructorV2Ports = replayConstructorV2Ports(db),
): Promise<ConstructorV2Result> {
  const catalog = loadCatalog();
  const goldens = loadConstructorGoldens();
  const { llm, embeddings, decisions } = ports;

  await indexEvalCatalog({ db, shopDomain: SHOP_DOMAIN, catalog, llm, embeddings });
  const cards = await writeCatalogCards({
    db,
    shopDomain: SHOP_DOMAIN,
    writer: { llm, modelId: "eval-card-writer" },
    fetchImage: fixtureImageFetch,
    languages: ["en", "he"],
    spendCapUsd: Number.POSITIVE_INFINITY,
  });
  if (cards.failed > 0) {
    throw new Error(`eval v2: ${cards.failed} cards failed — a card recording is missing or broken`);
  }
  await embedCatalogCards({ db, shopDomain: SHOP_DOMAIN, embeddings });

  const classicStore = createPgTrgmClassicStore(db);
  const orchestrator = createSearchOrchestrator({
    db,
    // The old engine's ports are required by the orchestrator but never
    // reached: every golden is a submitted search on Engine v2.
    classifier: createQueryClassifier({ llm }),
    extractor: createEscalatingIntentExtractor({
      lite: createIntentExtractor({ llm }),
      accuracy: createIntentExtractor({ llm }),
    }),
    retriever: createRetriever({ embeddings, store: createPgVectorRetrievalStore(db) }),
    classicStore,
    find: createFindStep({ db, embeddings, classicStore }),
    engineV2: true,
    judge: createDecisionJudge({ decisions, identity: `jev:${ports.judgeModelId}` }),
    judgeDeadlineMs: V2_EVAL_DEADLINE_MS,
    judgeGiveUpMs: V2_EVAL_DEADLINE_MS,
    wishExtractor: createWishExtractor({ llm }),
    extractionGraceMs: V2_EVAL_DEADLINE_MS,
  });

  const scores: ConstructorV2Score[] = [];
  for (const golden of goldens) {
    const response = await orchestrator.runSearch({
      query: golden.query,
      shopDomain: SHOP_DOMAIN,
      searchId: `v2-${golden.id}`,
      paging: { page: 1, pageSize: V2_PAGE_SIZE },
    });
    if (response.engine !== "v2") {
      throw new Error(`eval v2: golden ${golden.id} was served by the ${response.engine} engine`);
    }
    // Offline and deterministic: anything but a judged page means a
    // recording is missing or failed, and find order would masquerade as
    // the judge's quality.
    if (response.degraded || response.routeReason !== "judged") {
      throw new Error(
        `eval v2: golden ${golden.id} was served ${response.routeReason}${response.degraded ? " (degraded)" : ""} — a v2 recording is missing or failed`,
      );
    }
    const page: V2PageEntry[] = response.hits.map((hit) => ({
      productId: hit.productId,
      verdict: hit.verdict ?? null,
      overBudget: hit.label?.template === "price-near" || hit.label?.template === "price-far",
    }));
    const priceCap = response.chips.find((chip) => chip.field === "priceMax")?.value ?? null;
    const pageIds = page.map((entry) => entry.productId);
    const top10 = pageIds.slice(0, 10);
    const rank = top10.findIndex((id) => golden.expectedProductIds.includes(id));
    scores.push({
      golden,
      routeReason: response.routeReason,
      pageIds,
      page,
      priceCap,
      firstExpectedRank: rank === -1 ? null : rank + 1,
      mustNotInTop10: top10.filter((id) => golden.mustNotProductIds.includes(id)),
      breaches: v2Breaches(golden, page, priceCap),
    });
  }
  const judgeRows = await db.aiCall.groupBy({
    by: ["provider", "modelId"],
    where: { operation: "judge", shopDomain: SHOP_DOMAIN },
    _count: { _all: true },
  });
  return {
    catalogSize: catalog.length,
    cardsWritten: cards.written,
    scores,
    byGroup: summarizeV2(scores),
    judgeLedger: judgeRows.map((row) => ({
      provider: row.provider,
      modelId: row.modelId,
      calls: row._count._all,
    })),
  };
}

/** The scorecard printed by the suite: one line per golden, then per group. */
export function formatConstructorV2Report(result: ConstructorV2Result, floor: ConstructorV2Floor): string {
  const lines = result.scores.map((score) => {
    const rank = score.firstExpectedRank === null ? "miss" : `#${score.firstExpectedRank}`;
    const leak = score.mustNotInTop10.length === 0 ? "" : ` mustNot=${score.mustNotInTop10.join(",")}`;
    const breach = score.breaches.length === 0 ? "" : ` BREACH ${score.breaches.join("; ")}`;
    // A price-cap page in served order: each result's verdict, `$` when over budget.
    const cap =
      score.golden.group !== "priceCap"
        ? ""
        : ` cap=${score.priceCap ?? "none"} page=${score.page.map((entry) => `${entry.verdict ?? "-"}${entry.overBudget ? "$" : ""}`).join(",")}`;
    return `  ${score.golden.id} ${score.golden.group.padEnd(18)} ${rank.padEnd(4)} ${JSON.stringify(score.golden.query)}${cap}${leak}${breach}`;
  });
  const groups = CONSTRUCTOR_GROUPS.map((group) => {
    const measured = result.byGroup[group];
    const bar = floor.byGroup[group];
    return `  ${group.padEnd(18)} hit ${measured.hits}/${measured.total} (${measured.hitRatePercent}%, floor ${bar.hitRatePercent}%) · mustNot ${measured.mustNotViolations} (max ${bar.mustNotViolationsMax}) · breaches ${measured.breaches}`;
  });
  return [
    `Constructor bar on Engine v2 (judge ${floor.judge}): ${result.scores.length} goldens, ${result.catalogSize} products, ${result.cardsWritten} cards`,
    ...lines,
    "per group:",
    ...groups,
  ].join("\n");
}
