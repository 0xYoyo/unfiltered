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
 * Usage, from apps/shopify-app (the script loads .env itself):
 *
 *   npm run ingest:public -- --url https://store.example --slug store [--name "Store"] [--max 2000] [--source shopify-public|jsonld-crawl] [--pages 3000]
 *   npm run ingest:public -- --delete --slug store
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { createCatalogEmbeddingClient } from "../app/catalog/embed.server";
import {
  createEnrichmentLlmClient,
  createVisionLlmClient,
} from "../app/catalog/enrich.server";
import { runIngestPublicCli } from "../app/playground/ingest-public-cli.server";
import {
  CRAWL_CONCURRENCY,
  CRAWL_MIN_SPACING_MS,
} from "../app/playground/jsonld-crawl-source.server";
import { createPoliteFetch } from "../app/playground/polite-fetch.server";

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

const db = new PrismaClient();

try {
  process.exitCode = await runIngestPublicCli({
    argv: process.argv.slice(2),
    db,
    fetch: createPoliteFetch({
      contactUrl:
        process.env.PLAYGROUND_URL ?? "https://github.com/0xYoyo/unfiltered",
      // Page-crawl politeness (YOY-89 AC-1): up to 4 in flight per host,
      // ≥250 ms between request starts. The Shopify feed adapter pages
      // sequentially by construction, so this only widens the crawler.
      maxInFlightPerHost: CRAWL_CONCURRENCY,
      minSpacingMs: CRAWL_MIN_SPACING_MS,
    }),
    aiClients: () => ({
      llm: createEnrichmentLlmClient(db),
      vision: createVisionLlmClient(db),
      embeddings: createCatalogEmbeddingClient(db),
    }),
  });
} finally {
  await db.$disconnect();
}
