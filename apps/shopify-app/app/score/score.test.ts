import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient, StructuredCompletionRequest } from "@unfiltered/engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  calibrate,
  calibrateCommand,
  DEFAULT_FIXTURE_PATH,
  leakCheckCommand,
  readFixtureFile,
  REPO_ROOT,
  runScoreCommand,
  writeFixtureFile,
} from "./cli.server";
import { exportScoreFixture, importScoreFixture } from "./fixture.server";
import {
  gradeAgreement,
  gradeSearch,
  SCORE_GRADE_OPERATION,
  SCORE_RUBRIC,
  searchScore,
} from "./grade.server";
import { findLeaks } from "./leak.server";
import { formatScoreTable, runScoreSet } from "./run.server";
import {
  buildScoreSet,
  decodeHiddenSet,
  detectLanguage,
  encodeHiddenSet,
  exportLogQueries,
  fillerShapeCounts,
  HIDDEN_MAX_BYTES,
  isInsideDirectory,
  SCORE_LANGUAGES,
  ScoreSetRefusal,
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
  SYNTHETIC_STORE_KEY,
} from "./synthetic.server";

// Most tests build one or two PGlite databases (migrations included) inside
// the test body; under a full parallel run that alone can pass 5 s.
vi.setConfig({ testTimeout: 30_000 });

/** A grader that records its requests and answers a fixed grade per result. */
function fakeGrader(grade = 2): { llm: LlmClient; requests: StructuredCompletionRequest[] } {
  const requests: StructuredCompletionRequest[] = [];
  return {
    requests,
    llm: {
      async completeStructured(request) {
        requests.push(request);
        const count = (request.prompt.match(/^\d+\. /gm) ?? []).length;
        return { grades: Array.from({ length: count }, () => grade) };
      },
    },
  };
}

async function buildSyntheticSet(): Promise<ScoreSetEntry[]> {
  const db = await createTestDb();
  await seedSyntheticSearchLog(db);
  const logQueries = await exportLogQueries(db, [SYNTHETIC_STORE_KEY]);
  return buildScoreSet({ logQueries, llm: createSyntheticFillerLlm() });
}

describe("language detection (AC-1)", () => {
  it("files a search by script class alone", () => {
    expect(detectLanguage("black dress")).toBe("en");
    expect(detectLanguage("robe noire")).toBe("en");
    expect(detectLanguage("vestido negro")).toBe("en");
    expect(detectLanguage("שמלה שחורה")).toBe("he");
    expect(detectLanguage("Nike שחור")).toBe("he");
    expect(detectLanguage("فستان أسود")).toBe("ar");
    expect(detectLanguage("чёрное платье")).toBe("ru");
  });
});

