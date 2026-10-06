/**
 * The judge (YOY-147; PRD §3 Engine v2): one structured call per page reads
 * the shopper's sentence and the page's products together and answers per
 * product in short codes — a verdict, the kinds of wishes the product
 * misses, and a label template with at most two short values. No prose
 * field exists, so nothing the model writes reaches a shopper beyond those
 * values.
 *
 * Vendor-free by the engine's boundary rule: the judge speaks to the
 * `LlmClient` port, and the model behind it is the consumer's concern. The
 * one factory, `createJudge`, picks the port from `JUDGE_PROVIDER`; no code
 * outside the provider adapter names a judge model (AC-1). The challenger
 * (YOY-152) speaks to the `DecisionClient` port instead: one typed question
 * set per product, asked in parallel.
 */

import { previousChainLine } from "./extract.js";
import type { DecisionClient, DecisionQuestion, JsonSchema, LlmClient } from "./index.js";

/** Env var naming which provider answers the judge call (AC-1). */
export const JUDGE_PROVIDER_ENV = "JUDGE_PROVIDER";

/**
 * Providers the factory can select. `jev` is the default: the founder named
 * it the winner of the M6 judge comparison (YOY-152 AC-9, 2026-10-04);
 * `gemini` stays selectable as the fallback behind the same swap point.
 */
export const JUDGE_PROVIDERS = ["gemini", "jev"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];
export const DEFAULT_JUDGE_PROVIDER: JudgeProvider = "jev";

/**
 * The judge prompt's version (YOY-148 AC-1): part of the answer-cache key,
 * so a stored answer is never served for a prompt that has since changed.
 * Bump it with every change to `buildJudgePrompt`, `judgeRow` or the
 * answer schema.
 */
export const JUDGE_PROMPT_VERSION = 3;

/** Characters one candidate row is cut to (AC-2; raised to 480 by AC-17). */
export const DEFAULT_JUDGE_ROW_CHARS = 480;
/** Description characters a product with no card contributes (AC-2). */
export const JUDGE_DESCRIPTION_CHARS = 200;
/** Words a `fact-differs` value may hold; a longer one drops the label (AC-3, AC-9). */
export const JUDGE_LABEL_MAX_WORDS = 3;
/** Words the second reading may hold; a longer one is dropped (YOY-150 AC-7). */
export const JUDGE_READING_MAX_WORDS = 4;

/**
 * The verdict codes (AC-3), best first: exactly what was asked; the same
 * item in another colour or size; close; not relevant.
 */
export const JUDGE_VERDICTS = ["exact", "other-variant", "close", "not-relevant"] as const;
export type JudgeVerdictCode = (typeof JUDGE_VERDICTS)[number];

/** Which kind of stated wish a product misses (AC-3). */
export const JUDGE_MISSED_WISHES = ["fact", "description"] as const;
export type JudgeMissedWish = (typeof JUDGE_MISSED_WISHES)[number];

/** The label templates a judged product can carry (AC-3). */
export const JUDGE_LABEL_TEMPLATES = ["fact-differs", "close-match"] as const;
export type JudgeLabelTemplate = (typeof JUDGE_LABEL_TEMPLATES)[number];

/**
 * A label as the wire carries it (AC-9): `fact-differs` holds two values,
 * the product's and the asked one; `close-match` holds none.
 */
export interface JudgeLabel {
  template: JudgeLabelTemplate;
  values: string[];
}

/** One option of a candidate, with every value the product offers. */
export interface JudgeCandidateOption {
  name: string;
  values: string[];
}

/** One vision attribute of a candidate, e.g. `sleeve length` = `long` (AC-17). */
export interface JudgeCandidateAttribute {
  name: string;
  value: string;
}

