import type { LlmClient } from "@unfiltered/engine";

/**
 * The score grader (YOY-140 AC-4): one Flash-Lite call per search, at
 * temperature 0 (thinking level low is set on the client), grading each of
 * up to six results 0–3 against the fixed rubric below. The rubric is
 * committed verbatim in docs/SCORE.md; a test holds the two equal.
 */

export const SCORE_GRADE_OPERATION = "score-grade";
/** Results graded per search: the first screen a shopper sees. */
export const GRADED_RESULTS = 6;
export const MAX_GRADE = 3;

export const SCORE_RUBRIC = `Grade each result for the shopper's search, the way the shopper would judge it.
3 — exactly: it is what the shopper asked for, and every stated wish is met.
2 — close: the right kind of product, with one stated wish off or not shown.
1 — weak: related to the search, but not a product the shopper would pick for it.
0 — no: unrelated, or it breaks something the shopper asked for or ruled out.

Example, grade 1: search "black running shoes", result "Black leather dress shoes" — black shoes, but not for running.
Example, grade 0: search "dress not in red", result "Red wrap dress" — the shopper ruled red out.`;

/** One result as the grader sees it. */
export interface GradedResult {
  title: string;
  productType?: string;
  vendor?: string;
  priceMin?: number;
  priceMax?: number;
  currencyCode?: string;
  /** Free text — enrichment attributes or a description excerpt. */
  details?: string;
}

const GRADE_SCHEMA = {
  type: "object",
  properties: {
    grades: { type: "array", items: { type: "integer", minimum: 0, maximum: MAX_GRADE } },
  },
  required: ["grades"],
};

function describeResult(result: GradedResult, position: number): string {
  const price =
    result.priceMin === undefined
      ? ""
      : result.priceMax !== undefined && result.priceMax !== result.priceMin
        ? ` · ${result.priceMin}–${result.priceMax} ${result.currencyCode ?? ""}`.trimEnd()
        : ` · ${result.priceMin} ${result.currencyCode ?? ""}`.trimEnd();
  const kind = [result.productType, result.vendor].filter((part) => part).join(" · ");
  return [
    `${position}. ${result.title}${kind === "" ? "" : ` (${kind})`}${price}`,
    ...(result.details ? [`   ${result.details}`] : []),
  ].join("\n");
}

/** The grading prompt; its `Query:` line keys replay recordings. */
export function gradePrompt(query: string, results: readonly GradedResult[]): string {
  return [
    SCORE_RUBRIC,
    "",
    "Results, in the order the shop showed them:",
    ...results.map((result, index) => describeResult(result, index + 1)),
    "",
    `Answer as JSON: {"grades": [one grade per result, in order — ${results.length} grades]}.`,
    `Query: ${query}`,
  ].join("\n");
}

/**
 * Grade up to six results for one search. Zero results need no call: the
 * empty slots grade 0 in the score itself.
 */
export async function gradeSearch({
  llm,
  query,
  results,
}: {
  llm: LlmClient;
  query: string;
  results: readonly GradedResult[];
}): Promise<number[]> {
  const graded = results.slice(0, GRADED_RESULTS);
  if (graded.length === 0) {
    return [];
  }
  const answer = await llm.completeStructured({
    prompt: gradePrompt(query, graded),
    schema: GRADE_SCHEMA,
    operation: SCORE_GRADE_OPERATION,
    temperature: 0,
  });
  const grades = (answer as { grades?: unknown }).grades;
  if (
    !Array.isArray(grades) ||
    grades.length !== graded.length ||
    !grades.every((grade) => Number.isInteger(grade) && grade >= 0 && grade <= MAX_GRADE)
  ) {
    throw new Error(`score grader: expected ${graded.length} grades of 0–${MAX_GRADE}`);
  }
  return grades as number[];
}

/**
 * A search's score (AC-5): the mean of six grades over 3, every missing
 * result slot graded 0 — returning fewer than six results costs score.
 */
export function searchScore(grades: readonly number[]): number {
  let sum = 0;
  for (let slot = 0; slot < GRADED_RESULTS; slot += 1) {
    sum += grades[slot] ?? 0;
  }
  return sum / GRADED_RESULTS / MAX_GRADE;
}

/** Calibration agreement (AC-9) over every hand-graded result. */
export function gradeAgreement(
  pairs: readonly { hand: number; model: number }[],
): { pairs: number; exact: number; withinOne: number } {
  if (pairs.length === 0) {
    return { pairs: 0, exact: 0, withinOne: 0 };
  }
  const exact = pairs.filter((pair) => pair.hand === pair.model).length;
  const withinOne = pairs.filter((pair) => Math.abs(pair.hand - pair.model) <= 1).length;
  return {
    pairs: pairs.length,
    exact: (exact / pairs.length) * 100,
    withinOne: (withinOne / pairs.length) * 100,
  };
}
