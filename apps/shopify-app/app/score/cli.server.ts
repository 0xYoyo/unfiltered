import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { PrismaClient } from "@prisma/client";
import type { CostRecorder, LlmClient } from "@unfiltered/engine";

import type { SearchOrchestrator } from "../search/orchestrator.server";
import {
  exportScoreFixture,
  importScoreFixture,
  type ScoreFixture,
} from "./fixture.server";
import { gradeAgreement, gradeSearch, type GradedResult } from "./grade.server";
import { findLeaks } from "./leak.server";
import { formatScoreTable, runScoreSet, withCapturedConsole } from "./run.server";
import {
  buildScoreSet,
  decodeHiddenSet,
  exportLogQueries,
  ScoreSetRefusal,
  SCORE_SPLIT_SEED,
  splitScoreSet,
  writeScoreSets,
  type ScoreSetEntry,
} from "./set.server";
import {
  buildSyntheticFixture,
  createSyntheticFillerLlm,
  createSyntheticGrader,
  createSyntheticOrchestrator,
  seedSyntheticSearchLog,
} from "./synthetic.server";

/**
 * The score commands behind `scripts/score-*.mts` (YOY-140). Each takes its
 * argv and an output sink and returns an exit code, so tests run them
 * in-process. `--synthetic` swaps every database and model for the
 * synthetic tenant and replay clients: no network, no spend. Without it a
 * command reads the real database and calls Flash-Lite — paid calls.
 */

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_ROOT = resolve(APP_ROOT, "..", "..");
export const DEFAULT_PUBLIC_SET_PATH = join(APP_ROOT, "app", "score", "data", "public-set.json");
/**
 * The seed catalog the public half is scored against by default. Committed
 * gzipped: the size cap applies to the compressed file, and the fixture
 * always holds every product (YOY-141 AC-4).
 */
export const DEFAULT_FIXTURE_PATH = join(APP_ROOT, "app", "score", "data", "seed-fixture.json.gz");
export const DEFAULT_CALIBRATION_PATH = join(APP_ROOT, "app", "score", "data", "calibration.json");
/** Grader model override; Flash-Lite by default (AC-4). */
export const SCORE_MODEL_ENV = "GEMINI_SCORE_MODEL";

export type Output = (text: string) => void;

const stdout: Output = (text) => {
  process.stdout.write(`${text}\n`);
};
const stderr: Output = (text) => {
  process.stderr.write(`${text}\n`);
};

