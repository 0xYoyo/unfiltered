import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  type AiCallUsage,
  type CostRecorder,
  type InlineImage,
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
  runIndexEval,
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

// Fixture regeneration (AC-5 of YOY-27): re-records the catalog index's
// recordings — enrichments, vision answers, product vectors — against the
// live Gemini APIs and rewrites fixtures/recorded/{enrichment,vision,
// embeddings}.json in place. Never runs by default and never in CI:
// requires LIVE_LLM_TESTS=1 and a local GEMINI_API_KEY. After a successful
// run, re-run `npm test` to prove the index eval and the Engine v2
// Constructor suite still clear their bars on the fresh index (a changed
// product text needs the v2 recordings re-recorded too:
// constructor-v2-regen.test.ts), then commit the JSONs.
const live = process.env.LIVE_LLM_TESTS === "1";
/**
 * `REGEN_SCOPE=all` (the default) re-records every enrichment, every vision
 * answer and every product vector.
 *
 * `REGEN_SCOPE=catalog` (YOY-110 AC-5) re-records every enrichment and
 * vision answer — the prompt or rule changed, so every recording must — and
 * embeds only the product texts `embeddings.json` lacks.
 *
 * `REGEN_SCOPE=vision` (YOY-122) re-records every vision answer — for a
 * vision prompt/model change — records only the missing enrichments, and
 * embeds the product texts that moved with it.
 *
 * `REGEN_SCOPE=missing` records only what is missing: a product added to the
 * catalog gets its enrichment, vision answer and vector, and every existing
 * recording stays byte-identical.
 *
 * Every scope but `all` drops the vectors no product text references any
 * more, so `embeddings.json` holds exactly the replay set.
 */
const scope =
  process.env.REGEN_SCOPE === "catalog"
    ? "catalog"
    : process.env.REGEN_SCOPE === "vision"
      ? "vision"
      : process.env.REGEN_SCOPE === "missing"
        ? "missing"
        : "all";

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

