import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  classifyByHeuristics,
  composeQueryText,
  createIntentExtractor,
  createQueryClassifier,
  normalizeQuery,
  parseIntent,
  type AiCallUsage,
  type CostRecorder,
  type LlmClient,
  type StructuredCompletionRequest,
} from "@unfiltered/engine";
import {
  createGeminiEmbeddingClient,
  createGeminiLlmClient,
  GeminiApiError,
  geminiModelsFromEnv,
  GeminiTimeoutError,
} from "@unfiltered/provider-gemini";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { composeEmbeddingText } from "../catalog/embed.server";
import {
  buildEnrichmentPrompt,
  ENRICHMENT_SCHEMA,
  parseEnrichment,
} from "../catalog/enrich.server";
import { computeContentHash } from "../catalog/mapping.server";
import { createTestDb } from "../testing/helpers.server";
import {
  loadCatalog,
  loadGoldens,
  loadRefinementGoldens,
  runEval,
} from "./harness.server";
import { recordingKeyFromPrompt } from "./replay.server";
import {
  assertEngineSourceExecution,
  engineSourceResolutionFailure,
} from "./source-guard.server";

// Source-execution guard (YOY-52 run-6): at module load — before any paid
// LLM/embedding call — fail loudly unless @unfiltered/engine is executing
// from packages/engine/src via the root vitest.config.ts alias. A vitest run
// started inside apps/shopify-app picks up the app's alias-less
// vite.config.ts and would silently score stale compiled dist/ output.
assertEngineSourceExecution();

// Fixture regeneration (AC-5 of YOY-27): re-records every eval fixture output
// — enrichments, classifications, intents, embeddings — against the live
// Gemini APIs and rewrites fixtures/recorded/*.json in place. Never runs by
// default and never in CI: requires LIVE_LLM_TESTS=1 and a local
// GEMINI_API_KEY. After a successful run, re-run `npm test` to prove the
// harness still clears the bar on fresh recordings, then commit the JSONs.
const live = process.env.LIVE_LLM_TESTS === "1";

const recordedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "recorded",
);

interface RecordedEntry {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
}

// Free-tier Gemini keys rate-limit hard (YOY-28): every live call is paced by
// a fixed delay, a 429 backs off exponentially before giving up, and transient
// transport failures get a short fixed-backoff ladder of their own.
const DEFAULT_PACE_MS = 5_000;
const LOG_EVERY = 10;
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 30_000;
const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 10_000;

/**
 * Per-call pacing from REGEN_PACE_MS (YOY-28 wrap-up item 4). The default
 * stays free-tier-safe; Tier 1 keys can drop to ~500 for fast regens. A
 * malformed value falls back to the default rather than silently hammering
 * the API at pace 0 or NaN.
 */
export function resolvePaceMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PACE_MS;
  }
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value <= 0) {
    console.warn(
      `[regenerate-live] REGEN_PACE_MS=${JSON.stringify(raw)} is not a positive integer; using default ${DEFAULT_PACE_MS}ms`,
    );
    return DEFAULT_PACE_MS;
  }
  return value;
}

const PACE_MS = resolvePaceMs(process.env.REGEN_PACE_MS);

const TRANSIENT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "ECONNRESET",
  "ETIMEDOUT",
]);

function codeOf(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Transient transport failure worth retrying (YOY-28 wrap-up item 2): undici
 * surfaces network trouble as TypeError("fetch failed", { cause }) or errors
 * coded UND_ERR_HEADERS_TIMEOUT / ECONNRESET / ETIMEDOUT (the provider's
 * GeminiTimeoutError carries ETIMEDOUT), sometimes only on the cause.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = codeOf(error) ?? codeOf(error.cause);
  if (code !== undefined && TRANSIENT_CODES.has(code)) {
    return true;
  }
  return (
    (error instanceof TypeError && error.cause !== undefined) ||
    error.message === "fetch failed"
  );
}

let liveCallCount = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pace, then run one live call, retrying 429s with exponential backoff and
 * transient transport failures with a short fixed backoff. Everything else
 * rethrows immediately.
 */