describe("the set builder (AC-1, AC-2)", () => {
  it("exports the log de-duplicated on normalized text, oldest first", async () => {
    const db = await createTestDb();
    await seedSyntheticSearchLog(db);
    const queries = await exportLogQueries(db, [SYNTHETIC_STORE_KEY]);
    expect(queries.map((entry) => entry.query)).toEqual([
      "linen shirt",
      "black dress",
      "warm wool sweater for winter",
      "שמלה שחורה",
      "חולצת פשתן",
      "льняная рубашка",
    ]);
    expect(queries.every((entry) => entry.storeKey === SYNTHETIC_STORE_KEY)).toBe(true);
    expect(await exportLogQueries(db, ["playground:other"])).toEqual([]);
  });

  it("fills every language to exactly 25, log first, filler in the 60/30/10 shape", async () => {
    const set = await buildSyntheticSet();
    expect(set).toHaveLength(150);
    for (const language of SCORE_LANGUAGES) {
      expect(set.filter((entry) => entry.language === language)).toHaveLength(25);
    }
    const en = set.filter((entry) => entry.language === "en");
    expect(en.slice(0, 3).map((entry) => entry.source)).toEqual(["log", "log", "log"]);
    expect(en.slice(3).every((entry) => entry.source === "model")).toBe(true);
    // ar has no log entry; fr and es are never taken from the log.
    for (const language of ["ar", "fr", "es"] as const) {
      const entries = set.filter((entry) => entry.language === language);
      expect(entries.every((entry) => entry.modelWritten && entry.source === "model")).toBe(true);
    }
    for (const language of ["en", "he", "ru"] as const) {
      expect(set.filter((entry) => entry.language === language).every((entry) => !entry.modelWritten)).toBe(true);
    }
    const fr = set.filter((entry) => entry.language === "fr").map((entry) => entry.query);
    expect(fr.filter((query) => query.includes(" short ")).length).toBe(15);
    expect(fr.filter((query) => query.includes(" medium ")).length).toBe(7);
    expect(fr.filter((query) => query.includes(" long ")).length).toBe(3);
  });

  it("shapes filler 60 / 30 / 10 at any remainder", () => {
    expect(fillerShapeCounts(25)).toEqual({ short: 15, medium: 7, long: 3 });
    expect(fillerShapeCounts(22)).toEqual({ short: 13, medium: 7, long: 2 });
    expect(fillerShapeCounts(1)).toEqual({ short: 1, medium: 0, long: 0 });
    expect(fillerShapeCounts(0)).toEqual({ short: 0, medium: 0, long: 0 });
  });

  it("asks again when the filler repeats a search already taken", async () => {
    // 23 English log searches leave 2 to fill: one short, one medium.
    const shortAnswers = [["linen shirt"], ["wool coat"]];
    const llm: LlmClient = {
      async completeStructured(request) {
        const descriptor = /^Query: filler (\S+) (\S+) (\d+)$/m.exec(request.prompt)!;
        const [, language, shape, count] = descriptor;
        if (language === "en" && shape === "short") return { searches: shortAnswers.shift() };
        if (language === "en" && shape === "medium") return { searches: ["silk scarf"] };
        return {
          searches: Array.from({ length: Number(count) }, (_, index) => `${language} ${shape} ${index}`),
        };
      },
    };
    const set = await buildScoreSet({
      logQueries: Array.from({ length: 23 }, (_, index) => ({
        query: index === 0 ? "Linen Shirt" : `log search ${index}`,
        storeKey: SYNTHETIC_STORE_KEY,
        date: new Date(0),
      })),
      llm,
    });
    const en = set.filter((entry) => entry.language === "en").map((entry) => entry.query);
    expect(en.slice(23)).toEqual(["wool coat", "silk scarf"]);
    expect(shortAnswers).toEqual([]);
  });
});

