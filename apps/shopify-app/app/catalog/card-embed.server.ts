import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "@unfiltered/engine";

import {
  EMBED_BATCH_SIZE,
  EmbeddingDimensionError,
  ensureEmbeddingIndex,
  toVectorLiteral,
} from "./embed.server";

/**
 * Card vectors (YOY-144; PRD §3 Engine v2): Engine v2 finds a product by
 * its card, not by the fixed attribute text `ProductEmbedding` holds. Each
 * written card becomes several vectors — one for the prose (`facts` +
 * `look` + `read`) and one per ask-list language — so a short query in any
 * language lands near the products it asks for. `embedCatalog` and its
 * `ProductEmbedding` rows are untouched (NG-2): they stay the fallback for
 * a product with no card.
 */

/** The prose section's name. */
export const PROSE_SECTION = "prose";

/** The section name of one language's ask list. */
export function asksSection(language: string): string {
  return `asks:${language}`;
}

/** The card fields a card's vectors are built from. */
export interface EmbeddableCard {
  facts: string;
  look: string;
  read: string;
  /** { "<language>": [ways to ask] }, as `ProductCard.asks` stores it. */
  asks: unknown;
}

/**
 * The texts one card embeds, by section (AC-2): the prose as facts, look and
 * read on separate lines, then one text per language whose ask list holds
 * at least one ask, one ask per line. Languages keep the card's own order.
 */
export function cardEmbeddingSections(card: EmbeddableCard): Array<{ section: string; text: string }> {
  const sections = [
    {
      section: PROSE_SECTION,
      text: [card.facts, card.look, card.read].filter((part) => part !== "").join("\n"),
    },
  ];
  const asks = card.asks;
  if (asks !== null && typeof asks === "object" && !Array.isArray(asks)) {
    for (const [language, list] of Object.entries(asks as Record<string, unknown>)) {
      const texts = Array.isArray(list) ? list.filter((ask): ask is string => typeof ask === "string" && ask !== "") : [];
      if (texts.length > 0) {
        sections.push({ section: asksSection(language), text: texts.join("\n") });
      }
    }
  }
  return sections.filter((entry) => entry.text !== "");
}

function sectionTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Outcome counts of one card-vector run (AC-9). */
export interface CardEmbedResult {
  /** Sections embedded this run. */
  embedded: number;
  /** Sections whose stored text hash is current: no call. */
  cached: number;
  /** Vectors removed: their product has no written card, or the section is gone. */
  deleted: number;
}

/** The `card vectors: …` operator report line (AC-9). */
export function formatCardVectorReport(result: CardEmbedResult): string {
  return `card vectors: embedded ${result.embedded}, cached ${result.cached}`;
}

/**
 * Embed one store's written cards into `CardEmbedding`, incrementally
 * (AC-2): only sections whose text hash differs from the stored row are
 * embedded, so a re-run over unchanged cards makes zero embedding calls.
 * Vectors of a product whose card is missing or `failed`, and of a section
 * the card no longer has (a language dropped from `CARD_ASK_LANGUAGES`), are
 * deleted: such a product falls back to its `ProductEmbedding` row (AC-4).
 *
 * Texts go through the engine's embedding port in batches, as in
 * `embedCatalog`, so a metered adapter writes one ledger row per batch.
 * Every vector must match the client's declared dimension — a mismatch
 * throws before the batch is stored.
 */
export async function embedCatalogCards({
  db,
  shopDomain,
  embeddings,
}: {
  db: PrismaClient;
  shopDomain: string;
  embeddings: EmbeddingClient;
}): Promise<CardEmbedResult> {
  const dimension = embeddings.dimension;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new EmbeddingDimensionError(`Embedding dimension must be a positive integer, got ${dimension}`);
  }
  await ensureEmbeddingIndex(db, dimension, "CardEmbedding");

  const cards = await db.productCard.findMany({
    where: { shopDomain, status: "written" },
    select: { productId: true, facts: true, look: true, read: true, asks: true },
    orderBy: { productId: "asc" },
  });
  const existing = await db.$queryRawUnsafe<Array<{ productId: string; section: string; textHash: string }>>(
    `SELECT "productId", "section", "textHash" FROM "CardEmbedding" WHERE "shopDomain" = $1`,
    shopDomain,
  );
  const key = (productId: string, section: string): string => `${productId}\u0000${section}`;
  const existingHashes = new Map(existing.map((row) => [key(row.productId, row.section), row.textHash]));

  const wanted = cards.flatMap((card) =>
    cardEmbeddingSections(card).map(({ section, text }) => ({
      productId: card.productId,
      section,
      text,
      textHash: sectionTextHash(text),
    })),
  );
  const wantedKeys = new Set(wanted.map((entry) => key(entry.productId, entry.section)));

  const stale = existing.filter((row) => !wantedKeys.has(key(row.productId, row.section)));
  for (const row of stale) {
    await db.$executeRawUnsafe(
      `DELETE FROM "CardEmbedding" WHERE "shopDomain" = $1 AND "productId" = $2 AND "section" = $3`,
      shopDomain,
      row.productId,
      row.section,
    );
  }

  const toEmbed = wanted.filter((entry) => existingHashes.get(key(entry.productId, entry.section)) !== entry.textHash);
  for (let start = 0; start < toEmbed.length; start += EMBED_BATCH_SIZE) {
    const batch = toEmbed.slice(start, start + EMBED_BATCH_SIZE);
    const vectors = await embeddings.embed({ texts: batch.map((entry) => entry.text), storeId: shopDomain });
    if (vectors.length !== batch.length) {
      throw new EmbeddingDimensionError(`Embedding port returned ${vectors.length} vectors for ${batch.length} texts`);
    }
    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== dimension) {
        throw new EmbeddingDimensionError(
          `Card vector for product ${batch[index]!.productId} (${batch[index]!.section}) has dimension ${vector.length}, configuration expects ${dimension}`,
        );
      }
    }
    for (const [index, vector] of vectors.entries()) {
      const entry = batch[index]!;
      await db.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding"
           ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6::vector(${dimension}), CURRENT_TIMESTAMP)
         ON CONFLICT ("shopDomain", "productId", "section") DO UPDATE SET
           "textHash" = EXCLUDED."textHash",
           "embedding" = EXCLUDED."embedding",
           "updatedAt" = CURRENT_TIMESTAMP`,
        randomUUID(),
        shopDomain,
        entry.productId,
        entry.section,
        entry.textHash,
        toVectorLiteral(vector),
      );
    }
  }

  return { embedded: toEmbed.length, cached: wanted.length - toEmbed.length, deleted: stale.length };
}
