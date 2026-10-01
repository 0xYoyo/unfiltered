/**
 * Export one store key's CatalogProduct, ProductEnrichment and
 * ProductEmbedding rows from the configured database to a score fixture
 * (YOY-140 AC-8).
 *
 * Env loads in-process like render-migrate.mts.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exportFixtureCommand } from "../app/score/cli.server";

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "..", ".env"), resolve(here, "..", "..", "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

process.exit(await exportFixtureCommand(process.argv.slice(2)));
