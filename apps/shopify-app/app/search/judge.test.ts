import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  buildJudgePrompt,
  createJudge,
  createLlmJudge,
  DEFAULT_JUDGE_ROW_CHARS,
  JUDGE_ANSWER_CODES,
  JUDGE_SCHEMA,
  JUDGE_VERDICT_CODES,
  JudgeAnswerError,
  judgeProviderFromEnv,
  judgeRow,
  orderByVerdict,
  parseJudgeAnswer,
  type AiCallUsage,
  type CostRecorder,
  type EmbeddingClient,
  type IntentExtractor,
  type JudgeCandidate,
  type LlmClient,
  type QueryClassifier,
  type Retriever,
  type StructuredCompletionRequest,
} from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createReplayLlmClient, type LlmRecording } from "../eval/replay.server";
import { serializePlaygroundSearchResponse } from "../playground/api.server";
import { createTestDb } from "../testing/helpers.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import { createFindStep } from "./find.server";
import {
  DEFAULT_JUDGE_DEADLINE_MS,
  judgeDeadlineMsFromEnv,
  judgeRowCharsFromEnv,
  loadJudgeCandidates,
} from "./judge-step.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
  type SearchRequest,
} from "./orchestrator.server";
import { serializeProxySearchResponse } from "./proxy.server";

// The judge (YOY-147): the engine's prompt, schema and ordering as pure
// units, then the whole v2 path on the embedded PGlite database — the real
// find step, the real card index and keyword store — with the judge's LLM
// port answered from recordings (`createReplayLlmClient`, keyed by the
// prompt's `Query:` line) or a scripted fake where a test needs a sequence
// or a slow answer. Offline and $0.

const SHOP = "judge-shop.myshopify.com";
const DIMENSION = 3;

function candidate(id: string, overrides: Partial<JudgeCandidate> = {}): JudgeCandidate {
  return {
    id,
    title: `Product ${id}`,
    priceMin: 100,
    priceMax: 100,
    currencyCode: "USD",
    options: [],
    summary: `Summary of ${id}`,
    description: "",
    ...overrides,
  };
}

/**
 * An answer in the model's wire shape: one three-letter code per candidate
 * (verdict E/V/C/N, missed wishes -/F/D/B, label F/C/X) and the side list of
 * fact-differs values.
 */
function answer(codes: string[], d: Array<{ n: number; p: string; a: string }> = []) {
  return { c: codes, d };
}

/** An LLM port answering a fixed sequence, recording every request. */
function scriptedLlm(
  answers: Array<unknown | (() => Promise<unknown>)>,
): LlmClient & { requests: StructuredCompletionRequest[] } {
  const client = {
    requests: [] as StructuredCompletionRequest[],
    async completeStructured(request: StructuredCompletionRequest) {
      client.requests.push(request);
      const next = answers[Math.min(client.requests.length - 1, answers.length - 1)];
      return typeof next === "function" ? (next as () => Promise<unknown>)() : next;
    },
  };
  return client;
}

describe("the judge's rows and prompt (AC-2)", () => {
  it("holds title, price, option names and values, and the card summary, cut to 320 characters", () => {
    const row = judgeRow(
      candidate("a", {
        title: "Aurora Midi Dress",
        priceMin: 80,
        priceMax: 95.5,
        currencyCode: "EUR",
        options: [
          { name: "Color", values: ["Black", "Navy"] },
          { name: "Size", values: ["S", "M"] },
        ],
        summary: "Black   long-sleeve\nmidi dress in viscose.",
      }),
    );
    expect(row).toBe(
      "Aurora Midi Dress | 80–95.5 EUR | Color: Black, Navy; Size: S, M | Black long-sleeve midi dress in viscose.",
    );
    expect(DEFAULT_JUDGE_ROW_CHARS).toBe(320);
    const long = judgeRow(candidate("b", { summary: "x".repeat(1000) }));
    expect(long).toHaveLength(320);
    expect(judgeRow(candidate("b", { summary: "x".repeat(1000) }), 50)).toHaveLength(50);
  });

  it("uses the title and the description's first 200 characters for a product with no card", () => {
    const row = judgeRow(
      candidate("c", { title: "Plain Tee", summary: null, description: "d".repeat(500) }),
      1000,
    );
    expect(row).toBe(`Plain Tee | 100 USD | ${"d".repeat(200)}`);
  });

  it("carries the sentence on a Query line and numbers every row", () => {
    const prompt = buildJudgePrompt("long sleeve  midi dress", [candidate("a"), candidate("b")]);
    expect(prompt).toContain("\nQuery: long sleeve midi dress\n");
    expect(prompt).toContain("\n1. Product a | 100 USD | Summary of a");
    expect(prompt).toContain("\n2. Product b | 100 USD | Summary of b");
  });
});

