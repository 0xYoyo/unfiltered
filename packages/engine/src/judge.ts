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
 * outside the provider adapter names a judge model (AC-1).
 */

import type { JsonSchema, LlmClient } from "./index.js";

/** Env var naming which provider answers the judge call (AC-1). */
export const JUDGE_PROVIDER_ENV = "JUDGE_PROVIDER";

/** Providers the factory can select; `gemini` is the default (AC-1, NG-4). */
export const JUDGE_PROVIDERS = ["gemini"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];
export const DEFAULT_JUDGE_PROVIDER: JudgeProvider = "gemini";

/**
 * The judge prompt's version (YOY-148 AC-1): part of the answer-cache key,
 * so a stored answer is never served for a prompt that has since changed.
 * Bump it with every change to `buildJudgePrompt`, `judgeRow` or the
 * answer schema.
 */
export const JUDGE_PROMPT_VERSION = 2;

/** Characters one candidate row is cut to (AC-2; raised to 480 by AC-17). */
export const DEFAULT_JUDGE_ROW_CHARS = 480;
/** Description characters a product with no card contributes (AC-2). */
export const JUDGE_DESCRIPTION_CHARS = 200;
/** Words a `fact-differs` value may hold; a longer one drops the label (AC-3, AC-9). */
export const JUDGE_LABEL_MAX_WORDS = 3;

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
  candidates: JudgeCandidate[];
  storeId?: string;
  searchId?: string;
  /** Aborts the call (the caller's deadline, AC-6). */
  signal?: AbortSignal;
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
}

export interface Judge {
  /**
   * Which provider and model answer, e.g. `gemini:gemini-3.5-flash-lite`
   * (YOY-148 AC-1): part of the answer-cache key. Absent on a judge built
   * without one; it then caches under `unknown`.
   */
  readonly identity?: string;
  /**
   * One verdict per candidate, in candidate order. Rejects with
   * `JudgeAnswerError` when the answer is invalid twice (AC-4), and with
   * the port's own error when the call fails.
   */
  judge(request: JudgeRequest): Promise<JudgeVerdict[]>;
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
 * lists the numbers of products the shopper excluded (YOY-149 AC-11). Short
 * codes only; no prose field exists.
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
  },
  required: ["c", "d", "x"],
};

/** The provider `JUDGE_PROVIDER` names; unset means gemini, an unknown name fails. */
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

/** The judge prompt; its `Query:` line keys replay recordings. */
export function buildJudgePrompt(
  sentence: string,
  candidates: readonly JudgeCandidate[],
  maxRowChars = DEFAULT_JUDGE_ROW_CHARS,
): string {
  const rows = candidates.map(
    (candidate, index) => `${index + 1}. ${judgeRow(candidate, maxRowChars)}`,
  );
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
    "Example: E-X is an exact match; CDC is close, a described wish not shown.",
    "",
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
 * Validate one answer against the schema and against the page (AC-4):
 * exactly one known code per candidate, and a side list naming each
 * candidate at most once. Null when invalid.
 */
export function parseJudgeAnswer(
  answer: unknown,
  candidates: readonly JudgeCandidate[],
): JudgeVerdict[] | null {
  if (typeof answer !== "object" || answer === null) {
    return null;
  }
  const { c, d, x } = answer as Record<string, unknown>;
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
  return candidates.map((candidate, index) => {
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
      const prompt = buildJudgePrompt(request.sentence, request.candidates, maxRowChars);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const answer = await llm.completeStructured({
          prompt,
          schema: JUDGE_SCHEMA,
          operation: "judge",
          temperature: 0,
          storeId: request.storeId,
          searchId: request.searchId,
          signal: request.signal,
        });
        const verdicts = parseJudgeAnswer(answer, request.candidates);
        if (verdicts !== null) {
          return verdicts;
        }
      }
      throw new JudgeAnswerError(
        `judge answer did not cover the ${request.candidates.length} candidates against the schema, twice`,
      );
    },
  };
}

export interface JudgeFactoryOptions {
  /** Which provider answers; `judgeProviderFromEnv` reads it from `JUDGE_PROVIDER`. */
  provider: JudgeProvider;
  /** The provider's LLM client for the judge call, built only for the selected one. */
  clients: Record<JudgeProvider, () => LlmClient>;
  /** The model each provider's client calls, for the answer-cache key (YOY-148 AC-1). */
  modelIds?: Partial<Record<JudgeProvider, string>>;
  maxRowChars?: number;
}

/** The one judge factory (AC-1): the selected provider's client behind the one judge. */
export function createJudge(options: JudgeFactoryOptions): Judge {
  const modelId = options.modelIds?.[options.provider] ?? "unknown";
  return createLlmJudge({
    llm: options.clients[options.provider](),
    identity: `${options.provider}:${modelId}`,
    ...(options.maxRowChars !== undefined ? { maxRowChars: options.maxRowChars } : {}),
  });
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
}

/**
 * Order a page by verdict (AC-5, AC-8): verdict rank, ties in find order,
 * "not relevant" last and never removed. When every candidate is "not
 * relevant", the page stays in find order and every item carries
 * `close-match`. A product the judge flagged as excluded is dropped from
 * the page (YOY-149 AC-11). `items` and `verdicts` are parallel, in find
 * order.
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
      index,
    }))
    .filter((entry) => !entry.excluded);
  if (judged.length > 0 && judged.every((entry) => entry.verdict === "not-relevant")) {
    return judged.map(({ item, verdict }) => ({
      item,
      verdict,
      label: { template: "close-match", values: [] },
    }));
  }
  return judged
    .sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || a.index - b.index)
    .map(({ item, verdict, label }) => ({ item, verdict, label }));
}
