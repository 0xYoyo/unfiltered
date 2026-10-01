/**
 * Build the score set (YOY-140 AC-1..AC-3): log queries plus Flash-Lite
 * filler, split 13 public / 12 hidden; the hidden half goes base64-encoded
 * to --hidden-out, which must lie outside the repository.
 *
 * `--synthetic` runs against the synthetic tenant with replay clients: no
 * network, no spend.
 *
 * Env loads in-process like render-migrate.mts.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSetCommand } from "../app/score/cli.server";

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "..", ".env"), resolve(here, "..", "..", "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

process.exit(await buildSetCommand(process.argv.slice(2)));