describe("the split (AC-3)", () => {
  it("splits each language 13 public / 12 hidden, reproducibly", async () => {
    const set = await buildSyntheticSet();
    const first = splitScoreSet(set);
    const second = splitScoreSet(set);
    expect(first).toEqual(second);
    expect(first.publicSet).toHaveLength(78);
    expect(first.hiddenSet).toHaveLength(72);
    for (const language of SCORE_LANGUAGES) {
      expect(first.publicSet.filter((entry) => entry.language === language)).toHaveLength(13);
      expect(first.hiddenSet.filter((entry) => entry.language === language)).toHaveLength(12);
    }
    const halves = new Set([...first.publicSet, ...first.hiddenSet].map((entry) => entry.query));
    expect(halves.size).toBe(150);
    expect(splitScoreSet(set, 7).publicSet).not.toEqual(first.publicSet);
  });

  it("writes the public half as JSON and the hidden half base64-encoded", async () => {
    const { publicSet, hiddenSet } = splitScoreSet(await buildSyntheticSet());
    const dir = mkdtempSync(join(tmpdir(), "score-set-"));
    writeScoreSets({
      publicSet,
      hiddenSet,
      publicPath: join(dir, "public-set.json"),
      hiddenPath: join(dir, "hidden.b64"),
      repoRoot: REPO_ROOT,
    });
    expect(JSON.parse(readFileSync(join(dir, "public-set.json"), "utf8"))).toEqual(publicSet);
    const encoded = readFileSync(join(dir, "hidden.b64"), "utf8");
    expect(encoded).not.toContain("synthetic");
    expect(decodeHiddenSet(encoded)).toEqual(hiddenSet);
  });

  it("refuses a hidden path inside the repository and writes nothing", async () => {
    const { publicSet, hiddenSet } = splitScoreSet(await buildSyntheticSet());
    const dir = mkdtempSync(join(tmpdir(), "score-set-"));
    const publicPath = join(dir, "public-set.json");
    const hiddenPath = join(REPO_ROOT, "apps", "shopify-app", "hidden.b64");
    expect(() =>
      writeScoreSets({ publicSet, hiddenSet, publicPath, hiddenPath, repoRoot: REPO_ROOT }),
    ).toThrow(ScoreSetRefusal);
    expect(existsSync(publicPath)).toBe(false);
    expect(existsSync(hiddenPath)).toBe(false);
    expect(isInsideDirectory(REPO_ROOT, REPO_ROOT)).toBe(true);
    expect(isInsideDirectory(join(REPO_ROOT, "..", "elsewhere.b64"), REPO_ROOT)).toBe(false);
  });

  it("refuses an encoded hidden file of 48 KB or more and writes nothing", () => {
    const big: ScoreSetEntry[] = Array.from({ length: 400 }, (_, index) => ({
      query: `${"long vague search ".repeat(6)}${index}`,
      language: "en",
      source: "model",
      modelWritten: true,
    }));
    expect(Buffer.byteLength(encodeHiddenSet(big))).toBeGreaterThanOrEqual(HIDDEN_MAX_BYTES);
    const dir = mkdtempSync(join(tmpdir(), "score-set-"));
    expect(() =>
      writeScoreSets({
        publicSet: [],
        hiddenSet: big,
        publicPath: join(dir, "public-set.json"),
        hiddenPath: join(dir, "hidden.b64"),
        repoRoot: REPO_ROOT,
      }),
    ).toThrow(/48|49152/);
    expect(existsSync(join(dir, "public-set.json"))).toBe(false);
    expect(existsSync(join(dir, "hidden.b64"))).toBe(false);
  });
});

describe("the grader (AC-4)", () => {
  it("makes one Flash-Lite call per search at temperature 0 with the rubric", async () => {
    const { llm, requests } = fakeGrader(3);
    const grades = await gradeSearch({
      llm,
      query: "linen shirt",
      results: Array.from({ length: 8 }, (_, index) => ({ title: `Shirt ${index}` })),
    });
    expect(grades).toEqual([3, 3, 3, 3, 3, 3]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.operation).toBe(SCORE_GRADE_OPERATION);
    expect(requests[0]!.temperature).toBe(0);
    expect(requests[0]!.prompt).toContain(SCORE_RUBRIC);
    expect(requests[0]!.prompt).toMatch(/^Query: linen shirt$/m);
  });

  it("makes no call for a search with no results", async () => {
    const { llm, requests } = fakeGrader();
    expect(await gradeSearch({ llm, query: "nothing", results: [] })).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("rejects an answer of the wrong length or out of range", async () => {
    const results = [{ title: "A" }, { title: "B" }];
    const answering = (grades: unknown): LlmClient => ({ completeStructured: async () => ({ grades }) });
    await expect(gradeSearch({ llm: answering([3]), query: "q", results })).rejects.toThrow();
    await expect(gradeSearch({ llm: answering([3, 4]), query: "q", results })).rejects.toThrow();
    await expect(gradeSearch({ llm: answering([3, 1.5]), query: "q", results })).rejects.toThrow();
  });

  it("commits the prompt's rubric verbatim in docs/SCORE.md", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "SCORE.md"), "utf8");
    expect(doc).toContain(SCORE_RUBRIC);
    expect(SCORE_RUBRIC).toMatch(/Example, grade 1:/);
    expect(SCORE_RUBRIC).toMatch(/Example, grade 0:/);
  });
});

