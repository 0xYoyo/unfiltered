import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  buildExtractPrompt,
  buildJudgePrompt,
  createLlmJudge,
  createWishExtractor,
  NO_WISHES,
  parseExtractAnswer,
  parseJudgeAnswer,
  type EmbeddingClient,
  type ExtractedWishes,
  type IntentExtractor,
  type JudgeCandidate,
  type LlmClient,
  type QueryClassifier,
  type Retriever,
  type StructuredCompletionRequest,
  type WishExtractor,
} from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { serializePlaygroundSearchResponse } from "../playground/api.server";
import { createTestDb } from "../testing/helpers.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import { extractionCacheKey } from "./extraction-cache.server";
import { createFindStep, mergeNearest } from "./find.server";
import { judgeCacheKey, resetPendingLabels } from "./judge-step.server";
import { createSearchOrchestrator, nextCarry, type SearchRequest } from "./orchestrator.server";
import {
  parseProxySearchBody,
  parseProxySearchParams,
  serializeProxySearchResponse,
} from "./proxy.server";

// Refinement and the two-meanings chip (YOY-150): the previous sentence
// reaches find, the extraction and the judge; the response carries `carry`
// and, on page 1, the judge's second reading. Offline and $0: every model
// call is a scripted fake.

const SHOP = "refinement-shop.myshopify.com";
const DIMENSION = 3;

describe("the carry (AC-3)", () => {
  it("is the query alone on a fresh search and when the query replaces the chain", () => {
    expect(nextCarry("black dress", undefined, null)).toBe("black dress");
    expect(nextCarry("running shoes", "black dress", false)).toBe("running shoes");
  });

  it("appends a refinement, and a late extraction counts as refining", () => {
    expect(nextCarry("cheaper", "black dress", true)).toBe("black dress\ncheaper");
    expect(nextCarry("cheaper", "black dress", null)).toBe("black dress\ncheaper");
  });

  it("keeps the chain's first sentence and its two most recent refinements", () => {
    const chain = "black dress\ncheaper\nin size M";
    expect(nextCarry("long sleeves", chain, true)).toBe("black dress\nin size M\nlong sleeves");
    expect(nextCarry("no lace", "black dress\nin size M\nlong sleeves", null)).toBe(
      "black dress\nlong sleeves\nno lace",
    );
  });

  it("holds each sentence on one line, so a newline only ever separates sentences", () => {
    expect(nextCarry("  same\n but   cheaper ", " black \n\n dress ", true)).toBe(
      "black\ndress\nsame but cheaper",
    );
  });
});

describe("the extraction reads both sentences (AC-2)", () => {
  it("shows the previous search and asks whether the new one refines or replaces it", () => {
    const prompt = buildExtractPrompt("same but cheaper", "black dress\nlong sleeves");
    expect(prompt).toContain("Previous search: black dress / long sleeves");
    expect(prompt).toContain("REFINE");
    expect(prompt).toContain("REPLACE");
    expect(prompt.split("\n").at(-1)).toBe("Query: same but cheaper");
    // A fresh search's prompt is unchanged by the refinement lines.
    expect(buildExtractPrompt("black dress")).not.toContain("Previous search");
  });

  it("validates a refining answer against the chain and a replacing one against the new sentence alone", () => {
    const answer = { priceMax: 100, excluded: [{ typed: "black", english: "black" }], size: "M" };
    const refining = parseExtractAnswer({ ...answer, refines: true }, "under 100", "dress, not black, size M");
    expect(refining).toMatchObject({
      priceMax: { amount: 100, raw: "100" },
      size: "M",
      excluded: [{ typed: "black", english: "black" }],
      refines: true,
    });
    const replacing = parseExtractAnswer({ ...answer, refines: false }, "shoes under 100", "dress, not black, size M");
    expect(replacing).toMatchObject({ priceMax: { amount: 100 }, size: null, excluded: [], refines: false });
  });

  it("reads a missing refines as refining, and carries none without a previous sentence", () => {
    expect(parseExtractAnswer({ excluded: [] }, "cheaper", "black dress")!.refines).toBe(true);
    expect(parseExtractAnswer({ excluded: [], refines: true }, "black dress")).not.toHaveProperty("refines");
  });

  it("sends the previous sentence in the call, and caches the chain apart from the sentence alone", async () => {
    const requests: StructuredCompletionRequest[] = [];
    const extractor = createWishExtractor({
      llm: {
        async completeStructured(request) {
          requests.push(request);
          return { excluded: [], refines: true };
        },
      },
    });
    await extractor.extract({ sentence: "cheaper", previousSentence: "black dress" });
    expect(requests[0]!.prompt).toContain("Previous search: black dress");
    const alone = extractionCacheKey({ sentence: "cheaper", modelId: "m" });
    expect(extractionCacheKey({ sentence: "cheaper", previousSentence: "black dress", modelId: "m" })).not.toBe(alone);
    expect(extractionCacheKey({ sentence: "cheaper", previousSentence: "", modelId: "m" })).toBe(alone);
  });
});

