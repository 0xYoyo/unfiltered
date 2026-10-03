/**
 * The wish extraction (YOY-149; PRD §3 Engine v2): one small structured call
 * that starts with the search, in parallel with the find step, and reads
 * only what the shopper STATED as a number or a fact — a price cap or floor
 * with its currency, a size, "in stock", and terms the shopper excluded —
 * plus whether a price or size was stated as firm ("max", "no more than",
 * "only", "must be"). Nothing is inferred into a wish: every value the model
 * returns is checked against the sentence and discarded when the sentence
 * does not carry it (AC-2).
 *
 * Vendor-free by the engine's boundary rule: the extraction speaks to the
 * `LlmClient` port, under ledger operation `extract`.
 */

import type { JsonSchema, LlmClient } from "./index.js";

/**
 * The extraction prompt's version (AC-18): part of the extraction-cache key,
 * so a cached answer is never served for a prompt that has since changed.
 * Bump it with every change to `buildExtractPrompt`, `EXTRACT_SCHEMA` or
 * `parseExtractAnswer`.
 */
export const EXTRACT_PROMPT_VERSION = 2;

/** One term the shopper excluded, as typed and in English (AC-1). */
export interface ExcludedTerm {
  typed: string;
  english: string;
}

/** A stated price bound: the shopper's own number (AC-1, AC-14). */
export interface StatedPrice {
  amount: number;
  /** The number exactly as the sentence writes it, digits only, e.g. "400". */
  raw: string;
}

/** What the shopper stated, validated against the sentence (AC-1, AC-2). */
export interface ExtractedWishes {
  priceMax: StatedPrice | null;
  priceMin: StatedPrice | null;
  /** ISO 4217 code the shopper stated or wrote in (e.g. "ILS"), upper case; null when none. */
  currency: string | null;
  size: string | null;
  /** True when the shopper asked for in-stock products only. */
  inStock: boolean;
  excluded: ExcludedTerm[];
  priceFirm: boolean;
  sizeFirm: boolean;
}

/** No wishes at all: the extraction's empty answer. */
export const NO_WISHES: ExtractedWishes = {
  priceMax: null,
  priceMin: null,
  currency: null,
  size: null,
  inStock: false,
  excluded: [],
  priceFirm: false,
  sizeFirm: false,
};

/** JSON Schema of the extraction's answer (AC-1): every field may be null. */
export const EXTRACT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    // Every field admits null (AC-1); the provider adapter re-expresses the
    // union in its nullable dialect, as for the intent schema.
    priceMax: { type: ["number", "null"] },
    priceMin: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    size: { type: ["string", "null"] },
    inStock: { type: ["boolean", "null"] },
    excluded: {
      type: "array",
      items: {
        type: "object",
        properties: { typed: { type: "string" }, english: { type: "string" } },
        required: ["typed", "english"],
      },
    },
    priceFirm: { type: ["boolean", "null"] },
    sizeFirm: { type: ["boolean", "null"] },
  },
  required: [
    "priceMax",
    "priceMin",
    "currency",
    "size",
    "inStock",
    "excluded",
    "priceFirm",
    "sizeFirm",
  ],
};

/** The extraction prompt; its `Query:` line keys replay recordings. */
export function buildExtractPrompt(sentence: string): string {
  return [
    "Read a shopper's store search and return ONLY what the shopper stated. Never guess.",
    "",
    "priceMax: the highest price the shopper will pay, as a number, or null.",
    "priceMin: the lowest price the shopper wants, as a number, or null.",
    "currency: the ISO 4217 code of the price's currency when the search states one (\"$\" is USD,",
    "\"₪\" or \"שקל\" is ILS, \"€\" is EUR, \"£\" is GBP); for a price written in Hebrew with no",
    "currency, ILS; otherwise null.",
    "size: a clothing or shoe size the shopper asked for, exactly as written (\"M\", \"38\"), or null.",
    "inStock: true only when the shopper asked for items in stock or available now; else null.",
    "excluded: every thing the shopper said they do NOT want: typed is the excluded word",
    "exactly as written, WITHOUT the negation (\"not black\" -> \"black\"; \"no wool\" -> \"wool\";",
    "\"לא שחורה\" -> \"שחורה\"), english is that word in English. Empty when none.",
    "priceFirm: true only when the price was stated as a hard limit (\"max\", \"no more than\",",
    "\"at most\", \"only\", \"must be\", \"לא יותר מ\", \"מקסימום\"); \"under\", \"up to\", \"below\",",
    "\"around\" and \"עד\" are NOT firm. Else null.",
    "sizeFirm: true only when the size was stated as a hard requirement (\"only\", \"must be\"); else null.",
    "",
    `Query: ${sentence.replace(/\s+/g, " ").trim()}`,
  ].join("\n");
}

