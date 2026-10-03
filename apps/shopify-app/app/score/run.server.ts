import type { PrismaClient } from "@prisma/client";
import type { LlmClient } from "@unfiltered/engine";

import { runPlaygroundSearch } from "../search/playground-search.server";
import type { SearchOrchestrator } from "../search/orchestrator.server";
import {
  gradeSearch,
  GRADED_RESULTS,
  searchScore,
  type GradedResult,
} from "./grade.server";
import { SCORE_LANGUAGES, type ScoreLanguage, type ScoreSetEntry } from "./set.server";

/**
 * The score runner (YOY-140 AC-5..AC-7): every search of a set through the
 * playground's own search function at a 24-result limit, the top six
 * graded, scores rolled up per language. Query text is the hidden half's
 * secret, so nothing a search prints may reach the process output: the run
 * captures the console and the caller prints the table alone.
 */

/** Results fetched per search: one playground page. */
export const SCORE_RESULT_LIMIT = 24;
/** A search under this server-side latency counts toward the under-1-s share. */
export const FAST_SEARCH_MS = 1000;

export interface SearchOutcome {
  language: ScoreLanguage;
  score: number;
  latencyMs: number;
  /**
   * Whether the wish extraction answered in time (YOY-149 AC-4); null when
   * the search was not served by Engine v2's find path, or failed.
   */
  extractionInTime: boolean | null;
  /** The search or its grading threw; scored 0. */
  failed: boolean;
  /** Where and what threw, for a failed search (YOY-141 AC-13). */
  failure?: FailureClass;
}

/** The stage of a scored search that can throw. */
export type FailureStage = "search" | "grade";

/**
 * A failure as the run may print it (YOY-141 AC-13): the stage and the
 * error's class name only — never its message, which can carry the query.
 */
export interface FailureClass {
  stage: FailureStage;
  className: string;
}

/** Failed searches per distinct (stage, class) pair. */
export interface FailureCount extends FailureClass {
  count: number;
}

const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * The thrown value's class name, read from its constructor — code-defined,
 * never from the error's own fields, so no message text can pass through.
 * Anything that is not a plain identifier prints as `Unnamed`.
 */
export function failureClassName(thrown: unknown): string {
  const name =
    typeof thrown === "object" && thrown !== null
      ? (thrown as { constructor?: { name?: unknown } }).constructor?.name
      : typeof thrown;
  return typeof name === "string" && CLASS_NAME.test(name) ? name : "Unnamed";
}

export interface LanguageScore {
  language: ScoreLanguage;
  score: number;
  searches: number;
  modelWritten: boolean;
  /** Share of searches answered in under 1 s, 0–1. */
  underOneSecond: number;
  /**
   * Share of Engine v2 searches composed without the wish extraction, 0–1
   * (YOY-149 AC-4); null when no search in the language reported it.
   */
  withoutExtraction: number | null;
  failed: number;
}

export interface ScoreReport {
  languages: LanguageScore[];
  /** The run's spend, read from the cost ledger (YOY-141 AC-10). */
  cost: { usd: number; calls: number };
  /** Failed searches per (stage, class), most frequent first (YOY-141 AC-13). */
  failures: FailureCount[];
}

/**
 * The run's spend from the cost ledger (YOY-141 AC-10). The scratch database
 * is discarded when the run ends, so the run reads its own ledger before
 * that. The caller flushes any queued ledger writes first: the search
 * pipeline queues them off the hot path (YOY-64 AC-1).
 */
export async function readRunCost(db: PrismaClient): Promise<ScoreReport["cost"]> {
  const { _sum, _count } = await db.aiCall.aggregate({ _sum: { costUsd: true }, _count: true });
  return { usd: _sum.costUsd ?? 0, calls: _count };
}

/** Description characters the grader sees (YOY-141 AC-11). */
export const DESCRIPTION_EXCERPT_CHARS = 300;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * A product description as a shopper reads it: HTML stripped, whitespace
 * collapsed, the first 300 characters (YOY-141 AC-11).
 */
export function descriptionExcerpt(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
      const lower = name.toLowerCase();
      if (!lower.startsWith("#")) return HTML_ENTITIES[lower] ?? entity;
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, DESCRIPTION_EXCERPT_CHARS).join("").trimEnd();
}

interface GraderEnrichment {
  category: string | null;
  colors: string[];
  occasions: string[];
  fit: string | null;
  styleTags: string[];
  sleeveLength: string | null;
  neckline: string | null;
  garmentLength: string | null;
  pattern: string | null;
  materialAppearance: string | null;
}

/**
 * What the grader sees besides title, type, vendor and price (YOY-140 AC-4,
 * YOY-141 AC-11): the enrichment's category, colours and occasions; its fit,
 * style tags and five vision attributes where present; and the description
 * excerpt. A product with none of the additions grades with today's shape.
 */