describe.runIf(live)("eval fixture regeneration (live)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("re-records the catalog index: enrichments, vision answers, product vectors", async () => {
    const models = geminiModelsFromEnv();
    const catalog = loadCatalog();
    const usage = captureUsage(createPrismaCostRecorder(db));
    // Failure collection (YOY-52 directive): a live run costs paid minutes,
    // so a single bad assertion must not hide every finding behind it. Each
    // section collects its failures and keeps going; the run fails once, at
    // the end, with the complete picture. Recording files are still written
    // per section, so a failing run leaves a full fixture set to inspect.
    const failures: string[] = [];
    const check = (condition: boolean, message: string): void => {
      if (!condition) {
        failures.push(message);
      }
    };
    const readRecording = (file: string): { modelId: string; entries: Record<string, RecordedEntry> } =>
      JSON.parse(readFileSync(join(recordedDir, file), "utf8"));

    // 1. Enrichment: the classification-tier model over every sparse
    //    product. The recording is keyed by title, so a re-recorded
    //    product's entry is replaced, not merged — a stale entry would
    //    replay the pre-rule output shape. Missing-only under the vision
    //    and missing scopes: every existing entry is reused.
    const rerecordEnrichment = scope === "all" || scope === "catalog";
    const enrichmentEntries: Record<string, RecordedEntry> = {};
    if (!rerecordEnrichment) {
      const onDisk = readRecording("enrichment.json");
      check(
        onDisk.modelId === models.classificationModel,
        `enrichment.json is ${onDisk.modelId}, env says ${models.classificationModel}; regenerate with REGEN_SCOPE=catalog`,
      );
      Object.assign(enrichmentEntries, onDisk.entries);
    }
    const enrichmentLlm = captureCompletions(
      createGeminiLlmClient({
        modelId: models.classificationModel,
        costRecorder: usage.recorder,
      }),
      usage.last,
      enrichmentEntries,
    );
    const attributesByProduct = new Map<string, ReturnType<typeof parseEnrichment>>();
    let enrichmentsRecorded = 0;
    for (const { sourceUpdatedAt, ...product } of catalog) {
      void sourceUpdatedAt; // not part of the enrichment input
      if (enrichmentEntries[product.title] === undefined) {
        await enrichmentLlm.completeStructured({
          prompt: buildEnrichmentPrompt({ ...product, contentHash: computeContentHash(product) }),
          schema: ENRICHMENT_SCHEMA,
          operation: "enrichment",
        });
        enrichmentsRecorded += 1;
      }
      const entry = enrichmentEntries[product.title];
      check(entry !== undefined, `enrichment: ${product.productId} recorded no completion`);
      const attributes = entry === undefined ? null : parseEnrichment(entry.output, product);
      check(attributes !== null, `enrichment: ${product.productId} answered outside the schema`);
      attributesByProduct.set(product.productId, attributes);
    }
    writeRecording("enrichment.json", models.classificationModel, enrichmentEntries);
    check(
      Object.keys(enrichmentEntries).length === catalog.length,
      `coverage: ${Object.keys(enrichmentEntries).length}/${catalog.length} enrichments recorded`,
    );

    // 2. Vision (YOY-122): every product with fixture images; re-recorded
    //    under every scope but missing, which records only the products
    //    with no answer yet.
    const visionByProduct = await recordVision({
      models,
      catalog,
      usage,
      check,
      rerecordAll: scope !== "missing",
    });

    // 3. Product vectors: every composed product text (the merged text and
    //    vision attributes). Scope all re-embeds every text; the others
    //    embed only the texts embeddings.json lacks and drop the vectors no
    //    product text references any more — a re-enriched product's
    //    previous composed text.
    const embeddingsPath = join(recordedDir, "embeddings.json");
    const onDisk = existsSync(embeddingsPath)
      ? (JSON.parse(readFileSync(embeddingsPath, "utf8")) as {
          modelId: string;
          dimension: number;
          vectors: Record<string, number[]>;
        })
      : null;
    if (scope !== "all") {
      check(
        onDisk !== null &&
          onDisk.modelId === models.embeddingModel &&
          onDisk.dimension === models.embeddingDimension,
        `embeddings.json is ${onDisk?.modelId}@${onDisk?.dimension}, env says ${models.embeddingModel}@${models.embeddingDimension}; regenerate with REGEN_SCOPE=all`,
      );
    }
    const wanted = new Set(
      catalog.map((product) =>
        composeEmbeddingText(
          { ...product, contentHash: computeContentHash(product) },
          mergeAttributes(
            attributesByProduct.get(product.productId) ?? null,
            visionByProduct.get(product.productId) ?? null,
          ),
        ),
      ),
    );
    const vectors: Record<string, number[]> = {};
    if (scope !== "all" && onDisk !== null) {
      for (const [text, vector] of Object.entries(onDisk.vectors)) {
        if (wanted.has(text)) {
          vectors[text] = vector;
        }
      }
    }
    const orphaned = onDisk === null ? 0 : Object.keys(onDisk.vectors).filter((text) => !wanted.has(text)).length;
    const missing = [...wanted].filter((text) => vectors[text] === undefined);
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
        vectors[text] = batchVectors[index]!;
      });
    }
    writeFileSync(
      embeddingsPath,
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
      Object.keys(vectors).length === wanted.size,
      `coverage: ${Object.keys(vectors).length}/${wanted.size} product vectors recorded`,
    );

    // 4. In-process re-score against the freshly written recordings (YOY-31
    //    AC-6). Vitest gives the offline suites no ordering guarantee
    //    relative to this file, so a green offline run in the same
    //    invocation proves nothing about the fresh recordings; re-running
    //    the index eval here, after every fixture is on disk, makes a
    //    regression fail the live run itself.
    const evalDb = await createTestDb();
    try {
      const rescored = await runIndexEval(evalDb);
      check(
        rescored.contaminationViolations.length === 0,
        `rescore: contamination: ${rescored.contaminationViolations.join("; ")}`,
      );
      const sparseMisses = rescored.perSparse
        .filter((score) => score.satisfied.length === 0)
        .map((score) => score.golden.id);
      check(
        rescored.sparseHitRate >= 0.8,
        `rescore: sparse goldens ${(rescored.sparseHitRate * 100).toFixed(0)} % below the 80 % bar; misses: ${sparseMisses.join(", ")}`,
      );
    } catch (error) {
      check(false, `rescore: index eval failed: ${String(error)}`);
    } finally {
      await evalDb.$disconnect();
    }

    const spent = await db.aiCall.findMany();
    console.log(
      `[regenerate-live] scope=${scope} recorded: ${enrichmentsRecorded} enrichment(s), ${missing.length} product vector(s) (${orphaned} orphaned vector(s) dropped); metered spend $${spent.reduce((sum, row) => sum + row.costUsd, 0).toFixed(4)}`,
    );
    // The single verdict: every collected failure from every section, at
    // once. An empty list is the green run that ends the regeneration loop.
    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  }, 2_700_000);
});
