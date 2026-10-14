import type { PrismaClient } from "@prisma/client";
import type { LlmClient } from "@unfiltered/engine";

import type { FindStep } from "../search/find.server";
import { gradePrompt, MAX_GRADE, type GradedResult } from "./grade.server";
import { graderDetails, type ScoreReport } from "./run.server";
import type { ScoreLanguage, ScoreSetEntry } from "./set.server";

/**
 * Find recall (YOY-174): how much of a public search's relevant set the find
 * step reaches. The relevant set is graded once, offline, with the score
 * grader's rubric over every product of the fixture, then committed as the
 * truth file so re-runs make no grading call. The find step then runs alone,
 * with no extraction and no judge, at the production find-set size.
 *
 * The truth is graded without descriptions (founder, 2026-10-14). Each
 * product shows the grader's view minus its 300-character description
 * excerpt: title, type, vendor and price, then category, colours, occasions,
 * fit, style tags and the five vision attributes. That keeps the one-time
 * build under its cap. If the build stops at the cap anyway, the searches
 * graded so far are written as a truth marked partial and measured.
 *
 * Recall counts families, not products (one family, one card). The find step
 * collapses colourways to their family's first product, so a relevant
 * colourway counts as reached when its family's card is reached.
 */

export const RECALL_OPERATION = "score-recall";
/** Products per grading call (AC-1). */
export const RECALL_BATCH_SIZE = 48;
/** A product graded at least this is relevant (AC-1). */
export const RELEVANT_GRADE = 2;
/** The first page of the find order (AC-2): the score's result limit. */
export const RECALL_FIRST_PAGE = 24;
/** A search under this recall is counted per language (AC-2). */
export const LOW_RECALL = 0.5;
/** The truth build stops once its ledger passes this (co-manager, 2026-10-14: $0.50). */
export const RECALL_COST_CAP_USD = 0.5;
/** The languages the truth covers (AC-1): the two with real log searches. */
export const RECALL_LANGUAGES: readonly ScoreLanguage[] = ["en", "he"];

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    grades: { type: "array", items: { type: "integer", minimum: 0, maximum: MAX_GRADE } },
  },
  required: ["grades"],
};

/** One graded product of a search's relevant set. */
export interface RelevantProduct {
  productId: string;
  grade: number;
}

export interface RecallTruthSearch {
  query: string;
  language: ScoreLanguage;
  /** Every product graded ≥ `RELEVANT_GRADE`, in catalog order. */
  relevant: RelevantProduct[];
}

/** The committed truth file (AC-1). */
export interface RecallTruth {
  version: 1;
  storeKey: string;
  builtAt: string;
  /** Products graded per search: the whole fixture. */
  graded: number;
  /**
   * The build stopped at the cost cap: only the searches listed were graded,
   * out of `searchesPlanned`.
   */
  partial: boolean;
  searchesPlanned: number;
  searches: RecallTruthSearch[];
}

/** The searches the truth covers: the public set's en and he entries, in set order. */
export function recallSearches(set: readonly ScoreSetEntry[]): ScoreSetEntry[] {
  return set.filter((entry) => RECALL_LANGUAGES.includes(entry.language));
}

/** Every product of the store as the truth grader sees it, in catalog order. */
export async function recallCatalog(
  db: PrismaClient,
  storeKey: string,
): Promise<{ productId: string; result: GradedResult }[]> {
  const [products, enrichments] = await Promise.all([
    db.catalogProduct.findMany({ where: { shopDomain: storeKey }, orderBy: { productId: "asc" } }),
    db.productEnrichment.findMany({ where: { shopDomain: storeKey } }),
  ]);
  const enrichmentById = new Map(enrichments.map((row) => [row.productId, row]));
  return products.map((product) => ({
    productId: product.productId,
    result: {
      title: product.title,
      productType: product.productType,
      vendor: product.vendor,
      priceMin: product.priceMin,
      priceMax: product.priceMax,
      currencyCode: product.currencyCode,
      // The grader's view without the description (see the header).
      details: graderDetails("", enrichmentById.get(product.productId)),
    },
  }));
}