describe("the judge's answer (AC-3, AC-4, AC-9)", () => {
  const page = [candidate("a"), candidate("b"), candidate("c")];

  it("is fixed-schema JSON with short codes and no prose field", () => {
    expect(Object.keys(JUDGE_SCHEMA.properties as object).sort()).toEqual(["c", "d"]);
    const side = (JUDGE_SCHEMA.properties as { d: { items: { properties: object } } }).d.items;
    expect(Object.keys(side.properties).sort()).toEqual(["a", "n", "p"]);
    // 4 verdicts × 4 missed-wish flags × 3 label templates.
    expect(JUDGE_ANSWER_CODES).toHaveLength(48);
    expect(JUDGE_ANSWER_CODES).toEqual(expect.arrayContaining(["E-X", "VFF", "CDC", "NBX"]));
    expect(JUDGE_VERDICT_CODES).toEqual({
      E: "exact",
      V: "other-variant",
      C: "close",
      N: "not-relevant",
    });
  });

  it("maps each code back to its candidate, in candidate order", () => {
    const verdicts = parseJudgeAnswer(
      answer(["E-X", "VFF", "CDC"], [{ n: 2, p: "navy", a: "black" }]),
      page,
    );
    expect(verdicts).toEqual([
      { id: "a", verdict: "exact", missed: [], label: null },
      {
        id: "b",
        verdict: "other-variant",
        missed: ["fact"],
        label: { template: "fact-differs", values: ["navy", "black"] },
      },
      {
        id: "c",
        verdict: "close",
        missed: ["description"],
        label: { template: "close-match", values: [] },
      },
    ]);
    expect(parseJudgeAnswer(answer(["NBX", "E-X", "E-X"]), page)![0]!.missed).toEqual([
      "fact",
      "description",
    ]);
  });

  it("rejects an answer that misses or invents a candidate, or breaks the schema", () => {
    expect(parseJudgeAnswer(answer(["E-X", "E-X", "E-X"]), page)).not.toBeNull();
    for (const invalid of [
      answer(["E-X", "E-X"]),
      answer(["E-X", "E-X", "E-X", "E-X"]),
      answer(["E-X", "Z-X", "E-X"]),
      answer(["E-X", "exact", "E-X"]),
      answer(["E-X", "E-X", "E-X"], [{ n: 4, p: "navy", a: "black" }]),
      answer(["E-X", "EFF", "EFF"], [
        { n: 2, p: "navy", a: "black" },
        { n: 2, p: "red", a: "black" },
      ]),
      { c: ["E-X", "E-X", "E-X"], d: [{ n: 1, p: 4, a: "black" }] },
      { c: ["E-X", "E-X", "E-X"] },
      { v: ["E", "E", "E"], d: [] },
      null,
    ]) {
      expect(parseJudgeAnswer(invalid, page)).toBeNull();
    }
  });

  it("drops a fact-differs label whose value runs past three words, keeping the verdict (AC-9)", () => {
    const [first, second, third] = parseJudgeAnswer(
      answer(
        ["CFF", "CFF", "CFF"],
        [
          { n: 1, p: "dark navy blue wool", a: "black" },
          { n: 2, p: "dark navy blue", a: "pure black" },
        ],
      ),
      page,
    )!;
    expect(first).toMatchObject({ verdict: "close", label: null });
    expect(second!.label).toEqual({ template: "fact-differs", values: ["dark navy blue", "pure black"] });
    // No values for a fact-differs label: no label.
    expect(third).toMatchObject({ verdict: "close", label: null });
  });

  it("asks once more after an invalid answer, then fails (AC-4)", async () => {
    const valid = answer(["E-X", "CDC", "E-X"]);
    const recovers = scriptedLlm([answer(["E-X"]), valid]);
    const verdicts = await createLlmJudge({ llm: recovers }).judge({ sentence: "dress", candidates: page });
    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(["exact", "close", "exact"]);
    expect(recovers.requests).toHaveLength(2);

    const never = scriptedLlm([answer([])]);
    await expect(
      createLlmJudge({ llm: never }).judge({ sentence: "dress", candidates: page }),
    ).rejects.toBeInstanceOf(JudgeAnswerError);
    expect(never.requests).toHaveLength(2);
  });

  it("calls at temperature 0 under operation judge, with the caller's context and signal", async () => {
    const llm = scriptedLlm([answer(["E-X", "E-X", "E-X"])]);
    const signal = new AbortController().signal;
    await createLlmJudge({ llm }).judge({
      sentence: "dress",
      candidates: page,
      storeId: SHOP,
      searchId: "s-9",
      signal,
    });
    expect(llm.requests[0]).toMatchObject({
      operation: "judge",
      temperature: 0,
      schema: JUDGE_SCHEMA,
      storeId: SHOP,
      searchId: "s-9",
      signal,
    });
  });
});