/** One product on the page, as the judge reads it (AC-2, AC-17). */
export interface JudgeCandidate {
  id: string;
  title: string;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  options: JudgeCandidateOption[];
  /** The card's `facts` section; null when the product has no card. */
  facts: string | null;
  /** The enrichment's vision attributes that hold a value, in a fixed order. */
  attributes: JudgeCandidateAttribute[];
  /** Read only when `facts` is null: its first 200 characters stand in. */
  description: string;
}

/** One judge call: a page of candidates in find order. */
export interface JudgeRequest {
  sentence: string;
  /**
   * The chain the sentence follows (YOY-150 AC-2): the client's
   * `previousQuery`, sentences separated by newlines. Absent on a fresh
   * search.
   */
  previousSentence?: string;
  candidates: JudgeCandidate[];
  storeId?: string;
  searchId?: string;
  /** Aborts the call (the caller's deadline, AC-6). */
  signal?: AbortSignal;
  /**
   * Diagnostics (YOY-159 AC-1): told each single provider call's duration
   * in ms as it settles, answered or failed. The decision judge makes one
   * call per candidate; the LLM judge one per attempt for the page.
   */
  onCallSettled?: (ms: number) => void;
}

/** The judge's answer for one candidate. */
export interface JudgeVerdict {
  id: string;
  verdict: JudgeVerdictCode;
  missed: JudgeMissedWish[];
  /** Null when the template is none or a value broke the word limit (AC-9). */
  label: JudgeLabel | null;
  /**
   * The product is something the shopper said they do not want (YOY-149
   * AC-11): it is dropped from the page and never labelled.
   */
  excluded: boolean;
  /**
   * The verdict is a stand-in for an answer that never came — a call that
   * failed, ran past its limit, or answered invalidly (YOY-159): it reads
   * "not relevant" but is never a judgment, so the product stays on the
   * page, last and unlabelled. Absent on a real verdict.
   */
  standIn?: true;
}

/** The judge's answer for one page. */
export interface JudgeAnswer {
  /** One verdict per candidate, in candidate order. */
  verdicts: JudgeVerdict[];
  /**
   * A second reading of the sentence that at least one candidate fits
   * (YOY-150 AC-7): at most four words, in the shopper's language. Null
   * when there is none, when no candidate fits it, or when it is too long.
   */
  otherReading: string | null;
  /**
   * True when a candidate's verdict is a stand-in for an answer that never
   * came — the decision judge reads a failed or invalid per-product answer
   * as not relevant (YOY-152 AC-2). The page is served, but the answer is
   * never cached: a transient failure must not pin a product down for every
   * later identical search. Absent on a fully answered page.
   */
  partial?: true;
}

export interface Judge {
  /**
   * Which provider and model answer, e.g. `gemini:gemini-3.5-flash-lite`
   * (YOY-148 AC-1): part of the answer-cache key. Absent on a judge built
   * without one; it then caches under `unknown`.
   */
  readonly identity?: string;
  /**
   * One verdict per candidate, in candidate order, and the second reading
   * when there is one. Rejects with `JudgeAnswerError` when the answer is
   * invalid twice (AC-4), and with the port's own error when the call fails.
   */
  judge(request: JudgeRequest): Promise<JudgeAnswer>;
}

/** The judge's answer failed the schema or the coverage check twice (AC-4). */
export class JudgeAnswerError extends Error {
  override readonly name = "JudgeAnswerError";
}

/**
 * The short codes the model answers in (AC-3). Output tokens are the
 * judge's latency, and Flash-Lite pretty-prints structured JSON: a page of
 * 24 answered as one object per candidate ran ~950–1,500 output tokens and
 * 2.5–4 s, past the 1,500 ms deadline, most of it indentation; one array
 * per field still ran ~400. So each candidate's answer is one three-letter
 * code in page order — verdict, missed wishes, label — and the two label
 * values ride a short side list, present only for `fact-differs` labels.
 */
