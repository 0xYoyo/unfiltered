import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { PrismaClient } from "@prisma/client";
import type { CostRecorder, LlmClient } from "@unfiltered/engine";

import type { FindStep } from "../search/find.server";
import type { SearchOrchestrator } from "../search/orchestrator.server";
import {
  exportScoreFixture,
  importScoreFixture,
  type ScoreFixture,
} from "./fixture.server";
import { gradeAgreement, gradeSearch, type GradedResult } from "./grade.server";
import { findLeaks } from "./leak.server";
import {
  buildRecallTruth,
  formatLanguageRecallLine,
  formatRecallLine,
  languageRecall,
  measureRecall,
  RECALL_COST_CAP_USD,
  recallSearches,
  type RecallTruth,
} from "./recall.server";
import {
  formatCostLine,
  formatGradeLines,
  formatScoreTable,
  readRunCost,
  runScoreSet,
  withCapturedConsole,
  type ScoreReport,
} from "./run.server";
import {
  buildHardSet,
  buildScoreSet,
  decodeHiddenSet,
  exportLogQueries,
  reproduceOldSet,
  RepositoryText,
  repositoryText,
  SCORE_LANGUAGES,
  SCORE_SET_NAMES,
  ScoreSetRefusal,
  SCORE_SPLIT_SEED,
  setOf,
  splitScoreSet,
  writeScoreSets,
  type OldHalves,
  type ScoreLanguage,
  type ScoreSetEntry,
  type ScoreSetName,
} from "./set.server";
import {
  buildSyntheticFixture,
  createSyntheticFillerLlm,
  createSyntheticGrader,
  createSyntheticFindStep,
  createSyntheticOrchestrator,
  createSyntheticRecallGrader,
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
/** The committed find-recall truth (YOY-174 AC-1). */
export const DEFAULT_RECALL_TRUTH_PATH = join(APP_ROOT, "app", "score", "data", "recall-truth.json");
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
/** The runner's per-call timeout on grader and judge calls (YOY-149 runner guard). */
export const RUNNER_CALL_TIMEOUT_MS = 30_000;

async function flashLite(costRecorder: CostRecorder): Promise<LlmClient> {
  const { createGeminiLlmClient, DEFAULT_INTENT_LITE_MODEL } = await import(
    "@unfiltered/provider-gemini"
  );
  return createGeminiLlmClient({
    modelId: process.env[SCORE_MODEL_ENV] ?? DEFAULT_INTENT_LITE_MODEL,
    thinkingLevel: "low",
    costRecorder,
    requestTimeoutMs: RUNNER_CALL_TIMEOUT_MS,
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
      // Keep the old set's en and he searches (YOY-175 AC-1): rebuild them
      // from the log as it stood before this instant, and keep each language
      // whose old public half comes back exactly.
      "keep-before": { type: "string" },
      // The old public half that check compares against; the committed file by default.
      "previous-public": { type: "string" },
    },
  });
  const hiddenOut = values["hidden-out"];
  if (hiddenOut === undefined) {
    err("usage: score-build-set.mts --hidden-out <path outside the repo> [--public-out <path>] [--seed <n>] [--keep-before <ISO time> [--previous-public <path>]] [--synthetic]");
    return 2;
  }
  const keepBefore = values["keep-before"] === undefined ? undefined : new Date(values["keep-before"]);
  if (keepBefore !== undefined && Number.isNaN(keepBefore.getTime())) {
    err("score set: --keep-before must be an ISO time, e.g. 2026-10-01T17:33:28Z");
    return 2;
  }
  let previousPublic: ScoreSetEntry[] = [];
  if (keepBefore !== undefined) {
    try {
      // Read before anything is written: the public file is overwritten below.
      previousPublic = JSON.parse(
        readFileSync(resolve(values["previous-public"] ?? DEFAULT_PUBLIC_SET_PATH), "utf8"),
      ) as ScoreSetEntry[];
    } catch {
      err("score set: the previous public set is missing or unreadable");
      return 1;
    }
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
    const keep: Partial<Record<ScoreLanguage, ScoreSetEntry[]>> = {};
    const pinned: Partial<Record<ScoreLanguage, OldHalves>> = {};
    if (keepBefore !== undefined) {
      for (const result of reproduceOldSet({ logQueries, previousPublic, before: keepBefore, seed })) {
        // Counts and a verdict only: the rebuilt entries include hidden ones.
        out(`reproduce ${result.language} ${result.reproduced ? "reproduced" : "not reproduced"}`);
        if (result.entries !== undefined) keep[result.language] = result.entries;
        if (result.halves !== undefined) pinned[result.language] = result.halves;
      }
    }
    // No search already in the repository may enter a hidden half (YOY-175
    // AC-1, amended): the split pins every such added search public. The
    // synthetic log and filler live in a tracked file, so a synthetic build
    // checks against nothing.
    const known = values.synthetic ? new RepositoryText("") : repositoryText(REPO_ROOT);
    const simple = await buildScoreSet({ logQueries, llm, keep, known });
    const hard = await buildHardSet({ llm, avoid: simple, known });
    const { publicSet, hiddenSet } = splitScoreSet([...simple, ...hard], seed, pinned, known);
    writeScoreSets({
      publicSet,
      hiddenSet,
      publicPath: resolve(values["public-out"] ?? DEFAULT_PUBLIC_SET_PATH),
      hiddenPath: resolve(hiddenOut),
      repoRoot: REPO_ROOT,
    });
    out(`score set: ${publicSet.length} public, ${hiddenSet.length} hidden (seed ${seed})`);
    // Counts only, never the text: added searches pinned public because the repository already holds them.
    for (const [key, count] of known.pinned) out(`pinned ${key} ${count}`);
    // Per set and language (YOY-175 AC-1, AC-2): sizes and where the
    // searches came from, as counts — never a query.
    for (const entries of [simple, hard]) {
      for (const language of SCORE_LANGUAGES) {
        const own = entries.filter((entry) => entry.language === language);
        if (own.length === 0) continue;
        const name = setOf(own[0]!);
        const count = (half: readonly ScoreSetEntry[]) =>
          half.filter((entry) => setOf(entry) === name && entry.language === language).length;
        out(
          `set ${name} ${language} ${own.length}: ${count(publicSet)} public, ${count(hiddenSet)} hidden; ${own.filter((entry) => entry.source === "log").length} log, ${own.filter((entry) => entry.source === "model").length} filler`,
        );
      }
    }
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
      // Passes over the set on one scratch database (YOY-149 AC-18): the
      // second pass meets the caches the first filled — warm.
      passes: { type: "string", default: "1" },
      // One line per public search with its query, after the table (YOY-172 AC-5).
      "per-search": { type: "boolean", default: false },
      // Which set to score (YOY-175 AC-4): simple, hard or all.
      "set-name": { type: "string", default: "all" },
    },
  });
  const setName = values["set-name"];
  if (setName !== "all" && !(SCORE_SET_NAMES as readonly string[]).includes(setName)) {
    err("score run: --set-name must be simple, hard or all");
    return 2;
  }
  const hidden = values["hidden-set"] !== undefined;
  if (hidden && values["per-search"]) {
    // A hidden run prints the index alone (YOY-172 NG-4): refused before any call.
    err("score run: --per-search prints query text and is refused with --hidden-set");
    return 1;
  }
  const passes = Number(values.passes);
  if (!Number.isInteger(passes) || passes < 1 || passes > 3) {
    err("score run: --passes must be 1, 2 or 3");
    return 2;
  }
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
  // The sets to score, in order (YOY-175 AC-4): an entry without `set` is simple.
  const sets: [ScoreSetName, ScoreSetEntry[]][] = SCORE_SET_NAMES.filter(
    (name) => setName === "all" || setName === name,
  )
    .map((name): [ScoreSetName, ScoreSetEntry[]] => [name, set.filter((entry) => setOf(entry) === name)])
    .filter(([, entries]) => entries.length > 0);
  if (sets.length === 0) {
    err(`score run: the set file holds no ${setName} searches`);
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
    const { result: reports } = await withCapturedConsole(async () => {
      await importScoreFixture(db, fixture);
      let orchestrator: SearchOrchestrator;
      let grader: LlmClient;
      let flushLedger: (() => Promise<void>) | undefined;
      if (values.synthetic) {
        orchestrator = createSyntheticOrchestrator(db);
        grader = await createSyntheticGrader(orchestrator, set);
      } else {
        const { createProxySearchOrchestrator } = await import("../search/proxy.server");
        const { createPrismaCostRecorder, createQueuedCostRecorder } = await import(
          "../ai/cost-recorder.server"
        );
        // The run reads its spend from this ledger (AC-10): it owns the
        // pipeline's queued recorder so it can flush it first.
        const searchLedger = createQueuedCostRecorder(createPrismaCostRecorder(db));
        orchestrator = createProxySearchOrchestrator(db, {
          costRecorder: searchLedger,
          requestTimeoutMs: RUNNER_CALL_TIMEOUT_MS,
        });
        grader = await flashLite(createPrismaCostRecorder(db));
        flushLedger = searchLedger.flush;
      }
      // Each set is scored apart and reports its own table (YOY-175 AC-4).
      // Each pass and set reports its own spend and extraction calls: the
      // ledger is cumulative, so each table subtracts what came before it.
      const results: { pass: number; name: ScoreSetName; entries: ScoreSetEntry[]; report: ScoreReport }[] = [];
      let before = { usd: 0, calls: 0, extractCalls: 0 };
      passes: for (let pass = 1; pass <= passes; pass += 1) {
        for (const [name, entries] of sets) {
          const report = await runScoreSet({
            db,
            orchestrator,
            grader,
            storeKey: fixture.storeKey,
            set: entries,
            flushLedger,
            // Progress to stderr as each search finishes (YOY-149 runner guard).
            progress: (line) => err(line),
          });
          const extractCalls = report.extractCalls ?? 0;
          results.push({
            pass,
            name,
            entries,
            report: {
              ...report,
              cost: { usd: report.cost.usd - before.usd, calls: report.cost.calls - before.calls },
              extractCalls: extractCalls - before.extractCalls,
            },
          });
          before = { usd: report.cost.usd, calls: report.cost.calls, extractCalls };
          // A run that stopped early scores nothing more.
          if (report.abortedAfter !== undefined) break passes;
        }
      }
      return results;
    });
    // Each table is preceded by its strict `set <name>` line (YOY-175 AC-4),
    // and followed by one line per search (YOY-172 AC-1, AC-5): always on a
    // hidden run, by index alone; on a public run with `--per-search`, with
    // the query. Indices count within the table's own set.
    const printed = ({ name, entries, report }: (typeof reports)[number]) =>
      [
        `set ${name}`,
        formatScoreTable(report),
        ...(hidden
          ? formatGradeLines(report.grades ?? [])
          : values["per-search"]
            ? formatGradeLines(report.grades ?? [], entries)
            : []),
      ].join("\n");
    const lines: string[] = [];
    for (const [index, result] of reports.entries()) {
      if (passes > 1 && (index === 0 || reports[index - 1]!.pass !== result.pass)) {
        lines.push(`pass ${result.pass}`);
      }
      lines.push(printed(result));
    }
    out(lines.join("\n"));
    return reports.some(({ report }) => report.abortedAfter !== undefined) ? 1 : 0;
  } catch (error) {
    // The name only: a message can carry query text.
    err(`score run failed (${(error as Error).name})`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

// --- score-recall (YOY-174) -------------------------------------------------

export async function runRecallCommand(
  argv: readonly string[],
  { out = stdout, err = stderr }: { out?: Output; err?: Output } = {},
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      set: { type: "string" },
      fixture: { type: "string" },
      // Where the truth is read from and written to. `--synthetic` without
      // it builds the truth in memory and writes nothing.
      truth: { type: "string" },
      synthetic: { type: "boolean", default: false },
      // Grade again even though the truth file exists (AC-4).
      "rebuild-truth": { type: "boolean", default: false },
    },
  });
  let searches: ScoreSetEntry[];
  try {
    searches = recallSearches(
      JSON.parse(readFileSync(values.set ?? DEFAULT_PUBLIC_SET_PATH, "utf8")) as ScoreSetEntry[],
    );
  } catch {
    err("score recall: the set file is missing or unreadable");
    return 1;
  }
  let fixture: ScoreFixture;
  try {
    fixture = values.synthetic
      ? buildSyntheticFixture()
      : readFixtureFile(values.fixture ?? DEFAULT_FIXTURE_PATH);
  } catch {
    err("score recall: the fixture is missing or unreadable — pass --fixture");
    return 1;
  }
  const truthPath = values.truth ?? (values.synthetic ? undefined : DEFAULT_RECALL_TRUTH_PATH);
  const reuse = truthPath !== undefined && existsSync(truthPath) && !values["rebuild-truth"];

  const db = await createScratchDb();
  try {
    const { result } = await withCapturedConsole(async () => {
      await importScoreFixture(db, fixture);
      const { createPrismaCostRecorder } = await import("../ai/cost-recorder.server");
      const lines: string[] = [];
      let truth: RecallTruth;
      if (reuse) {
        // The truth exists: no grading call (AC-4).
        truth = JSON.parse(readFileSync(truthPath, "utf8")) as RecallTruth;
        lines.push(`${truthLine(truth)}, read from file`);
      } else {
        const build = await buildRecallTruth({
          db,
          llm: values.synthetic
            ? createSyntheticRecallGrader()
            : await flashLite(createPrismaCostRecorder(db)),
          storeKey: fixture.storeKey,
          searches,
          readCost: () => readRunCost(db),
          progress: (line) => err(line),
        });
        truth = build.truth;
        if (truthPath !== undefined) {
          writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`);
        }
        lines.push(
          `${truthLine(truth)}${truthPath === undefined ? ", not written" : ", written"}`,
          // The build's own spend, before the find step's embeddings.
          `truth ${formatCostLine(build.cost)}`,
        );
      }
      const find = values.synthetic
        ? createSyntheticFindStep(db)
        : await liveFindStep(db, createPrismaCostRecorder(db));
      const rows = await measureRecall({ db, find, storeKey: fixture.storeKey, truth });
      lines.push(
        ...rows.map((row, index) => formatRecallLine(row, index)),
        ...languageRecall(rows).map(formatLanguageRecallLine),
        formatCostLine(await readRunCost(db)),
      );
      return { code: 0, lines };
    });
    out(result.lines.join("\n"));
    return result.code;
  } catch (error) {
    // The name only: a message can carry query text.
    err(`score recall failed (${(error as Error).name})`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

/** The truth's first line: its size, and `partial` when the cost cap stopped the build. */
function truthLine(truth: RecallTruth): string {
  const partial = truth.partial
    ? `, partial (cost cap $${RECALL_COST_CAP_USD.toFixed(2)}): ${truth.searches.length} of ${truth.searchesPlanned} searches graded`
    : "";
  return `truth ${truth.searches.length} searches, built ${truth.builtAt}${partial}`;
}

/** The find step as production builds it (YOY-174 AC-2): Gemini embeddings, the production find-set size. */
async function liveFindStep(db: PrismaClient, costRecorder: CostRecorder): Promise<FindStep> {
  const { createGeminiEmbeddingClient, geminiModelsFromEnv } = await import(
    "@unfiltered/provider-gemini"
  );
  const { createPgTrgmClassicStore } = await import("../search/classic-store.server");
  const { createFindStep, findSetSizeFromEnv } = await import("../search/find.server");
  const models = geminiModelsFromEnv();
  return createFindStep({
    db,
    embeddings: createGeminiEmbeddingClient({
      modelId: models.embeddingModel,
      dimension: models.embeddingDimension,
      costRecorder,
    }),
    classicStore: createPgTrgmClassicStore(db),
    findSetSize: findSetSizeFromEnv(),
  });
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
      `fixture: ${fixture.products.length} products, ${fixture.enrichments.length} enrichments, ${fixture.embeddings.length} embeddings, ${fixture.variants?.length ?? 0} variants, ${fixture.cards?.length ?? 0} cards, ${fixture.cardEmbeddings?.length ?? 0} card vectors (ingested ${fixture.ingestedAt})`,
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