describe("verdict order (AC-5, AC-8)", () => {
  const verdict = (id: string, code: "exact" | "other-variant" | "close" | "not-relevant") => ({
    id,
    verdict: code,
    missed: [],
    label: null,
  });

  it("ranks by verdict, ties in find order, not relevant last and never removed", () => {
    const ordered = orderByVerdict(
      ["a", "b", "c", "d", "e", "f"],
      [
        verdict("a", "not-relevant"),
        verdict("b", "close"),
        verdict("c", "exact"),
        verdict("d", "other-variant"),
        verdict("e", "exact"),
        verdict("f", "close"),
      ],
    );
    expect(ordered.map((item) => item.item)).toEqual(["c", "e", "d", "b", "f", "a"]);
  });

  it("serves find order with close-match on every card when every candidate is not relevant", () => {
    const ordered = orderByVerdict(["a", "b"], [verdict("a", "not-relevant"), verdict("b", "not-relevant")]);
    expect(ordered).toEqual([
      { item: "a", verdict: "not-relevant", label: { template: "close-match", values: [] } },
      { item: "b", verdict: "not-relevant", label: { template: "close-match", values: [] } },
    ]);
  });
});

describe("the one factory and its configuration (AC-1, AC-2, AC-6)", () => {
  it("selects the provider from JUDGE_PROVIDER, gemini by default, and builds only that client", async () => {
    expect(judgeProviderFromEnv({})).toBe("gemini");
    expect(judgeProviderFromEnv({ JUDGE_PROVIDER: "gemini" })).toBe("gemini");
    expect(() => judgeProviderFromEnv({ JUDGE_PROVIDER: "jev" })).toThrow(/JUDGE_PROVIDER/);

    let built = 0;
    const llm = scriptedLlm([answer(["E-X"])]);
    const judge = createJudge({
      provider: judgeProviderFromEnv({}),
      clients: {
        gemini: () => {
          built += 1;
          return llm;
        },
      },
    });
    await judge.judge({ sentence: "dress", candidates: [candidate("a")] });
    expect(built).toBe(1);
    expect(llm.requests[0]!.operation).toBe("judge");
  });

  it("reads the deadline and the row length from the environment", () => {
    expect(judgeDeadlineMsFromEnv({})).toBe(DEFAULT_JUDGE_DEADLINE_MS);
    expect(DEFAULT_JUDGE_DEADLINE_MS).toBe(1_500);
    expect(judgeDeadlineMsFromEnv({ JUDGE_DEADLINE_MS: "1" })).toBe(1);
    expect(() => judgeDeadlineMsFromEnv({ JUDGE_DEADLINE_MS: "0" })).toThrow(/JUDGE_DEADLINE_MS/);
    expect(judgeRowCharsFromEnv({})).toBe(320);
    expect(judgeRowCharsFromEnv({ JUDGE_ROW_CHARS: "200" })).toBe(200);
    expect(() => judgeRowCharsFromEnv({ JUDGE_ROW_CHARS: "x" })).toThrow(/JUDGE_ROW_CHARS/);
  });
});

interface Product {
  productId: string;
  title: string;
  /** Card-vector distance knob; no card vector when absent. */
  y?: number;
  summary?: string;
  description?: string;
  options?: Array<Array<{ name: string; value: string }>>;
}

