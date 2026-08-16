/**
 * Full catalog ingest entrypoint (YOY-69 AC-1): the committed form of the
 * throwaway script docs/M3-LIVE-RUN.md used to inline — ingest → enrich →
 * embed for one shop, authenticated by the offline session already
 * persisted in the `Session` table. No tunnel and no running dev server
 * needed; only DATABASE_URL, GEMINI_API_KEY, SHOPIFY_API_KEY/_SECRET (for
 * the token refresh below), and the offline session.
 *
 * Offline access tokens expire after 60 minutes (YOY-98): the app requests
 * expiring tokens, as Shopify mandates for public apps, and the embedded
 * app refreshes them on every request — this script must refresh too, or
 * it dies within an hour of the last admin interaction. When no usable
 * token can be produced (no session, refresh token expired or revoked, the
 * Admin API answers 401) it exits non-zero with the re-authorize
 * instruction, never a raw API error.
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
import {
  OfflineAuthError,
  rejectUnauthenticated,
  resolveOfflineAccessToken,
} from "../app/catalog/offline-token.server";

/** Keep in sync with `api_version` in shopify.app.toml. */
const ADMIN_API_VERSION = "2025-10";

const shop =
  process.argv[2] ?? process.env.INGEST_SHOP ?? "unfiltered-dev.myshopify.com";

const db = new PrismaClient();

try {
  // The offline session the app stored at install time authenticates the
  // Admin API directly — no proxy, no tunnel, no dev server — refreshed
  // first when its 60-minute access token has expired (YOY-98 AC-1).
  const accessToken = await resolveOfflineAccessToken({
    db,
    shop,
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    apiSecretKey: process.env.SHOPIFY_API_SECRET ?? "",
  });

  const graphql = (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) =>
    fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: options?.variables }),
    }).then((response) => rejectUnauthenticated(shop, response));

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
} catch (error) {
  if (error instanceof OfflineAuthError) {
    // Actionable, not a stack trace (YOY-98 AC-2).
    console.error(`ingest aborted: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await db.$disconnect();
}
