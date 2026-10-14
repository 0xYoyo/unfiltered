import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient, StructuredCompletionRequest } from "@unfiltered/engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  calibrate,
  calibrateCommand,
  DEFAULT_CALIBRATION_PATH,
  DEFAULT_FIXTURE_PATH,
  DEFAULT_PUBLIC_SET_PATH,
  type CalibrationEntry,
  leakCheckCommand,
  readFixtureFile,
  buildSetCommand,
  REPO_ROOT,
  runRecallCommand,
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
import {
  buildRecallTruth,
  languageRecall,
  RECALL_BATCH_SIZE,
  RECALL_COST_CAP_USD,
  RECALL_OPERATION,
  recallSearches,
  searchRecall,
  type RecallTruth,
} from "./recall.server";
import {
  descriptionExcerpt,
  failureClassName,
  formatCostLine,
  formatFailureLine,
  formatGradeLines,
  formatScoreTable,
  graderDetails,
  readRunCost,
  runScoreSet,
} from "./run.server";
import {
  buildHardSet,
  buildScoreSet,
  decodeHiddenSet,
  HARD_KINDS,
  hardFillerPrompt,
  reproduceOldSet,
  RepositoryText,
  repositoryText,
  type LogQuery,
  detectLanguage,
  encodeHiddenSet,
  exportLogQueries,
  fillerShapeCounts,
  HIDDEN_MAX_BYTES,
  isInsideDirectory,
  isShopperShaped,
  LOG_SINCE,
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

  it("fills every language but he to 25, log first, filler in the 60/30/10 shape; he is its log searches only (YOY-175 AC-1)", async () => {
    const set = await buildSyntheticSet();
    expect(set).toHaveLength(25 * 5 + 2);
    for (const language of SCORE_LANGUAGES) {
      expect(set.filter((entry) => entry.language === language)).toHaveLength(language === "he" ? 2 : 25);
    }
    // Hebrew is never filler: the synthetic log holds two Hebrew searches, so he is 2.
    expect(set.filter((entry) => entry.language === "he").every((entry) => entry.source === "log")).toBe(true);
    expect(set.every((entry) => entry.set === "simple")).toBe(true);
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
        date: new Date(Date.UTC(2026, 8, 1)),
      })),
      llm,
    });
    const en = set.filter((entry) => entry.language === "en").map((entry) => entry.query);
    expect(en.slice(23)).toEqual(["wool coat", "silk scarf"]);
    expect(shortAnswers).toEqual([]);
  });
});

describe("shopper-shaped log selection (YOY-141 AC-12)", () => {
  const inEra = new Date(Date.UTC(2026, 8, 1));

  it("keeps a playground-era search of three or more plain characters", () => {
    expect(isShopperShaped({ query: "linen shirt", date: inEra })).toBe(true);
    expect(isShopperShaped({ query: "  top  ", date: LOG_SINCE })).toBe(true);
  });

  it("drops a search submitted before 2026-08-10", () => {
    expect(isShopperShaped({ query: "snowboard", date: new Date(Date.UTC(2026, 7, 9, 23, 59)) })).toBe(false);
  });

  it("drops a search shorter than three characters after trimming", () => {
    for (const query of ["b", "s ", "  xy  "]) {
      expect(isShopperShaped({ query, date: inEra })).toBe(false);
    }
  });

  it("drops a search carrying a zero-width format character", () => {
    for (const character of ["\u200B", "\u200C", "\u200D", "\u2060"]) {
      expect(isShopperShaped({ query: `black dress ${character}`, date: inEra })).toBe(false);
    }
  });

  it("drops the latency probe's committed queries", () => {
    expect(isShopperShaped({ query: "comfortable sneakers for running", date: inEra })).toBe(false);
    expect(isShopperShaped({ query: "Black  Shirt", date: inEra })).toBe(false);
    expect(isShopperShaped({ query: "שמלת קיץ, לא שחורה", date: inEra })).toBe(false);
  });

  it("exports only shopper-shaped searches from the log", async () => {
    const db = await createTestDb();
    const rows: [string, Date][] = [
      ["snowbar", new Date(Date.UTC(2026, 5, 1))],
      ["b", inEra],
      ["jacket", inEra],
      ["linen shirt\u200B\u200C", inEra],
      ["wide leg trousers", inEra],
    ];
    for (const [index, [query, createdAt]] of rows.entries()) {
      await db.searchEvent.create({
        data: {
          searchId: `ac12-${index}`,
          shopDomain: SYNTHETIC_STORE_KEY,
          sessionId: "ac12",
          query,
          route: "classic",
          degraded: false,
          latencyMs: 100,
          resultCount: 1,
          createdAt,
        },
      });
    }
    const queries = await exportLogQueries(db, [SYNTHETIC_STORE_KEY]);
    expect(queries.map((entry) => entry.query)).toEqual(["wide leg trousers"]);
  });

  it("takes a language's newest 25 searches, not its oldest", async () => {
    const logQueries = Array.from({ length: 30 }, (_, index) => ({
      query: `log search ${index}`,
      storeKey: SYNTHETIC_STORE_KEY,
      date: new Date(Date.UTC(2026, 8, 1, 0, index)),
    }));
    const set = await buildScoreSet({ logQueries, llm: createSyntheticFillerLlm() });
    const en = set.filter((entry) => entry.language === "en");
    expect(en).toHaveLength(25);
    expect(en.every((entry) => entry.source === "log")).toBe(true);
    expect(new Set(en.map((entry) => entry.query))).toEqual(
      new Set(Array.from({ length: 25 }, (_, index) => `log search ${index + 5}`)),
    );
  });

  it("fills only from shopper-shaped searches", async () => {
    const logQueries = [
      { query: "snowbar", date: new Date(Date.UTC(2026, 5, 1)) },
      { query: "s", date: inEra },
      { query: "dress", date: inEra },
      { query: "linen shirt", date: inEra },
    ].map((entry) => ({ ...entry, storeKey: SYNTHETIC_STORE_KEY }));
    const set = await buildScoreSet({ logQueries, llm: createSyntheticFillerLlm() });
    const fromLog = set.filter((entry) => entry.source === "log").map((entry) => entry.query);
    expect(fromLog).toEqual(["linen shirt"]);
  });
});