async function paced<T>(call: () => Promise<T>): Promise<T> {
  await sleep(PACE_MS);
  liveCallCount += 1;
  if (liveCallCount % LOG_EVERY === 0) {
    console.log(`[regenerate-live] ${liveCallCount} live calls dispatched`);
  }
  let backoffMs = INITIAL_BACKOFF_MS;
  let rateLimitAttempts = 0;
  let transientAttempts = 0;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GeminiApiError && error.status === 429) {
        rateLimitAttempts += 1;
        if (rateLimitAttempts >= MAX_ATTEMPTS) {
          throw error;
        }
        console.log(
          `[regenerate-live] 429 rate-limited; waiting ${backoffMs / 1000}s before retry (attempt ${rateLimitAttempts}/${MAX_ATTEMPTS})`,
        );
        await sleep(backoffMs);
        backoffMs *= 2;
      } else if (isTransientNetworkError(error)) {
        transientAttempts += 1;
        if (transientAttempts >= TRANSIENT_MAX_ATTEMPTS) {
          throw error;
        }
        console.log(
          `[regenerate-live] transient network error (${(error as Error).message}); waiting ${TRANSIENT_BACKOFF_MS / 1000}s before retry (attempt ${transientAttempts}/${TRANSIENT_MAX_ATTEMPTS})`,
        );
        await sleep(TRANSIENT_BACKOFF_MS);
      } else {
        throw error;
      }
    }
  }
}

/** Wrap a CostRecorder so the last recorded usage is observable. */
function captureUsage(inner: CostRecorder): {
  recorder: CostRecorder;
  last: () => AiCallUsage;
} {
  let lastUsage: AiCallUsage | null = null;
  return {
    recorder: {
      async record(usage) {
        lastUsage = usage;
        await inner.record(usage);
      },
    },
    last: () => {
      if (lastUsage === null) {
        throw new Error("no usage captured — the live call never metered");
      }
      return lastUsage;
    },
  };
}

/** Wrap an LlmClient so each request/response lands in a recording map. */
function captureCompletions(
  inner: LlmClient,
  usage: () => AiCallUsage,
  entries: Record<string, RecordedEntry>,
): LlmClient {
  return {
    async completeStructured(request: StructuredCompletionRequest) {
      const response = await paced(() => inner.completeStructured(request));
      const called = usage();
      entries[recordingKeyFromPrompt(request.prompt)] = {
        output: response,
        inputTokens: called.inputTokens,
        outputTokens: called.outputTokens,
      };
      return response;
    },
  };
}

function writeRecording(
  file: string,
  modelId: string,
  entries: Record<string, RecordedEntry>,
): void {
  writeFileSync(
    join(recordedDir, file),
    `${JSON.stringify({ modelId, provenance: "live", entries }, null, 2)}\n`,
  );
}