function candidate(id: string): JudgeCandidate {
  return {
    id,
    title: `Product ${id}`,
    priceMin: 100,
    priceMax: 100,
    currencyCode: "USD",
    options: [],
    facts: null,
    attributes: [],
    description: "",
  };
}

describe("the judge reads both sentences and names a second reading (AC-2, AC-7)", () => {
  const page = [candidate("a"), candidate("b")];

  it("shows the previous search before the query, and asks for r and rn", () => {
    const prompt = buildJudgePrompt("cheaper", page, undefined, "black dress");
    expect(prompt).toContain("Previous search: black dress");
    expect(prompt).toContain("may refine the previous one");
    expect(prompt.indexOf("Previous search")).toBeLessThan(prompt.indexOf("Query: cheaper"));
    expect(prompt).toContain("r: when the search can honestly mean a second");
    expect(buildJudgePrompt("cheaper", page)).not.toContain("Previous search");
  });

  it("keeps a reading of at most four words that a listed product fits", () => {
    const codes = { c: ["E-X", "N-X"], d: [], x: [] };
    expect(parseJudgeAnswer({ ...codes, r: "Bridal gowns", rn: [2] }, page)!.otherReading).toBe("Bridal gowns");
    expect(parseJudgeAnswer({ ...codes, r: " שמלות  כלה ", rn: [1] }, page)!.otherReading).toBe("שמלות כלה");
    expect(parseJudgeAnswer({ ...codes, r: "a b c d", rn: [1] }, page)!.otherReading).toBe("a b c d");
  });

  it("drops a reading no product fits, one over four words, and an empty one — never failing the answer", () => {
    const codes = { c: ["E-X", "N-X"], d: [], x: [] };
    for (const extra of [
      { r: "Bridal gowns", rn: [] },
      { r: "Bridal gowns", rn: [3] },
      { r: "Bridal gowns for the bride", rn: [1] },
      { r: "", rn: [1] },
      { r: 4, rn: [1] },
      {},
    ]) {
      const parsed = parseJudgeAnswer({ ...codes, ...extra }, page);
      expect(parsed).not.toBeNull();
      expect(parsed!.otherReading).toBeNull();
    }
  });

  it("sends the previous sentence in the judge call, and caches the chain apart", async () => {
    const requests: StructuredCompletionRequest[] = [];
    const judge = createLlmJudge({
      llm: {
        async completeStructured(request) {
          requests.push(request);
          return { c: ["E-X", "E-X"], d: [], x: [], r: "", rn: [] };
        },
      },
    });
    const answer = await judge.judge({ sentence: "cheaper", previousSentence: "black dress", candidates: page });
    expect(answer.otherReading).toBeNull();
    expect(requests[0]!.prompt).toContain("Previous search: black dress");
    const key = (previousSentence?: string) =>
      judgeCacheKey({
        sentence: "cheaper",
        ...(previousSentence !== undefined ? { previousSentence } : {}),
        candidates: [{ id: "a", cardTextHash: "" }],
        identity: "j",
      });
    expect(key("black dress")).not.toBe(key());
    expect(key("")).toBe(key());
  });
});

describe("the find step merges both candidate sets (AC-1)", () => {
  it("merges nearest first, each product once at its nearer distance", () => {
    expect(
      mergeNearest([
        [
          { productId: "a", distance: 0.1 },
          { productId: "b", distance: 0.4 },
        ],
        [
          { productId: "c", distance: 0.2 },
          { productId: "b", distance: 0.3 },
          { productId: "a", distance: 0.5 },
        ],
      ]).map((hit) => [hit.productId, hit.distance]),
    ).toEqual([
      ["a", 0.1],
      ["c", 0.2],
      ["b", 0.3],
    ]);
  });
});

const untouchable = {
  classifier: { classify: () => Promise.reject(new Error("unexpected classification")) } as QueryClassifier,
  extractor: { extract: () => Promise.reject(new Error("unexpected intent")) } as IntentExtractor,
  retriever: { retrieve: () => Promise.reject(new Error("unexpected retrieval")) } as Retriever,
};

/**
 * An embedding port recording each call's texts: the new sentence alone
 * lands on [1, 0, 0], any text holding a newline — the chain plus the new
 * sentence — on [0, 1, 0].
 */
function recordingEmbeddings(): EmbeddingClient & { calls: string[][] } {
  const client = {
    dimension: DIMENSION,
    calls: [] as string[][],
    async embed({ texts }: { texts: string[] }) {
      client.calls.push([...texts]);
      return texts.map((text) => (text.includes("\n") ? [0, 1, 0] : [1, 0, 0]));
    },
  };
  return client;
}