async function seed(db: PrismaClient, products: Product[]): Promise<void> {
  for (const product of products) {
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: product.productId,
        title: product.title,
        description: product.description ?? "",
        tags: [],
        vendor: "fixture",
        productType: "",
        priceMin: 100,
        priceMax: 100,
        currencyCode: "USD",
        available: true,
        imageAltTexts: [],
        sourceUpdatedAt: new Date(),
        contentHash: `hash-${product.productId}`,
      },
    });
    if (product.y !== undefined) {
      await db.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, 'prose', 'h', $4::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
        randomUUID(),
        SHOP,
        product.productId,
        `[1,${product.y},0]`,
      );
    }
    if (product.summary !== undefined) {
      await db.productCard.create({
        data: {
          shopDomain: SHOP,
          productId: product.productId,
          status: "written",
          summary: product.summary,
          asks: {},
          inputHash: "i",
          cardVersion: 1,
          modelId: "m",
          writtenAt: new Date(),
        },
      });
    }
    for (const [index, options] of (product.options ?? []).entries()) {
      await db.productVariant.create({
        data: {
          shopDomain: SHOP,
          productId: product.productId,
          variantId: `${product.productId}-v${index + 1}`,
          position: index + 1,
          options,
          price: 100,
          available: true,
        },
      });
    }
  }
}

const embeddings: EmbeddingClient = {
  dimension: DIMENSION,
  embed: async ({ texts }) => texts.map(() => [1, 0, 0]),
};

/** Ports the old engine must never touch on the v2 path. */
const untouchable = {
  classifier: { classify: () => Promise.reject(new Error("unexpected classification")) } as QueryClassifier,
  extractor: { extract: () => Promise.reject(new Error("unexpected intent")) } as IntentExtractor,
  retriever: { retrieve: () => Promise.reject(new Error("unexpected retrieval")) } as Retriever,
};

function ledger(): CostRecorder & { rows: AiCallUsage[] } {
  const recorder = {
    rows: [] as AiCallUsage[],
    async record(usage: AiCallUsage) {
      recorder.rows.push(usage);
    },
  };
  return recorder;
}

/** A recording answering the judge for one query, keyed like every replay. */
function recording(query: string, output: unknown): Record<string, LlmRecording> {
  return {
    judge: {
      modelId: "gemini-3.5-flash-lite",
      provenance: "synthesized",
      entries: { [query]: { output, inputTokens: 900, outputTokens: 60 } },
    },
  };
}

