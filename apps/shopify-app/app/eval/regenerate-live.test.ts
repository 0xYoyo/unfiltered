import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  type InlineImage,
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
  buildVisionPrompt,
  mergeAttributes,
  parseVisionAttributes,
  VISION_SCHEMA,
  type VisionAttributes,
} from "../catalog/enrich.server";
import { computeContentHash } from "../catalog/mapping.server";
import { createTestDb } from "../testing/helpers.server";
import {
  loadCatalog,
  loadConstructorGoldens,
  loadGoldens,
  loadRefinementGoldens,
  runEval,
  type Golden,
  goldenHit,
  loadVisionGoldens,
  VISION_FIXTURES_DIR,
  type EvalProduct,
} from "./harness.server";
import { recordingKeyFromRequest } from "./replay.server";
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
/**
 * `REGEN_SCOPE=lite` (YOY-116) re-records only the lite-tier intents —
 * `intent-lite.json` and `intent-lite-refinement.json` — leaving every
 * accuracy-tier recording untouched, so a lite-tier change never silently
 * reshuffles the baseline the zero-regression bar is scored against.
 * Default `all` re-records everything, the lite files included.
 *
 * `REGEN_SCOPE=catalog` (YOY-110 AC-5) re-records the enrichment of every
 * product — the enrichment prompt/rule changed, so every recording must —
 * and then records only the MISSING classification, intent (both tiers), and
 * embedding entries: new goldens and new or re-enriched product texts. Every
 * existing intent recording stays byte-identical, so the zero-regression
 * baseline is scored against the same intents; only the index changes.
 *
 * `REGEN_SCOPE=goldens` (YOY-111) is the same missing-only pass WITHOUT the
 * enrichment re-record: for a new golden over an unchanged catalog, so the
 * enrichment recordings — and with them every product vector — stay
 * byte-identical too.
 *
 * `REGEN_SCOPE=vision` (YOY-122) is the goldens pass plus a re-record of
 * EVERY vision answer (`vision.json`) — for a vision prompt/model change —
 * and of the product vectors whose merged text moved with it. The catalog
 * and goldens scopes record only the missing vision answers.
 *
 * `REGEN_REQUERY=<golden ids, comma-separated>` (YOY-133) narrows an intent
 * change to the goldens it changes: under the goldens scope the named
 * goldens' intent entries — both tiers — are dropped before the missing-
 * only pass, so exactly those are re-recorded at the current prompt and
 * schema while every other intent recording stays byte-identical. The
 * embedding step then records the re-recorded intents' query texts and
 * drops the vectors nothing references any more, as it always did.
 */
const scope =
  process.env.REGEN_SCOPE === "lite"
    ? "lite"
    : process.env.REGEN_SCOPE === "intent"
      ? "intent"
      : process.env.REGEN_SCOPE === "catalog"
        ? "catalog"
        : process.env.REGEN_SCOPE === "goldens"
          ? "goldens"
          : process.env.REGEN_SCOPE === "vision"
            ? "vision"
            : "all";
/**
 * `REGEN_RESUME=1` keeps the lite entries already on disk and records only
 * the missing keys and the recorded FAILURES — a lite run that a slow
 * upstream cut short or timed out on resumes instead of re-spending every
 * call, and a flaky-day failure gets another chance. Never applies to the
 * accuracy-tier recordings.
 */
const resume = process.env.REGEN_RESUME === "1";
/** Golden ids whose intent recordings the goldens scope re-records (YOY-133). */
const requery = new Set(
  (process.env.REGEN_REQUERY ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== ""),
);
/** The lite tier is fast by design; a hung call is retried sooner. */
const LITE_REQUEST_TIMEOUT_MS = 20_000;

const recordedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "recorded",
);

interface RecordedEntry {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  /** A recorded failure of the lite tier (YOY-116); see replay.server.ts. */
  error?: string;
}

/**
 * Record a lite-tier failure as evidence (YOY-116): when the lite model
 * still fails after the retry ladder, the recording carries the error name
 * so the offline harness replays the failure and scores the ladder's
 * escalation on it — gemini-3.5-flash-lite hung deterministically on one
 * refinement prompt, and hiding that would score a ladder that never ran.
 */