async function seed(db: PrismaClient, products: Array<{ productId: string; title: string; vector: number[] }>) {
  for (const entry of products) {
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: entry.productId,
        title: entry.title,
        description: "",
        tags: [],
        vendor: "fixture",
        productType: "",
        priceMin: 100,
        priceMax: 100,
        currencyCode: "USD",
        available: true,
        imageAltTexts: [],
        sourceUpdatedAt: new Date(),
        contentHash: `hash-${entry.productId}`,
      },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
       VALUES ($1, $2, $3, 'prose', 'h', $4::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
      randomUUID(),
      SHOP,
      entry.productId,
      `[${entry.vector.join(",")}]`,
    );
  }
}

/** An extractor answering fixed wishes after `delayMs`, recording each request. */
function recordingExtractor(
  answer: ExtractedWishes,
  delayMs = 0,
): WishExtractor & { requests: Array<{ sentence: string; previousSentence?: string }> } {
  const extractor = {
    modelId: "fake-extract",
    requests: [] as Array<{ sentence: string; previousSentence?: string }>,
    extract: (request: { sentence: string; previousSentence?: string }) => {
      extractor.requests.push(request);
      return new Promise<ExtractedWishes>((resolve) => setTimeout(() => resolve(answer), delayMs));
    },
  };
  return extractor;
}

/** A judge LLM answering every product exact, with reading `r` fitting product numbers `rn`. */
function readingJudge(r: string, rn: number[]): LlmClient & { prompts: string[] } {
  const llm = {
    prompts: [] as string[],
    async completeStructured(request: StructuredCompletionRequest) {
      llm.prompts.push(request.prompt);
      const count = request.prompt.split("\n").filter((line) => /^\d+\. /.test(line)).length;
      return { c: Array.from({ length: count }, () => "E-X"), d: [], x: [], r, rn };
    },
  };
  return llm;
}

