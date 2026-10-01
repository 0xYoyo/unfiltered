/**
 * Score a set (YOY-140 AC-6, AC-10): seed an in-process PGlite from a
 * fixture, search through the playground's own search function, grade the
 * top six, and print the score table only. `npm run score:public` runs the
 * public half.
 *
 * `--synthetic` runs against the synthetic tenant with replay clients: no
 * network, no spend.
 *
 * Env loads in-process like render-migrate.mts.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runScoreCommand } from "../app/score/cli.server";

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "..", ".env"), resolve(here, "..", "..", "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

process.exit(await runScoreCommand(process.argv.slice(2)));
