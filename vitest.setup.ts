import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Prisma client drift guard (YOY-71, YOY-78): after pulling a migration, the
// generated client in node_modules is stale and every DB-touching test fails
// with dozens of confusing "Unknown argument" validation errors. Fail once,
// loudly, with the fix — same loud-guard pattern as the source-execution guard
// (PR #54). The generated client keeps a copy of the schema it was built from;
// equal contents mean fresh, whatever the mtimes — so branch switches that
// merely bump the schema's mtime no longer trip a false "stale" (YOY-78).
// Cost when fresh: two small file reads per test file, well under a millisecond.
{
  const schemaPath = fileURLToPath(
    new URL("./apps/shopify-app/prisma/schema.prisma", import.meta.url),
  );
  const generatedSchemaPath = fileURLToPath(
    new URL("./node_modules/.prisma/client/schema.prisma", import.meta.url),
  );
  const fixCommand = "npm exec --workspace=app -- prisma generate";
  // prisma generate re-prints the schema copy it embeds (its own field
  // alignment), so raw bytes differ from the source even when freshly
  // generated; normalize whitespace before comparing.
  const normalize = (schema: string) =>
    schema
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " "))
      .join("\n")
      .trim();
  let generatedSchema: string | null = null;
  try {
    generatedSchema = readFileSync(generatedSchemaPath, "utf8");
  } catch {
    throw new Error(
      `Prisma client has not been generated (${generatedSchemaPath} is missing). ` +
        `Run: ${fixCommand}`,
    );
  }
  if (normalize(readFileSync(schemaPath, "utf8")) !== normalize(generatedSchema)) {
    throw new Error(
      "Stale Prisma client: apps/shopify-app/prisma/schema.prisma is newer than " +
        "the generated client in node_modules/.prisma/client. Tests would fail " +
        `with confusing "Unknown argument" errors. Run: ${fixCommand}`,
    );
  }
}

// Placeholder Shopify credentials so app modules that read env at import time
// (app/shopify.server.ts) can load in tests. No test may reach the network.
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-api-secret";
process.env.SHOPIFY_APP_URL ??= "https://test-app.example.com";
process.env.SCOPES ??= "write_products";
// Placeholder only — never connected to. DB-touching tests use the embedded
// PGlite database from createTestDb(), not this URL.
process.env.DATABASE_URL ??=
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";