function recordLiteFailure(
  entries: Record<string, RecordedEntry>,
  query: string,
  error: unknown,
): void {
  entries[query] = {
    output: null,
    inputTokens: 0,
    outputTokens: 0,
    error: error instanceof Error ? error.name : "Error",
  };
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
      entries[recordingKeyFromRequest(request)] = {
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

/** The fixture image bytes of one product (YOY-122), in `images` order. */
function visionImagesOf(product: EvalProduct): InlineImage[] {
  return (product.images ?? []).map((file) => ({
    mimeType: "image/jpeg",
    data: new Uint8Array(readFileSync(join(VISION_FIXTURES_DIR, file))),
  }));
}

/**
 * Record the vision pass (YOY-122 AC-1) for every product with fixture
 * images: the live vision model over the same anchored prompt and schema
 * production uses, keyed in `vision.json` by title plus a digest of the
 * ordered image bytes (YOY-125 AC-14), the same key the replay client
 * derives. `rerecordAll` replaces
 * every entry (a prompt or model change); otherwise only missing entries
 * are recorded and every existing answer is reused byte-identical. Returns
 * each product's parsed answer (null without images) for the merged
 * embedding text.
 */
async function recordVision({
  models,
  catalog,
  usage,
  check,
  rerecordAll,
}: {
  models: ReturnType<typeof geminiModelsFromEnv>;
  catalog: EvalProduct[];
  usage: ReturnType<typeof captureUsage>;
  check: (condition: boolean, message: string) => void;
  rerecordAll: boolean;
}): Promise<Map<string, VisionAttributes | null>> {
  const path = join(recordedDir, "vision.json");
  const onDisk = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { modelId: string; entries: Record<string, RecordedEntry> })
    : { modelId: models.visionModel, entries: {} };
  check(
    rerecordAll || onDisk.modelId === models.visionModel,
    `vision.json is ${onDisk.modelId}, env says ${models.visionModel}; regenerate with REGEN_SCOPE=vision`,
  );
  const entries: Record<string, RecordedEntry> = rerecordAll ? {} : onDisk.entries;
  const llm = captureCompletions(
    createGeminiLlmClient({
      modelId: models.visionModel,
      thinkingLevel: models.visionThinkingLevel,
      costRecorder: usage.recorder,
    }),
    usage.last,
    entries,
  );
  const byProduct = new Map<string, VisionAttributes | null>();
  let recorded = 0;
  let withImages = 0;
  for (const product of catalog) {
    if ((product.images ?? []).length === 0) {
      byProduct.set(product.productId, null);
      continue;
    }
    withImages += 1;
    const call = {
      prompt: buildVisionPrompt({ ...product, contentHash: computeContentHash(product) }),
      schema: VISION_SCHEMA,
      operation: "vision" as const,
      temperature: 0,
      images: visionImagesOf(product),
    };
    const key = recordingKeyFromRequest(call);
    if (entries[key] === undefined) {
      try {
        await llm.completeStructured(call);
        recorded += 1;
      } catch (error) {
        check(false, `vision: ${product.productId} failed: ${String(error)}`);
        byProduct.set(product.productId, null);
        continue;
      }
    }
    const entry = entries[key];
    const attributes = entry === undefined ? null : parseVisionAttributes(entry.output);
    check(attributes !== null, `vision: ${product.productId} answered outside the schema`);
    byProduct.set(product.productId, attributes);
  }
  writeRecording("vision.json", models.visionModel, entries);
  console.log(
    `[regenerate-live] vision: ${recorded} answer(s) recorded live, ${withImages} product(s) with images`,
  );
  return byProduct;
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

/**
 * Every golden the harness replays (YOY-118): the main set and the
 * Constructor-bar set share the recording files, keyed by query, so each
 * live scope records both — a Constructor golden with no recording would
 * fail the offline run exactly like a main golden.
 */
function loadRecordedGoldens(): Golden[] {
  return [...loadGoldens(), ...loadConstructorGoldens(), ...loadVisionGoldens()];
}

describe("golden classification tiers (YOY-52 AC-1 amendment)", () => {
  // Pins each golden's regeneration expectation offline, so a heuristics
  // change that reroutes a golden fails here — in every `npm test` — instead
  // of surfacing as a false FAIL mid-way through a paid live regeneration.
  it("AI-tier goldens escalate past the heuristics or settle AI as purpose phrases; heuristic-settled classic goldens are classic controls", () => {
    for (const golden of loadRecordedGoldens()) {
      const heuristic = classifyByHeuristics(normalizeQuery(golden.query));
      if ((golden.expectedRoute ?? "ai") === "ai") {
        // A purpose phrase settles AI deterministically (YOY-133 AC-4);
        // every other AI golden must reach the model.
        if (heuristic !== null) {
          expect(heuristic, `${golden.id} heuristic route`).toEqual({
            route: "ai",
            reason: "purpose-phrase",
          });
        }
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

  it.skipIf(scope !== "all")("re-records enrichments, classifications, intents, and embeddings", async () => {
    const models = geminiModelsFromEnv();
    const catalog = loadCatalog();
    const goldens = loadRecordedGoldens();
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
      const attributes = parseEnrichment(completion, product);
      check(
        attributes !== null,
        `enrichment: ${product.productId} answered outside the schema`,
      );
      attributesByProduct.set(product.productId, attributes);
    }
    writeRecording("enrichment.json", models.classificationModel, enrichmentEntries);
    // Vision (YOY-122): every product with fixture images, re-recorded.
    const visionByProduct = await recordVision({ models, catalog, usage, check, rerecordAll: true });

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
          // Same thinking level production runs at (YOY-109), so the
          // recordings stay live evidence of the deployed configuration.
          thinkingLevel: models.intentThinkingLevel,
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
          // Same thinking level production runs at (YOY-109), so the
          // recordings stay live evidence of the deployed configuration.
          thinkingLevel: models.intentThinkingLevel,
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
          mergeAttributes(
            attributesByProduct.get(product.productId) ?? null,
            visionByProduct.get(product.productId) ?? null,
          ),
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
        rescored.perSearchCostPer1000Usd <= 0.6,
        `rescore: blended cost $${rescored.perSearchCostPer1000Usd.toFixed(4)}/1k exceeds the $0.60 bar`,
      );
      check(
        rescored.contaminationViolations.length === 0,
        `rescore: contamination: ${rescored.contaminationViolations.join("; ")}`,
      );
      const sparseMisses = rescored.perSparse
        .filter((score) => !goldenHit(score))
        .map((score) => score.golden.id);
      check(
        rescored.sparseHitRate >= 0.8,
        `rescore: sparse goldens ${(rescored.sparseHitRate * 100).toFixed(0)} % below the 80 % bar; misses: ${sparseMisses.join(", ")}`,
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

  it.skipIf(scope !== "intent")("re-records the accuracy-tier intents only (YOY-64 AC-2: REGEN_SCOPE=intent)", async () => {
    // The trimmed prompt changes every intent answer's token count and may
    // change its soft attributes; enrichment, classification, and the
    // catalog embeddings are untouched, so the zero-regression baseline is
    // scored against the same index. The lite step below re-records the
    // lite tier and merges the query embeddings both tiers now need.
    const models = geminiModelsFromEnv();
    const goldens = loadRecordedGoldens();
    const usage = captureUsage(createPrismaCostRecorder(db));
    const failures: string[] = [];
    const check = (condition: boolean, message: string): void => {
      if (!condition) {
        failures.push(message);
      }
    };
    // REGEN_RESUME keeps this tier's entries on disk too (a flaky upstream
    // cut a run short): only missing keys are recorded.
    const existingAccuracy = (file: string): Record<string, RecordedEntry> => {
      const path = join(recordedDir, file);
      if (!resume || !existsSync(path)) {
        return {};
      }
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        modelId?: string;
        entries?: Record<string, RecordedEntry>;
      };
      return parsed.modelId === models.intentModel ? (parsed.entries ?? {}) : {};
    };
    const intentEntries: Record<string, RecordedEntry> = existingAccuracy("intent.json");
    const extractor = createIntentExtractor({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.intentModel,
          costRecorder: usage.recorder,
          thinkingLevel: models.intentThinkingLevel,
          // No production abort budget here: a recording captures the
          // model's answer, and the 8 s intent budget (AC-3) is measured by
          // the latency probe, not enforced on the recorder — g20 (mixed
          // Hebrew/English) legitimately runs past it at this tier.
        }),
        usage.last,
        intentEntries,
      ),
    });
    for (const golden of goldens) {
      if (intentEntries[golden.query] !== undefined) {
        continue; // resumed from disk
      }
      try {
        await extractor.extract(golden.query);
      } catch (error) {
        check(false, `intent: ${golden.id} extraction failed: ${String(error)}`);
        continue;
      }
      check(intentEntries[golden.query] !== undefined, `intent: ${golden.id} recorded no completion`);
    }
    writeRecording("intent.json", models.intentModel, intentEntries);

    const refinementEntries: Record<string, RecordedEntry> = existingAccuracy(
      "intent-refinement.json",
    );
    const refinementExtractor = createIntentExtractor({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.intentModel,
          costRecorder: usage.recorder,
          thinkingLevel: models.intentThinkingLevel,
        }),
        usage.last,
        refinementEntries,
      ),
    });
    for (const golden of loadRefinementGoldens()) {
      if (refinementEntries[golden.query] !== undefined) {
        continue; // resumed from disk
      }
      try {
        await refinementExtractor.extract(golden.query, { previousIntent: golden.previousIntent });
      } catch (error) {
        check(false, `refinement: ${golden.id} extraction failed: ${String(error)}`);
        continue;
      }
      check(refinementEntries[golden.query] !== undefined, `refinement: ${golden.id} recorded no completion`);
    }
    writeRecording("intent-refinement.json", models.intentModel, refinementEntries);
    check(
      Object.keys(intentEntries).length === goldens.length,
      `coverage: ${Object.keys(intentEntries).length}/${goldens.length} intents recorded`,
    );
    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  }, 1_800_000);

  it.skipIf(scope !== "catalog" && scope !== "goldens" && scope !== "vision")("re-records every enrichment (catalog scope) and only the missing classification/intent/embedding entries (YOY-110 AC-5: REGEN_SCOPE=catalog; YOY-111: REGEN_SCOPE=goldens; YOY-122: REGEN_SCOPE=vision)", async () => {
    const models = geminiModelsFromEnv();
    const catalog = loadCatalog();
    const goldens = loadRecordedGoldens();
    const refinementGoldens = loadRefinementGoldens();
    const usage = captureUsage(createPrismaCostRecorder(db));
    const failures: string[] = [];
    const check = (condition: boolean, message: string): void => {
      if (!condition) {
        failures.push(message);
      }
    };
    const readRecording = (file: string): { modelId: string; provenance?: string; entries: Record<string, RecordedEntry> } =>
      JSON.parse(readFileSync(join(recordedDir, file), "utf8"));

    // 1. Enrichment: every product, at the current prompt and rule. The
    //    recording is keyed by title, so a product's entry is replaced, not
    //    merged — a stale entry would replay the pre-rule output shape.
    //    Under REGEN_SCOPE=goldens the recording on disk is reused as-is.
    const attributesByProduct = new Map<string, ReturnType<typeof parseEnrichment>>();
    if (scope === "catalog") {
      const enrichmentEntries: Record<string, RecordedEntry> = {};
      const enrichmentLlm = captureCompletions(
        createGeminiLlmClient({
          modelId: models.classificationModel,
          costRecorder: usage.recorder,
        }),
        usage.last,
        enrichmentEntries,
      );
      for (const { sourceUpdatedAt, ...product } of catalog) {
        void sourceUpdatedAt;
        const completion = await enrichmentLlm.completeStructured({
          prompt: buildEnrichmentPrompt({ ...product, contentHash: computeContentHash(product) }),
          schema: ENRICHMENT_SCHEMA,
          operation: "enrichment",
        });
        const attributes = parseEnrichment(completion, product);
        check(attributes !== null, `enrichment: ${product.productId} answered outside the schema`);
        attributesByProduct.set(product.productId, attributes);
      }
      writeRecording("enrichment.json", models.classificationModel, enrichmentEntries);
      check(
        Object.keys(enrichmentEntries).length === catalog.length,
        `coverage: ${Object.keys(enrichmentEntries).length}/${catalog.length} enrichments recorded`,
      );
    } else {
      // Missing-only (YOY-117): a product added with a new golden gets its
      // enrichment recorded live and merged; every existing entry is reused.
      const onDisk = readRecording("enrichment.json");
      check(
        onDisk.modelId === models.classificationModel,
        `enrichment.json is ${onDisk.modelId}, env says ${models.classificationModel}; regenerate with REGEN_SCOPE=catalog`,
      );
      const enrichmentLlm = captureCompletions(
        createGeminiLlmClient({
          modelId: models.classificationModel,
          costRecorder: usage.recorder,
        }),
        usage.last,
        onDisk.entries,
      );
      let recorded = 0;
      for (const { sourceUpdatedAt, ...product } of catalog) {
        void sourceUpdatedAt;
        if (onDisk.entries[product.title] === undefined) {
          await enrichmentLlm.completeStructured({
            prompt: buildEnrichmentPrompt({ ...product, contentHash: computeContentHash(product) }),
            schema: ENRICHMENT_SCHEMA,
            operation: "enrichment",
          });
          recorded += 1;
        }
        const entry = onDisk.entries[product.title];
        check(entry !== undefined, `enrichment: ${product.productId} recorded no completion`);
        const attributes = entry === undefined ? null : parseEnrichment(entry.output, product);
        check(attributes !== null, `enrichment: ${product.productId} answered outside the schema`);
        attributesByProduct.set(product.productId, attributes);
      }
      if (recorded > 0) {
        writeRecording("enrichment.json", onDisk.modelId, onDisk.entries);
      }
      console.log(`[regenerate-live] scope=goldens: ${recorded} missing enrichment(s) recorded`);
    }

    // 1b. Vision (YOY-122): catalog and vision scopes re-record every
    //     product with images (the answer shape or model changed); goldens
    //     scope records only the products with no answer yet.
    const visionByProduct = await recordVision({
      models,
      catalog,
      usage,
      check,
      rerecordAll: scope === "catalog" || scope === "vision",
    });

    // 2. Classification: only model-answered goldens with no live entry yet.
    const classification = readRecording("classification.json");
    check(
      classification.modelId === models.classificationModel,
      `classification.json is ${classification.modelId}, env says ${models.classificationModel}; regenerate with REGEN_SCOPE=all`,
    );
    const classifier = createQueryClassifier({
      llm: captureCompletions(
        createGeminiLlmClient({ modelId: models.classificationModel, costRecorder: usage.recorder }),
        usage.last,
        classification.entries,
      ),
      timeoutMs: 600_000,
    });
    let classificationsRecorded = 0;
    for (const golden of goldens) {
      const key = normalizeQuery(golden.query);
      if (classifyByHeuristics(key) !== null || classification.entries[key] !== undefined) {
        continue; // heuristic-settled, or already recorded live
      }
      const decision = await classifier.classify(golden.query);
      classificationsRecorded += 1;
      check(
        decision.route === (golden.expectedRoute ?? "ai"),
        `classification: ${golden.id} routed ${decision.route}, expected ${golden.expectedRoute ?? "ai"}`,
      );
      check(classification.entries[key] !== undefined, `classification: ${golden.id} recorded no completion`);
    }
    writeRecording("classification.json", classification.modelId, classification.entries);

    // 3. Accuracy-tier intents: only goldens with no entry yet — plus the
    //    REGEN_REQUERY goldens, whose entries are dropped first (YOY-133).
    const intentRecording = readRecording("intent.json");
    const requeried = goldens.filter((golden) => requery.has(golden.id));
    check(
      requeried.length === requery.size,
      `REGEN_REQUERY names unknown golden id(s): ${[...requery].filter((id) => !goldens.some((golden) => golden.id === id)).join(", ")}`,
    );
    for (const golden of requeried) {
      delete intentRecording.entries[golden.query];
    }
    check(
      intentRecording.modelId === models.intentModel,
      `intent.json is ${intentRecording.modelId}, env says ${models.intentModel}; regenerate with REGEN_SCOPE=intent`,
    );
    const extractor = createIntentExtractor({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.intentModel,
          costRecorder: usage.recorder,
          thinkingLevel: models.intentThinkingLevel,
        }),
        usage.last,
        intentRecording.entries,
      ),
    });
    let intentsRecorded = 0;
    for (const golden of goldens) {
      if (intentRecording.entries[golden.query] !== undefined) {
        continue;
      }
      try {
        await extractor.extract(golden.query);
        intentsRecorded += 1;
      } catch (error) {
        check(false, `intent: ${golden.id} extraction failed: ${String(error)}`);
        continue;
      }
      check(intentRecording.entries[golden.query] !== undefined, `intent: ${golden.id} recorded no completion`);
    }
    writeRecording("intent.json", intentRecording.modelId, intentRecording.entries);
    check(
      Object.keys(intentRecording.entries).length === goldens.length,
      `coverage: ${Object.keys(intentRecording.entries).length}/${goldens.length} intents recorded`,
    );

    // 4. Lite-tier intents: only goldens with no entry yet (a recorded lite
    //    failure stays as it was recorded — this scope adds, never re-judges).
    const liteRecording = readRecording("intent-lite.json");
    check(
      liteRecording.modelId === models.intentLiteModel,
      `intent-lite.json is ${liteRecording.modelId}, env says ${models.intentLiteModel}; regenerate with REGEN_SCOPE=lite`,
    );
    for (const golden of requeried) {
      delete liteRecording.entries[golden.query];
    }
    const liteExtractor = createIntentExtractor({
      llm: captureCompletions(
        createGeminiLlmClient({
          modelId: models.intentLiteModel,
          costRecorder: usage.recorder,
          thinkingLevel: models.intentLiteThinkingLevel,
          requestTimeoutMs: LITE_REQUEST_TIMEOUT_MS,
        }),
        usage.last,
        liteRecording.entries,
      ),
    });
    let liteRecorded = 0;
    for (const golden of goldens) {
      if (liteRecording.entries[golden.query] !== undefined) {
        continue;
      }
      try {
        const intent = await liteExtractor.extract(golden.query);
        liteRecorded += 1;
        check(typeof intent.confidence === "number", `intent-lite: ${golden.id} reported no confidence`);
      } catch (error) {
        if (error instanceof GeminiTimeoutError) {
          console.warn(`[regenerate-live] intent-lite: ${golden.id} timed out after retries; recorded as a lite failure`);
          recordLiteFailure(liteRecording.entries, golden.query, error);
          continue;
        }
        check(false, `intent-lite: ${golden.id} extraction failed: ${String(error)}`);
        continue;
      }
      check(liteRecording.entries[golden.query] !== undefined, `intent-lite: ${golden.id} recorded no completion`);
    }
    writeRecording("intent-lite.json", liteRecording.modelId, liteRecording.entries);

    // 5. Embeddings: every product text (fresh enrichment attributes change
    //    the composed text) and every query text of both tiers, for goldens
    //    and refinement goldens alike — only texts embeddings.json lacks,
    //    merged in; existing vectors stay untouched.
    const embeddingsPath = join(recordedDir, "embeddings.json");
    const embeddingRecording = JSON.parse(readFileSync(embeddingsPath, "utf8")) as {
      modelId: string;
      dimension: number;
      vectors: Record<string, number[]>;
    };
    check(
      embeddingRecording.modelId === models.embeddingModel &&
        embeddingRecording.dimension === models.embeddingDimension,
      `embeddings.json is ${embeddingRecording.modelId}@${embeddingRecording.dimension}, env says ${models.embeddingModel}@${models.embeddingDimension}; regenerate with REGEN_SCOPE=all`,
    );
    const wanted = new Set<string>();
    for (const { sourceUpdatedAt, ...product } of catalog) {
      void sourceUpdatedAt;
      wanted.add(
        composeEmbeddingText(
          { ...product, contentHash: computeContentHash(product) },
          mergeAttributes(
            attributesByProduct.get(product.productId) ?? null,
            visionByProduct.get(product.productId) ?? null,
          ),
        ),
      );
    }
    const liteRefinement = readRecording("intent-lite-refinement.json");
    const accuracyRefinement = readRecording("intent-refinement.json");
    const queryEntries = [
      ...goldens.flatMap((golden) => [intentRecording.entries[golden.query], liteRecording.entries[golden.query]]),
      ...refinementGoldens.flatMap((golden) => [
        accuracyRefinement.entries[golden.query],
        liteRefinement.entries[golden.query],
      ]),
    ];
    for (const entry of queryEntries) {
      if (entry === undefined || entry.error !== undefined) {
        continue;
      }
      const intent = parseIntent(entry.output);
      if (intent === null) {
        continue;
      }
      const text = composeQueryText(intent);
      if (text !== "") {
        wanted.add(text);
      }
    }
    const missing = [...wanted].filter((text) => embeddingRecording.vectors[text] === undefined);
    // Vectors no product text or recorded intent references any more — a
    // re-enriched product's previous composed text — are dropped, so the
    // recording holds exactly the replay set and does not grow run over run.
    const orphaned = Object.keys(embeddingRecording.vectors).filter((text) => !wanted.has(text));
    for (const text of orphaned) {
      delete embeddingRecording.vectors[text];
    }
    if (missing.length > 0 || orphaned.length > 0) {
      const embeddings = createGeminiEmbeddingClient({
        modelId: models.embeddingModel,
        dimension: models.embeddingDimension,
        costRecorder: usage.recorder,
      });
      const BATCH = 100;
      for (let start = 0; start < missing.length; start += BATCH) {
        const batch = missing.slice(start, start + BATCH);
        const batchVectors = await paced(() => embeddings.embed({ texts: batch }));
        batch.forEach((text, index) => {
          embeddingRecording.vectors[text] = batchVectors[index]!;
        });
      }
      writeFileSync(embeddingsPath, `${JSON.stringify(embeddingRecording, null, 2)}\n`);
    }

    // 6. Re-score against the fresh recordings (same reason as scope=all),
    //    and report the run's metered spend from the ledger.
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
      for (const violation of rescored.perQuery.flatMap((score) => score.violations)) {
        check(false, `rescore: ${violation}`);
      }
      for (const violation of rescored.perRefinement.flatMap((score) => score.violations)) {
        check(false, `rescore: ${violation}`);
      }
      check(
        rescored.perSearchCostPer1000Usd <= 0.6,
        `rescore: blended cost $${rescored.perSearchCostPer1000Usd.toFixed(4)}/1k exceeds the $0.60 bar`,
      );
      check(
        rescored.contaminationViolations.length === 0,
        `rescore: contamination: ${rescored.contaminationViolations.join("; ")}`,
      );
      const sparseMisses = rescored.perSparse
        .filter((score) => !goldenHit(score))
        .map((score) => score.golden.id);
      check(
        rescored.sparseHitRate >= 0.8,
        `rescore: sparse goldens ${(rescored.sparseHitRate * 100).toFixed(0)} % below the 80 % bar; misses: ${sparseMisses.join(", ")}`,
      );
    } catch (error) {
      check(false, `rescore: eval run failed: ${String(error)}`);
    } finally {
      await evalDb.$disconnect();
    }
    const spent = await db.aiCall.findMany();
    const byOperation = new Map<string, { calls: number; usd: number }>();
    for (const row of spent) {
      const bucket = byOperation.get(row.operation) ?? { calls: 0, usd: 0 };
      bucket.calls += 1;
      bucket.usd += row.costUsd;
      byOperation.set(row.operation, bucket);
    }
    console.log(
      [
        `[regenerate-live] scope=${scope} recorded: ${scope === "catalog" ? catalog.length : 0} enrichments, ${classificationsRecorded} classifications, ${intentsRecorded} accuracy intents, ${liteRecorded} lite intents (${requeried.length} re-queried), ${missing.length} embeddings (${orphaned.length} orphaned vector(s) dropped)`,
        ...[...byOperation].map(([operation, bucket]) => `[regenerate-live]   ${operation}: ${bucket.calls} call(s), $${bucket.usd.toFixed(4)}`),
        `[regenerate-live]   total metered spend: $${spent.reduce((sum, row) => sum + row.costUsd, 0).toFixed(4)}`,
      ].join("\n"),
    );
    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  }, 2_700_000);

  it.skipIf(scope === "catalog" || scope === "goldens")("re-records the lite-tier intents (YOY-116 AC-5)", async () => {
    // The same goldens and refinement goldens, answered by the lite model at
    // its explicit thinking level — each answer carrying its `confidence`,
    // which is what the offline harness routes on. Written beside the
    // accuracy recordings, never over them.
    const models = geminiModelsFromEnv();
    const goldens = loadRecordedGoldens();
    const usage = captureUsage(createPrismaCostRecorder(db));
    const failures: string[] = [];
    const check = (condition: boolean, message: string): void => {
      if (!condition) {
        failures.push(message);
      }
    };
    const liteClient = () =>
      createGeminiLlmClient({
        modelId: models.intentLiteModel,
        costRecorder: usage.recorder,
        thinkingLevel: models.intentLiteThinkingLevel,
        requestTimeoutMs: LITE_REQUEST_TIMEOUT_MS,
      });
    const existing = (file: string): Record<string, RecordedEntry> => {
      const path = join(recordedDir, file);
      if (!resume || !existsSync(path)) {
        return {};
      }
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        modelId?: string;
        entries?: Record<string, RecordedEntry>;
      };
      // Resume only what the same model recorded.
      return parsed.modelId === models.intentLiteModel ? (parsed.entries ?? {}) : {};
    };

    const liteEntries: Record<string, RecordedEntry> = existing("intent-lite.json");
    const liteExtractor = createIntentExtractor({
      llm: captureCompletions(liteClient(), usage.last, liteEntries),
    });
    for (const golden of goldens) {
      if (liteEntries[golden.query] !== undefined && liteEntries[golden.query]!.error === undefined) {
        continue; // resumed from disk; a recorded failure is retried
      }
      try {
        const intent = await liteExtractor.extract(golden.query);
        check(
          typeof intent.confidence === "number",
          `intent-lite: ${golden.id} reported no confidence`,
        );
      } catch (error) {
        if (error instanceof GeminiTimeoutError) {
          console.warn(`[regenerate-live] intent-lite: ${golden.id} timed out after retries; recorded as a lite failure`);
          recordLiteFailure(liteEntries, golden.query, error);
          continue;
        }
        check(false, `intent-lite: ${golden.id} extraction failed: ${String(error)}`);
        continue;
      }
      check(
        liteEntries[golden.query] !== undefined,
        `intent-lite: ${golden.id} recorded no completion`,
      );
    }
    writeRecording("intent-lite.json", models.intentLiteModel, liteEntries);

    const liteRefinementEntries: Record<string, RecordedEntry> = existing(
      "intent-lite-refinement.json",
    );
    const liteRefinementExtractor = createIntentExtractor({
      llm: captureCompletions(liteClient(), usage.last, liteRefinementEntries),
    });
    for (const golden of loadRefinementGoldens()) {
      if (
        liteRefinementEntries[golden.query] !== undefined &&
        liteRefinementEntries[golden.query]!.error === undefined
      ) {
        continue; // resumed from disk; a recorded failure is retried
      }
      try {
        await liteRefinementExtractor.extract(golden.query, {
          previousIntent: golden.previousIntent,
        });
      } catch (error) {
        if (error instanceof GeminiTimeoutError) {
          console.warn(`[regenerate-live] intent-lite-refinement: ${golden.id} timed out after retries; recorded as a lite failure`);
          recordLiteFailure(liteRefinementEntries, golden.query, error);
          continue;
        }
        check(false, `intent-lite-refinement: ${golden.id} extraction failed: ${String(error)}`);
        continue;
      }
      check(
        liteRefinementEntries[golden.query] !== undefined,
        `intent-lite-refinement: ${golden.id} recorded no completion`,
      );
    }
    writeRecording(
      "intent-lite-refinement.json",
      models.intentLiteModel,
      liteRefinementEntries,
    );

    check(
      Object.keys(liteEntries).length === goldens.length,
      `coverage: ${Object.keys(liteEntries).length}/${goldens.length} lite intents recorded`,
    );

    // Query embeddings for the lite intents: a lite answer composes its own
    // query text (its soft attributes differ from the accuracy tier's), and
    // the retrieval replay is keyed by exact text — a text with no recorded
    // vector degrades the golden. Embed only the texts embeddings.json lacks
    // and MERGE them in: the accuracy tier's vectors stay untouched.
    const embeddingsPath = join(recordedDir, "embeddings.json");
    const embeddingRecording = JSON.parse(readFileSync(embeddingsPath, "utf8")) as {
      modelId: string;
      dimension: number;
      vectors: Record<string, number[]>;
    };
    check(
      embeddingRecording.modelId === models.embeddingModel &&
        embeddingRecording.dimension === models.embeddingDimension,
      `embeddings.json is ${embeddingRecording.modelId}@${embeddingRecording.dimension}, env says ${models.embeddingModel}@${models.embeddingDimension}; regenerate with REGEN_SCOPE=all`,
    );
    const liteTexts = new Set<string>();
    // Both tiers' query texts (YOY-64: the accuracy recordings change under
    // REGEN_SCOPE=intent too, and their texts need vectors just the same).
    const accuracyEntries = JSON.parse(
      readFileSync(join(recordedDir, "intent.json"), "utf8"),
    ) as { entries: Record<string, RecordedEntry> };
    for (const golden of goldens) {
      for (const entry of [liteEntries[golden.query], accuracyEntries.entries[golden.query]]) {
        if (entry === undefined || entry.error !== undefined) {
          continue;
        }
        const intent = parseIntent(entry.output);
        if (intent === null) {
          continue; // a schema-violating lite answer escalates at replay
        }
        const text = composeQueryText(intent);
        if (text !== "" && embeddingRecording.vectors[text] === undefined) {
          liteTexts.add(text);
        }
      }
    }
    const missing = [...liteTexts];
    if (missing.length > 0) {
      const embeddings = createGeminiEmbeddingClient({
        modelId: models.embeddingModel,
        dimension: models.embeddingDimension,
        costRecorder: usage.recorder,
      });
      const BATCH = 100;
      for (let start = 0; start < missing.length; start += BATCH) {
        const batch = missing.slice(start, start + BATCH);
        const batchVectors = await paced(() => embeddings.embed({ texts: batch }));
        batch.forEach((text, index) => {
          embeddingRecording.vectors[text] = batchVectors[index]!;
        });
      }
      writeFileSync(embeddingsPath, `${JSON.stringify(embeddingRecording, null, 2)}\n`);
    }
    console.log(
      `[regenerate-live] lite query embeddings: ${missing.length} new text(s) merged into embeddings.json`,
    );
    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  }, 1_800_000);
});
