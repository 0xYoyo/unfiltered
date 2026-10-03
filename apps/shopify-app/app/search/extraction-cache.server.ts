import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  EXTRACT_PROMPT_VERSION,
  type ExcludedTerm,
  type ExtractedWishes,
  type ExtractRequest,
  type StatedPrice,
  type WishExtractor,
} from "@unfiltered/engine";

import { normalizeReuseQuery } from "./events.server";

/**
 * The wish extraction cache (YOY-149 AC-18): the same sentence is extracted
 * once. The key is the SHA-256 of the normalized sentence, its language by
 * script, the extraction prompt version and the model id; the row holds the
 * validated wishes. Persistent, so it survives deploys; not keyed by tenant,
 * because the answer depends on the sentence alone. Reads and writes never
 * fail a search: a broken cache is a miss. A refinement's previous chain
 * (YOY-150 AC-2) is part of the key: "cheaper" after "black dress" is
 * another question than "cheaper" alone.
 */

/** The sentence's language by script class: he, ar, ru, else en. */
export function sentenceLanguage(text: string): "en" | "he" | "ar" | "ru" {
  if (/\p{Script=Hebrew}/u.test(text)) return "he";
  if (/\p{Script=Arabic}/u.test(text)) return "ar";
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  return "en";
}

export function extractionCacheKey(input: {
  sentence: string;
  previousSentence?: string;
  modelId: string;
  promptVersion?: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        normalizeReuseQuery(input.sentence),
        sentenceLanguage(input.sentence),
        input.promptVersion ?? EXTRACT_PROMPT_VERSION,
        input.modelId,
        ...(input.previousSentence !== undefined && input.previousSentence.trim() !== ""
          ? [input.previousSentence.split("\n").map(normalizeReuseQuery)]
          : []),
      ]),
    )
    .digest("hex");
}

/** One extraction, and whether the cache answered it. */
export interface CachedExtraction {
  wishes: ExtractedWishes;
  cached: boolean;
}

function storedPrice(value: unknown): StatedPrice | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const { amount, raw } = value as Record<string, unknown>;
  return typeof amount === "number" && typeof raw === "string" ? { amount, raw } : undefined;
}

/** A stored row read back; null when it no longer fits the shape (a miss). */
function storedWishes(value: Prisma.JsonValue): ExtractedWishes | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const priceMax = storedPrice(record.priceMax);
  const priceMin = storedPrice(record.priceMin);
  if (
    priceMax === undefined ||
    priceMin === undefined ||
    !(record.currency === null || typeof record.currency === "string") ||
    !(record.size === null || typeof record.size === "string") ||
    typeof record.inStock !== "boolean" ||
    typeof record.priceFirm !== "boolean" ||
    typeof record.sizeFirm !== "boolean" ||
    !(record.refines === undefined || typeof record.refines === "boolean") ||
    !Array.isArray(record.excluded)
  ) {
    return null;
  }
  const excluded: ExcludedTerm[] = [];
  for (const entry of record.excluded) {
    const { typed, english } = (entry ?? {}) as Record<string, unknown>;
    if (typeof typed !== "string" || typeof english !== "string") {
      return null;
    }
    excluded.push({ typed, english });
  }
  return {
    priceMax,
    priceMin,
    currency: record.currency as string | null,
    size: record.size as string | null,
    inStock: record.inStock,
    excluded,
    priceFirm: record.priceFirm,
    sizeFirm: record.sizeFirm,
    ...(typeof record.refines === "boolean" ? { refines: record.refines } : {}),
  };
}

/**
 * Extract through the cache (AC-18): a stored answer for the key is served
 * with no call; otherwise the extractor is called and its answer stored —
 * also when it lands after the grace, so the next search is warm. Rejects
 * only when the call itself fails.
 */
export async function extractThroughCache(
  db: PrismaClient,
  extractor: WishExtractor,
  request: ExtractRequest,
): Promise<CachedExtraction> {
  const cacheKey = extractionCacheKey({
    sentence: request.sentence,
    ...(request.previousSentence !== undefined ? { previousSentence: request.previousSentence } : {}),
    modelId: extractor.modelId ?? "unknown",
  });
  try {
    const row = await db.extractionAnswer.findUnique({
      where: { cacheKey },
      select: { wishes: true },
    });
    const wishes = row === null ? null : storedWishes(row.wishes);
    if (wishes !== null) {
      return { wishes, cached: true };
    }
  } catch (error) {
    warnCache("read", error);
  }
  const wishes = await extractor.extract(request);
  const value = JSON.parse(JSON.stringify(wishes)) as Prisma.InputJsonValue;
  try {
    await db.extractionAnswer.upsert({
      where: { cacheKey },
      create: { cacheKey, wishes: value },
      update: { wishes: value },
    });
  } catch (error) {
    warnCache("write", error);
  }
  return { wishes, cached: false };
}

function warnCache(what: string, error: unknown): void {
  console.warn(
    `[search] extraction cache ${what} failed`,
    JSON.stringify({ error: error instanceof Error ? error.name : String(error) }),
  );
}