// Offline coverage for the retry predicate and pacing knob — these run in
// every `npm test`, live or not.
describe("transient network error predicate", () => {
  it("retries undici transport failures and coded timeouts", () => {
    const fetchFailed = new TypeError("fetch failed", {
      cause: new Error("socket hang up"),
    });
    const headersTimeout = Object.assign(new Error("headers timeout"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    const connReset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    const timedOut = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    for (const error of [fetchFailed, headersTimeout, connReset, timedOut]) {
      expect(isTransientNetworkError(error), error.message).toBe(true);
    }
  });

  it("retries the provider's GeminiTimeoutError via its ETIMEDOUT code", () => {
    expect(
      isTransientNetworkError(new GeminiTimeoutError("timed out", 60_000)),
    ).toBe(true);
  });

  it("rethrows everything else immediately", () => {
    const nonTransient = [
      new GeminiApiError("Gemini API answered 500", 500, "boom"),
      new GeminiApiError("Gemini API answered 429", 429, "quota"), // 429 has its own ladder
      new Error("assertion failed"),
      new TypeError("x is not a function"), // TypeError without cause is a code bug
      "not even an error",
    ];
    for (const error of nonTransient) {
      expect(isTransientNetworkError(error), String(error)).toBe(false);
    }
  });
});

describe("REGEN_PACE_MS resolution", () => {
  it("defaults to 5000 when unset", () => {
    expect(resolvePaceMs(undefined)).toBe(5_000);
  });

  it("accepts a positive integer", () => {
    expect(resolvePaceMs("500")).toBe(500);
  });

  it("falls back to the default with a warning on malformed values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const raw of ["", "  ", "abc", "-1", "0", "2.5"]) {
        expect(resolvePaceMs(raw), JSON.stringify(raw)).toBe(5_000);
      }
      expect(warn).toHaveBeenCalledTimes(6);
      expect(warn.mock.calls[0]![0]).toMatch(/REGEN_PACE_MS/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("source-execution guard (YOY-52 run-6)", () => {
  // Pins the guard both ways so a refactor can't quietly disarm it: source
  // resolution passes, dist resolution — current or so stale the sentinel
  // export is missing entirely — trips with a message naming the fix.
  it("passes on a source-resolved engine module", () => {
    expect(
      engineSourceResolutionFailure(
        "file:///repo/packages/engine/src/index.ts",
      ),
    ).toBeNull();
  });

  it("trips on a dist-resolved engine module and names the fix", () => {
    const failure = engineSourceResolutionFailure(
      "file:///repo/packages/engine/dist/index.js",
    );
    expect(failure).toMatch(/did not resolve to packages\/engine\/src/);
    expect(failure).toMatch(/repository root/);
    expect(failure).toMatch(/vitest\.config\.ts/);
    expect(failure).toMatch(/regen:live/);
  });

  it("trips on a dist build so stale it predates the sentinel export", () => {
    expect(engineSourceResolutionFailure(undefined)).toMatch(
      /predates the ENGINE_SOURCE_URL sentinel/,
    );
  });

  it("this run itself is executing the engine from source", () => {
    expect(() => assertEngineSourceExecution()).not.toThrow();
  });
});

describe("golden classification tiers (YOY-52 AC-1 amendment)", () => {
  // Pins each golden's regeneration expectation offline, so a heuristics
  // change that reroutes a golden fails here — in every `npm test` — instead
  // of surfacing as a false FAIL mid-way through a paid live regeneration.
  it("AI-tier goldens escalate past the heuristics; heuristic-settled goldens are classic controls", () => {
    for (const golden of loadGoldens()) {
      const heuristic = classifyByHeuristics(normalizeQuery(golden.query));
      if ((golden.expectedRoute ?? "ai") === "ai") {
        expect(heuristic, `${golden.id} must escalate to the model`).toBeNull();
      } else if (heuristic !== null) {
        expect(heuristic.route, `${golden.id} heuristic route`).toBe("classic");
      }
    }
  });
});

describe.runIf(live)("eval fixture regeneration (live)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("re-records enrichments, classifications, intents, and embeddings", async () => {
    const models = geminiModelsFromEnv();
    const catalog = loadCatalog();
    const goldens = loadGoldens();
    const usage = captureUsage(createPrismaCostRecorder(db));

    // Failure collection (YOY-52 directive): a live run costs ~9 paid
    // minutes, so a single bad assertion must not hide every finding behind
    // it. Each section collects its failures and keeps going; the run fails
    // once, at the end, with the complete picture. Recording files are still
    // written per section, so a failing run leaves a full fixture set to
    // inspect rather than a half-rewritten tree.
    const failures: string[] = [];
    const check = (condition: boolean, message: string): void => {
      if (!condition) {
        failures.push(message);
      }
    };

    // Enrichment: the classification-tier model over every sparse product.
    const enrichmentEntries: Record<string, RecordedEntry> = {};
    const enrichmentLlm = captureCompletions(
      createGeminiLlmClient({
        modelId: models.classificationModel,
        costRecorder: usage.recorder,
      }),
      usage.last,
      enrichmentEntries,
    );
    const attributesByProduct = new Map<string, ReturnType<typeof parseEnrichment>>();
    for (const { sourceUpdatedAt, ...product } of catalog) {
      void sourceUpdatedAt; // not part of the enrichment input
      const completion = await enrichmentLlm.completeStructured({
        prompt: buildEnrichmentPrompt({
          ...product,
          contentHash: computeContentHash(product),
        }),
        schema: ENRICHMENT_SCHEMA,
        operation: "enrichment",
      });
      const attributes = parseEnrichment(completion);
      check(
        attributes !== null,
        `enrichment: ${product.productId} answered outside the schema`,
      );
      attributesByProduct.set(product.productId, attributes);
    }
    writeRecording("enrichment.json", models.classificationModel, enrichmentEntries);

    // Classification: through the real classifier so heuristics and prompt
    // wording match the harness exactly; only model-answered queries record.
    const classificationEntries: Record<string, RecordedEntry> = {};
    const classifier = createQueryClassifier({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.classificationModel,
          costRecorder: usage.recorder,
        }),
        usage.last,
        classificationEntries,
      ),
      // Generous: pacing and 429 backoff happen inside the wrapped llm call,
      // so the classifier's own timeout must outlast a full retry ladder.
      timeoutMs: 600_000,
    });
    // Per-golden expected reason (YOY-52 AC-1 amendment): heuristic-settled
    // goldens — the SKU-shaped and short-query classic controls — never reach
    // the model, so demanding reason "model" for every golden is wrong since
    // the YOY-61 classifier rewrite. The heuristics are deterministic, so
    // each golden's expectation derives from classifyByHeuristics itself.
    for (const golden of goldens) {
      const decision = await classifier.classify(golden.query);
      check(
        decision.route === (golden.expectedRoute ?? "ai"),
        `classification: ${golden.id} routed ${decision.route}, expected ${golden.expectedRoute ?? "ai"}`,
      );
      const heuristic = classifyByHeuristics(normalizeQuery(golden.query));
      if (heuristic === null) {
        check(
          decision.reason === "model",
          `classification: ${golden.id} must reach the model, got reason ${decision.reason}`,
        );
        check(
          classificationEntries[normalizeQuery(golden.query)] !== undefined,
          `classification: ${golden.id} recorded no completion`,
        );
      } else {
        check(
          decision.reason === heuristic.reason,
          `classification: ${golden.id} should settle heuristically (${heuristic.reason}), got ${decision.reason}`,
        );
        check(
          classificationEntries[normalizeQuery(golden.query)] === undefined,
          `classification: ${golden.id} spent a model call despite settling heuristically`,
        );
      }
    }
    writeRecording(
      "classification.json",
      models.classificationModel,
      classificationEntries,
    );
    // The synthesized stopgap classifications (YOY-67 AC-2) are superseded by
    // the live answers just recorded; leaving them in place would collide
    // with classification.json at replay time, so the regeneration empties
    // the file rather than leaving that cleanup to hand-editing.
    writeFileSync(
      join(recordedDir, "classification-synthesized.json"),
      `${JSON.stringify(
        {
          modelId: models.classificationModel,
          provenance: "synthesized",
          entries: {},
        },
        null,
        2,
      )}\n`,
    );

    // Intent: the accuracy-tier model per golden query.
    const intentEntries: Record<string, RecordedEntry> = {};
    const extractor = createIntentExtractor({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.intentModel,
          costRecorder: usage.recorder,
        }),
        usage.last,
        intentEntries,
      ),
    });
    const intents = new Map<string, NonNullable<ReturnType<typeof parseIntent>>>();
    for (const golden of goldens) {
      try {
        intents.set(golden.id, await extractor.extract(golden.query));
      } catch (error) {
        check(false, `intent: ${golden.id} extraction failed: ${String(error)}`);
        continue;
      }
      check(
        intentEntries[golden.query] !== undefined,
        `intent: ${golden.id} recorded no completion`,
      );
    }
    writeRecording("intent.json", models.intentModel, intentEntries);

    // Refinement intents (YOY-42): the same extractor, each call carrying the
    // golden's previous intent. Recorded into their own file so the base
    // goldens' recordings stay a clean per-query set, and so a run that fails
    // here cannot half-rewrite intent.json.
    const refinementEntries: Record<string, RecordedEntry> = {};
    const refinementExtractor = createIntentExtractor({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.intentModel,
          costRecorder: usage.recorder,
        }),
        usage.last,
        refinementEntries,
      ),
    });
    for (const golden of loadRefinementGoldens()) {
      try {
        await refinementExtractor.extract(golden.query, {
          previousIntent: golden.previousIntent,
        });
      } catch (error) {
        check(
          false,
          `refinement: ${golden.id} extraction failed: ${String(error)}`,
        );
        continue;
      }
      check(
        refinementEntries[golden.query] !== undefined,
        `refinement: ${golden.id} recorded no completion`,
      );
    }
    writeRecording(
      "intent-refinement.json",
      models.intentModel,
      refinementEntries,
    );

    // Embeddings: every product composed text (with the fresh enrichment
    // attributes) and every query text derived from the fresh intents.
    const embeddings = createGeminiEmbeddingClient({
      modelId: models.embeddingModel,
      dimension: models.embeddingDimension,
      costRecorder: usage.recorder,
    });
    const texts = [
      ...catalog.map((product) =>
        composeEmbeddingText(
          { ...product, contentHash: computeContentHash(product) },
          attributesByProduct.get(product.productId) ?? null,
        ),
      ),
      ...goldens
        .filter((golden) => intents.has(golden.id))
        .map((golden) => composeQueryText(intents.get(golden.id)!)),
    ];
    const unique = [...new Set(texts)];
    const vectors: Record<string, number[]> = {};
    const BATCH = 100;
    for (let start = 0; start < unique.length; start += BATCH) {
      const batch = unique.slice(start, start + BATCH);
      const batchVectors = await paced(() => embeddings.embed({ texts: batch }));
      batch.forEach((text, index) => {
        vectors[text] = batchVectors[index]!;
      });
    }
    writeFileSync(
      join(recordedDir, "embeddings.json"),
      `${JSON.stringify(
        {
          modelId: models.embeddingModel,
          dimension: models.embeddingDimension,
          vectors,
        },
        null,
        2,
      )}\n`,
    );

    check(
      Object.keys(enrichmentEntries).length === catalog.length,
      `coverage: ${Object.keys(enrichmentEntries).length}/${catalog.length} enrichments recorded`,
    );
    check(
      Object.keys(intentEntries).length === goldens.length,
      `coverage: ${Object.keys(intentEntries).length}/${goldens.length} intents recorded`,
    );
    check(
      Object.keys(vectors).length === unique.length,
      `coverage: ${Object.keys(vectors).length}/${unique.length} embeddings recorded`,
    );

    // In-process re-score against the freshly written recordings (YOY-31
    // AC-6). Vitest gives the offline harness suite no ordering guarantee
    // relative to this file — it may score the OLD recordings, or even run
    // before this test rewrites them — so a green offline suite in the same
    // run proves nothing about the fresh recordings. Re-running the eval here,
    // after every fixture is on disk, makes taxonomy drift fail the live run
    // itself instead of the next offline run.
    const evalDb = await createTestDb();
    try {
      const rescored = await runEval(evalDb);
      const misses = rescored.perQuery
        .filter((score) => score.firstExpectedRank === null)
        .map((score) => score.golden.id);
      check(
        rescored.hitRate >= 0.8,
        `rescore: hit rate ${rescored.hitRate.toFixed(2)} misses the 0.8 bar; misses: ${misses.join(", ")}`,
      );
      for (const violation of rescored.perQuery.flatMap(
        (score) => score.violations,
      )) {
        check(false, `rescore: ${violation}`);
      }
      for (const violation of rescored.perRefinement.flatMap(
        (score) => score.violations,
      )) {
        check(false, `rescore: ${violation}`);
      }
      check(
        rescored.perSearchCostPer1000Usd <= 2.0,
        `rescore: blended cost $${rescored.perSearchCostPer1000Usd.toFixed(4)}/1k exceeds the $2.00 bar`,
      );
    } catch (error) {
      check(false, `rescore: eval run failed: ${String(error)}`);
    } finally {
      await evalDb.$disconnect();
    }

    // The single verdict: every collected failure from every section, at
    // once. An empty list is the green run that ends the regeneration loop.
    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  }, 2_700_000);
});
