import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { PrismaClient } from "@prisma/client";
import { PrismaPGlite } from "pglite-prisma-adapter";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Create a PrismaClient against a fresh in-process PGlite (embedded Postgres)
 * database with the pgvector extension loaded and the committed migration SQL
 * applied. Keeps every test fully offline: no DATABASE_URL and no external
 * Postgres server is ever needed.
 */
export async function createTestDb(
  options: {
    /**
     * Statement listener (YOY-115 AC-1): called once per SQL statement the
     * client sends, with its text. Lets a test count round trips.
     */
    onQuery?: (sql: string) => void;
  } = {},
): Promise<PrismaClient> {
  const pglite = new PGlite({ extensions: { vector, pg_trgm } });
  // pglite-prisma-adapter pins @prisma/driver-adapter-utils@6.10.1 while
  // @prisma/client ships its own copy, so TS sees two structurally identical
  // but nominally distinct adapter types.
  const adapter = new PrismaPGlite(pglite) as unknown as NonNullable<
    NonNullable<ConstructorParameters<typeof PrismaClient>[0]>["adapter"]
  >;
  const client =
    options.onQuery === undefined
      ? new PrismaClient({ adapter })
      : new PrismaClient({
          adapter,
          log: [{ level: "query", emit: "event" }],
        });
  if (options.onQuery !== undefined) {
    const onQuery = options.onQuery;
    (client as PrismaClient<{ log: [{ level: "query"; emit: "event" }] }>).$on(
      "query",
      (event) => onQuery(event.query),
    );
  }

  const migrationsDir = join(appRoot, "prisma", "migrations");
  for (const migration of (await readdir(migrationsDir)).sort()) {
    if (migration.startsWith(".") || migration === "migration_lock.toml") {
      continue;
    }
    const sql = await readFile(
      join(migrationsDir, migration, "migration.sql"),
      "utf8",
    );
    for (const statement of sql.split(";")) {
      if (statement.trim()) {
        await client.$executeRawUnsafe(statement);
      }
    }
  }

  return client;
}

/**
 * Build a webhook Request the way Shopify sends it: JSON body plus topic,
 * shop, and HMAC headers, signed with SHOPIFY_API_SECRET unless a different
 * secret is passed (to produce an invalid signature).
 */
export function webhookRequest({
  topic,
  shop = "test-shop.myshopify.com",
  payload = {},
  secret = process.env.SHOPIFY_API_SECRET ?? "",
  omitHmac = false,
}: {
  topic: string;
  shop?: string;
  payload?: Record<string, unknown>;
  secret?: string;
  omitHmac?: boolean;
}): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": shop,
    "X-Shopify-API-Version": "2025-10",
    "X-Shopify-Webhook-Id": randomUUID(),
  };
  if (!omitHmac) {
    headers["X-Shopify-Hmac-Sha256"] = createHmac("sha256", secret)
      .update(body, "utf8")
      .digest("base64");
  }

  return new Request("https://test-app.example.com/webhooks", {
    method: "POST",
    headers,
    body,
  });
}