/** The digits of a number as a sentence would write them: 400, 1200, 49.9. */
function digitsOf(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/**
 * Whether the sentence carries the number (AC-2): its digits appear, ignoring
 * thousands separators — "1,200" and "1 200" carry 1200.
 */
export function sentenceHasNumber(sentence: string, amount: number): boolean {
  const compact = sentence.replace(/(\d)[,\s.'’](?=\d{3}\b)/g, "$1");
  const digits = digitsOf(amount);
  return new RegExp(`(^|[^\\d.])${digits.replace(".", "\\.")}($|[^\\d])`).test(compact);
}

/** Whether the sentence carries the text verbatim, ignoring case (AC-2). */
export function sentenceHasText(sentence: string, text: string): boolean {
  const needle = text.trim().toLowerCase();
  return needle !== "" && sentence.toLowerCase().includes(needle);
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * A leading negation the model may leave on an excluded term ("not black",
 * "לא שחורה"): the term is the excluded thing, never its negation.
 */
const LEADING_NEGATION = /^(?:not|no|without|non|לא|בלי|ללא)[\s-]+/iu;

/** Currency signs and words a sentence can state a price in. */
const STATED_CURRENCIES: ReadonlyArray<[RegExp, string]> = [
  [/₪|ש["״]?ח|שקל|\bnis\b|\bils\b/iu, "ILS"],
  [/\$|\busd\b|dollars?\b/iu, "USD"],
  [/€|\beur\b|euros?\b/iu, "EUR"],
  [/£|\bgbp\b|pounds?\b/iu, "GBP"],
];

/**
 * The currency a sentence states for its price when the model named none
 * (YOY-149 AC-17): a currency sign or word in the sentence; else, for a
 * Hebrew sentence, shekels; else null (the catalog's own currency).
 */
export function statedCurrency(sentence: string): string | null {
  for (const [pattern, code] of STATED_CURRENCIES) {
    if (pattern.test(sentence)) {
      return code;
    }
  }
  return /\p{Script=Hebrew}/u.test(sentence) ? "ILS" : null;
}

function withoutNegation(term: string): string {
  return term.trim().replace(LEADING_NEGATION, "").trim();
}

/**
 * Validate one answer against the sentence (AC-2): a price is kept only when
 * its digits appear in the sentence; a size or an excluded term only when it
 * appears verbatim, ignoring case. Anything else is discarded. Null when the
 * answer is not the schema's shape at all.
 */
export function parseExtractAnswer(answer: unknown, sentence: string): ExtractedWishes | null {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return null;
  }
  const record = answer as Record<string, unknown>;
  const price = (value: unknown): StatedPrice | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && sentenceHasNumber(sentence, value)
      ? { amount: value, raw: digitsOf(value) }
      : null;
  const priceMax = price(record.priceMax);
  const priceMin = price(record.priceMin);
  const currencyRaw = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
  const sizeRaw = typeof record.size === "string" ? record.size.trim() : "";
  const excluded: ExcludedTerm[] = [];
  if (Array.isArray(record.excluded)) {
    for (const entry of record.excluded) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const { typed: typedRaw, english: englishRaw } = entry as Record<string, unknown>;
      if (typeof typedRaw !== "string") {
        continue;
      }
      const typed = withoutNegation(typedRaw);
      if (typed === "" || !sentenceHasText(sentence, typed)) {
        continue;
      }
      const english =
        typeof englishRaw === "string" && withoutNegation(englishRaw) !== ""
          ? withoutNegation(englishRaw)
          : typed;
      const term = { typed, english };
      if (!excluded.some((kept) => kept.typed.toLowerCase() === term.typed.toLowerCase())) {
        excluded.push(term);
      }
    }
  }
  const size = sizeRaw !== "" && sentenceHasText(sentence, sizeRaw) ? sizeRaw : null;
  return {
    priceMax,
    priceMin,
    currency:
      priceMax === null && priceMin === null
        ? null
        : CURRENCY_CODE.test(currencyRaw)
          ? currencyRaw
          : statedCurrency(sentence),
    size,
    inStock: record.inStock === true,
    excluded,
    priceFirm: record.priceFirm === true && (priceMax !== null || priceMin !== null),
    sizeFirm: record.sizeFirm === true && size !== null,
  };
}

export interface ExtractRequest {
  sentence: string;
  storeId?: string;
  searchId?: string;
  signal?: AbortSignal;
}

export interface WishExtractor {
  /** The model that answers, for the extraction-cache key (AC-18); `unknown` when absent. */
  readonly modelId?: string;
  /** The validated wishes; rejects when the call fails or its answer is not the schema's shape. */
  extract(request: ExtractRequest): Promise<ExtractedWishes>;
}

/** The extraction's answer was not the schema's shape. */
export class ExtractAnswerError extends Error {
  override readonly name = "ExtractAnswerError";
}

/** The extraction over the LLM port: one call at temperature 0 under operation `extract` (AC-1). */
export function createWishExtractor(options: { llm: LlmClient; modelId?: string }): WishExtractor {
  return {
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    async extract(request) {
      const answer = await options.llm.completeStructured({
        prompt: buildExtractPrompt(request.sentence),
        schema: EXTRACT_SCHEMA,
        operation: "extract",
        temperature: 0,
        storeId: request.storeId,
        searchId: request.searchId,
        signal: request.signal,
      });
      const wishes = parseExtractAnswer(answer, request.sentence);
      if (wishes === null) {
        throw new ExtractAnswerError("extraction answer is not the schema's shape");
      }
      return wishes;
    },
  };
}