export function graderDetails(
  description: string,
  enrichment: GraderEnrichment | undefined,
): string | undefined {
  const labelled = (label: string, value: string | null | undefined) =>
    value ? `${label}: ${value}` : "";
  const excerpt = descriptionExcerpt(description);
  const parts = [
    enrichment?.category ?? "",
    enrichment?.colors.join(", ") ?? "",
    enrichment?.occasions.join(", ") ?? "",
    labelled("fit", enrichment?.fit),
    labelled("style", enrichment?.styleTags.join(", ")),
    labelled("sleeve length", enrichment?.sleeveLength),
    labelled("neckline", enrichment?.neckline),
    labelled("garment length", enrichment?.garmentLength),
    labelled("pattern", enrichment?.pattern),
    labelled("material appearance", enrichment?.materialAppearance),
    labelled("description", excerpt),
  ].filter((part) => part !== "");
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** The graded view of a search's top results, read from the catalog rows. */
async function gradedResults(
  db: PrismaClient,
  storeKey: string,
  productIds: readonly string[],
): Promise<GradedResult[]> {
  const [products, enrichments] = await Promise.all([
    db.catalogProduct.findMany({
      where: { shopDomain: storeKey, productId: { in: [...productIds] } },
    }),
    db.productEnrichment.findMany({
      where: { shopDomain: storeKey, productId: { in: [...productIds] } },
    }),
  ]);
  const byId = new Map(products.map((product) => [product.productId, product]));
  const enrichmentById = new Map(enrichments.map((row) => [row.productId, row]));
  return productIds.flatMap((productId) => {
    const product = byId.get(productId);
    if (product === undefined) return [];
    return [
      {
        title: product.title,
        productType: product.productType,
        vendor: product.vendor,
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        currencyCode: product.currencyCode,
        details: graderDetails(product.description, enrichmentById.get(productId)),
      },
    ];
  });
}

export async function runScoreSet({
  db,
  orchestrator,
  grader,
  storeKey,
  set,
  flushLedger = async () => {},
}: {
  db: PrismaClient;
  orchestrator: SearchOrchestrator;
  grader: LlmClient;
  storeKey: string;
  set: readonly ScoreSetEntry[];
  /** Settles the search pipeline's queued ledger writes before the cost is read. */
  flushLedger?: () => Promise<void>;
}): Promise<ScoreReport> {
  const outcomes: SearchOutcome[] = [];
  for (const entry of set) {
    let stage: FailureStage = "search";
    try {
      const { response, latencyMs } = await runPlaygroundSearch(orchestrator, {
        query: entry.query,
        storeKey,
        limit: SCORE_RESULT_LIMIT,
      });
      stage = "grade";
      const top = response.hits.slice(0, GRADED_RESULTS).map((hit) => hit.productId);
      const results = await gradedResults(db, storeKey, top);
      const grades = await gradeSearch({ llm: grader, query: entry.query, results });
      outcomes.push({
        language: entry.language,
        score: searchScore(grades),
        latencyMs,
        extractionInTime: response.extractionInTime ?? null,
        failed: false,
      });
    } catch (error) {
      // A failure is scored and counted by stage and class, never printed:
      // its message may carry the query.
      outcomes.push({
        language: entry.language,
        score: 0,
        latencyMs: Infinity,
        extractionInTime: null,
        failed: true,
        failure: { stage, className: failureClassName(error) },
      });
    }
  }

  const languages: LanguageScore[] = [];
  for (const language of SCORE_LANGUAGES) {
    const scored = outcomes.filter((outcome) => outcome.language === language);
    if (scored.length === 0) continue;
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    languages.push({
      language,
      score: mean(scored.map((outcome) => outcome.score)),
      searches: scored.length,
      modelWritten: set.some((entry) => entry.language === language && entry.modelWritten),
      underOneSecond: mean(scored.map((outcome) => (outcome.latencyMs < FAST_SEARCH_MS ? 1 : 0))),
      withoutExtraction: shareWithoutExtraction(scored),
      failed: scored.filter((outcome) => outcome.failed).length,
    });
  }
  await flushLedger();
  return { languages, cost: await readRunCost(db), failures: countFailures(outcomes) };
}

/** The share of searches that reported the extraction late (YOY-149 AC-4); null when none reported. */
function shareWithoutExtraction(outcomes: readonly SearchOutcome[]): number | null {
  const reported = outcomes.filter((outcome) => outcome.extractionInTime !== null);
  return reported.length === 0
    ? null
    : reported.filter((outcome) => outcome.extractionInTime === false).length / reported.length;
}

function countFailures(outcomes: readonly SearchOutcome[]): FailureCount[] {
  const counts = new Map<string, FailureCount>();
  for (const { failure } of outcomes) {
    if (failure === undefined) continue;
    const key = `${failure.stage} ${failure.className}`;
    const current = counts.get(key) ?? { ...failure, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.stage.localeCompare(b.stage) ||
      a.className.localeCompare(b.className),
  );
}

/** The score table: the only thing a run prints (AC-5, AC-7). */
export function formatScoreTable(report: ScoreReport): string {
  const rows = [
    ["language", "score", "searches", "model-written", "under 1 s", "no extraction", "failed"],
    ...report.languages.map((row) => [
      row.language,
      row.score.toFixed(3),
      String(row.searches),
      row.modelWritten ? "yes" : "no",
      `${Math.round(row.underOneSecond * 100)}%`,
      row.withoutExtraction === null ? "—" : `${Math.round(row.withoutExtraction * 100)}%`,
      String(row.failed),
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return [
    ...rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()),
    formatCostLine(report.cost),
    ...report.failures.map(formatFailureLine),
  ].join("\n");
}

/** One line per (stage, class) under the cost line (YOY-141 AC-13). */
export function formatFailureLine(failure: FailureCount): string {
  return `failed ${failure.stage} ${failure.className} ${failure.count}`;
}

/** The ledger line under the table: numbers only, like every table row. */
export function formatCostLine(cost: ScoreReport["cost"]): string {
  return `cost $${cost.usd.toFixed(4)} over ${cost.calls} model calls`;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/**
 * Run `work` with every console method captured (AC-7): engine logging,
 * fallback warnings, a framework's error print — none reaches the process
 * output while the set's queries are in flight.
 */
export async function withCapturedConsole<T>(
  work: () => Promise<T>,
): Promise<{ result: T; captured: string[] }> {
  const captured: string[] = [];
  const originals = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  try {
    return { result: await work(), captured };
  } finally {
    for (const [method, original] of originals) {
      console[method] = original;
    }
  }
}
