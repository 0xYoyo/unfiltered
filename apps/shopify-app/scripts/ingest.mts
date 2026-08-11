/**
 * Full catalog ingest entrypoint (YOY-69 AC-1): the committed form of the
 * throwaway script docs/M3-LIVE-RUN.md used to inline — ingest → enrich →
 * embed for one shop, authenticated by the offline session token already
 * persisted in the `Session` table. No tunnel and no running dev server
 * needed; only DATABASE_URL, GEMINI_API_KEY, and the offline session.
 *
 * This is operator tooling, not the product entrypoint: install-time ingest
 * with indexing progress is M7 onboarding, and the M4 playground's seeded
 * catalog ingest may reuse this. Re-running is idempotent — content hashes
 * make a second pass report `unchanged`/`cached`.
 *
 * Usage, from apps/shopify-app:
 *
 *   set -a && source .env && set +a
 *   npm run ingest                        # default dev shop
 *   npm run ingest -- other.myshopify.com # any shop with an offline session
 */

import { PrismaClient } from "@prisma/client";

import {
  createCatalogEmbeddingClient,
  embedCatalog,
} from "../app/catalog/embed.server";
import {
  createEnrichmentLlmClient,
  enrichCatalog,
} from "../app/catalog/enrich.server";
import { ingestCatalog } from "../app/catalog/ingest.server";

/** Keep in sync with `api_version` in shopify.app.toml. */
const ADMIN_API_VERSION = "2025-10";

const shop =
  process.argv[2] ?? process.env.INGEST_SHOP ?? "unfiltered-dev.myshopify.com";

const db = new PrismaClient();

try {
  // The offline access token the app stored at install time authenticates
  // the Admin API directly — no proxy, no tunnel, no dev server.
  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
  });
  if (session === null) {
    throw new Error(
      `no offline session for ${shop} — install the app on that shop first`,
    );
  }

  const graphql = (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) =>
    fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables: options?.variables }),
    });

  console.log(`shop: ${shop}`);
  console.log(
    "ingest:",
    await ingestCatalog({ db, shopDomain: shop, graphql }),
  );
  console.log(
    "enrich:",
    await enrichCatalog({
      db,
      shopDomain: shop,
      llm: createEnrichmentLlmClient(db),
    }),
  );
  console.log(
    "embed:",
    await embedCatalog({
      db,
      shopDomain: shop,
      embeddings: createCatalogEmbeddingClient(db),
    }),
  );
} finally {
  await db.$disconnect();
}