/** One grading call over a batch, with the score grader's rubric and prompt. */
export async function gradeRecallBatch(
  llm: LlmClient,
  query: string,
  results: readonly GradedResult[],
): Promise<number[]> {
  const answer = await llm.completeStructured({
    prompt: gradePrompt(query, results),
    schema: BATCH_SCHEMA,
    operation: RECALL_OPERATION,
    temperature: 0,
  });
  const grades = (answer as { grades?: unknown }).grades;
  if (
    !Array.isArray(grades) ||
    grades.length !== results.length ||
    !grades.every((grade) => Number.isInteger(grade) && grade >= 0 && grade <= MAX_GRADE)
  ) {
    throw new Error(`score recall: expected ${results.length} grades of 0–${MAX_GRADE}`);
  }
  return grades as number[];
}

export interface RecallTruthBuild {
  truth: RecallTruth;
  cost: ScoreReport["cost"];
}

/**
 * Build the truth (AC-1): every product graded for every search, in batches
 * of `RECALL_BATCH_SIZE`. After each call the ledger is read, and once it
 * passes `capUsd` the build stops. The searches fully graded so far form a
 * truth marked `partial`; the search in progress is dropped.
 */
export async function buildRecallTruth({
  db,
  llm,
  storeKey,
  searches,
  readCost,
  capUsd = RECALL_COST_CAP_USD,
  batchSize = RECALL_BATCH_SIZE,
  now = () => new Date(),
  progress = () => {},
}: {
  db: PrismaClient;
  llm: LlmClient;
  storeKey: string;
  searches: readonly ScoreSetEntry[];
  readCost: () => Promise<ScoreReport["cost"]>;
  capUsd?: number;
  batchSize?: number;
  now?: () => Date;
  /** One line per search as it finishes, `[n/N] <lang> graded`; never the query. */
  progress?: (line: string) => void;
}): Promise<RecallTruthBuild> {
  const catalog = await recallCatalog(db, storeKey);
  const done: RecallTruthSearch[] = [];
  for (const [index, entry] of searches.entries()) {
    const relevant: RelevantProduct[] = [];
    for (let start = 0; start < catalog.length; start += batchSize) {
      const batch = catalog.slice(start, start + batchSize);
      const results = batch.map((item) => item.result);
      // One retry on a failed or malformed answer: a lost batch would lose
      // the whole paid build.
      const grades = await gradeRecallBatch(llm, entry.query, results).catch(() =>
        gradeRecallBatch(llm, entry.query, results),
      );
      batch.forEach((item, position) => {
        const grade = grades[position]!;
        if (grade >= RELEVANT_GRADE) {
          relevant.push({ productId: item.productId, grade });
        }
      });
      const cost = await readCost();
      if (cost.usd > capUsd) {
        return { truth: truthOf(true), cost };
      }
    }
    done.push({ query: entry.query, language: entry.language, relevant });
    progress(`[${index + 1}/${searches.length}] ${entry.language} graded`);
  }
  return { truth: truthOf(false), cost: await readCost() };

  function truthOf(partial: boolean): RecallTruth {
    return {
      version: 1,
      storeKey,
      builtAt: now().toISOString(),
      graded: catalog.length,
      partial,
      searchesPlanned: searches.length,
      searches: [...done],
    };
  }
}

/** One search's recall (AC-2). */
export interface SearchRecall {
  query: string;
  language: ScoreLanguage;
  /** Relevant families. */
  relevant: number;
  /** Relevant families whose card is inside the find set. */
  inFindSet: number;
  /** `inFindSet / relevant`; null when nothing is relevant. */
  recall: number | null;
  /** Relevant families inside the first `RECALL_FIRST_PAGE` of the find order. */
  inFirstPage: number;
}