export const JUDGE_VERDICT_CODES: Record<string, JudgeVerdictCode> = {
  E: "exact",
  V: "other-variant",
  C: "close",
  N: "not-relevant",
};
/** Missed-wish flags as one letter: none, fact, description, or both. */
export const JUDGE_MISSED_CODES: Record<string, JudgeMissedWish[]> = {
  "-": [],
  F: ["fact"],
  D: ["description"],
  B: ["fact", "description"],
};
export const JUDGE_LABEL_CODES: Record<string, JudgeLabelTemplate | null> = {
  F: "fact-differs",
  C: "close-match",
  X: null,
};

/** Every answer code: verdict letter, missed-wish letter, label letter. */
export const JUDGE_ANSWER_CODES: readonly string[] = Object.keys(JUDGE_VERDICT_CODES).flatMap(
  (verdict) =>
    Object.keys(JUDGE_MISSED_CODES).flatMap((missed) =>
      Object.keys(JUDGE_LABEL_CODES).map((label) => `${verdict}${missed}${label}`),
    ),
);

/**
 * JSON Schema of the judge's answer (AC-3): `c` holds one code per
 * candidate, in page order — its verdict, missed-wish flags and label
 * template — and `d` holds, for each `fact-differs` label, the candidate's
 * number `n` with the product's value `p` and the asked value `a`; `x`
 * lists the numbers of products the shopper excluded (YOY-149 AC-11); `r`
 * is a second reading of the sentence ("" when none) and `rn` the numbers
 * of the products that fit it (YOY-150 AC-7). Short codes and one short
 * phrase only; no prose field exists.
 */
export const JUDGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    c: { type: "array", items: { type: "string", enum: [...JUDGE_ANSWER_CODES] } },
    d: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          p: { type: "string" },
          a: { type: "string" },
        },
        required: ["n", "p", "a"],
      },
    },
    x: { type: "array", items: { type: "integer" } },
    r: { type: "string" },
    rn: { type: "array", items: { type: "integer" } },
  },
  required: ["c", "d", "x", "r", "rn"],
};

/** The provider `JUDGE_PROVIDER` names; unset means jev, an unknown name fails. */
export function judgeProviderFromEnv(
  env: Record<string, string | undefined>,
): JudgeProvider {
  const raw = env[JUDGE_PROVIDER_ENV];
  if (raw === undefined) {
    return DEFAULT_JUDGE_PROVIDER;
  }
  const provider = raw.trim();
  if (!(JUDGE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `${JUDGE_PROVIDER_ENV} must be one of ${JUDGE_PROVIDERS.join("|")}, got ${JSON.stringify(raw)}`,
    );
  }
  return provider as JudgeProvider;
}

function formatPrice(candidate: JudgeCandidate): string {
  const amount = (value: number) => String(Math.round(value * 100) / 100);
  return candidate.priceMin === candidate.priceMax
    ? `${amount(candidate.priceMin)} ${candidate.currencyCode}`
    : `${amount(candidate.priceMin)}–${amount(candidate.priceMax)} ${candidate.currencyCode}`;
}

/** Collapse runs of whitespace so a row stays one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * One compact candidate row (AC-2, AC-17): title, price, the card's facts —
 * or, with no card, the description's first 200 characters — then the
 * vision attributes as `key: value`, then option names and values, cut to
 * `maxChars`. Facts, not a blurb: a summary often leaves out the sleeves.
 */
export function judgeRow(candidate: JudgeCandidate, maxChars = DEFAULT_JUDGE_ROW_CHARS): string {
  const options = candidate.options
    .filter((option) => option.values.length > 0)
    .map((option) => `${option.name}: ${option.values.join(", ")}`)
    .join("; ");
  const about =
    candidate.facts !== null
      ? candidate.facts
      : candidate.description.slice(0, JUDGE_DESCRIPTION_CHARS);
  const attributes = candidate.attributes
    .map((attribute) => `${attribute.name}: ${attribute.value}`)
    .join("; ");
  const row = [candidate.title, formatPrice(candidate), about, attributes, options]
    .map(oneLine)
    .filter((part) => part !== "")
    .join(" | ");
  return row.slice(0, maxChars);
}