describe("the split (AC-3)", () => {
  it("splits each language ceil(n/2) public / floor(n/2) hidden, reproducibly (YOY-175 AC-1)", async () => {
    const set = await buildSyntheticSet();
    const first = splitScoreSet(set);
    const second = splitScoreSet(set);
    expect(first).toEqual(second);
    expect(first.publicSet).toHaveLength(13 * 5 + 1);
    expect(first.hiddenSet).toHaveLength(12 * 5 + 1);
    for (const language of SCORE_LANGUAGES) {
      expect(first.publicSet.filter((entry) => entry.language === language)).toHaveLength(language === "he" ? 1 : 13);
      expect(first.hiddenSet.filter((entry) => entry.language === language)).toHaveLength(language === "he" ? 1 : 12);
    }
    const halves = new Set([...first.publicSet, ...first.hiddenSet].map((entry) => entry.query));
    expect(halves.size).toBe(25 * 5 + 2);
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

describe("the grader's shopper view (YOY-141 AC-11)", () => {
  it("strips HTML, collapses whitespace and keeps the first 300 characters", () => {
    expect(descriptionExcerpt("<p>Soft&nbsp;linen,\n\n <b>relaxed</b> cut &amp; long sleeves.</p>")).toBe(
      "Soft linen, relaxed cut & long sleeves.",
    );
    expect(descriptionExcerpt(`<div>${"a".repeat(400)}</div>`)).toBe("a".repeat(300));
    expect(descriptionExcerpt("caf&#233; &#x2014; &#99999999; &bogus;")).toBe("café — &#99999999; &bogus;");
    expect(descriptionExcerpt("")).toBe("");
  });

  it("puts the description excerpt, fit, style tags and vision attributes in the grading prompt", async () => {
    const fixture = buildSyntheticFixture();
    const described = fixture.products.find((product) => product.productId === "syn-1")!;
    described.description = `<p>Breathable  <em>linen</em> shirt.</p><ul><li>Relaxed fit</li></ul>${" more".repeat(80)}`;
    const enriched = fixture.enrichments.find((row) => row.productId === "syn-1")!;
    Object.assign(enriched, {
      occasions: ["beach"],
      fit: "relaxed",
      styleTags: ["minimal", "summer"],
      sleeveLength: "long",
      neckline: "collared",
      garmentLength: "hip",
      pattern: "solid",
      materialAppearance: "linen",
    });
    // A product with neither a description nor the added attributes.
    const plain = fixture.products.find((product) => product.productId === "syn-5")!;
    plain.description = "";

    const db = await createTestDb();
    await importScoreFixture(db, fixture);
    const set: ScoreSetEntry[] = [
      { query: "linen shirt", language: "en", source: "log", modelWritten: false },
    ];
    const { llm, requests } = fakeGrader();
    await runScoreSet({
      db,
      orchestrator: createSyntheticOrchestrator(db),
      grader: llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set,
    });
    expect(requests).toHaveLength(1);
    const lines = requests[0]!.prompt.split("\n");
    const detailsAfter = (title: string) =>
      lines[lines.findIndex((line) => new RegExp(`^\\d+\\. ${title} \\(`).test(line)) + 1];

    const excerpt = descriptionExcerpt(described.description);
    expect(excerpt).toHaveLength(300);
    expect(excerpt.startsWith("Breathable linen shirt. Relaxed fit more")).toBe(true);
    expect(detailsAfter("Linen Shirt")).toBe(
      `   shirt · white · beach · fit: relaxed · style: minimal, summer · sleeve length: long · neckline: collared · garment length: hip · pattern: solid · material appearance: linen · description: ${excerpt}`,
    );
    // Today's shape: category · colours (no occasions, nothing added).
    expect(detailsAfter("Black Linen Shirt")).toBe("   shirt · black");
  });

  it("grades a product with nothing to show without a details line", () => {
    expect(graderDetails("", undefined)).toBeUndefined();
    expect(graderDetails("<p> </p>", undefined)).toBeUndefined();
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
    const orchestrator = createSyntheticOrchestrator(db);
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

  it("reads the run's spend from the cost ledger after flushing queued writes (YOY-141 AC-10)", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = [
      { query: "linen shirt", language: "en", source: "log", modelWritten: false },
    ];
    const row = (costUsd: number) => ({
      provider: "gemini",
      modelId: "m",
      operation: "score-grade",
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
    });
    await db.aiCall.create({ data: row(0.0125) });
    let flushed = false;
    const report = await runScoreSet({
      db,
      orchestrator: createSyntheticOrchestrator(db),
      grader: fakeGrader(3).llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set,
      // A write still queued off the hot path when the searches end.
      flushLedger: async () => {
        await db.aiCall.create({ data: row(0.0075) });
        flushed = true;
      },
    });
    expect(flushed).toBe(true);
    expect(report.cost).toEqual({ usd: expect.closeTo(0.02, 10), calls: 2 });
    expect(await readRunCost(await createTestDb())).toEqual({ usd: 0, calls: 0 });
    expect(formatCostLine(report.cost)).toBe("cost $0.0200 over 2 model calls");
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
    const orchestrator = createSyntheticOrchestrator(db);
    const runSearch = vi.spyOn(orchestrator, "runSearch");
    await runScoreSet({ db, orchestrator, grader: fakeGrader().llm, storeKey: SYNTHETIC_STORE_KEY, set });
    expect(runSearch).toHaveBeenCalledWith({ query: "shirt", shopDomain: SYNTHETIC_STORE_KEY, limit: 24 });
  });

  it("prints the score table only — a marker in the queries never reaches the output", async () => {
    const marker = "ZQX-MARKER-140";
    const set: ScoreSetEntry[] = [
      // No query vector is recorded: the find step's embedding fails and the
      // search is served degraded, logging as a live outage would.
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
    // Progress lines go to stderr as the run goes; stdout starts with the
    // set line (YOY-175 AC-4: entries without `set` are simple), then the table.
    expect(output.replace(/^\[\d+\/\d+\] .*\n/gm, "")).toMatch(/^set simple\nlanguage\s+score/);
    // The set line, the header, three language rows, the cost line, the
    // extract-call line, one no-extraction line per language (YOY-171 AC-17)
    // — plus one progress line per search on stderr (YOY-149 runner guard).
    const onePass = output.trim().split("\n");
    const progressLines = onePass.filter((line) => /^\[\d+\/\d+\] /.test(line));
    expect(progressLines.length).toBeGreaterThan(0);
    expect(progressLines.every((line) => / ok$/.test(line))).toBe(true);
    const tableLines = onePass.filter((line) => !/^\[\d+\/\d+\] /.test(line));
    expect(tableLines).toHaveLength(10);
    expect(tableLines.slice(-4)).toEqual([
      "extract calls 0",
      expect.stringMatching(/^no-extraction [a-z]{2} \d+%$/),
      expect.stringMatching(/^no-extraction [a-z]{2} \d+%$/),
      expect.stringMatching(/^no-extraction [a-z]{2} \d+%$/),
    ]);

    written.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(record);
    vi.spyOn(process.stderr, "write").mockImplementation(record);
    const twice = await runScoreCommand(["--synthetic", "--set", setPath, "--passes", "2"]);
    vi.restoreAllMocks();
    expect(twice).toBe(0);
    const lines = written
      .join("")
      .trim()
      .split("\n")
      .filter((line) => !/^\[\d+\/\d+\] /.test(line));
    // Each pass: its header line, then its own table (YOY-149 AC-18).
    expect(lines.filter((line) => /^pass \d$/.test(line))).toEqual(["pass 1", "pass 2"]);
    expect(lines.filter((line) => line.startsWith("language"))).toHaveLength(2);
    expect(await runScoreCommand(["--synthetic", "--set", setPath, "--passes", "4"])).toBe(2);
  });

  it("reports progress per search, stops after five consecutive failures, and times a stuck search out (YOY-149 runner guards)", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = Array.from({ length: 8 }, (_, index) => ({
      query: `QUERY-${index}`,
      language: "en" as const,
      source: "log" as const,
      modelWritten: false,
    }));
    const progress: string[] = [];
    const failing = {
      runSearch: () => Promise.reject(new TypeError("fetch failed")),
    } as unknown as Parameters<typeof runScoreSet>[0]["orchestrator"];
    const report = await runScoreSet({
      db,
      orchestrator: failing,
      grader: fakeGrader(3).llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set,
      progress: (line) => void progress.push(line),
    });
    expect(progress).toEqual([
      "[1/8] en fail search",
      "[2/8] en fail search",
      "[3/8] en fail search",
      "[4/8] en fail search",
      "[5/8] en fail search",
    ]);
    expect(report.abortedAfter).toBe(5);
    expect(report.languages[0]!.searches).toBe(5);
    const table = formatScoreTable(report);
    expect(table.split("\n")).toContain("aborted after 5 consecutive failures");
    expect(table).not.toContain("QUERY-");
    // The leak check reads the guard lines as table lines, not query text.
    expect(findLeaks(`${progress.join("\n")}\n${table}\n`, set)).toEqual({ leaked: 0 });

    const stuck = {
      runSearch: () => new Promise(() => undefined),
    } as unknown as Parameters<typeof runScoreSet>[0]["orchestrator"];
    const timed = await runScoreSet({
      db,
      orchestrator: stuck,
      grader: fakeGrader(3).llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set: set.slice(0, 1),
      searchTimeoutMs: 20,
    });
    expect(timed.failures).toEqual([{ stage: "search", className: "ScoreSearchTimeout", count: 1 }]);
  });

  it("captures the warnings a degraded search logs, which never name the query", async () => {
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
        orchestrator: createSyntheticOrchestrator(db),
        grader: fakeGrader().llm,
        storeKey: SYNTHETIC_STORE_KEY,
        set,
      }),
    );
    // The find step's warning is captured, not printed — and it names the
    // error class only, never the query.
    expect(captured.join("\n")).toContain("find step vector half failed");
    expect(captured.join("\n")).not.toContain(marker);
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
    const orchestrator = createSyntheticOrchestrator(db);
    const grader = await createSyntheticGrader(orchestrator, set);
    const report = await runScoreSet({ db, orchestrator, grader, storeKey: SYNTHETIC_STORE_KEY, set });
    expect(report.languages[0]!.failed).toBe(0);
    expect(report.languages[0]!.score).toBeGreaterThan(0);
  });
});

describe("per-search lines (YOY-172 AC-1, AC-5, AC-7)", () => {
  const marker = "ZQX-MARKER-172";
  const set: ScoreSetEntry[] = [
    { query: `${marker} linen shirt`, language: "en", source: "log", modelWritten: false },
    { query: `${marker} black dress`, language: "he", source: "log", modelWritten: false },
    { query: `shirt ${marker}`, language: "fr", source: "model", modelWritten: true },
  ];

  /** Run the score command in-process; stdout and stderr lines apart. */
  async function run(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runScoreCommand(argv, {
      out: (text) => void out.push(...text.split("\n")),
      err: (text) => void err.push(text),
    });
    return { code, out, err };
  }

  it("ends a hidden run with one grade line per search, by index and never with query text (AC-1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "score-grades-"));
    const hiddenPath = join(dir, "hidden.b64");
    writeFileSync(hiddenPath, encodeHiddenSet(set));

    const { code, out, err } = await run(["--synthetic", "--hidden-set", hiddenPath]);

    expect(code).toBe(0);
    const grades = out.filter((line) => line.startsWith("grade "));
    expect(grades).toHaveLength(set.length);
    // A hidden run never prints the served titles (YOY-173 AC-5).
    expect(out.filter((line) => line.startsWith("title "))).toEqual([]);
    // After the table and its no-extraction lines, in set order.
    expect(out.slice(-set.length)).toEqual(grades);
    expect(out.indexOf(grades[0]!)).toBeGreaterThan(
      out.map((line) => line.startsWith("no-extraction ")).lastIndexOf(true),
    );
    expect(grades.map((line) => line.split(" ").slice(0, 3).join(" "))).toEqual([
      "grade en 0",
      "grade he 1",
      "grade fr 2",
    ]);
    for (const line of grades) {
      expect(line).toMatch(/^grade (en|he|ar|ru|fr|es) \d+ (\d\.\d{3}|failed)$/);
    }
    const output = [...err, ...out].join("\n");
    expect(output).not.toContain(marker);
    expect(findLeaks(`${output}\n`, set)).toEqual({ leaked: 0 });
  });

  it("prints public lines with the query only under --per-search (AC-5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "score-grades-"));
    const setPath = join(dir, "set.json");
    writeFileSync(setPath, JSON.stringify(set));

    const plain = await run(["--synthetic", "--set", setPath]);
    expect(plain.code).toBe(0);
    expect(plain.out.filter((line) => line.startsWith("grade "))).toEqual([]);
    expect(plain.out.filter((line) => line.startsWith("title "))).toEqual([]);

    const perSearch = await run(["--synthetic", "--set", setPath, "--per-search"]);
    expect(perSearch.code).toBe(0);
    const grades = perSearch.out.filter((line) => line.startsWith("grade "));
    expect(grades).toEqual([
      expect.stringMatching(new RegExp(`^grade en 0 \\d\\.\\d{3} ${marker} linen shirt$`)),
      expect.stringMatching(new RegExp(`^grade he 1 \\d\\.\\d{3} ${marker} black dress$`)),
      expect.stringMatching(new RegExp(`^grade fr 2 \\d\\.\\d{3} shirt ${marker}$`)),
    ]);
    // Each grade line is followed by its search's served titles (YOY-173
    // AC-5): `title <lang> <index> <position> <title>`, position 1-based.
    const tail = perSearch.out.slice(perSearch.out.indexOf(grades[0]!));
    expect(tail.every((line) => line.startsWith("grade ") || line.startsWith("title "))).toBe(true);
    const titles = tail.filter((line) => line.startsWith("title "));
    expect(titles.length).toBeGreaterThan(0);
    for (const line of titles) expect(line).toMatch(/^title (en|he|fr) [0-2] [1-6] \S/);
    for (const [index, grade] of grades.entries()) {
      const own = tail.slice(tail.indexOf(grade) + 1);
      const next = own.findIndex((line) => line.startsWith("grade "));
      const block = next === -1 ? own : own.slice(0, next);
      expect(block.map((line) => line.split(" ").slice(0, 4).join(" "))).toEqual(
        block.map((_, position) => `title ${set[index]!.language} ${index} ${position + 1}`),
      );
    }
  });

  it("refuses --per-search with --hidden-set before reading or calling anything (AC-5)", async () => {
    const { code, out, err } = await run([
      "--synthetic",
      "--hidden-set",
      "/nonexistent/hidden.b64",
      "--per-search",
    ]);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    // The refusal, not the unreadable-file message: nothing was read.
    expect(err).toEqual(["score run: --per-search prints query text and is refused with --hidden-set"]);
  });

  it("prints a failed search as `failed`, from the one formatter both halves use (AC-1, AC-7)", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const failing = {
      runSearch: () => Promise.reject(new TypeError(`fetch failed for ${marker}`)),
    } as unknown as Parameters<typeof runScoreSet>[0]["orchestrator"];
    const report = await runScoreSet({
      db,
      orchestrator: failing,
      grader: fakeGrader().llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set: set.slice(0, 2),
    });
    expect(report.grades).toEqual([
      { language: "en", index: 0, score: null, titles: [] },
      { language: "he", index: 1, score: null, titles: [] },
    ]);
    expect(formatGradeLines(report.grades!)).toEqual(["grade en 0 failed", "grade he 1 failed"]);
    expect(formatGradeLines(report.grades!, set)).toEqual([
      `grade en 0 failed ${marker} linen shirt`,
      `grade he 1 failed ${marker} black dress`,
    ]);
    expect(formatGradeLines([{ language: "ru", index: 11, score: 2 / 3 }])).toEqual(["grade ru 11 0.667"]);
    // Titles print with a set only (YOY-173 AC-5), never on the hidden path.
    const titled = [{ language: "en" as const, index: 0, score: 1, titles: ["Linen shirt", "Oxford shirt"] }];
    expect(formatGradeLines(titled)).toEqual(["grade en 0 1.000"]);
    expect(formatGradeLines(titled, set)).toEqual([
      `grade en 0 1.000 ${marker} linen shirt`,
      "title en 0 1 Linen shirt",
      "title en 0 2 Oxford shirt",
    ]);
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

  it("round-trips variants, cards and card vectors (YOY-144 AC-10)", async () => {
    const source = await createTestDb();
    await importScoreFixture(source, buildSyntheticFixture());
    await source.productVariant.create({
      data: {
        shopDomain: SYNTHETIC_STORE_KEY,
        productId: "syn-1",
        variantId: "syn-1-v1",
        position: 1,
        options: { size: "M", colour: "white" },
        price: 40,
        available: true,
        quantity: 3,
        sourceUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await source.productCard.create({
      data: {
        shopDomain: SYNTHETIC_STORE_KEY,
        productId: "syn-1",
        status: "written",
        facts: "A linen shirt. Material: 100% linen.",
        look: "White, relaxed.",
        read: "Summer, casual.",
        summary: "A white linen shirt.",
        asks: { en: ["linen shirt"], he: ["חולצת פשתן"] },
        cardText: "Facts: A linen shirt.",
        cardTextHash: "card-hash",
        inputHash: "input-hash",
        cardVersion: 1,
        modelId: "gemini-3.5-flash-lite",
        writtenAt: new Date("2026-10-02T09:13:28.046Z"),
      },
    });
    for (const [section, vector] of [["prose", "[0.25,-0.5,1]"], ["asks:en", "[0.125,0.75,-1]"]] as const) {
      await source.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'syn-1', $2, $3, $4::vector(3), CURRENT_TIMESTAMP)`,
        SYNTHETIC_STORE_KEY,
        section,
        `hash-${section}`,
        vector,
      );
    }

    const ingestedAt = new Date("2026-09-15T12:00:00.000Z");
    const exported = await exportScoreFixture(source, SYNTHETIC_STORE_KEY, { ingestedAt });
    expect(exported.version).toBe(2);
    expect(exported.variants).toHaveLength(1);
    expect(exported.cards).toHaveLength(1);
    expect(exported.cardEmbeddings?.map((row) => row.section)).toEqual(["asks:en", "prose"]);
    expect(exported.cards?.[0]).not.toHaveProperty("id");

    const target = await createTestDb();
    await importScoreFixture(target, JSON.parse(JSON.stringify(exported)));
    expect(await exportScoreFixture(target, SYNTHETIC_STORE_KEY, { ingestedAt })).toEqual(exported);
    const cardVectors = async (db: typeof source) =>
      db.$queryRawUnsafe<{ section: string; embedding: string }[]>(
        `SELECT "section", "embedding"::text AS "embedding" FROM "CardEmbedding" ORDER BY "section"`,
      );
    expect(await cardVectors(target)).toEqual(await cardVectors(source));
  });

  it("still imports a version-1 fixture, which has no variants, cards or card vectors", async () => {
    const db = await createTestDb();
    const fixture = buildSyntheticFixture();
    expect(fixture.version).toBe(1);
    expect(fixture).not.toHaveProperty("cards");
    await importScoreFixture(db, fixture);
    expect(await db.catalogProduct.count()).toBe(7);
    expect(await db.productCard.count()).toBe(0);
  });

  it("exports nothing of another store key", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const exported = await exportScoreFixture(db, "playground:other");
    expect(exported.products).toEqual([]);
    expect(exported.embeddings).toEqual([]);
  });
});

describe("failures by stage and class (YOY-141 AC-13)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  class GeminiTimeoutError extends Error {}

  it("names a failure by its constructor, never by its message", () => {
    expect(failureClassName(new GeminiTimeoutError("timed out on: linen shirt"))).toBe("GeminiTimeoutError");
    expect(failureClassName(new TypeError("x"))).toBe("TypeError");
    expect(failureClassName("a thrown string with the query")).toBe("string");
    expect(failureClassName(Object.assign(Object.create(null), { message: "q" }))).toBe("Unnamed");
    const renamed = new Error("q");
    renamed.name = "linen shirt";
    expect(failureClassName(renamed)).toBe("Error");
    expect(formatFailureLine({ stage: "grade", className: "Error", count: 3 })).toBe("failed grade Error 3");
  });

  it("counts failures per (stage, class) and prints them under the cost line, without the message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const marker = "ZQX-MARKER-141";
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = [
      { query: `${marker} linen shirt`, language: "en", source: "log", modelWritten: false },
      { query: `${marker} black dress`, language: "en", source: "log", modelWritten: false },
      { query: `${marker} shirt`, language: "he", source: "log", modelWritten: false },
    ];
    const orchestrator = createSyntheticOrchestrator(db);
    vi.spyOn(orchestrator, "runSearch").mockImplementation(async (request) => {
      throw new GeminiTimeoutError(`timed out on ${request.query}`);
    });
    const failingGrader: LlmClient = {
      completeStructured: async (request: StructuredCompletionRequest) => {
        throw new Error(`bad grades for ${request.prompt}`);
      },
    } as unknown as LlmClient;
    const report = await runScoreSet({
      db,
      orchestrator,
      grader: failingGrader,
      storeKey: SYNTHETIC_STORE_KEY,
      set,
    });
    expect(report.failures).toEqual([{ stage: "search", className: "GeminiTimeoutError", count: 3 }]);
    const table = formatScoreTable(report);
    expect(table.split("\n").at(-1)).toBe("failed search GeminiTimeoutError 3");
    expect(table).not.toContain(marker);
    expect(findLeaks(table, set)).toEqual({ leaked: 0 });

    // The search succeeds and the grader throws: the stage is "grade".
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const graded = await runScoreSet({
      db,
      orchestrator: createSyntheticOrchestrator(db),
      grader: failingGrader,
      storeKey: SYNTHETIC_STORE_KEY,
      set: set.slice(0, 1).map((entry) => ({ ...entry, query: "linen shirt" })),
    });
    expect(graded.failures).toEqual([{ stage: "grade", className: "Error", count: 1 }]);
  });

  it("prints no failure line when nothing failed", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const set: ScoreSetEntry[] = [
      { query: "linen shirt", language: "en", source: "log", modelWritten: false },
    ];
    const report = await runScoreSet({
      db,
      orchestrator: createSyntheticOrchestrator(db),
      grader: fakeGrader(3).llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set,
    });
    expect(report.failures).toEqual([]);
    // The cost line, the extract-call line (YOY-149 AC-18), the language's
    // no-extraction line (YOY-171 AC-17), and no failure line.
    expect(formatScoreTable(report).split("\n").slice(-3)).toEqual([
      expect.stringMatching(/^cost /),
      "extract calls 0",
      expect.stringMatching(/^no-extraction en \d+%$/),
    ]);
  });
});

describe("the committed calibration set (YOY-141 AC-6)", () => {
  it("holds ten public-half en searches with six graded-view results each", () => {
    const calibration = JSON.parse(readFileSync(DEFAULT_CALIBRATION_PATH, "utf8")) as CalibrationEntry[];
    const publicSet = JSON.parse(readFileSync(DEFAULT_PUBLIC_SET_PATH, "utf8")) as ScoreSetEntry[];
    const english = publicSet.filter((entry) => entry.language === "en").map((entry) => entry.query);
    expect(calibration).toHaveLength(10);
    // Public-half en searches, in file order.
    const positions = calibration.map((entry) => english.indexOf(entry.query));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const entry of calibration) {
      expect(entry.results).toHaveLength(6);
      for (const result of entry.results) {
        expect(typeof result.title).toBe("string");
      }
      // Empty until the outside reader's grades are filled in; then 0–3 each.
      expect([0, 6]).toContain(entry.grades.length);
      expect(entry.grades.every((grade) => Number.isInteger(grade) && grade >= 0 && grade <= 3)).toBe(true);
    }
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
      { language: "en", score: 0.5, searches: 12, modelWritten: false, underOneSecond: 0.5, withoutExtraction: 0.25, extractionCached: 0.5, failed: 0 },
      { language: "he", score: 0.25, searches: 12, modelWritten: false, underOneSecond: 1, withoutExtraction: null, extractionCached: null, failed: 1 },
    ],
    cost: { usd: 0.0812, calls: 96 },
    failures: [
      { stage: "search", className: "GeminiTimeoutError", count: 2 },
      { stage: "grade", className: "Error", count: 1 },
    ],
  });

  it("prints the shares composed without the extraction and answered by its cache, a dash when none reported (YOY-149 AC-4, AC-18)", () => {
    const [header, en, he] = table.split("\n");
    expect(header).toMatch(/under 1 s \(local\)\s+no extraction\s+extraction cached\s+failed$/);
    expect(en).toMatch(/\s50%\s+25%\s+50%\s+0$/);
    expect(he).toMatch(/\s100%\s+—\s+—\s+1$/);
  });

  it("skips only strict pass headers and extract-call lines (YOY-149 AC-18)", () => {
    const hiddenWord: ScoreSetEntry[] = [
      { query: "pass", language: "en", source: "model", modelWritten: false },
      { query: "extract", language: "en", source: "model", modelWritten: false },
    ];
    expect(findLeaks("pass 2\nextract calls 0\n", hiddenWord)).toEqual({ leaked: 0 });
    expect(findLeaks("pass the salt\nextract calls for linen\n", hiddenWord)).toEqual({ leaked: 2 });
    expect(formatScoreTable({ languages: [], cost: { usd: 0, calls: 0 }, failures: [], extractCalls: 0 })).toContain(
      "extract calls 0",
    );
  });

  it("prints one no-extraction line per language that reports a share, and the leak check admits only that shape (YOY-171 AC-17)", () => {
    // en reports 25 %; he reports none (an em dash in the table), so no line.
    expect(table.split("\n").filter((line) => line.startsWith("no-extraction"))).toEqual([
      "no-extraction en 25%",
    ]);
    const hiddenWord: ScoreSetEntry[] = [
      { query: "no-extraction", language: "en", source: "model", modelWritten: false },
    ];
    expect(findLeaks("no-extraction en 25%\nno-extraction he 0%\n", hiddenWord)).toEqual({ leaked: 0 });
    expect(findLeaks("no-extraction for linen 25%\n", hiddenWord)).toEqual({ leaked: 1 });
    expect(findLeaks("no-extraction xx 25%\n", hiddenWord)).toEqual({ leaked: 1 });
  });

  it("passes a clean score table, even when hidden searches are table words", () => {
    expect(table.split("\n").slice(-4)).toEqual([
      "cost $0.0812 over 96 model calls",
      "no-extraction en 25%",
      "failed search GeminiTimeoutError 2",
      "failed grade Error 1",
    ]);
    expect(findLeaks(`${table}\n`, hidden)).toEqual({ leaked: 0 });
  });

  it("skips only a strict cost line: a query after it is still found", () => {
    const hiddenCost: ScoreSetEntry[] = [
      { query: "cost", language: "en", source: "model", modelWritten: false },
    ];
    expect(findLeaks("cost $0.0812 over 96 model calls\n", hiddenCost)).toEqual({ leaked: 0 });
    expect(findLeaks("cost $0.0812 over 96 model calls for cost\n", hiddenCost)).toEqual({ leaked: 1 });
  });

  it("skips only a strict failure line: a query in its place is still found", () => {
    const hiddenWord: ScoreSetEntry[] = [
      { query: "linen", language: "en", source: "model", modelWritten: false },
    ];
    expect(findLeaks("failed grade linen 1\n", hiddenWord)).toEqual({ leaked: 0 });
    expect(findLeaks("failed grade linen shirt 1\n", hiddenWord)).toEqual({ leaked: 1 });
    expect(findLeaks("failed linen Error 1\n", hiddenWord)).toEqual({ leaked: 1 });
  });

  it("skips only a strict grade line: the word grade as a hidden query neither false-fails nor leaks (YOY-172 AC-2)", () => {
    const hiddenGrade: ScoreSetEntry[] = [
      { query: "grade", language: "en", source: "model", modelWritten: false },
    ];
    const clean = "grade en 0 0.667\ngrade he 11 failed\ngrade es 3 1.000\n";
    expect(findLeaks(clean, hiddenGrade)).toEqual({ leaked: 0 });
    // The same word anywhere else is still found.
    expect(findLeaks(`${clean}grade\n`, hiddenGrade)).toEqual({ leaked: 1 });
    expect(findLeaks("grade en 0 0.667 grade\n", hiddenGrade)).toEqual({ leaked: 1 });
    // Nothing but the exact shape is admitted: a query on the line, a
    // two-decimal score, an unknown language.
    const hiddenWord: ScoreSetEntry[] = [
      { query: "linen", language: "en", source: "model", modelWritten: false },
    ];
    expect(findLeaks("grade en 0 0.667 linen\n", hiddenWord)).toEqual({ leaked: 1 });
    expect(findLeaks("grade en 0 0.67\n", hiddenGrade)).toEqual({ leaked: 1 });
    expect(findLeaks("grade xx 0 0.667\n", hiddenGrade)).toEqual({ leaked: 1 });
    expect(findLeaks("grade linen 0 0.667\n", hiddenWord)).toEqual({ leaked: 1 });
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

  it("has no engine input: there is one engine (YOY-155 AC-3)", () => {
    expect(triggers).not.toMatch(/^\s+engine:$/m);
    expect(workflow).not.toMatch(/ENGINE_V\d/);
  });

  it("scores with the judge the dispatch names: gemini, jev or none into JUDGE_PROVIDER, jev by default (YOY-152 AC-6; YOY-157 AC-19; YOY-172 AC-3)", () => {
    expect(triggers).toMatch(
      /judge:\n(?:\s+.*\n)*?\s+default: jev\n\s+type: choice\n\s+options:\n\s+- gemini\n\s+- jev\n\s+- none\n/,
    );
    // The settings echo names the choice as given, `none` included.
    expect(workflow).toContain('echo "judge: JUDGE_PROVIDER=$JUDGE_PROVIDER"');
    expect(workflow).toContain("JUDGE_PROVIDER: ${{ inputs.judge }}");
    expect(workflow).toContain("OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}");
  });

  it("gives the judge 4,000 ms on a score run, here and in score:public (YOY-147 AC-18)", () => {
    expect(workflow).toContain('JUDGE_DEADLINE_MS: "4000"');
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "shopify-app", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts["score:public"]).toBe(
      "JUDGE_DEADLINE_MS=4000 npx tsx scripts/score-run.mts",
    );
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

  // The two jobs, by their text: `run` up to `check:`, `check` to the end.
  const runJob = workflow.slice(workflow.indexOf("\n  run:\n"), workflow.indexOf("\n  check:\n"));
  const checkJob = workflow.slice(workflow.indexOf("\n  check:\n"));
  const checkouts = (job: string) => job.match(/actions\/checkout@v4\n\s+with:\n\s+ref: (.*)\n/g) ?? [];

  it("splits the run and the leak check into two jobs that never share a filesystem (YOY-157 AC-2, AC-31)", () => {
    expect(workflow.match(/^ {2}[a-z-]+:\n {4}(?:needs|runs-on):/gm)).toHaveLength(2);
    expect(runJob.length).toBeGreaterThan(0);
    expect(checkJob.length).toBeGreaterThan(0);

    // The scored ref's job: checks out inputs.ref only and never runs the
    // guard, prints the output or writes the job summary.
    expect(checkouts(runJob)).toEqual([expect.stringContaining("ref: ${{ inputs.ref }}")]);
    expect(runJob).toContain("scripts/score-run.mts --hidden-set");
    expect(runJob).not.toContain("score-leak-check.mts");
    expect(runJob).not.toMatch(/\bcat\b/);
    expect(runJob).not.toContain("GITHUB_STEP_SUMMARY");
    expect(runJob).toContain("actions/upload-artifact@v4");

    // The guard's job: checks out the workflow's own commit only, depends on
    // the run, and runs the check before it prints.
    expect(checkJob).toMatch(/^ {4}needs: run$/m);
    expect(checkouts(checkJob)).toEqual([expect.stringContaining("ref: ${{ github.sha }}")]);
    expect(checkJob).not.toContain("score-run.mts");
    expect(checkJob).toContain("actions/download-artifact@v4");
    const check = checkJob.indexOf("scripts/score-leak-check.mts");
    expect(check).toBeGreaterThan(-1);
    expect(checkJob.indexOf('cat "$RUNNER_TEMP/score-output.txt"')).toBeGreaterThan(check);
    expect(checkJob.indexOf("GITHUB_STEP_SUMMARY")).toBeGreaterThan(check);
    expect(workflow.match(/score-leak-check\.mts/g)).toHaveLength(1);

    // Both jobs get the hidden set from the secret.
    expect(runJob).toContain("HIDDEN_SET_B64: ${{ secrets.HIDDEN_SET_B64 }}");
    expect(checkJob).toContain("HIDDEN_SET_B64: ${{ secrets.HIDDEN_SET_B64 }}");
  });

  it("uploads the output encrypted with the hidden-set secret, kept one day, and exits with the run's status", () => {
    expect(runJob).toContain("openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:HIDDEN_SET_B64");
    expect(runJob).toMatch(/path: \$\{\{ runner\.temp \}\}\/score-output\.enc\n\s+retention-days: 1/);
    expect(checkJob).toContain("openssl enc -d -aes-256-cbc -pbkdf2 -pass env:HIDDEN_SET_B64");
    expect(runJob).toContain('echo "run-status=$run_status" >> "$GITHUB_OUTPUT"');
    expect(checkJob).toContain("RUN_STATUS: ${{ needs.run.outputs.run-status }}");
    expect(checkJob).toContain('exit "${RUN_STATUS:-1}"');
  });

  it("prints the GEMINI_ env names before the run, never their values (YOY-141 AC-13)", () => {
    const names = workflow.indexOf("env | cut -d= -f1 | grep -E '^GEMINI_'");
    expect(names).toBeGreaterThan(-1);
    expect(names).toBeLessThan(workflow.indexOf("scripts/score-run.mts --hidden-set"));
  });
});

describe("find recall (YOY-174)", () => {
  const set: ScoreSetEntry[] = [
    { query: "linen shirt", language: "en", source: "log", modelWritten: false },
    { query: "שמלה שחורה", language: "he", source: "log", modelWritten: false },
    { query: "chemise lin", language: "fr", source: "model", modelWritten: true },
  ];

  /** A grader answering grade 3 for products whose title holds "Linen", else 1. */
  function batchGrader(): { llm: LlmClient; requests: StructuredCompletionRequest[] } {
    const requests: StructuredCompletionRequest[] = [];
    return {
      requests,
      llm: {
        async completeStructured(request) {
          requests.push(request);
          const titles = [...request.prompt.matchAll(/^\d+\. (.*)$/gm)].map((match) => match[1]!);
          return { grades: titles.map((title) => (title.includes("Linen") ? 3 : 1)) };
        },
      },
    };
  }

  it("covers the en and he searches only (AC-1)", () => {
    expect(recallSearches(set).map((entry) => entry.language)).toEqual(["en", "he"]);
    expect(RECALL_BATCH_SIZE).toBe(48);
  });

  it("grades every product in batches with the rubric and keeps grades of 2 and up (AC-1)", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const { llm, requests } = batchGrader();
    const build = await buildRecallTruth({
      db,
      llm,
      storeKey: SYNTHETIC_STORE_KEY,
      searches: recallSearches(set),
      readCost: async () => ({ usd: 0, calls: 0 }),
      batchSize: 3,
      now: () => new Date("2026-10-14T00:00:00Z"),
    });
    // Seven products in batches of three: three calls per search.
    expect(requests).toHaveLength(6);
    for (const request of requests) {
      expect(request.operation).toBe(RECALL_OPERATION);
      expect(request.temperature).toBe(0);
      expect(request.prompt.startsWith(SCORE_RUBRIC)).toBe(true);
      // The truth is graded without descriptions.
      expect(request.prompt).not.toContain("from the synthetic score catalog");
    }
    expect(build.truth.partial).toBe(false);
    expect(build.truth.searchesPlanned).toBe(2);
    expect(build.truth.graded).toBe(7);
    expect(build.truth.builtAt).toBe("2026-10-14T00:00:00.000Z");
    // Grade 1 is not relevant; grade 3 is.
    expect(build.truth.searches[0]!.relevant).toEqual([
      { productId: "syn-1", grade: 3 },
      { productId: "syn-4", grade: 3 },
      { productId: "syn-5", grade: 3 },
    ]);
  });

  it("retries a malformed batch answer once", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    let calls = 0;
    const llm: LlmClient = {
      async completeStructured() {
        calls += 1;
        // The first answer is one grade short; the retry answers in full.
        return { grades: calls === 1 ? [3] : Array.from({ length: 7 }, () => 2) };
      },
    };
    const build = await buildRecallTruth({
      db,
      llm,
      storeKey: SYNTHETIC_STORE_KEY,
      searches: recallSearches(set).slice(0, 1),
      readCost: async () => ({ usd: 0, calls }),
    });
    expect(calls).toBe(2);
    expect(build.truth.searches[0]!.relevant).toHaveLength(7);
  });

  it("stops at the cost cap and keeps the searches graded so far, marked partial (spend rule)", async () => {
    const db = await createTestDb();
    await importScoreFixture(db, buildSyntheticFixture());
    const { llm, requests } = batchGrader();
    let usd = 0;
    const build = await buildRecallTruth({
      db,
      llm,
      storeKey: SYNTHETIC_STORE_KEY,
      searches: recallSearches(set),
      // Each call costs a quarter of the cap: the fourth — the second
      // search's first batch — passes it.
      readCost: async () => {
        usd += RECALL_COST_CAP_USD / 4 + 0.001;
        return { usd, calls: requests.length };
      },
      batchSize: 3,
    });
    expect(build.cost).toEqual({ usd, calls: 4 });
    expect(build.truth.partial).toBe(true);
    expect(build.truth.searchesPlanned).toBe(2);
    // The search in progress when the cap passed is dropped.
    expect(build.truth.searches.map((search) => search.query)).toEqual(["linen shirt"]);
  });

  it("counts recall by family, inside the find set and the first page (AC-2)", () => {
    const families: Record<string, string> = { a1: "a", a2: "a", b: "b", c: "c", d: "d" };
    const familyOf = (productId: string) => families[productId] ?? productId;
    const search = {
      query: "q",
      language: "en" as const,
      relevant: [
        { productId: "a2", grade: 3 },
        { productId: "a1", grade: 2 },
        { productId: "c", grade: 2 },
        { productId: "d", grade: 3 },
      ],
    };
    // "a1" is the family's card; "d" is a keyword match beyond the find set
    // but inside the first page; "c" is not found at all.
    const row = searchRecall({ search, productIds: ["b", "a1", "d"], findSetCount: 2, familyOf });
    expect(row).toEqual({
      query: "q",
      language: "en",
      relevant: 3,
      inFindSet: 1,
      recall: 1 / 3,
      inFirstPage: 2,
    });
    const none = searchRecall({ search: { ...search, relevant: [] }, productIds: [], findSetCount: 0, familyOf });
    expect(none.recall).toBeNull();
    expect(languageRecall([row, { ...row, recall: 1 }, { ...none }])).toEqual([
      { language: "en", searches: 3, meanRecall: (1 / 3 + 1) / 2, lowRecall: 1, noneRelevant: 1 },
      { language: "he", searches: 0, meanRecall: null, lowRecall: 0, noneRelevant: 0 },
    ]);
  });

  it("builds and writes the truth once, then reads it without grading unless --rebuild-truth (AC-4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "score-recall-"));
    const setPath = join(dir, "set.json");
    const truthPath = join(dir, "truth.json");
    writeFileSync(setPath, JSON.stringify(set));
    async function run(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runRecallCommand(argv, {
        out: (text) => void out.push(...text.split("\n")),
        err: (text) => void err.push(text),
      });
      return { code, out, err };
    }

    const first = await run(["--synthetic", "--set", setPath, "--truth", truthPath]);
    expect(first.code).toBe(0);
    expect(first.out[0]).toMatch(/^truth 2 searches, built .*, written$/);
    expect(first.out[1]).toBe("truth cost $0.0000 over 0 model calls");
    expect(first.err.filter((line) => line.endsWith(" graded"))).toEqual(["[1/2] en graded", "[2/2] he graded"]);
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as RecallTruth;
    expect(truth.searches.map((search) => search.query)).toEqual(["linen shirt", "שמלה שחורה"]);
    // The synthetic grader keeps titles holding a query word.
    expect(truth.searches[0]!.relevant.map((product) => product.productId)).toEqual(["syn-1", "syn-4", "syn-5", "syn-7"]);
    expect(first.out.filter((line) => line.startsWith("recall "))).toEqual([
      expect.stringMatching(/^recall en 0 relevant 4 in-find-set 0 recall 0\.000 first-24 \d+ linen shirt$/),
      "recall he 1 relevant 0 in-find-set 0 recall — first-24 0 שמלה שחורה",
    ]);
    expect(first.out.slice(-3)).toEqual([
      "recall-mean en 0.000 over 1 of 1 searches, under 0.5 1, none relevant 0",
      "recall-mean he — over 0 of 1 searches, under 0.5 0, none relevant 1",
      "cost $0.0000 over 0 model calls",
    ]);

    // The truth exists: no grading, the same table.
    const second = await run(["--synthetic", "--set", setPath, "--truth", truthPath]);
    expect(second.code).toBe(0);
    expect(second.out[0]).toBe(`truth 2 searches, built ${truth.builtAt}, read from file`);
    expect(second.err.filter((line) => line.endsWith(" graded"))).toEqual([]);
    expect(second.out.slice(1)).toEqual(first.out.slice(2));

    const rebuilt = await run(["--synthetic", "--set", setPath, "--truth", truthPath, "--rebuild-truth"]);
    expect(rebuilt.code).toBe(0);
    expect(rebuilt.out[0]).toMatch(/, written$/);
    expect(rebuilt.err.filter((line) => line.endsWith(" graded"))).toHaveLength(2);
  });

  it("writes nothing under --synthetic without --truth", async () => {
    const out: string[] = [];
    const code = await runRecallCommand(["--synthetic"], { out: (text) => void out.push(text), err: () => {} });
    expect(code).toBe(0);
    // The committed public set's en and he: simple 13 + 38, hard 15 + 15 (YOY-175).
    expect(out.join("\n")).toMatch(/^truth 81 searches, built .*, not written$/m);
  });
});

describe("Hebrew 75, the hard set and per-set tables (YOY-175)", () => {
  /** A log of `count` searches per language, one minute apart, all in the playground era. */
  function log(count: number, start: Date, tag: string): LogQuery[] {
    return (["en", "he"] as const).flatMap((language, offset) =>
      Array.from({ length: count }, (_, index) => ({
        query: language === "he" ? `חיפוש ${tag} ${index}` : `search ${tag} ${index}`,
        storeKey: SYNTHETIC_STORE_KEY,
        date: new Date(start.getTime() + (offset * count + index) * 60_000),
      })),
    );
  }

  it("builds 30 hard searches per language in en and he, the five kinds in equal parts (AC-2)", async () => {
    const simple = await buildSyntheticSet();
    const hard = await buildHardSet({ llm: createSyntheticFillerLlm(), avoid: simple });
    for (const language of ["en", "he"] as const) {
      const own = hard.filter((entry) => entry.language === language);
      expect(own).toHaveLength(30);
      for (const kind of HARD_KINDS) {
        expect(own.filter((entry) => entry.kind === kind)).toHaveLength(6);
      }
    }
    expect(hard.every((entry) => entry.set === "hard" && entry.source === "model" && entry.modelWritten)).toBe(true);
    const simpleQueries = new Set(simple.map((entry) => entry.query));
    expect(hard.some((entry) => simpleQueries.has(entry.query))).toBe(false);
    const prompt = hardFillerPrompt("he", "lookalike", 6, []);
    expect(prompt).toContain("in Hebrew");
    expect(prompt).toContain("look-alike of a well-known fashion brand");
    expect(prompt.endsWith("Query: hard he lookalike 6")).toBe(true);
  });

  it("splits the hard set 15 / 15 per language and leaves the 25-search split unchanged (AC-1, AC-4)", async () => {
    const simple = await buildSyntheticSet();
    const hard = await buildHardSet({ llm: createSyntheticFillerLlm(), avoid: simple });
    const both = splitScoreSet([...simple, ...hard]);
    for (const language of ["en", "he"] as const) {
      const ofHard = (half: ScoreSetEntry[]) => half.filter((entry) => entry.set === "hard" && entry.language === language);
      expect(ofHard(both.publicSet)).toHaveLength(15);
      expect(ofHard(both.hiddenSet)).toHaveLength(15);
    }
    // Adding the hard set moves no simple entry between halves.
    const simpleOnly = splitScoreSet(simple);
    expect(both.publicSet.filter((entry) => entry.set === "simple")).toEqual(simpleOnly.publicSet);
    // en comes first in the shuffle, so en's split is the one a 25-per-language build always gave.
    const old = splitScoreSet(simple.map((entry) => (entry.language === "he" ? { ...entry } : entry)).filter((entry) => entry.language === "en"));
    expect(simpleOnly.publicSet.filter((entry) => entry.language === "en")).toEqual(old.publicSet);
  });

  it("keeps the old en and he 25 when the old public half reproduces, and only then (AC-1)", async () => {
    const cutoff = new Date(Date.UTC(2026, 9, 1, 17, 0));
    const before = log(30, new Date(Date.UTC(2026, 8, 20)), "old");
    const after = log(60, new Date(Date.UTC(2026, 9, 5)), "new");
    // The old build: the newest 25 per language before the cutoff, 13 / 12.
    const oldSet = (["en", "he"] as const).flatMap((language) =>
      before
        .filter((entry) => detectLanguage(entry.query) === language)
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 25)
        .map((entry) => ({ query: entry.query, language, source: "log" as const, modelWritten: false })),
    );
    const previousPublic = splitScoreSet(oldSet).publicSet;
    const results = reproduceOldSet({ logQueries: [...before, ...after], previousPublic, before: cutoff });
    expect(results.map((result) => [result.language, result.reproduced])).toEqual([
      ["en", true],
      ["he", true],
    ]);
    const keep = Object.fromEntries(results.map((result) => [result.language, result.entries!]));
    const set = await buildScoreSet({ logQueries: [...before, ...after], llm: createSyntheticFillerLlm(), keep });
    const he = set.filter((entry) => entry.language === "he");
    expect(he).toHaveLength(75);
    // Every old Hebrew entry is kept, then the 50 newest later log searches; no filler is needed.
    const oldHe = oldSet.filter((entry) => entry.language === "he").map((entry) => entry.query);
    expect(he.slice(0, 25).map((entry) => entry.query)).toEqual(keep.he!.map((entry) => entry.query));
    expect(new Set(he.map((entry) => entry.query))).toEqual(new Set([...oldHe, ...he.slice(25).map((entry) => entry.query)]));
    expect(oldHe.every((query) => he.some((entry) => entry.query === query))).toBe(true);
    expect(he.slice(25).every((entry) => entry.source === "log" && entry.query.includes(" new "))).toBe(true);
    expect(set.filter((entry) => entry.language === "en").map((entry) => entry.query).sort()).toEqual(
      oldSet.filter((entry) => entry.language === "en").map((entry) => entry.query).sort(),
    );

    // One changed public entry: that language is built fresh instead.
    const tampered = previousPublic.map((entry, index) =>
      index === previousPublic.findIndex((candidate) => candidate.language === "he") ? { ...entry, query: "something else" } : entry,
    );
    expect(
      reproduceOldSet({ logQueries: [...before, ...after], previousPublic: tampered, before: cutoff }).map(
        (result) => [result.language, result.reproduced, result.entries === undefined],
      ),
    ).toEqual([
      ["en", true, false],
      ["he", false, true],
    ]);
  });

  it("keeps a reproduced language's old halves and shuffles only the added searches: 38 / 37 (AC-1, amended)", async () => {
    const cutoff = new Date(Date.UTC(2026, 9, 1, 17, 0));
    const before = log(30, new Date(Date.UTC(2026, 8, 20)), "old");
    const after = log(60, new Date(Date.UTC(2026, 9, 5)), "new");
    const oldSet = (["en", "he"] as const).flatMap((language) =>
      before
        .filter((entry) => detectLanguage(entry.query) === language)
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 25)
        .map((entry) => ({ query: entry.query, language, source: "log" as const, modelWritten: false })),
    );
    const old = splitScoreSet(oldSet);
    const logQueries = [...before, ...after];
    const results = reproduceOldSet({ logQueries, previousPublic: old.publicSet, before: cutoff });
    const keep = Object.fromEntries(results.map((result) => [result.language, result.entries!]));
    const pinned = Object.fromEntries(results.map((result) => [result.language, result.halves!]));
    const set = await buildScoreSet({ logQueries, llm: createSyntheticFillerLlm(), keep });
    const { publicSet, hiddenSet } = splitScoreSet(set, undefined, pinned);
    const queries = (entries: readonly ScoreSetEntry[], language: string) =>
      entries.filter((entry) => entry.language === language).map((entry) => entry.query);

    for (const language of ["en", "he"] as const) {
      const hidden = new Set(queries(hiddenSet, language));
      const shown = new Set(queries(publicSet, language));
      // An old public search is in the repository: it can never land in the hidden half.
      expect(queries(old.publicSet, language).some((query) => hidden.has(query))).toBe(false);
      expect(queries(old.publicSet, language).every((query) => shown.has(query))).toBe(true);
      expect(queries(old.hiddenSet, language).every((query) => hidden.has(query))).toBe(true);
    }
    // en keeps its 13 / 12 exactly, in the old order; he adds 50 split 25 / 25.
    expect(queries(publicSet, "en")).toEqual(queries(old.publicSet, "en"));
    expect(queries(hiddenSet, "en")).toEqual(queries(old.hiddenSet, "en"));
    expect(queries(publicSet, "he")).toHaveLength(38);
    expect(queries(hiddenSet, "he")).toHaveLength(37);
    expect(queries(publicSet, "he").slice(0, 13)).toEqual(queries(old.publicSet, "he"));
    expect(splitScoreSet(set, undefined, pinned)).toEqual({ publicSet, hiddenSet });

    // Without the pin, the same 75 reshuffle and old public searches fall into the hidden half.
    const loose = new Set(queries(splitScoreSet(set).hiddenSet, "he"));
    expect(queries(old.publicSet, "he").some((query) => loose.has(query))).toBe(true);
  });

  it("draws the hidden added searches from the newest repository-unknown log searches, the public from the rest (AC-1, amended)", async () => {
    const cutoff = new Date(Date.UTC(2026, 9, 1, 17, 0));
    const before = log(30, new Date(Date.UTC(2026, 8, 20)), "old");
    const after = log(60, new Date(Date.UTC(2026, 9, 5)), "new");
    const oldSet = (["en", "he"] as const).flatMap((language) =>
      before
        .filter((entry) => detectLanguage(entry.query) === language)
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 25)
        .map((entry) => ({ query: entry.query, language, source: "log" as const, modelWritten: false })),
    );
    const logQueries = [...before, ...after];
    const results = reproduceOldSet({ logQueries, previousPublic: splitScoreSet(oldSet).publicSet, before: cutoff });
    const keep = Object.fromEntries(results.map((result) => [result.language, result.entries!]));
    const pinned = Object.fromEntries(results.map((result) => [result.language, result.halves!]));
    // The newest added Hebrew search, as a test file would quote it, in upper case and odd spacing.
    const repoKnown = "חיפוש new 59";
    const known = new RepositoryText(`expect(search("  חיפוש   NEW 59 ")).toBe(true);`.toLowerCase().replace(/\s+/g, " "));
    const set = await buildScoreSet({ logQueries, llm: createSyntheticFillerLlm(), keep, known, halves: pinned });
    const { publicSet, hiddenSet } = splitScoreSet(set, undefined, pinned, known);
    const he = set.filter((entry) => entry.language === "he");
    const queries = (entries: readonly ScoreSetEntry[]) =>
      new Set(entries.filter((entry) => entry.language === "he").map((entry) => entry.query));
    const range = (from: number, to: number) =>
      Array.from({ length: from - to + 1 }, (_, index) => `חיפוש new ${from - index}`);

    // Hidden added: the 25 newest unknown (58..34). Public added: the newest remaining (59, then 33..10).
    expect(hiddenSet.filter((entry) => entry.language === "he").slice(12).map((entry) => entry.query)).toEqual(range(58, 34));
    expect(publicSet.filter((entry) => entry.language === "he").slice(13).map((entry) => entry.query)).toEqual([
      repoKnown,
      ...range(33, 10),
    ]);
    // Kept, not dropped, and public; no repository-known search is hidden.
    expect(he.some((entry) => entry.query === repoKnown)).toBe(true);
    expect(queries(publicSet).has(repoKnown)).toBe(true);
    expect(queries(hiddenSet).has(repoKnown)).toBe(false);
    expect(hiddenSet.some((entry) => known.has(entry.query))).toBe(false);
    // An old public entry never lands in the hidden half either.
    const oldPublic = splitScoreSet(oldSet).publicSet.filter((entry) => entry.language === "he");
    expect(oldPublic.some((entry) => queries(hiddenSet).has(entry.query))).toBe(false);
    // A log of 75 or more real Hebrew searches takes no filler: he is 75 from the log, 38 / 37.
    expect(he).toHaveLength(75);
    expect(he.every((entry) => entry.source === "log")).toBe(true);
    expect(he.some((entry) => entry.query === "חיפוש new 9")).toBe(false);
    expect(queries(publicSet).size).toBe(38);
    expect(queries(hiddenSet).size).toBe(37);
    expect(known.pinned.get("simple he")).toBe(1);
    expect(known.pinned.get("simple en")).toBe(0);
  });

  it("takes every Hebrew log search and no filler: old 25 + 42 new is 67, 34 / 33 (AC-1, amended)", async () => {
    const cutoff = new Date(Date.UTC(2026, 9, 1, 17, 0));
    const before = log(25, new Date(Date.UTC(2026, 8, 20)), "old");
    const after = log(42, new Date(Date.UTC(2026, 9, 5)), "new");
    const oldSet = (["en", "he"] as const).flatMap((language) =>
      before
        .filter((entry) => detectLanguage(entry.query) === language)
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .map((entry) => ({ query: entry.query, language, source: "log" as const, modelWritten: false })),
    );
    const old = splitScoreSet(oldSet);
    const logQueries = [...before, ...after];
    const results = reproduceOldSet({ logQueries, previousPublic: old.publicSet, before: cutoff });
    const keep = Object.fromEntries(results.map((result) => [result.language, result.entries!]));
    const pinned = Object.fromEntries(results.map((result) => [result.language, result.halves!]));
    const known = new RepositoryText("חיפוש new 41");
    const set = await buildScoreSet({ logQueries, llm: createSyntheticFillerLlm(), keep, known, halves: pinned });
    const { publicSet, hiddenSet } = splitScoreSet(set, undefined, pinned, known);
    const ofHe = (entries: readonly ScoreSetEntry[]) =>
      entries.filter((entry) => entry.language === "he").map((entry) => entry.query);
    const range = (from: number, to: number) =>
      Array.from({ length: from - to + 1 }, (_, index) => `חיפוש new ${from - index}`);

    expect(set.filter((entry) => entry.language === "he")).toHaveLength(67);
    expect(set.filter((entry) => entry.language === "he").every((entry) => entry.source === "log")).toBe(true);
    expect(ofHe(publicSet)).toHaveLength(34);
    expect(ofHe(hiddenSet)).toHaveLength(33);
    // The old 13 / 12 stay; hidden added are the 21 newest unknown, public added the rest.
    expect(ofHe(publicSet).slice(0, 13)).toEqual(ofHe(old.publicSet));
    expect(ofHe(hiddenSet).slice(0, 12)).toEqual(ofHe(old.hiddenSet));
    expect(ofHe(hiddenSet).slice(12)).toEqual(range(40, 20));
    expect(ofHe(publicSet).slice(13)).toEqual(["חיפוש new 41", ...range(19, 0)]);
    // The check is on substrings, so "new 4" is known too: two public added searches are repository-known.
    expect(known.pinned.get("simple he")).toBe(2);
    // en is unchanged: its kept 25, 13 / 12.
    expect(publicSet.filter((entry) => entry.language === "en")).toHaveLength(13);
  });

  it("reads every tracked file as normalized text for the repository check (AC-1, amended)", () => {
    const known = repositoryText(REPO_ROOT);
    expect(known.has("The GROWN set and   the hard set")).toBe(true);
    // Built at run time: this test file is tracked too, so a literal would be found in it.
    expect(known.has(["zqx", "never", "written", String(175 * 7)].join(" "))).toBe(false);
  });

  it("builds both sets offline, writes `set` on every public entry, and reports counts only (verify step 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "score-set-175-"));
    const publicPath = join(dir, "public.json");
    const hiddenPath = join(dir, "hidden.b64");
    const out: string[] = [];
    const code = await buildSetCommand(
      ["--synthetic", "--hidden-out", hiddenPath, "--public-out", publicPath],
      { out: (text) => void out.push(text), err: () => {} },
    );
    expect(code).toBe(0);
    const publicSet = JSON.parse(readFileSync(publicPath, "utf8")) as ScoreSetEntry[];
    expect(publicSet.every((entry) => entry.set === "simple" || entry.set === "hard")).toBe(true);
    expect(publicSet.filter((entry) => entry.set === "simple" && entry.language === "he")).toHaveLength(1);
    for (const language of ["en", "he"] as const) {
      expect(publicSet.filter((entry) => entry.set === "hard" && entry.language === language)).toHaveLength(15);
    }
    const hiddenSet = decodeHiddenSet(readFileSync(hiddenPath, "utf8"));
    expect(hiddenSet).toHaveLength(12 * 5 + 1 + 15 * 2);
    expect(hiddenSet.every((entry) => entry.set !== undefined)).toBe(true);
    expect(out).toContain("set simple he 2: 1 public, 1 hidden; 2 log, 0 filler");
    // A synthetic build checks against no repository text, and says so as a count.
    expect(out).toContain("pinned simple he 0");
    expect(out).toContain("pinned hard en 0");
    expect(out).toContain("set hard en 30: 15 public, 15 hidden; 0 log, 30 filler");
    // The summary never carries a query.
    expect(findLeaks(out.join("\n"), hiddenSet)).toEqual({ leaked: 0 });

    // --keep-before compares against the previous public file and says per language whether it reproduced.
    const keepOut: string[] = [];
    await buildSetCommand(
      [
        "--synthetic",
        "--hidden-out",
        join(dir, "hidden2.b64"),
        "--public-out",
        join(dir, "public2.json"),
        "--keep-before",
        "2026-10-01T17:33:28Z",
        "--previous-public",
        publicPath,
      ],
      { out: (text) => void keepOut.push(text), err: () => {} },
    );
    expect(keepOut.filter((line) => line.startsWith("reproduce "))).toEqual([
      "reproduce en not reproduced",
      "reproduce he not reproduced",
    ]);
    expect(
      await buildSetCommand(["--synthetic", "--hidden-out", join(dir, "h3"), "--keep-before", "not a time"], {
        out: () => {},
        err: () => {},
      }),
    ).toBe(2);
  });

  it("scores each set apart: a strict `set` line before each table, indices per set, --set-name to choose (AC-4)", async () => {
    const marker = "ZQX-MARKER-175";
    const set: ScoreSetEntry[] = [
      { query: `${marker} linen shirt`, language: "en", source: "log", modelWritten: false, set: "simple" },
      { query: `${marker} black dress`, language: "he", source: "log", modelWritten: false, set: "simple" },
      { query: `${marker} shoes like prada`, language: "en", source: "model", modelWritten: true, set: "hard", kind: "lookalike" },
    ];
    const dir = mkdtempSync(join(tmpdir(), "score-sets-"));
    const hiddenPath = join(dir, "hidden.b64");
    writeFileSync(hiddenPath, encodeHiddenSet(set));
    async function run(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runScoreCommand(argv, {
        out: (text) => void out.push(...text.split("\n")),
        err: (text) => void err.push(text),
      });
      return { code, out, err };
    }

    const all = await run(["--synthetic", "--hidden-set", hiddenPath]);
    expect(all.code).toBe(0);
    expect(all.out.filter((line) => line.startsWith("set "))).toEqual(["set simple", "set hard"]);
    expect(all.out.filter((line) => line.startsWith("language "))).toHaveLength(2);
    // Each set counts its own indices from 0.
    expect(all.out.filter((line) => line.startsWith("grade ")).map((line) => line.split(" ").slice(0, 3).join(" "))).toEqual([
      "grade en 0",
      "grade he 1",
      "grade en 0",
    ]);
    expect(all.out.indexOf("set hard")).toBeGreaterThan(all.out.indexOf("set simple"));
    const output = [...all.err, ...all.out].join("\n");
    expect(output).not.toContain(marker);
    expect(findLeaks(`${output}\n`, set)).toEqual({ leaked: 0 });

    const hard = await run(["--synthetic", "--hidden-set", hiddenPath, "--set-name", "hard"]);
    expect(hard.out.filter((line) => line.startsWith("set "))).toEqual(["set hard"]);
    expect(hard.out.filter((line) => line.startsWith("grade "))).toHaveLength(1);
    expect((await run(["--synthetic", "--hidden-set", hiddenPath, "--set-name", "medium"])).code).toBe(2);
  });

  it("admits only the two set lines, strictly (AC-4)", () => {
    const hidden: ScoreSetEntry[] = [{ query: "hard", language: "en", source: "model", modelWritten: true, set: "hard" }];
    expect(findLeaks("set hard\nset simple\n", hidden)).toEqual({ leaked: 0 });
    expect(findLeaks("set hard extra\n", hidden)).toEqual({ leaked: 1 });
  });

  it("carries the brand-and-person paragraph in the rubric, verbatim and equal to docs/SCORE.md (AC-3)", () => {
    const paragraph =
      'A brand or person reference is graded on the look it names, not on the brand: "shoes that look like Prada" grades 3 for a loafer with the same shape and finish and 0 for a sandal. A person reference is graded on the garment the sentence describes when it describes one, and on the category alone when it does not.';
    expect(SCORE_RUBRIC.endsWith(`\n\n${paragraph}`)).toBe(true);
    expect(readFileSync(join(REPO_ROOT, "docs", "SCORE.md"), "utf8")).toContain(SCORE_RUBRIC);
  });
});
