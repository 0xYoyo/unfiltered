/**
 * Grade app/score/data/calibration.json's hand-graded results with the live
 * grader and print exact and within-one agreement (YOY-140 AC-9). Paid: one
 * Flash-Lite call per calibration search.
 *
 * Env loads in-process like render-migrate.mts.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { calibrateCommand } from "../app/score/cli.server";

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "..", ".env"), resolve(here, "..", "..", "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

process.exit(await calibrateCommand(process.argv.slice(2)));