/**
 * The judge prompt; its `Query:` line keys replay recordings. With a
 * previous sentence (YOY-150 AC-2) it shows the previous search and says
 * the new one may refine or replace it.
 */
export function buildJudgePrompt(
  sentence: string,
  candidates: readonly JudgeCandidate[],
  maxRowChars = DEFAULT_JUDGE_ROW_CHARS,
  previousSentence?: string,
): string {
  const rows = candidates.map(
    (candidate, index) => `${index + 1}. ${judgeRow(candidate, maxRowChars)}`,
  );
  const previous =
    previousSentence === undefined || previousSentence.trim() === ""
      ? []
      : [
          `Previous search: ${previousChainLine(previousSentence)}`,
          "The search below may refine the previous one (keep its wishes and add or change some)",
          "or replace it with a different search. Judge against what the shopper wants now.",
        ];
  return [
    "You judge store search results. Read the shopper's search, then every numbered product.",
    "Products are listed in search order. Answer with one three-letter code per product in c,",
    "in product order. Judge each product only by what its row says.",
    "",
    "Letter 1, the verdict:",
    "E = exact: only when every wish the shopper stated is met by the product's row.",
    "V = the item the shopper asked for, but only in another colour or size than asked.",
    "C = close: the right kind of product, but a stated wish the row contradicts or does not",
    "mention (for example, long sleeves asked and the row says sleeveless or says nothing of",
    "sleeves). Mark it C with the D missed-wish flag (B when a merchant fact also differs), never E.",
    "N = not relevant: the wrong kind of product.",
    "Products with the same verdict keep their search order.",
    "",
    "Letter 2, the wishes it misses: - = none; F = a merchant fact differs or is not shown",
    "(material, colour, size, price, an option); D = a described quality is not met or not shown",
    "(style, look, sleeves, length, fit, occasion); B = both.",
    "",
    "Letter 3, the label: F = one merchant fact differs from what was asked; C = close for any",
    "other reason; X = no label. For every F label, add one entry to d: n is the product's",
    "number, p the product's value and a the asked value, each at most three words, in the",
    "language of the search. d is empty when no label is F.",
    "",
    "x: the numbers of every product that is something the shopper said they do NOT want",
    "(\"not black\" and the product is black; \"no wool\" and it is wool). x is empty when none.",
    "",
    "r: when the search can honestly mean a second, different kind of product (\"wedding dress\":",
    "a bridal gown, or a dress to wear as a guest) and at least one listed product fits that",
    "other meaning, r names it in at most four words, in the language of the search (\"Bridal",
    "gowns\"), and rn lists the numbers of the products that fit it. Otherwise r is \"\" and rn",
    "is empty.",
    "",
    "Example: E-X is an exact match; CDC is close, a described wish not shown.",
    "",
    ...previous,
    `Query: ${oneLine(sentence)}`,
    "Products:",
    ...rows,
  ].join("\n");
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((word) => word !== "").length;
}

/**
 * The label one answer entry carries (AC-9): `close-match` as is; a
 * `fact-differs` with both values present, each non-empty and at most three
 * words; anything else is no label.
 */
function labelOf(
  template: JudgeLabelTemplate | null,
  productValue: string | null,
  askedValue: string | null,
): JudgeLabel | null {
  if (template === "close-match") {
    return { template: "close-match", values: [] };
  }
  if (template !== "fact-differs") {
    return null;
  }
  const values = [productValue, askedValue].map((value) =>
    value === null ? "" : oneLine(value),
  );
  if (values.some((value) => value === "" || wordCount(value) > JUDGE_LABEL_MAX_WORDS)) {
    return null;
  }
  return { template: "fact-differs", values };
}