describe("refinement and the second reading on Engine v2 (on the database)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
    await db.catalogProduct.deleteMany();
    await db.judgeAnswer.deleteMany();
    await db.judgeVerdict.deleteMany();
    await db.extractionAnswer.deleteMany();
    resetPendingLabels();
    // "near-new" sits by the new sentence's vector, "near-chain" by the
    // chain's; each is far from the other vector.
    await seed(db, [
      { productId: "near-new", title: "Gown", vector: [1, 0.05, 0] },
      { productId: "near-chain", title: "Frock", vector: [0.05, 1, 0] },
    ]);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  function orchestrator(options: {
    embeddings: EmbeddingClient;
    extractor?: WishExtractor;
    judge?: LlmClient;
    graceMs?: number;
    findSetSize?: number;
  }) {
    return createSearchOrchestrator({
      db,
      ...untouchable,
      classicStore: createPgTrgmClassicStore(db),
      find: createFindStep({
        db,
        embeddings: options.embeddings,
        classicStore: createPgTrgmClassicStore(db),
        findSetSize: options.findSetSize ?? 1,
      }),
      engineV2: true,
      ...(options.extractor !== undefined ? { wishExtractor: options.extractor } : {}),
      ...(options.judge !== undefined ? { judge: createLlmJudge({ llm: options.judge }) } : {}),
      ...(options.graceMs !== undefined ? { extractionGraceMs: options.graceMs } : {}),
    });
  }

  const search = (engine: ReturnType<typeof orchestrator>, request: Partial<SearchRequest> = {}) =>
    engine.runSearch({ query: "cheaper", shopDomain: SHOP, ...request });

  it("embeds the new sentence alone and the chain plus it in one call, and merges both nearest sets (AC-1)", async () => {
    const embeddings = recordingEmbeddings();
    const fresh = await search(orchestrator({ embeddings }));
    expect(embeddings.calls).toEqual([["cheaper"]]);
    expect(fresh.hits.map((hit) => hit.productId)).toEqual(["near-new"]);

    const refined = await search(orchestrator({ embeddings }), { previousQuery: "black dress" });
    // The new sentence's vector is cached by its own step instance only, so
    // the refined search embeds both texts in its one call.
    expect(embeddings.calls.at(-1)).toEqual(["cheaper", "black dress\ncheaper"]);
    expect(embeddings.calls).toHaveLength(2);
    expect(refined.hits.map((hit) => hit.productId).sort()).toEqual(["near-chain", "near-new"]);
  });

  it("passes the chain to the extraction and the judge, and carries the refinement (AC-2, AC-3)", async () => {
    const extractor = recordingExtractor({ ...NO_WISHES, refines: true });
    const judge = readingJudge("", []);
    const response = await search(
      orchestrator({ embeddings: recordingEmbeddings(), extractor, judge }),
      { previousQuery: "black dress" },
    );
    expect(extractor.requests[0]).toMatchObject({ sentence: "cheaper", previousSentence: "black dress" });
    expect(judge.prompts[0]).toContain("Previous search: black dress");
    expect(response.carry).toBe("black dress\ncheaper");
    expect(response).not.toHaveProperty("otherReading");
  });

  it("carries the new sentence alone when the extraction says it replaces the chain (AC-3)", async () => {
    const response = await search(
      orchestrator({ embeddings: recordingEmbeddings(), extractor: recordingExtractor({ ...NO_WISHES, refines: false }) }),
      { query: "running shoes", previousQuery: "black dress" },
    );
    expect(response.carry).toBe("running shoes");
  });

  it("treats a late extraction as refining (AC-3)", async () => {
    const late = recordingExtractor({ ...NO_WISHES, refines: false }, 200);
    const response = await search(
      orchestrator({ embeddings: recordingEmbeddings(), extractor: late, graceMs: 10 }),
      { previousQuery: "black dress" },
    );
    expect(response.extractionInTime).toBe(false);
    expect(response.carry).toBe("black dress\ncheaper");
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it("carries the query on a fresh search, with no extractor wired", async () => {
    const response = await search(orchestrator({ embeddings: recordingEmbeddings() }), { query: "wedding dress" });
    expect(response.carry).toBe("wedding dress");
  });

  it("answers the second reading on page 1 only, on both wires (AC-7)", async () => {
    const judge = readingJudge("Bridal gowns", [1]);
    const engine = orchestrator({ embeddings: recordingEmbeddings(), judge, findSetSize: 2 });
    const first = await search(engine, { query: "wedding dress", paging: { page: 1, pageSize: 1 } });
    expect(first.otherReading).toBe("Bridal gowns");
    expect(serializeProxySearchResponse(first)).toMatchObject({ otherReading: "Bridal gowns", carry: "wedding dress" });
    const playground = serializePlaygroundSearchResponse(first, {
      routeReason: first.routeReason,
      latencyMs: 1,
      limited: null,
      stages: first.stages,
      intentTier: null,
      engine: "v2",
    });
    expect(playground.otherReading).toBe("Bridal gowns");
    const second = await search(engine, { query: "wedding dress", paging: { page: 2, pageSize: 1 } });
    expect(second.hits).toHaveLength(1);
    expect(second).not.toHaveProperty("otherReading");
  });

  it("serves the second reading from the judge cache too", async () => {
    const judge = readingJudge("Bridal gowns", [1]);
    const engine = orchestrator({ embeddings: recordingEmbeddings(), judge });
    await search(engine, { query: "wedding dress" });
    const cached = await search(engine, { query: "wedding dress" });
    expect(cached.routeReason).toBe("judge-cached");
    expect(cached.otherReading).toBe("Bridal gowns");
    expect(judge.prompts).toHaveLength(1);
  });

  it("ignores the chain on the old engine (NG-4): no carry", async () => {
    const engine = createSearchOrchestrator({
      db,
      ...untouchable,
      classifier: {
        classify: () => Promise.resolve({ route: "classic", reason: "short-query" }),
        settled: () => ({ route: "classic", reason: "short-query" }),
      } as QueryClassifier,
      classicStore: createPgTrgmClassicStore(db),
    });
    const response = await engine.runSearch({ query: "gown", shopDomain: SHOP, previousQuery: "black dress" });
    expect(response.engine).toBe("v1");
    expect(response).not.toHaveProperty("carry");
  });
});

describe("previousQuery on the wire (AC-1)", () => {
  const base = { query: "cheaper", sessionId: "s" };

  it("is accepted as a plain string on both transports", () => {
    expect(parseProxySearchBody({ ...base, previousQuery: "black dress\nlong" })).toMatchObject({
      previousQuery: "black dress\nlong",
    });
    const params = new URLSearchParams({ ...base, previousQuery: "black dress\nlong" });
    expect(parseProxySearchParams(params)).toMatchObject({ previousQuery: "black dress\nlong" });
  });

  it("drops a blank one and rejects a non-string, an overlong one, and one on a preview or classic rescue", () => {
    expect(parseProxySearchBody({ ...base, previousQuery: "  " })).not.toHaveProperty("previousQuery");
    expect(parseProxySearchBody({ ...base, previousQuery: 4 })).toBeNull();
    expect(parseProxySearchBody({ ...base, previousQuery: "x".repeat(2001) })).toBeNull();
    expect(parseProxySearchBody({ ...base, previousQuery: "a", mode: "preview" })).toBeNull();
    expect(parseProxySearchBody({ ...base, previousQuery: "a", mode: "classic" })).toBeNull();
  });
});
