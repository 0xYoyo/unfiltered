/**
 * Find recall (YOY-174): grade every product of the seed fixture for each
 * public en and he search once, write the truth to
 * `app/score/data/recall-truth.json`, then run the find step alone and
 * report how much of each relevant set it reaches. With the truth file
 * present no grading call is made; `--rebuild-truth` grades again.
 *
 * `--synthetic` runs against the synthetic tenant with an offline grader:
 * no network, no spend.
 *
 * Env loads in-process like score-run.mts.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runRecallCommand } from "../app/score/cli.server";

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "..", ".env"), resolve(here, "..", "..", "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

process.exit(await runRecallCommand(process.argv.slice(2)));
