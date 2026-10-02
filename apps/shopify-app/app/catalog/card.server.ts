import { createHash } from "node:crypto";

import type { PrismaClient, ProductEnrichment } from "@prisma/client";
import type { JsonSchema, LlmClient } from "@unfiltered/engine";
import {
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { fetchInlineImages, loadVisionImages } from "./enrich.server";
import type { ImageFetch } from "./images.server";
import { globalImageFetch } from "./images.server";

/**
 * The card writer (YOY-143; PRD §3 Engine v2, Refinements 5, 6 and 9): one
 * model call per product, at load time, writes a plain-text card — the
 * dossier later steps find and judge against. Sections:
 *
 * - `facts`: what the item is and the merchant's stated details,
 *   merchant-stated material first; a detail seen only in a photo is
 *   written "looks like …".
 * - `look`: what it looks like, from the photos and the text, under the
 *   same "looks like" rule.
 * - `read`: style, occasion and who wears it — the model's read, never
 *   shown to a shopper and never used to reject a product.
 * - `summary`: at most 300 characters.
 * - `asks`: 10–20 natural ways to ask for the item, per configured
 *   language.
 *
 * Prose is written in the language of the product's own text (AC-5).
 * Cached by input hash and CARD_VERSION (AC-7): an unchanged product makes
 * zero calls. Two failed attempts mark the product failed without failing
 * the run; it is retried when its inputs change (AC-8). A run stops at the
 * spend cap (AC-12): the cap is code, not a promise.
 */

/**
 * Bump when the prompt, schema or validation changes, so every card is
 * rewritten once on the next run — the ENRICHMENT_VERSION rule.
 */
export const CARD_VERSION = 1;

/** The ask languages when `CARD_ASK_LANGUAGES` is unset (AC-4). */
export const DEFAULT_CARD_LANGUAGES = ["en", "he"] as const;

export const MIN_ASKS_PER_LANGUAGE = 10;
export const MAX_ASKS_PER_LANGUAGE = 20;
export const MAX_SUMMARY_CHARS = 300;
/** Images per card call: the four `ProductImage` rows a product can hold. */
export const MAX_CARD_IMAGES = 4;

/**
 * The configured ask languages: `CARD_ASK_LANGUAGES` as a comma-separated
 * list of language codes ("en,he,ar"), else en and he. A malformed value
 * fails loudly rather than silently writing cards for the wrong languages.
 */
export function cardLanguagesFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.CARD_ASK_LANGUAGES;
  if (raw === undefined) {
    return [...DEFAULT_CARD_LANGUAGES];
  }
  const languages = raw
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter((code) => code !== "");
  if (languages.length === 0 || languages.some((code) => !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code))) {
    throw new Error(
      `CARD_ASK_LANGUAGES must be a comma-separated list of language codes, got ${JSON.stringify(raw)}`,
    );
  }
  return [...new Set(languages)];
}

/** The card spend cap when `CARD_SPEND_CAP_USD` is unset, USD (AC-12). */
export const DEFAULT_CARD_SPEND_CAP_USD = 3;

/**
 * The per-run card spend cap: `CARD_SPEND_CAP_USD` as a positive number of
 * dollars, else DEFAULT_CARD_SPEND_CAP_USD. A malformed value fails loudly
 * rather than silently running uncapped.
 */
export function cardSpendCapFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CARD_SPEND_CAP_USD;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CARD_SPEND_CAP_USD;
  }
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`CARD_SPEND_CAP_USD must be a positive number of dollars, got ${JSON.stringify(raw)}`);
  }
  return cap;
}

/** One card's sections, validated. */
export interface CardSections {
  facts: string;
  look: string;
  read: string;
  summary: string;
  /** { "<language>": [10–20 ways to ask] }, in configured-language order. */
  asks: Record<string, string[]>;
}

/** The structured-output schema for one card, with one ask list per language. */
export function buildCardSchema(languages: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      facts: { type: "string" },
      look: { type: "string" },
      read: { type: "string" },
      summary: { type: "string" },
      asks: {
        type: "object",
        properties: Object.fromEntries(
          languages.map((code) => [code, { type: "array", items: { type: "string" } }]),
        ),
        required: [...languages],
      },
    },
    required: ["facts", "look", "read", "summary", "asks"],
  };
}

/** The `CatalogProduct` fields the card is written from. */
export interface CardableProduct {
  productId: string;
  title: string;
  description: string;
  tags: string[];
  vendor: string;
  productType: string;
  imageAltTexts: string[];
  contentHash: string;
}

