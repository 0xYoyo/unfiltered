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
  /** The search or its grading threw; scored 0. */
  failed: boolean;
}

export interface LanguageScore {
  language: ScoreLanguage;
  score: number;
  searches: number;
  modelWritten: boolean;
  /** Share of searches answered in under 1 s, 0–1. */
  underOneSecond: number;
  failed: number;
}

export interface ScoreReport {
  languages: LanguageScore[];
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
}: {
  db: PrismaClient;
  orchestrator: SearchOrchestrator;
  grader: LlmClient;
  storeKey: string;
  set: readonly ScoreSetEntry[];
}): Promise<ScoreReport> {
  const outcomes: SearchOutcome[] = [];
  for (const entry of set) {
    try {
      const { response, latencyMs } = await runPlaygroundSearch(orchestrator, {
        query: entry.query,
        storeKey,
        limit: SCORE_RESULT_LIMIT,
      });
      const top = response.hits.slice(0, GRADED_RESULTS).map((hit) => hit.productId);
      const results = await gradedResults(db, storeKey, top);
      const grades = await gradeSearch({ llm: grader, query: entry.query, results });
      outcomes.push({ language: entry.language, score: searchScore(grades), latencyMs, failed: false });
    } catch {
      // A failure is scored, never printed: its message may carry the query.
      outcomes.push({ language: entry.language, score: 0, latencyMs: Infinity, failed: true });
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
      failed: scored.filter((outcome) => outcome.failed).length,
    });
  }
  return { languages };
}

/** The score table: the only thing a run prints (AC-5, AC-7). */
export function formatScoreTable(report: ScoreReport): string {
  const rows = [
    ["language", "score", "searches", "model-written", "under 1 s", "failed"],
    ...report.languages.map((row) => [
      row.language,
      row.score.toFixed(3),
      String(row.searches),
      row.modelWritten ? "yes" : "no",
      `${Math.round(row.underOneSecond * 100)}%`,
      String(row.failed),
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
    .join("\n");
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
