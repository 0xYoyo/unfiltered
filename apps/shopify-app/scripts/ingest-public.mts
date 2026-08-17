/**
 * Public-catalog ingest entrypoint (YOY-88 AC-6): ingest → enrich → embed for
 * one PUBLIC storefront catalog into the playground registry, read through
 * the polite fetch helper and the generic catalog-source port. No app
 * install, no Admin API, no tunnel — only DATABASE_URL and GEMINI_API_KEY.
 * Re-running is idempotent (content hashes make a second pass report
 * `unchanged`/`cached` with zero AI calls); `--delete` removes one catalog
 * and nothing else. All logic lives in app/playground/ingest-public-cli
 * .server.ts, tested offline; this file only wires the process.
 *
 * Usage, from apps/shopify-app:
 *
 *   set -a && source .env && set +a
 *   npm run ingest:public -- --url https://store.example --slug store [--name "Store"] [--max 2000]
 *   npm run ingest:public -- --delete --slug store
 */

import { PrismaClient } from "@prisma/client";

import { createCatalogEmbeddingClient } from "../app/catalog/embed.server";
import { createEnrichmentLlmClient } from "../app/catalog/enrich.server";
import { runIngestPublicCli } from "../app/playground/ingest-public-cli.server";
import { createPoliteFetch } from "../app/playground/polite-fetch.server";

const db = new PrismaClient();

try {
  process.exitCode = await runIngestPublicCli({
    argv: process.argv.slice(2),
    db,
    fetch: createPoliteFetch({
      contactUrl:
        process.env.PLAYGROUND_URL ?? "https://github.com/0xYoyo/unfiltered",
    }),
    aiClients: () => ({
      llm: createEnrichmentLlmClient(db),
      embeddings: createCatalogEmbeddingClient(db),
    }),
  });
} finally {
  await db.$disconnect();
}