/** The enrichment columns handed to the writer as hints (the merged answer). */
export type CardEnrichment = Pick<
  ProductEnrichment,
  | "status"
  | "category"
  | "colors"
  | "primaryColor"
  | "occasions"
  | "fit"
  | "styleTags"
  | "seasons"
  | "sleeveLength"
  | "neckline"
  | "garmentLength"
  | "pattern"
  | "materialAppearance"
>;

/** The enrichment as prompt lines; only fields that hold a value. */
function enrichmentLines(enrichment: CardEnrichment | null): string[] {
  if (enrichment === null || enrichment.status !== "enriched") {
    return ["(none)"];
  }
  const entries: Array<[string, string | string[] | null]> = [
    ["category", enrichment.category],
    ["colors", enrichment.colors],
    ["primary color", enrichment.primaryColor],
    ["occasions", enrichment.occasions],
    ["fit", enrichment.fit],
    ["style", enrichment.styleTags],
    ["seasons", enrichment.seasons],
    ["sleeve length", enrichment.sleeveLength],
    ["neckline", enrichment.neckline],
    ["garment length", enrichment.garmentLength],
    ["pattern", enrichment.pattern],
    ["material appearance", enrichment.materialAppearance],
  ];
  const lines = entries
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== null && value !== ""))
    .map(([name, value]) => `- ${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
  return lines.length > 0 ? lines : ["(none)"];
}

/**
 * The card prompt (AC-2 to AC-5): the merchant's text, the enrichment as
 * hints, and the images, which the call carries inline before this text.
 */
export function buildCardPrompt(
  product: CardableProduct,
  enrichment: CardEnrichment | null,
  languages: readonly string[],
  imageCount: number,
): string {
  return [
    "Write a plain-text card for this e-commerce product. A search engine will",
    "find the product by this card and judge it against shoppers' requests, so",
    "be concrete and complete; never invent anything.",
    "",
    "Sections:",
    "- facts: what the item is, then every detail the merchant's text states —",
    "  material first (exactly as stated), then the rest (fit, length,",
    "  measurements, closures, care, what is printed on it). A detail you can",
    '  only see in a photo, which the merchant\'s text does not state, is',
    '  written as "looks like …" (for example "looks like linen"). Never state',
    "  a photo-only detail as fact, and never contradict the merchant's text.",
    "- look: what it looks like — colour, cut, shape, pattern, print, visible",
    '  details — from the photos and the text, with the same "looks like" rule',
    "  for anything only a photo shows.",
    "- read: your read of its style, the occasions it suits and who wears it.",
    `- summary: one or two sentences, at most ${MAX_SUMMARY_CHARS} characters.`,
    `- asks: for each of these language codes — ${languages.join(", ")} — between`,
    `  ${MIN_ASKS_PER_LANGUAGE} and ${MAX_ASKS_PER_LANGUAGE} different, natural ways a shopper would search for`,
    "  this item in that language: short queries and full sentences, naming",
    "  the item, its look, its use or who it is for.",
    "",
    "Write facts, look, read and summary in the language of the product's own",
    "text below (if the text is Hebrew, write them in Hebrew). The asks are in",
    "their own languages.",
    "",
    "The machine-read attributes are hints and may be wrong; the merchant's",
    "text wins wherever they differ.",
    "",
    `Photos: ${imageCount === 0 ? "none" : `${imageCount}, shown before this text`}`,
    `Title: ${product.title}`,
    `Vendor: ${product.vendor}`,
    `Product type: ${product.productType}`,
    `Tags: ${product.tags.join(", ")}`,
    `Image alt texts: ${product.imageAltTexts.join(", ")}`,
    `Description: ${product.description}`,
    "",
    "Machine-read attributes:",
    ...enrichmentLines(enrichment),
    "",
    "Answer as JSON.",
  ].join("\n");
}

/** `text` cut to at most `max` characters at a word boundary. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Validate one model answer into `CardSections`, or null when it cannot be
 * a card: a missing or empty prose section, a missing language, or fewer
 * than MIN_ASKS_PER_LANGUAGE distinct asks in any language. Asks are
 * trimmed, de-duplicated (ignoring case) and kept to the first
 * MAX_ASKS_PER_LANGUAGE; a summary over MAX_SUMMARY_CHARS is cut at a word
 * boundary (AC-4).
 */
export function parseCard(value: unknown, languages: readonly string[]): CardSections | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const prose: Record<string, string> = {};
  for (const key of ["facts", "look", "read", "summary"] as const) {
    const text = record[key];
    if (typeof text !== "string" || text.trim() === "") {
      return null;
    }
    prose[key] = text.trim().replace(/\s+/g, " ");
  }
  const rawAsks = record.asks;
  if (rawAsks === null || typeof rawAsks !== "object" || Array.isArray(rawAsks)) {
    return null;
  }
  const asks: Record<string, string[]> = {};
  for (const code of languages) {
    const list = (rawAsks as Record<string, unknown>)[code];
    if (!Array.isArray(list)) {
      return null;
    }
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const item of list) {
      if (typeof item !== "string") {
        continue;
      }
      const ask = item.trim().replace(/\s+/g, " ");
      if (ask === "" || seen.has(ask.toLowerCase())) {
        continue;
      }
      seen.add(ask.toLowerCase());
      kept.push(ask);
    }
    if (kept.length < MIN_ASKS_PER_LANGUAGE) {
      return null;
    }
    asks[code] = kept.slice(0, MAX_ASKS_PER_LANGUAGE);
  }
  return {
    facts: prose.facts!,
    look: prose.look!,
    read: prose.read!,
    summary: cutAtWord(prose.summary!, MAX_SUMMARY_CHARS),
    asks,
  };
}

/** The whole card as one text: what `cardTextHash` hashes and later steps read. */
export function composeCardText(card: CardSections): string {
  return [
    `Facts: ${card.facts}`,
    `Look: ${card.look}`,
    `Read: ${card.read}`,
    `Summary: ${card.summary}`,
    ...Object.entries(card.asks).map(([code, list]) => `Asks (${code}): ${list.join(" | ")}`),
  ].join("\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The hash of everything a card is written from (AC-7): the product's
 * searchable content (its contentHash covers title, description, tags,
 * vendor, type, prices, availability and alt texts), its enrichment, its
 * image hashes in position order, and the ask languages. Variants are
 * deliberately outside it: stock moves daily and the card states no stock.
 */
export function computeCardInputHash({
  product,
  enrichment,
  imageHashes,
  languages,
}: {
  product: Pick<CardableProduct, "contentHash">;
  enrichment: CardEnrichment | null;
  imageHashes: readonly string[];
  languages: readonly string[];
}): string {
  return sha256(
    JSON.stringify([
      product.contentHash,
      enrichment === null ? null : enrichmentLines(enrichment),
      imageHashes,
      languages,
    ]),
  );
}

/** The writer's model port and the model id recorded on each card. */
export interface CardWriter {
  llm: LlmClient;
  modelId: string;
}

/** Outcome counts of one card run (AC-9). */
export interface CardResult {
  /** Cards written this run. */
  written: number;
  /** Products whose card (or failure) is current: no call. */
  cached: number;
  /** Products whose two attempts failed this run, or whose images could not be fetched. */
  failed: number;
  /** Ledger cost of this run's `card` calls for the store, USD. */
  costUsd: number;
  /**
   * The spend cap, USD, when the run stopped at it (AC-12); absent when the
   * run finished under the cap. A capped run is a failed run: callers exit
   * non-zero.
   */
  capReachedUsd?: number;
}

/** The `cards: …` operator report line (AC-9), one format for every ingest path. */
export function formatCardReport(cards: CardResult): string {
  const report = `cards: written ${cards.written}, cached ${cards.cached}, failed ${cards.failed}, cost $${cards.costUsd.toFixed(6)}`;
  return cards.capReachedUsd === undefined
    ? report
    : `${report}, cap reached at $${cards.capReachedUsd.toFixed(2)}`;
}

/**
 * Write the store's missing or stale cards, in priority order (AC-6): in
 * stock first, then most recently updated, product id as the tie-break.
 *
 * A product whose card row carries the current input hash and CARD_VERSION
 * — written or failed — makes zero calls (AC-7, AC-8). Otherwise one call
 * (operation `card`) carries the prompt and up to four images re-read
 * through the vision pass's fetch (AC-2). An invalid answer or a call error
 * is retried once; two failures write a `failed` row with the input hash,
 * so it is retried only when the inputs change (AC-8). A product with
 * images none of which can be fetched makes no call and keeps its row, so
 * the next run tries again. Rows are written one product at a time, so a
 * run that stops part-way never pays twice for the cards it finished.
 *
 * Spend cap (AC-12): after each product that made a call, the run's `card`
 * ledger rows for the store are summed; once the sum reaches `spendCapUsd`
 * the run stops — every finished card stays, the rest stay unwritten — and
 * the result carries `capReachedUsd`.
 */
export async function writeCatalogCards({
  db,
  shopDomain,
  writer,
  fetchImage = globalImageFetch,
  languages = cardLanguagesFromEnv(),
  spendCapUsd = cardSpendCapFromEnv(),
  now = () => new Date(),
}: {
  db: PrismaClient;
  shopDomain: string;
  writer: CardWriter;
  fetchImage?: ImageFetch;
  languages?: readonly string[];
  spendCapUsd?: number;
  now?: () => Date;
}): Promise<CardResult> {
  const startedAt = now();
  const products = await db.catalogProduct.findMany({
    where: { shopDomain },
    orderBy: [{ available: "desc" }, { sourceUpdatedAt: "desc" }, { productId: "asc" }],
  });
  const [enrichments, cards, imagesByProduct] = await Promise.all([
    db.productEnrichment.findMany({ where: { shopDomain } }),
    db.productCard.findMany({
      where: { shopDomain },
      select: { productId: true, inputHash: true, cardVersion: true },
    }),
    loadVisionImages(db, shopDomain),
  ]);
  const enrichmentByProduct = new Map(enrichments.map((row) => [row.productId, row]));
  const cardByProduct = new Map(cards.map((row) => [row.productId, row]));
  const schema = buildCardSchema(languages);
  const result: CardResult = { written: 0, cached: 0, failed: 0, costUsd: 0 };
  const runCost = async (): Promise<number> => {
    const cost = await db.aiCall.aggregate({
      _sum: { costUsd: true },
      where: { shopDomain, operation: "card", createdAt: { gte: startedAt } },
    });
    return cost._sum.costUsd ?? 0;
  };

  for (const product of products) {
    const enrichment = enrichmentByProduct.get(product.productId) ?? null;
    const images = (imagesByProduct.get(product.productId) ?? []).slice(0, MAX_CARD_IMAGES);
    const inputHash = computeCardInputHash({
      product,
      enrichment,
      imageHashes: images.map((image) => image.contentHash),
      languages,
    });
    const stored = cardByProduct.get(product.productId);
    if (stored !== undefined && stored.inputHash === inputHash && stored.cardVersion === CARD_VERSION) {
      result.cached += 1;
      continue;
    }

    const inline = images.length === 0 ? [] : await fetchInlineImages(fetchImage, images);
    if (images.length > 0 && inline.length === 0) {
      // Nothing to show the model (every image fetch failed): no call and
      // no row update, so the next run tries again.
      result.failed += 1;
      continue;
    }

    const prompt = buildCardPrompt(product, enrichment, languages, inline.length);
    let card: CardSections | null = null;
    for (let attempt = 0; attempt < 2 && card === null; attempt += 1) {
      try {
        card = parseCard(
          await writer.llm.completeStructured({
            prompt,
            schema,
            operation: "card",
            storeId: shopDomain,
            ...(inline.length > 0 ? { images: inline } : {}),
          }),
          languages,
        );
      } catch {
        // An unparseable answer or a transient API error counts as one
        // failed attempt, like invalid output.
        card = null;
      }
    }

    const cardText = card === null ? "" : composeCardText(card);
    const data = {
      status: card === null ? "failed" : "written",
      facts: card?.facts ?? "",
      look: card?.look ?? "",
      read: card?.read ?? "",
      summary: card?.summary ?? "",
      asks: card?.asks ?? {},
      cardText,
      cardTextHash: card === null ? "" : sha256(cardText),
      inputHash,
      cardVersion: CARD_VERSION,
      modelId: writer.modelId,
      writtenAt: now(),
    };
    await db.productCard.upsert({
      where: { shopDomain_productId: { shopDomain, productId: product.productId } },
      create: { shopDomain, productId: product.productId, ...data },
      update: data,
    });
    result[card === null ? "failed" : "written"] += 1;

    if ((await runCost()) >= spendCapUsd) {
      result.capReachedUsd = spendCapUsd;
      break;
    }
  }

  result.costUsd = await runCost();
  return result;
}

/**
 * The card writer's port (AC-2): `GEMINI_CARD_MODEL` (default Flash-Lite)
 * at an explicit thinking level (`GEMINI_CARD_THINKING_LEVEL`, default
 * `low`), metered through the Prisma cost ledger under operation `card`.
 * Requires GEMINI_API_KEY.
 */
export function createCardWriter(db: PrismaClient): CardWriter {
  const models = geminiModelsFromEnv();
  return {
    llm: createGeminiLlmClient({
      modelId: models.cardModel,
      thinkingLevel: models.cardThinkingLevel,
      costRecorder: createPrismaCostRecorder(db),
    }),
    modelId: models.cardModel,
  };
}
