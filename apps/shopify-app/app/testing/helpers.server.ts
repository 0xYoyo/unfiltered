import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Create a PrismaClient against a fresh throwaway SQLite database with the
 * Session table applied from the committed migration SQL. Keeps every test
 * fully offline and isolated from prisma/dev.sqlite.
 */
export async function createTestDb(): Promise<PrismaClient> {
  const dir = mkdtempSync(join(tmpdir(), "unfiltered-test-db-"));
  const client = new PrismaClient({
    datasourceUrl: `file:${join(dir, "test.sqlite")}`,
  });

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