/**
 * The second reading an answer carries (YOY-150 AC-7): kept only when it
 * is a non-empty phrase of at most four words and at least one listed
 * product number fits it. Anything else is no reading, never an invalid
 * answer.
 */
function readingOf(r: unknown, rn: unknown, count: number): string | null {
  if (typeof r !== "string" || !Array.isArray(rn)) {
    return null;
  }
  const reading = oneLine(r);
  const fits = rn.some(
    (n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= count,
  );
  return reading === "" || !fits || wordCount(reading) > JUDGE_READING_MAX_WORDS ? null : reading;
}

/**
 * Validate one answer against the schema and against the page (AC-4):
 * exactly one known code per candidate, and a side list naming each
 * candidate at most once. Null when invalid. The second reading is never
 * a reason to reject: a malformed one is simply absent (YOY-150 AC-7).
 */
export function parseJudgeAnswer(
  answer: unknown,
  candidates: readonly JudgeCandidate[],
): JudgeAnswer | null {
  if (typeof answer !== "object" || answer === null) {
    return null;
  }
  const { c, d, x, r, rn } = answer as Record<string, unknown>;
  const count = candidates.length;
  if (
    !Array.isArray(c) ||
    c.length !== count ||
    !c.every((code) => typeof code === "string" && JUDGE_ANSWER_CODES.includes(code)) ||
    !Array.isArray(d)
  ) {
    return null;
  }
  // The side list: at most one entry per candidate, by its number.
  const values = new Map<number, { p: string; a: string }>();
  for (const raw of d) {
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const { n, p, a } = raw as Record<string, unknown>;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > count ||
      values.has(n) ||
      typeof p !== "string" ||
      typeof a !== "string"
    ) {
      return null;
    }
    values.set(n, { p, a });
  }
  // The excluded list (YOY-149 AC-11): candidate numbers, each at most once.
  // Absent is read as none, so an answer without it still parses.
  const excluded = new Set<number>();
  if (x !== undefined) {
    if (!Array.isArray(x)) {
      return null;
    }
    for (const n of x) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > count || excluded.has(n)) {
        return null;
      }
      excluded.add(n);
    }
  }
  const verdicts = candidates.map((candidate, index) => {
    const [verdict, missed, label] = [...(c[index] as string)];
    const pair = values.get(index + 1);
    return {
      id: candidate.id,
      verdict: JUDGE_VERDICT_CODES[verdict!]!,
      missed: [...JUDGE_MISSED_CODES[missed!]!],
      label: excluded.has(index + 1)
        ? null
        : labelOf(JUDGE_LABEL_CODES[label!]!, pair?.p ?? null, pair?.a ?? null),
      excluded: excluded.has(index + 1),
    };
  });
  return { verdicts, otherReading: readingOf(r, rn, count) };
}

export interface LlmJudgeOptions {
  llm: LlmClient;
  /** Provider and model, for the answer-cache key (YOY-148 AC-1). */
  identity?: string;
  /** Characters a candidate row is cut to; 320 by default (AC-2). */
  maxRowChars?: number;
}

/**
 * The judge over the LLM port (AC-2 – AC-4): one call per page at
 * temperature 0 under ledger operation `judge`; an invalid answer is asked
 * once more, then rejected as `JudgeAnswerError`.
 */
export function createLlmJudge(options: LlmJudgeOptions): Judge {
  const { llm } = options;
  const maxRowChars = options.maxRowChars ?? DEFAULT_JUDGE_ROW_CHARS;
  return {
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
    async judge(request) {
      const prompt = buildJudgePrompt(
        request.sentence,
        request.candidates,
        maxRowChars,
        request.previousSentence,
      );
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const startedAt = performance.now();
        const answer = await llm
          .completeStructured({
            prompt,
            schema: JUDGE_SCHEMA,
            operation: "judge",
            temperature: 0,
            storeId: request.storeId,
            searchId: request.searchId,
            signal: request.signal,
          })
          .finally(() => request.onCallSettled?.(performance.now() - startedAt));
        const parsed = parseJudgeAnswer(answer, request.candidates);
        if (parsed !== null) {
          return parsed;
        }
      }
      throw new JudgeAnswerError(
        `judge answer did not cover the ${request.candidates.length} candidates against the schema, twice`,
      );
    },
  };
}