describe("the scoring math (AC-5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the mean of six grades over 3, missing slots graded 0", () => {
    expect(searchScore([3, 3, 3, 3, 3, 3])).toBe(1);
    expect(searchScore([])).toBe(0);
    expect(searchScore([3, 3, 3])).toBe(0.5);
    expect(searchScore([3, 2, 1, 0, 3, 2])).toBeCloseTo(11 / 18);
  });

  it("rolls searches up per language with count and model-written flag", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = [
      { query: "linen shirt", language: "en", source: "log", modelWritten: false },
      { query: "zzzz qqqq", language: "en", source: "model", modelWritten: false },
      { query: "black dress", language: "fr", source: "model", modelWritten: true },
    ];
    const orchestrator = createSyntheticOrchestrator(db, set);
    const report = await runScoreSet({
      db,
      orchestrator,
      grader: fakeGrader(3).llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set,
    });
    const en = report.languages.find((row) => row.language === "en")!;
    const fr = report.languages.find((row) => row.language === "fr")!;
    expect(en.searches).toBe(2);
    expect(en.modelWritten).toBe(false);
    expect(fr.searches).toBe(1);
    expect(fr.modelWritten).toBe(true);
    // "zzzz qqqq" finds nothing: six empty slots score 0.
    expect(en.score).toBeLessThan(fr.score + 1e-9);
    expect(report.languages.map((row) => row.language)).toEqual(["en", "fr"]);
    expect(formatScoreTable(report).split("\n")[0]).toMatch(/^language\s+score\s+searches\s+model-written/);
  });
});

describe("the runner (AC-6, AC-7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches through the playground's function at a 24-result limit", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = [
      { query: "shirt", language: "en", source: "log", modelWritten: false },
    ];
    const orchestrator = createSyntheticOrchestrator(db, set);
    const runSearch = vi.spyOn(orchestrator, "runSearch");
    await runScoreSet({ db, orchestrator, grader: fakeGrader().llm, storeKey: SYNTHETIC_STORE_KEY, set });
    expect(runSearch).toHaveBeenCalledWith({ query: "shirt", shopDomain: SYNTHETIC_STORE_KEY, limit: 24 });
  });

  it("prints the score table only — a marker in the queries never reaches the output", async () => {
    const marker = "ZQX-MARKER-140";
    const set: ScoreSetEntry[] = [
      // A purpose phrase routes to the AI path, whose intent call has no
      // recording: the orchestrator warns with the query in the message.
      { query: `${marker} dress for a wedding`, language: "en", source: "log", modelWritten: false },
      { query: `${marker} linen shirt`, language: "he", source: "model", modelWritten: false },
      { query: `shirt ${marker}`, language: "fr", source: "model", modelWritten: true },
    ];
    const dir = mkdtempSync(join(tmpdir(), "score-run-"));
    const setPath = join(dir, "set.json");
    writeFileSync(setPath, JSON.stringify(set));

    const written: string[] = [];
    const record = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(record);
    vi.spyOn(process.stderr, "write").mockImplementation(record);
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      });
    }

    const code = await runScoreCommand(["--synthetic", "--set", setPath]);
    vi.restoreAllMocks();

    expect(code).toBe(0);
    const output = written.join("");
    expect(output).not.toContain(marker);
    expect(output).toMatch(/^language\s+score/);
    expect(output.trim().split("\n")).toHaveLength(4);
  });

  it("captures the query-bearing warnings a degraded search logs", async () => {
    const marker = "ZQX-MARKER-140";
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = [
      { query: `${marker} dress for a wedding`, language: "en", source: "log", modelWritten: false },
    ];
    const { withCapturedConsole } = await import("./run.server");
    const { captured } = await withCapturedConsole(() =>
      runScoreSet({
        db,
        orchestrator: createSyntheticOrchestrator(db, set),
        grader: fakeGrader().llm,
        storeKey: SYNTHETIC_STORE_KEY,
        set,
      }),
    );
    // The leak the capture exists for: the orchestrator's warning names the query.
    expect(captured.join("\n")).toContain(marker);
  });

  it("captures the console while a run is in flight", async () => {
    const { withCapturedConsole } = await import("./run.server");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { captured } = await withCapturedConsole(async () => {
      console.warn("query text");
    });
    expect(captured).toEqual(["query text"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("grades the synthetic set end to end over replay clients", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = [
      { query: "linen shirt", language: "en", source: "log", modelWritten: false },
    ];
    const orchestrator = createSyntheticOrchestrator(db, set);
    const grader = await createSyntheticGrader(orchestrator, set);
    const report = await runScoreSet({ db, orchestrator, grader, storeKey: SYNTHETIC_STORE_KEY, set });
    expect(report.languages[0]!.failed).toBe(0);
    expect(report.languages[0]!.score).toBeGreaterThan(0);
  });
});

describe("the fixture (AC-8)", () => {
  it("exports and re-imports a synthetic tenant to identical rows", async () => {
    const source = await createTestDb();
    await importScoreFixture(source, buildSyntheticFixture());
    const ingestedAt = new Date("2026-09-15T12:00:00.000Z");
    const exported = await exportScoreFixture(source, SYNTHETIC_STORE_KEY, { ingestedAt });
    expect(exported.ingestedAt).toBe(ingestedAt.toISOString());
    expect(exported.products).toHaveLength(7);
    expect(exported.enrichments).toHaveLength(7);
    expect(exported.embeddings).toHaveLength(7);

    const target = await createTestDb();
    await importScoreFixture(target, JSON.parse(JSON.stringify(exported)));
    const reexported = await exportScoreFixture(target, SYNTHETIC_STORE_KEY, { ingestedAt });
    expect(reexported).toEqual(exported);

    const vectors = async (db: typeof source) =>
      db.$queryRawUnsafe<{ productId: string; embedding: string }[]>(
        `SELECT "productId", "embedding"::text AS "embedding" FROM "ProductEmbedding" ORDER BY "productId"`,
      );
    expect(await vectors(target)).toEqual(await vectors(source));
    expect(exported.products[0]).not.toHaveProperty("id");
  });

  it("exports nothing of another store key", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const exported = await exportScoreFixture(db, "playground:other");
    expect(exported.products).toEqual([]);
    expect(exported.embeddings).toEqual([]);
  });
});

