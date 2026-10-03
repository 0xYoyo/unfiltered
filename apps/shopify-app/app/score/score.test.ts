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
import {
  descriptionExcerpt,
  failureClassName,
  formatCostLine,
  formatFailureLine,
  formatScoreTable,
  graderDetails,
  readRunCost,
  runScoreSet,
} from "./run.server";
import {
  buildScoreSet,
  decodeHiddenSet,
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
      orchestrator: createSyntheticOrchestrator(db, set),
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
      orchestrator: createSyntheticOrchestrator(db, set),
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
    expect(output).toMatch(/^engine synthetic\nlanguage\s+score/);
    // The engine line, header, three language rows, the cost line, the extract-call line.
    expect(output.trim().split("\n")).toHaveLength(7);
    expect(output.trim().split("\n").at(-1)).toBe("extract calls 0");

    written.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(record);
    vi.spyOn(process.stderr, "write").mockImplementation(record);
    const twice = await runScoreCommand(["--synthetic", "--set", setPath, "--passes", "2"]);
    vi.restoreAllMocks();
    expect(twice).toBe(0);
    const lines = written.join("").trim().split("\n");
    // Each pass: its header line, then its own table (YOY-149 AC-18).
    expect(lines.filter((line) => /^pass \d$/.test(line))).toEqual(["pass 1", "pass 2"]);
    expect(lines.filter((line) => line.startsWith("language"))).toHaveLength(2);
    expect(await runScoreCommand(["--synthetic", "--set", setPath, "--passes", "4"])).toBe(2);
  });

  it("refuses to start a real run with no engine named, before it spends (YOY-149)", async () => {
    const saved = process.env.ENGINE_V2;
    delete process.env.ENGINE_V2;
    const errors: string[] = [];
    try {
      const code = await runScoreCommand(["--set", "/nonexistent/set.json"], {
        out: () => undefined,
        err: (line: string) => void errors.push(line),
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toMatch(/ENGINE_V2 is not set/);
      expect(
        await runScoreCommand(["--engine", "v3"], { out: () => undefined, err: () => undefined }),
      ).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.ENGINE_V2;
      else process.env.ENGINE_V2 = saved;
    }
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
    const orchestrator = createSyntheticOrchestrator(db, set);
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
      orchestrator: createSyntheticOrchestrator(db, set),
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
      orchestrator: createSyntheticOrchestrator(db, set),
      grader: fakeGrader(3).llm,
      storeKey: SYNTHETIC_STORE_KEY,
      set,
    });
    expect(report.failures).toEqual([]);
    // The cost line, then the extract-call line (YOY-149 AC-18), and no failure line.
    expect(formatScoreTable(report).split("\n").slice(-2)).toEqual([
      expect.stringMatching(/^cost /),
      "extract calls 0",
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
    expect(header).toMatch(/under 1 s\s+no extraction\s+extraction cached\s+failed$/);
    expect(en).toMatch(/\s50%\s+25%\s+50%\s+0$/);
    expect(he).toMatch(/\s100%\s+—\s+—\s+1$/);
  });

  it("skips only strict pass headers and extract-call lines (YOY-149 AC-18)", () => {
    const hiddenWord: ScoreSetEntry[] = [
      { query: "pass", language: "en", source: "model", modelWritten: false },
      { query: "extract", language: "en", source: "model", modelWritten: false },
    ];
    expect(findLeaks("pass 2\nextract calls 0\nengine v2\n", hiddenWord)).toEqual({ leaked: 0 });
    expect(findLeaks("pass the salt\nextract calls for linen\n", hiddenWord)).toEqual({ leaked: 2 });
    expect(formatScoreTable({ languages: [], cost: { usd: 0, calls: 0 }, failures: [], extractCalls: 0 })).toContain(
      "extract calls 0",
    );
  });

  it("passes a clean score table, even when hidden searches are table words", () => {
    expect(table.split("\n").slice(-3)).toEqual([
      "cost $0.0812 over 96 model calls",
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

  it("scores the engine the dispatch names: v2 sets ENGINE_V2=1, v1 by default (YOY-145 AC-13)", () => {
    expect(triggers).toMatch(/engine:\n(?:\s+.*\n)*?\s+default: v1/);
    expect(workflow).toContain("ENGINE_V2: ${{ inputs.engine == 'v2' && '1' || '0' }}");
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

  it("prints the GEMINI_ and INTENT_ env names before the run, never their values (YOY-141 AC-13)", () => {
    const names = workflow.indexOf("env | cut -d= -f1 | grep -E '^(GEMINI|INTENT)_'");
    expect(names).toBeGreaterThan(-1);
    expect(names).toBeLessThan(workflow.indexOf("scripts/score-run.mts --hidden-set"));
  });
});