/**
 * The questions the decision judge asks about each product (YOY-152 AC-2):
 * the verdict as pick-one, each missed-wish flag and the exclusion as
 * yes/no. A decision model writes no text, so there is no label question:
 * the label follows the verdict (AC-3), and no second reading is asked.
 */
export const DECISION_JUDGE_QUESTIONS: Record<
  "verdict" | "fact" | "description" | "excluded",
  DecisionQuestion
> = {
  verdict: {
    type: "choice",
    instructions: "How well does the product match the shopper's search? Judge it only by what the product row says.",
    criteria: {
      exact: "Every wish the shopper stated is met by the product row.",
      "other-variant": "The item the shopper asked for, but only in another colour or size than asked.",
      close:
        "The right kind of product, but a stated wish the row contradicts or does not mention (long sleeves asked and the row says sleeveless or says nothing of sleeves).",
      "not-relevant": "The wrong kind of product.",
    },
  },
  fact: {
    type: "yes-no",
    instructions:
      "Does a merchant fact the shopper asked for (material, colour, size, price, an option) differ in the product row, or is it not shown?",
    criteria: {
      yes: "A merchant fact the shopper asked for differs or is not shown.",
      no: "Every merchant fact the shopper asked for is shown and matches, or none was asked.",
    },
  },
  description: {
    type: "yes-no",
    instructions:
      "Does a described quality the shopper asked for (style, look, sleeves, length, fit, occasion) go unmet in the product row, or is it not shown?",
    criteria: {
      yes: "A described quality the shopper asked for is not met or not shown.",
      no: "Every described quality the shopper asked for is met, or none was asked.",
    },
  },
  excluded: {
    type: "yes-no",
    instructions:
      "Is the product something the shopper said they do NOT want (\"not black\" and the product is black; \"no wool\" and it is wool)?",
    criteria: {
      yes: "The product is something the shopper ruled out.",
      no: "The shopper ruled nothing out that this product is.",
    },
  },
};

/** The note the decision judge adds to each question when a previous search is sent. */
const DECISION_PREVIOUS_NOTE =
  "The search may refine the previous search (keep its wishes and add or change some) or replace it with a different search. Judge against what the shopper wants now. ";

/** A yes/no answer reads as yes from this probability. */
const DECISION_YES_AT = 0.5;

/** One product's typed answers as a verdict, or null when an answer is missing or unknown. */
function decisionVerdict(
  candidate: JudgeCandidate,
  answers: Record<string, unknown>,
): JudgeVerdict | null {
  const verdictAnswer = answers.verdict as { type?: unknown; choice?: unknown } | undefined;
  const choice = verdictAnswer?.type === "choice" ? verdictAnswer.choice : undefined;
  if (typeof choice !== "string" || !(JUDGE_VERDICTS as readonly string[]).includes(choice)) {
    return null;
  }
  const flags: Record<string, boolean> = {};
  for (const key of ["fact", "description", "excluded"]) {
    const answer = answers[key] as { type?: unknown; yes?: unknown } | undefined;
    if (answer?.type !== "yes-no" || typeof answer.yes !== "number" || !Number.isFinite(answer.yes)) {
      return null;
    }
    flags[key] = answer.yes >= DECISION_YES_AT;
  }
  const verdict = choice as JudgeVerdictCode;
  const excluded = flags.excluded === true;
  return {
    id: candidate.id,
    verdict,
    missed: JUDGE_MISSED_WISHES.filter((wish) => flags[wish] === true),
    // No text, so no `fact-differs` values (AC-3): a product off the ask
    // in any way carries `close-match`, the label a `fact-differs` becomes.
    label:
      !excluded && (verdict === "other-variant" || verdict === "close")
        ? { template: "close-match", values: [] }
        : null,
    excluded,
  };
}