describe("calibration (AC-9)", () => {
  it("computes exact and within-one agreement as percentages", () => {
    expect(
      gradeAgreement([
        { hand: 3, model: 3 },
        { hand: 2, model: 3 },
        { hand: 0, model: 2 },
        { hand: 1, model: 1 },
      ]),
    ).toEqual({ pairs: 4, exact: 50, withinOne: 75 });
    expect(gradeAgreement([])).toEqual({ pairs: 0, exact: 0, withinOne: 0 });
  });

  it("grades the hand-graded results and prints the agreement", async () => {
    const entries = [
      { query: "linen shirt", results: [{ title: "Linen Shirt" }, { title: "Wool Sweater" }], grades: [2, 0] },
    ];
    expect(await calibrate({ entries, llm: fakeGrader(2).llm })).toEqual({
      pairs: 2,
      exact: 50,
      withinOne: 50,
    });
    const dir = mkdtempSync(join(tmpdir(), "score-cal-"));
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(entries));
    const lines: string[] = [];
    const code = await calibrateCommand(["--file", join(dir, "calibration.json")], {
      out: (text) => lines.push(text),
      llm: fakeGrader(2).llm,
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      "calibration: 2 graded results · exact agreement 50.0% · within one 50.0%",
    ]);
  });
});

describe("the hidden run's leak check (YOY-141 AC-3)", () => {
  const hidden: ScoreSetEntry[] = [
    { query: "ZQX hidden linen shirt", language: "en", source: "log", modelWritten: false },
    { query: "שמלה סודית", language: "he", source: "log", modelWritten: false },
    // One-word searches that collide with the table's own words.
    { query: "score", language: "en", source: "model", modelWritten: false },
    { query: "en", language: "en", source: "model", modelWritten: false },
  ];
  const table = formatScoreTable({
    languages: [
      { language: "en", score: 0.5, searches: 12, modelWritten: false, underOneSecond: 0.5, failed: 0 },
      { language: "he", score: 0.25, searches: 12, modelWritten: false, underOneSecond: 1, failed: 1 },
    ],
  });

  it("passes a clean score table, even when hidden searches are table words", () => {
    expect(findLeaks(`${table}\n`, hidden)).toEqual({ leaked: 0 });
  });

  it("counts every hidden query found outside the table, case-insensitively", () => {
    const output = `${table}\n[search] intent extraction failed {"query":"zqx HIDDEN linen shirt"}\nשמלה סודית\n`;
    expect(findLeaks(output, hidden)).toEqual({ leaked: 2 });
  });

  it("fails the command on a leak and prints no query text", () => {
    const dir = mkdtempSync(join(tmpdir(), "score-leak-"));
    const hiddenPath = join(dir, "hidden.b64");
    const outputPath = join(dir, "output.txt");
    writeFileSync(hiddenPath, encodeHiddenSet(hidden));

    const lines: string[] = [];
    const sinks = { out: (text: string) => lines.push(text), err: (text: string) => lines.push(text) };

    writeFileSync(outputPath, `warning: ZQX hidden linen shirt\n${table}\n`);
    expect(leakCheckCommand(["--hidden-set", hiddenPath, "--output", outputPath], sinks)).toBe(1);
    writeFileSync(outputPath, `${table}\n`);
    expect(leakCheckCommand(["--hidden-set", hiddenPath, "--output", outputPath], sinks)).toBe(0);

    const printed = lines.join("\n");
    for (const entry of hidden.slice(0, 2)) {
      expect(printed).not.toContain(entry.query);
    }
    expect(lines[0]).toMatch(/^leak check FAILED: 1 hidden query appears/);
    expect(lines[1]).toBe("leak check: no hidden query in the output (4 checked)");
  });

  it("fails when the inputs are unreadable", () => {
    const lines: string[] = [];
    expect(
      leakCheckCommand(["--hidden-set", "/nonexistent/h.b64", "--output", "/nonexistent/o.txt"], {
        err: (text) => lines.push(text),
      }),
    ).toBe(1);
    expect(leakCheckCommand([], { err: (text) => lines.push(text) })).toBe(2);
  });
});