describe("the judge on Engine v2 (on the database)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
    await db.productCard.deleteMany();
    await db.productVariant.deleteMany();
    await db.catalogProduct.deleteMany();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  function orchestrator(
    llm: LlmClient | undefined,
    options: { deadlineMs?: number; findSetSize?: number } = {},
  ): SearchOrchestrator {
    return createSearchOrchestrator({
      db,
      ...untouchable,
      classicStore: createPgTrgmClassicStore(db),
      find: createFindStep({
        db,
        embeddings,
        classicStore: createPgTrgmClassicStore(db),
        ...(options.findSetSize !== undefined ? { findSetSize: options.findSetSize } : {}),
      }),
      engineV2: true,
      ...(llm !== undefined ? { judge: createLlmJudge({ llm }) } : {}),
      ...(options.deadlineMs !== undefined ? { judgeDeadlineMs: options.deadlineMs } : {}),
    });
  }

  const search = (engine: SearchOrchestrator, request: Partial<SearchRequest> = {}) =>
    engine.runSearch({ query: "an outfit for tonight", shopDomain: SHOP, ...request });

  const FOUR = [
    { productId: "p1", title: "Navy Midi Dress", y: 0.1 },
    { productId: "p2", title: "Beach Sandal", y: 0.2 },
    { productId: "p3", title: "Black Midi Dress", y: 0.3 },
    { productId: "p4", title: "Black Maxi Dress", y: 0.4 },
  ];

  it("orders the page by verdict, ties in find order, with labels on the wire and verdicts only in details (AC-5, AC-9, AC-12)", async () => {
    await seed(db, FOUR);
    const costs = ledger();
    const llm = createReplayLlmClient({
      recordings: recording(
        "an outfit for tonight",
        answer(["VFF", "N-X", "E-X", "CDC"], [{ n: 1, p: "navy", a: "black" }]),
      ),
      costRecorder: costs,
    });
    const response = await search(orchestrator(llm));

    expect(response.hits.map((hit) => hit.productId)).toEqual(["p3", "p1", "p4", "p2"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judged", engine: "v2" });
    expect(response.stages.judge).toBeGreaterThanOrEqual(0);
    expect(costs.rows.map((row) => row.operation)).toEqual(["judge"]);

    const wire = serializeProxySearchResponse(response);
    expect(wire.results.map((result) => result.label)).toEqual([
      null,
      { template: "fact-differs", values: ["navy", "black"] },
      { template: "close-match", values: [] },
      null,
    ]);
    // The storefront wire carries no verdict (AC-12).
    expect(JSON.stringify(wire)).not.toContain("verdict");
    expect(JSON.stringify(wire)).not.toContain("not-relevant");

    const playground = serializePlaygroundSearchResponse(response, {
      routeReason: response.routeReason,
      latencyMs: 5,
      limited: null,
      stages: response.stages,
      intentTier: response.intentTier,
      engine: response.engine,
    });
    expect(playground.details.judge).toEqual({
      outcome: "judged",
      verdicts: [
        { productId: "p3", verdict: "exact" },
        { productId: "p1", verdict: "other-variant" },
        { productId: "p4", verdict: "close" },
        { productId: "p2", verdict: "not-relevant" },
      ],
    });
    expect(Object.keys(playground.details.stages)).toContain("judge");
  });

  it("sends one compact row per candidate, from the card, the variants and the catalog row (AC-2)", async () => {
    await seed(db, [
      {
        productId: "p1",
        title: "Navy Midi Dress",
        y: 0.1,
        summary: "Navy long-sleeve midi dress.",
        options: [
          [
            { name: "Color", value: "Navy" },
            { name: "Size", value: "S" },
          ],
          [
            { name: "Color", value: "Navy" },
            { name: "Size", value: "M" },
          ],
        ],
      },
      { productId: "p2", title: "Plain Tee", y: 0.2, description: "Soft cotton tee." },
    ]);
    const candidates = await loadJudgeCandidates(db, SHOP, ["p2", "p1"]);
    expect(candidates.map((entry) => entry.id)).toEqual(["p2", "p1"]);
    expect(candidates[1]).toMatchObject({
      summary: "Navy long-sleeve midi dress.",
      options: [
        { name: "Color", values: ["Navy"] },
        { name: "Size", values: ["S", "M"] },
      ],
    });
    expect(candidates[0]).toMatchObject({ summary: null, description: "Soft cotton tee.", options: [] });

    const llm = scriptedLlm([answer(["E-X", "E-X"])]);
    await search(orchestrator(llm), { query: "navy dress" });
    expect(llm.requests).toHaveLength(1);
    const prompt = llm.requests[0]!.prompt;
    expect(prompt).toContain("1. Navy Midi Dress | 100 USD | Color: Navy; Size: S, M | Navy long-sleeve midi dress.");
    expect(prompt).toContain("2. Plain Tee | 100 USD | Soft cotton tee.");
  });

  it("retries an invalid answer once, then serves find order as judge-error (AC-4, AC-7)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([answer(["E-X"])]);
    const response = await search(orchestrator(llm));
    expect(llm.requests).toHaveLength(2);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judge-error", degraded: false });
    expect(response.hits.every((hit) => hit.label === null && hit.verdict === undefined)).toBe(true);
  });

  it("serves find order when the judge call fails, with no error reaching the shopper (AC-7)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([() => Promise.reject(new Error("upstream 503"))]);
    const response = await search(orchestrator(llm));
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judge-error" });
  });

  it("serves find order when the judge misses its deadline, and aborts the call (AC-6)", async () => {
    await seed(db, FOUR);
    let aborted = false;
    const slow: LlmClient = {
      completeStructured: (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          // Answers, but long after the deadline.
          setTimeout(
            () => resolve(answer(["N-X", "C-C", "V-X", "E-X"])),
            500,
          );
        }),
    };
    const startedAt = Date.now();
    const response = await search(orchestrator(slow, { deadlineMs: 30 }));
    expect(Date.now() - startedAt).toBeLessThan(450);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judge-timeout" });
    expect(aborted).toBe(true);
  });

  it("serves find order with close-match on every card when the judge rejects every candidate (AC-8)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([
      answer(["N-X", "NDX", "N-X", "NBX"]),
    ]);
    const response = await search(orchestrator(llm));
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response.routeReason).toBe("judged");
    expect(serializeProxySearchResponse(response).results.map((result) => result.label)).toEqual(
      Array(4).fill({ template: "close-match", values: [] }),
    );
  });

  it("makes no judge call under a throttle or a playground cap: find order, capped, classic route (AC-7, AC-11)", async () => {
    await seed(db, FOUR);
    const costs = ledger();
    const llm = createReplayLlmClient({ recordings: recording("an outfit for tonight", answer([])), costRecorder: costs });
    // The proxy's throttle and the playground's caps both force classic.
    const response = await search(orchestrator(llm), { forceClassic: true });
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "classic", routeReason: "capped", engine: "v2" });
    expect(costs.rows).toEqual([]);
    expect(response.stages.judge).toBeUndefined();
    expect(serializeProxySearchResponse(response).results.every((result) => result.label === null)).toBe(true);
  });

  it("keeps the client-timeout rescue on the keyword path, with no judge call", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([answer([])]);
    const response = await search(orchestrator(llm), {
      query: "dress",
      forceClassic: true,
      forceClassicReason: "client-timeout-rescue",
    });
    expect(response.routeReason).toBe("client-timeout-rescue");
    expect(llm.requests).toHaveLength(0);
  });

  it("serves pages beyond the find set in keyword order with no judge call (AC-10)", async () => {
    await seed(db, [
      { productId: "v1", title: "Silk Gown", y: 0.1 },
      { productId: "v2", title: "Chiffon Maxi", y: 0.2 },
      { productId: "k1", title: "Evening Party Clutch" },
      { productId: "k2", title: "Party Evening Shoes" },
    ]);
    const query = "something for an evening party";
    const llm = scriptedLlm([answer(["CDC", "E-X"])]);
    // A two-product find set; pages of two.
    const engine = orchestrator(llm, { findSetSize: 2 });

    const page1 = await search(engine, { query, paging: { page: 1, pageSize: 2 } });
    expect(page1.hits.map((hit) => hit.productId)).toEqual(["v2", "v1"]);
    expect(page1).toMatchObject({ route: "ai", routeReason: "judged" });
    expect(llm.requests).toHaveLength(1);

    const page2 = await search(engine, { query, paging: { page: 2, pageSize: 2 } });
    expect(page2).toMatchObject({ route: "classic", routeReason: "find-only", totalCount: 4 });
    expect(page2.hits.every((hit) => hit.label === null)).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it("judges only the find-set part of a page straddling the boundary, the keyword tail after it (AC-10)", async () => {
    await seed(db, [
      { productId: "v1", title: "Silk Gown", y: 0.1 },
      { productId: "v2", title: "Chiffon Maxi", y: 0.2 },
      { productId: "k1", title: "Evening Party Clutch" },
    ]);
    const llm = scriptedLlm([answer(["CDC", "E-X"])]);
    const response = await search(orchestrator(llm, { findSetSize: 2 }), { query: "something for an evening party" });
    expect(response.hits.map((hit) => hit.productId)).toEqual(["v2", "v1", "k1"]);
    expect(llm.requests[0]!.prompt).not.toContain("Clutch");
  });

  it("answers find-only, classic route, when no judge is wired", async () => {
    await seed(db, FOUR);
    const response = await search(orchestrator(undefined));
    expect(response).toMatchObject({ route: "classic", routeReason: "find-only" });
    expect(response.hits.map((hit) => hit.label)).toEqual([null, null, null, null]);
  });

  it("leaves the old engine's wire without a label key", async () => {
    await seed(db, FOUR);
    const v1 = await createSearchOrchestrator({
      db,
      ...untouchable,
      classifier: {
        classify: () => Promise.resolve({ route: "classic", reason: "short-query" }),
      },
      classicStore: createPgTrgmClassicStore(db),
    }).runSearch({ query: "dress", shopDomain: SHOP });
    expect(v1.engine).toBe("v1");
    for (const result of serializeProxySearchResponse(v1).results) {
      expect(result).not.toHaveProperty("label");
    }
  });
});