/** A failed or unanswerable question: the candidate is read as not relevant. */
function notRelevant(candidate: JudgeCandidate): JudgeVerdict {
  return {
    id: candidate.id,
    verdict: "not-relevant",
    missed: [],
    label: null,
    excluded: false,
    standIn: true,
  };
}

export interface DecisionJudgeOptions {
  decisions: DecisionClient;
  /** Provider and model, for the answer-cache key (YOY-148 AC-1). */
  identity?: string;
  /** Characters a candidate row is cut to (AC-2). */
  maxRowChars?: number;
  /**
   * How long one product's call may run (YOY-159 AC-3): past it the call is
   * aborted and the product reads as not relevant, the answer `partial`, so
   * one slow call cannot stall the page. Absent means no per-call limit.
   */
  callTimeoutMs?: number;
}

/**
 * The judge over the decision port (YOY-152 AC-1 – AC-3): one request per
 * product, every product of the page in parallel, under ledger operation
 * `judge`. The same answer shape as the LLM judge. One failed or invalid
 * answer reads its product as not relevant and marks the answer `partial`,
 * so it is served but never cached; when every product fails, the
 * call rejects, so the page is served as a judge error like a failed LLM
 * call. Never a second reading: a decision model writes no text.
 */
export function createDecisionJudge(options: DecisionJudgeOptions): Judge {
  const { decisions } = options;
  const maxRowChars = options.maxRowChars ?? DEFAULT_JUDGE_ROW_CHARS;
  return {
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
    async judge(request) {
      const previous =
        request.previousSentence === undefined || request.previousSentence.trim() === ""
          ? undefined
          : previousChainLine(request.previousSentence);
      const questions = Object.fromEntries(
        Object.entries(DECISION_JUDGE_QUESTIONS).map(([key, question]) => [
          key,
          previous === undefined
            ? question
            : { ...question, instructions: `${DECISION_PREVIOUS_NOTE}${question.instructions}` },
        ]),
      );
      const settled = await Promise.allSettled(
        request.candidates.map((candidate) => {
          const startedAt = performance.now();
          const signal =
            options.callTimeoutMs === undefined
              ? request.signal
              : AbortSignal.any([
                  ...(request.signal !== undefined ? [request.signal] : []),
                  AbortSignal.timeout(options.callTimeoutMs),
                ]);
          return decisions.decide({
            state: {
              ...(previous !== undefined ? { previous_search: previous } : {}),
              search: oneLine(request.sentence),
              product: judgeRow(candidate, maxRowChars),
            },
            questions,
            operation: "judge",
            storeId: request.storeId,
            searchId: request.searchId,
            ...(signal !== undefined ? { signal } : {}),
          }).finally(() => request.onCallSettled?.(performance.now() - startedAt));
        }),
      );
      if (request.signal?.aborted) {
        throw request.signal.reason ?? new Error("judge aborted");
      }
      const verdicts = request.candidates.map((candidate, index) => {
        const outcome = settled[index]!;
        return outcome.status === "fulfilled"
          ? decisionVerdict(candidate, outcome.value as Record<string, unknown>)
          : null;
      });
      if (request.candidates.length > 0 && verdicts.every((verdict) => verdict === null)) {
        const failure = settled.find((outcome) => outcome.status === "rejected");
        throw failure !== undefined
          ? (failure as PromiseRejectedResult).reason
          : new JudgeAnswerError(
              `no decision answer for any of the ${request.candidates.length} candidates was valid`,
            );
      }
      return {
        verdicts: verdicts.map((verdict, index) => verdict ?? notRelevant(request.candidates[index]!)),
        otherReading: null,
        ...(verdicts.some((verdict) => verdict === null) ? { partial: true as const } : {}),
      };
    },
  };
}

