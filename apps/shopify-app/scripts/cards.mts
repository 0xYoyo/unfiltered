/**
 * Cards-only entrypoint (YOY-177 AC-1): the existing card writer and card
 * embedder over one store key's catalog rows as they are — no catalog
 * fetch, no enrichment, no vision — so a card run can be bought on its own,
 * with the spend cap (`CARD_SPEND_CAP_USD`) stopping it. `CARD_PROVIDER`
 * picks who serves the calls (docs/DEPLOY.md): `openrouter` writes and
 * embeds through OpenRouter on the same model family. Writes to the
 * database `DATABASE_URL` names. Re-running is idempotent: an unchanged
 * card is `cached`, an unchanged section is never re-embedded.
 *
 * Usage, from apps/shopify-app (the script loads .env itself):
 *
 *   CARD_PROVIDER=openrouter CARD_SPEND_CAP_USD=2.3 npx tsx scripts/cards.mts playground:tentree
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  cardProviderFromEnv,
  cardSpendCapFromEnv,
  createCardWriter,
  formatCardReport,
  writeCatalogCards,
} from "../app/catalog/card.server";
import { embedCatalogCards, formatCardVectorReport } from "../app/catalog/card-embed.server";
import { createIngestEmbeddingClient } from "../app/catalog/embed.server";

// Env loading is in-process (YOY-142 AC-11), the `render-migrate.mts`
// pattern: Node's built-in `process.loadEnvFile` reads apps/shopify-app/.env,
// so no `source .env` in the shell; nothing here prints a value. A missing
// file is ignored (the env may already be exported), and an already-exported
// variable wins over the file.
try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const storeKey = process.argv[2];
if (storeKey === undefined || storeKey.startsWith("-")) {
  console.error("usage: npx tsx scripts/cards.mts <storeKey>");
  process.exit(2);
}
// Both settings fail here, before any call, when malformed.
const provider = cardProviderFromEnv();
const spendCapUsd = cardSpendCapFromEnv();

const db = new PrismaClient();
try {
  const products = await db.catalogProduct.count({ where: { shopDomain: storeKey } });
  if (products === 0) {
    console.error(`cards: no catalog rows for ${storeKey}`);
    process.exitCode = 1;
  } else {
    console.log(`cards: ${storeKey}, ${products} products, provider ${provider}, cap $${spendCapUsd.toFixed(2)}`);
    const cards = await writeCatalogCards({
      db,
      shopDomain: storeKey,
      writer: createCardWriter(db),
      spendCapUsd,
    });
    console.log(formatCardReport(cards));
    if (cards.capReachedUsd !== undefined) {
      // The spend cap stopped the card run (YOY-143 AC-12): the written
      // cards are still embedded, but the run exits non-zero.
      process.exitCode = 1;
    }
    const cardVectors = await embedCatalogCards({
      db,
      shopDomain: storeKey,
      embeddings: createIngestEmbeddingClient(db, provider),
    });
    console.log(formatCardVectorReport(cardVectors));
  }
} finally {
  await db.$disconnect();
}
