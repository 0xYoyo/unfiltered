/**
 * The judge comparison's local measures (YOY-152 AC-7): judge-stage median
 * latency, judge cost per 1,000 uncached searches and stability for one
 * judge, over the public half on the seed fixture. Live and paid.
 *
 *   npx tsx scripts/judge-compare.mts --judge gemini|jev
 *
 * Env loads in-process like score-run.mts.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { judgeCompareCommand } from "../app/search/judge-compare.server";

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "..", ".env"), resolve(here, "..", "..", "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

process.exit(await judgeCompareCommand(process.argv.slice(2)));