export interface JudgeFactoryOptions {
  /** Which provider answers; `judgeProviderFromEnv` reads it from `JUDGE_PROVIDER`. */
  provider: JudgeProvider;
  /**
   * Each provider's client for the judge call, built only for the selected
   * one: an LLM for `gemini`, a decision model for `jev` (YOY-152 AC-1).
   */
  clients: { gemini: () => LlmClient; jev: () => DecisionClient };
  /** The model each provider's client calls, for the answer-cache key (YOY-148 AC-1). */
  modelIds?: Partial<Record<JudgeProvider, string>>;
  maxRowChars?: number;
  /** The decision judge's per-call limit (YOY-159 AC-3); the LLM judge makes one call and ignores it. */
  callTimeoutMs?: number;
}

/** The one judge factory (AC-1): the selected provider's client behind the one judge. */
export function createJudge(options: JudgeFactoryOptions): Judge {
  const modelId = options.modelIds?.[options.provider] ?? "unknown";
  const identity = `${options.provider}:${modelId}`;
  const rows = options.maxRowChars !== undefined ? { maxRowChars: options.maxRowChars } : {};
  return options.provider === "jev"
    ? createDecisionJudge({
        decisions: options.clients.jev(),
        identity,
        ...rows,
        ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
      })
    : createLlmJudge({ llm: options.clients.gemini(), identity, ...rows });
}

const VERDICT_RANK: Record<JudgeVerdictCode, number> = {
  exact: 0,
  "other-variant": 1,
  close: 2,
  "not-relevant": 3,
};

/** A page item after the judge: its verdict and the label it carries. */
export interface JudgedItem<T> {
  item: T;
  verdict: JudgeVerdictCode;
  label: JudgeLabel | null;
  /** The verdict is a stand-in for a call that never answered (YOY-159). */
  standIn?: true;
}

/**
 * Order a page by verdict (AC-5, AC-8): verdict rank, ties in find order.
 * A "not relevant" product is dropped from a page that has anything better
 * (YOY-163), as an excluded one is (YOY-149 AC-11): the page may come out
 * short. When every product left is "not relevant", the page stays in find
 * order and every item carries `close-match` — nothing exact, here is the
 * closest. A stand-in verdict (YOY-159: a call that never answered) is no
 * judgment: the product stays, ranked where "not relevant" sorts, with no
 * label, and never counts toward the all-not-relevant case; a page of only
 * stand-ins is served in find order without labels. `items` and `verdicts`
 * are parallel, in find order.
 */
export function orderByVerdict<T>(
  items: readonly T[],
  verdicts: readonly JudgeVerdict[],
): JudgedItem<T>[] {
  const judged = items
    .map((item, index) => ({
      item,
      verdict: verdicts[index]!.verdict,
      label: verdicts[index]!.label,
      excluded: verdicts[index]!.excluded,
      standIn: verdicts[index]!.standIn === true,
      index,
    }))
    .filter((entry) => !entry.excluded);
  const out = ({ item, verdict, label, standIn }: (typeof judged)[number]): JudgedItem<T> => ({
    item,
    verdict,
    label: standIn ? null : label,
    ...(standIn ? { standIn: true as const } : {}),
  });
  // Stand-ins are no judgment (YOY-159): they never count toward reject-all,
  // are never dropped, and carry no label.
  const real = judged.filter((entry) => !entry.standIn);
  if (real.length === 0) {
    return judged.map(out);
  }
  if (real.every((entry) => entry.verdict === "not-relevant")) {
    return judged.map((entry) =>
      entry.standIn ? out(entry) : { ...out(entry), label: { template: "close-match", values: [] } },
    );
  }
  return judged
    .filter((entry) => entry.standIn || entry.verdict !== "not-relevant")
    .sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || a.index - b.index)
    .map(out);
}