export interface LanguageRecall {
  language: ScoreLanguage;
  searches: number;
  /** Mean recall over the searches with a relevant set; null when none has one. */
  meanRecall: number | null;
  /** Searches whose recall is under `LOW_RECALL`. */
  lowRecall: number;
  /** Searches with nothing relevant: left out of the mean. */
  noneRelevant: number;
}

/**
 * Recall of one search on one find order (AC-2). Pure. `familyOf` maps a
 * product to its family; a product with none is its own family.
 */
export function searchRecall({
  search,
  productIds,
  findSetCount,
  familyOf,
}: {
  search: RecallTruthSearch;
  productIds: readonly string[];
  findSetCount: number;
  familyOf: (productId: string) => string;
}): SearchRecall {
  const relevantFamilies = new Set(search.relevant.map((product) => familyOf(product.productId)));
  const familiesIn = (ids: readonly string[]) => new Set(ids.map(familyOf));
  const findSet = familiesIn(productIds.slice(0, findSetCount));
  const firstPage = familiesIn(productIds.slice(0, RECALL_FIRST_PAGE));
  const relevant = relevantFamilies.size;
  const inFindSet = [...relevantFamilies].filter((family) => findSet.has(family)).length;
  return {
    query: search.query,
    language: search.language,
    relevant,
    inFindSet,
    recall: relevant === 0 ? null : inFindSet / relevant,
    inFirstPage: [...relevantFamilies].filter((family) => firstPage.has(family)).length,
  };
}

/** Per language (AC-2): the mean recall and the searches under `LOW_RECALL`. */
export function languageRecall(rows: readonly SearchRecall[]): LanguageRecall[] {
  return RECALL_LANGUAGES.map((language) => {
    const own = rows.filter((row) => row.language === language);
    const scored = own.filter((row) => row.recall !== null);
    return {
      language,
      searches: own.length,
      meanRecall:
        scored.length === 0
          ? null
          : scored.reduce((sum, row) => sum + row.recall!, 0) / scored.length,
      lowRecall: scored.filter((row) => row.recall! < LOW_RECALL).length,
      noneRelevant: own.length - scored.length,
    };
  });
}

/** Run the find step alone on every truth search (AC-2). */
export async function measureRecall({
  db,
  find,
  storeKey,
  truth,
}: {
  db: PrismaClient;
  find: FindStep;
  storeKey: string;
  truth: RecallTruth;
}): Promise<SearchRecall[]> {
  const families = await db.catalogProduct.findMany({
    where: { shopDomain: storeKey },
    select: { productId: true, familyKey: true },
  });
  const familyById = new Map(
    families.map((row) => [row.productId, row.familyKey === "" ? row.productId : row.familyKey]),
  );
  const familyOf = (productId: string) => familyById.get(productId) ?? productId;
  const rows: SearchRecall[] = [];
  for (const [index, search] of truth.searches.entries()) {
    const found = await find.find({
      shopDomain: storeKey,
      query: search.query,
      searchId: `score-recall-${index}`,
    });
    rows.push(
      searchRecall({
        search,
        productIds: found.productIds,
        findSetCount: found.findSetCount,
        familyOf,
      }),
    );
  }
  return rows;
}

/** One line per search (public queries may print): numbers first, query last. */
export function formatRecallLine(row: SearchRecall, index: number): string {
  const recall = row.recall === null ? "—" : row.recall.toFixed(3);
  return `recall ${row.language} ${index} relevant ${row.relevant} in-find-set ${row.inFindSet} recall ${recall} first-${RECALL_FIRST_PAGE} ${row.inFirstPage} ${row.query}`;
}

/** One line per language (AC-2). */
export function formatLanguageRecallLine(row: LanguageRecall): string {
  const mean = row.meanRecall === null ? "—" : row.meanRecall.toFixed(3);
  return `recall-mean ${row.language} ${mean} over ${row.searches - row.noneRelevant} of ${row.searches} searches, under ${LOW_RECALL} ${row.lowRecall}, none relevant ${row.noneRelevant}`;
}