describe("gzipped fixtures (YOY-141 AC-4)", () => {
  it("writes and reads a .json.gz fixture, and plain JSON otherwise", () => {
    const fixture = buildSyntheticFixture();
    const dir = mkdtempSync(join(tmpdir(), "score-fixture-"));
    writeFixtureFile(join(dir, "seed.json.gz"), fixture);
    writeFixtureFile(join(dir, "seed.json"), fixture);
    expect(readFileSync(join(dir, "seed.json.gz")).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(readFixtureFile(join(dir, "seed.json.gz"))).toEqual(fixture);
    expect(readFixtureFile(join(dir, "seed.json"))).toEqual(fixture);
    expect(DEFAULT_FIXTURE_PATH.endsWith("seed-fixture.json.gz")).toBe(true);
  });
});

describe("the score workflow (YOY-141 AC-1, AC-2)", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "score.yml"), "utf8");
  const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));

  it("triggers on workflow_dispatch only, with a ref input defaulting to main", () => {
    expect(triggers).toMatch(/^\s+workflow_dispatch:$/m);
    expect(triggers).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
    expect(triggers).toMatch(/ref:\n(?:\s+.*\n)*?\s+default: main/);
  });

  it("leaves ci.yml on pull_request with no score job", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/^on:\n\s+pull_request:/m);
    expect(ci).not.toContain("score-run");
  });

  it("checks for leaks before it prints, and runs on the hidden half with the API key", () => {
    const run = workflow.indexOf("scripts/score-run.mts --hidden-set");
    const check = workflow.indexOf("scripts/score-leak-check.mts");
    const print = workflow.indexOf('cat "$RUNNER_TEMP/score-output.txt"');
    expect(run).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(run);
    expect(print).toBeGreaterThan(check);
    expect(workflow).toContain("GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}");
    expect(workflow).toContain("HIDDEN_SET_B64: ${{ secrets.HIDDEN_SET_B64 }}");
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
  });
});