/** A fixture file, gzipped when its name ends in `.gz`. */
export function readFixtureFile(path: string): ScoreFixture {
  const bytes = readFileSync(path);
  return JSON.parse(
    (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"),
  ) as ScoreFixture;
}

export function writeFixtureFile(path: string, fixture: ScoreFixture): void {
  const json = `${JSON.stringify(fixture)}\n`;
  writeFileSync(path, path.endsWith(".gz") ? gzipSync(json, { level: 9 }) : json);
}

const noCost: CostRecorder = { record: async () => {} };

async function createScratchDb(): Promise<PrismaClient> {
  // PGlite is a dev dependency: loaded only when a command needs it.
  const { createTestDb } = await import("../testing/helpers.server");
  return createTestDb();
}

async function liveDb(): Promise<PrismaClient> {
  return (await import("../db.server")).default;
}

/** Live Flash-Lite at thinking level low — the grader (AC-4) and the filler. */
async function flashLite(costRecorder: CostRecorder): Promise<LlmClient> {
  const { createGeminiLlmClient, DEFAULT_INTENT_LITE_MODEL } = await import(
    "@unfiltered/provider-gemini"
  );
  return createGeminiLlmClient({
    modelId: process.env[SCORE_MODEL_ENV] ?? DEFAULT_INTENT_LITE_MODEL,
    thinkingLevel: "low",
    costRecorder,
  });
}

// --- score-build-set ------------------------------------------------------

export async function buildSetCommand(
  argv: readonly string[],
  { out = stdout, err = stderr }: { out?: Output; err?: Output } = {},
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "hidden-out": { type: "string" },
      "public-out": { type: "string" },
      seed: { type: "string" },
      synthetic: { type: "boolean", default: false },
    },
  });
  const hiddenOut = values["hidden-out"];
  if (hiddenOut === undefined) {
    err("usage: score-build-set.mts --hidden-out <path outside the repo> [--public-out <path>] [--seed <n>] [--synthetic]");
    return 2;
  }
  const seed = values.seed === undefined ? SCORE_SPLIT_SEED : Number(values.seed);
  const db = values.synthetic ? await createScratchDb() : await liveDb();
  try {
    if (values.synthetic) {
      await seedSyntheticSearchLog(db);
    }
    const { playgroundStoreKeys } = await import("../playground/api.server");
    const logQueries = await exportLogQueries(db, await playgroundStoreKeys(db));
    const llm = values.synthetic ? createSyntheticFillerLlm() : await flashLite(noCost);
    const set = await buildScoreSet({ logQueries, llm });
    const { publicSet, hiddenSet } = splitScoreSet(set, seed);
    writeScoreSets({
      publicSet,
      hiddenSet,
      publicPath: resolve(values["public-out"] ?? DEFAULT_PUBLIC_SET_PATH),
      hiddenPath: resolve(hiddenOut),
      repoRoot: REPO_ROOT,
    });
    out(`score set: ${publicSet.length} public, ${hiddenSet.length} hidden (seed ${seed})`);
    return 0;
  } catch (error) {
    err(error instanceof ScoreSetRefusal ? `refused: ${error.message}` : `score set failed: ${(error as Error).message}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

// --- score-run (npm run score:public) ---------------------------------------

export async function runScoreCommand(
  argv: readonly string[],
  { out = stdout, err = stderr }: { out?: Output; err?: Output } = {},
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      set: { type: "string" },
      "hidden-set": { type: "string" },
      fixture: { type: "string" },
      synthetic: { type: "boolean", default: false },
    },
  });
  let set: ScoreSetEntry[];
  try {
    set =
      values["hidden-set"] !== undefined
        ? decodeHiddenSet(readFileSync(values["hidden-set"], "utf8"))
        : (JSON.parse(readFileSync(values.set ?? DEFAULT_PUBLIC_SET_PATH, "utf8")) as ScoreSetEntry[]);
  } catch {
    // Never echo the file: it is query text.
    err("score run: the set file is missing or unreadable — build it with score-build-set.mts");
    return 1;
  }
  let fixture: ScoreFixture;
  try {
    fixture = values.synthetic
      ? buildSyntheticFixture()
      : readFixtureFile(values.fixture ?? DEFAULT_FIXTURE_PATH);
  } catch {
    err("score run: the fixture is missing or unreadable — export one with score-export-fixture.mts, or pass --fixture");
    return 1;
  }

  const db = await createScratchDb();
  try {
    const { result: report } = await withCapturedConsole(async () => {
      await importScoreFixture(db, fixture);
      let orchestrator: SearchOrchestrator;
      let grader: LlmClient;
      if (values.synthetic) {
        orchestrator = createSyntheticOrchestrator(db, set);
        grader = await createSyntheticGrader(orchestrator, set);
      } else {
        const { createProxySearchOrchestrator } = await import("../search/proxy.server");
        const { createPrismaCostRecorder } = await import("../ai/cost-recorder.server");
        orchestrator = createProxySearchOrchestrator(db);
        grader = await flashLite(createPrismaCostRecorder(db));
      }
      return runScoreSet({ db, orchestrator, grader, storeKey: fixture.storeKey, set });
    });
    out(formatScoreTable(report));
    return 0;
  } catch (error) {
    // The name only: a message can carry query text.
    err(`score run failed (${(error as Error).name})`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

// --- score-export-fixture -------------------------------------------------

export async function exportFixtureCommand(
  argv: readonly string[],
  { out = stdout, err = stderr }: { out?: Output; err?: Output } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const [storeKey] = positionals;
  if (storeKey === undefined || values.out === undefined) {
    err("usage: score-export-fixture.mts <storeKey> --out <fixture.json[.gz]>");
    return 2;
  }
  const db = await liveDb();
  try {
    const fixture = await exportScoreFixture(db, storeKey);
    writeFixtureFile(values.out, fixture);
    out(
      `fixture: ${fixture.products.length} products, ${fixture.enrichments.length} enrichments, ${fixture.embeddings.length} embeddings (ingested ${fixture.ingestedAt})`,
    );
    return 0;
  } finally {
    await db.$disconnect();
  }
}

// --- score-calibrate --------------------------------------------------------

/** One hand-graded search in calibration.json (AC-9). */
export interface CalibrationEntry {
  query: string;
  results: GradedResult[];
  /** One hand grade 0–3 per result, in order. */
  grades: number[];
}

export async function calibrate({
  entries,
  llm,
}: {
  entries: readonly CalibrationEntry[];
  llm: LlmClient;
}): Promise<ReturnType<typeof gradeAgreement>> {
  const pairs: { hand: number; model: number }[] = [];
  for (const entry of entries) {
    const model = await gradeSearch({ llm, query: entry.query, results: entry.results });
    for (const [index, hand] of entry.grades.slice(0, model.length).entries()) {
      pairs.push({ hand, model: model[index]! });
    }
  }
  return gradeAgreement(pairs);
}

export async function calibrateCommand(
  argv: readonly string[],
  { out = stdout, err = stderr, llm }: { out?: Output; err?: Output; llm?: LlmClient } = {},
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { file: { type: "string" } },
  });
  let entries: CalibrationEntry[];
  try {
    entries = JSON.parse(
      readFileSync(values.file ?? DEFAULT_CALIBRATION_PATH, "utf8"),
    ) as CalibrationEntry[];
  } catch {
    err("score calibrate: app/score/data/calibration.json is missing or unreadable — see docs/SCORE.md for its shape");
    return 1;
  }
  const agreement = await calibrate({ entries, llm: llm ?? (await flashLite(noCost)) });
  out(
    `calibration: ${agreement.pairs} graded results · exact agreement ${agreement.exact.toFixed(1)}% · within one ${agreement.withinOne.toFixed(1)}%`,
  );
  return 0;
}

// --- score-leak-check (the score workflow, YOY-141 AC-3) ----------------------

/**
 * Fail when any hidden query appears in a run's captured output. Prints a
 * count, never a query, so the check itself cannot leak what it guards.
 */
export function leakCheckCommand(
  argv: readonly string[],
  { out = stdout, err = stderr }: { out?: Output; err?: Output } = {},
): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "hidden-set": { type: "string" },
      output: { type: "string" },
    },
  });
  if (values["hidden-set"] === undefined || values.output === undefined) {
    err("usage: score-leak-check.mts --hidden-set <hidden.b64> --output <captured.txt>");
    return 2;
  }
  let hiddenSet: ScoreSetEntry[];
  let output: string;
  try {
    hiddenSet = decodeHiddenSet(readFileSync(values["hidden-set"], "utf8"));
    output = readFileSync(values.output, "utf8");
  } catch {
    err("leak check: the hidden set or the captured output is missing or unreadable");
    return 1;
  }
  const { leaked } = findLeaks(output, hiddenSet);
  if (leaked > 0) {
    err(`leak check FAILED: ${leaked} hidden ${leaked === 1 ? "query appears" : "queries appear"} in the output — it is not printed`);
    return 1;
  }
  out(`leak check: no hidden query in the output (${hiddenSet.length} checked)`);
  return 0;
}
