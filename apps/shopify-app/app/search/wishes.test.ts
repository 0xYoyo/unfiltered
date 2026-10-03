import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  buildExtractPrompt,
  createLlmJudge,
  createWishExtractor,
  EXTRACT_SCHEMA,
  NO_WISHES,
  parseExtractAnswer,
  statedCurrency,
  type EmbeddingClient,
  type ExtractedWishes,
  type IntentExtractor,
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
import { createFindStep } from "./find.server";
import { extractionCacheKey, sentenceLanguage } from "./extraction-cache.server";
import { resetPendingLabels } from "./judge-step.server";
import { createSearchOrchestrator, type SearchRequest } from "./orchestrator.server";
import {
  parseProxySearchBody,
  parseProxySearchParams,
  serializeProxySearchResponse,
} from "./proxy.server";
import {
  composeWishes,
  convertAmount,
  CURRENCY_RATES,
  extractionGraceMsFromEnv,
  holdsWholeWord,
  keepUnremoved,
  priceNearPercentFromEnv,
  tierFrontSizeFromEnv,
  wishChips,
  type CurrencyRates,
  type WishProduct,
} from "./wishes.server";

// Engine v2's stated wishes (YOY-149): the extraction validated against the
// sentence, then applied by code — walls, number tiers, exclusions and the
// code-computed labels — and the chips a shopper can remove. Offline and $0:
// every model call is a scripted fake.

const SHOP = "wishes-shop.myshopify.com";
const DIMENSION = 3;

const wishes = (overrides: Partial<ExtractedWishes>): ExtractedWishes => ({ ...NO_WISHES, ...overrides });

describe("the extraction keeps only what the sentence states (AC-1, AC-2)", () => {
  it("asks for the stated fields only, every one nullable, under operation extract", async () => {
    expect(Object.keys(EXTRACT_SCHEMA.properties as object).sort()).toEqual([
      "currency",
      "excluded",
      "inStock",
      "priceFirm",
      "priceMax",
      "priceMin",
      "size",
      "sizeFirm",
    ]);
    const requests: StructuredCompletionRequest[] = [];
    const extractor = createWishExtractor({
      llm: {
        async completeStructured(request) {
          requests.push(request);
          return { priceMax: 400, currency: "ILS", excluded: [] };
        },
      },
    });
    const kept = await extractor.extract({ sentence: "שמלה עד 400" });
    expect(requests[0]).toMatchObject({ operation: "extract", temperature: 0 });
    expect(requests[0]!.prompt).toContain("\nQuery: שמלה עד 400");
    expect(kept.priceMax).toEqual({ amount: 400, raw: "400" });
    expect(kept.currency).toBe("ILS");
  });

  it("discards a price whose digits are not in the sentence, and a size or term not written there", () => {
    const sentence = "black dress under 1,200 in size M, not wool";
    const parsed = parseExtractAnswer(
      {
        priceMax: 1200,
        priceMin: 50,
        currency: "usd",
        size: "Medium",
        inStock: null,
        excluded: [
          { typed: "wool", english: "wool" },
          { typed: "polyester", english: "polyester" },
        ],
        priceFirm: null,
        sizeFirm: true,
      },
      sentence,
    )!;
    expect(parsed.priceMax).toEqual({ amount: 1200, raw: "1200" });
    expect(parsed.priceMin).toBeNull();
    expect(parsed.currency).toBe("USD");
    // "Medium" is not written; "M" would be.
    expect(parsed.size).toBeNull();
    expect(parsed.sizeFirm).toBe(false);
    expect(parsed.excluded).toEqual([{ typed: "wool", english: "wool" }]);
    expect(parseExtractAnswer({ size: "m" }, sentence)!.size).toBe("m");
    // 12 is not 1,200, and 40 is not 400.
    expect(parseExtractAnswer({ priceMax: 12 }, sentence)!.priceMax).toBeNull();
    expect(parseExtractAnswer({ priceMax: 40 }, "עד 400")!.priceMax).toBeNull();
    expect(parseExtractAnswer("nope", sentence)).toBeNull();
  });

  it("keeps the excluded thing, never its negation, and treats under and up to as soft", () => {
    const parsed = parseExtractAnswer(
      { excluded: [{ typed: "not black", english: "not black" }, { typed: "לא צמר", english: "no wool" }] },
      "dress not black לא צמר",
    )!;
    expect(parsed.excluded).toEqual([
      { typed: "black", english: "black" },
      { typed: "צמר", english: "wool" },
    ]);
    expect(buildExtractPrompt("x")).toContain('"עד" are NOT firm');
  });

  it("falls back to the currency the sentence states when the model names none (AC-17)", () => {
    expect(parseExtractAnswer({ priceMax: 400, currency: null }, "עד 400")!.currency).toBe("ILS");
    expect(parseExtractAnswer({ priceMax: 80 }, "shirt under $80")!.currency).toBe("USD");
    expect(parseExtractAnswer({ priceMax: 80 }, "shirt under 80 EUR")!.currency).toBe("EUR");
    expect(parseExtractAnswer({ priceMax: 80 }, "shirt under 80")!.currency).toBeNull();
    expect(parseExtractAnswer({ priceMax: 80, currency: "GBP" }, "שמלה עד 80")!.currency).toBe("GBP");
    expect(parseExtractAnswer({ currency: "ILS" }, "שמלה")!.currency).toBeNull();
    expect(statedCurrency('עד 300 ש"ח')).toBe("ILS");
  });

  it("keeps a Hebrew excluded term with its English form", () => {
    const parsed = parseExtractAnswer(
      { excluded: [{ typed: "שחור", english: "black" }] },
      "שמלה לא שחור",
    )!;
    expect(parsed.excluded).toEqual([{ typed: "שחור", english: "black" }]);
    expect(buildExtractPrompt("x")).toContain("excluded");
  });
});

describe("removed chips and chip values (AC-14, AC-15)", () => {
  const all = wishes({
    priceMax: { amount: 400, raw: "400" },
    priceMin: { amount: 50, raw: "50" },
    currency: "ILS",
    size: "M",
    inStock: true,
    excluded: [{ typed: "שחור", english: "black" }],
    priceFirm: true,
    sizeFirm: true,
  });

  it("carries one chip per kept fact, a price chip with the shopper's own number and currency", () => {
    expect(wishChips(all)).toEqual([
      { field: "priceMax", value: "400", currency: "ILS" },
      { field: "priceMin", value: "50", currency: "ILS" },
      { field: "size", value: "M" },
      { field: "availability", value: "in stock" },
      { field: "exclude", value: "שחור" },
    ]);
    expect(wishChips(wishes({ priceMax: { amount: 30, raw: "30" } }))).toEqual([
      { field: "priceMax", value: "30" },
    ]);
  });

  it("drops a removed fact and its chip", () => {
    const kept = keepUnremoved(all, [
      { field: "priceMax", value: "400" },
      { field: "exclude", value: "שחור" },
      { field: "size", value: "m" },
    ]);
    expect(wishChips(kept).map((chip) => chip.field)).toEqual(["priceMin", "availability"]);
    expect(kept.sizeFirm).toBe(false);
    expect(keepUnremoved(all, [{ field: "availability", value: "in stock" }]).inStock).toBe(false);
  });

  it("parses removedChips from a body and from query parameters", () => {
    const removed = [{ field: "priceMax", value: "400" }];
    expect(parseProxySearchBody({ query: "q", sessionId: "s", removedChips: removed })!.removedChips).toEqual(
      removed,
    );
    expect(
      parseProxySearchParams(
        new URLSearchParams({ query: "q", sessionId: "s", removedChips: JSON.stringify(removed) }),
      )!.removedChips,
    ).toEqual(removed);
    for (const bad of [[{ field: "category", value: "x" }], [{ field: "size" }], "nope", [{ field: "size", value: 3 }]]) {
      expect(parseProxySearchBody({ query: "q", sessionId: "s", removedChips: bad })).toBeNull();
    }
    expect(
      parseProxySearchParams(new URLSearchParams({ query: "q", sessionId: "s", removedChips: "{" })),
    ).toBeNull();
  });

  it("reads the grace and the near band from the environment", () => {
    expect(extractionGraceMsFromEnv({})).toBe(800);
    expect(extractionGraceMsFromEnv({ EXTRACTION_GRACE_MS: "0" })).toBe(0);
    expect(() => extractionGraceMsFromEnv({ EXTRACTION_GRACE_MS: "x" })).toThrow(/EXTRACTION_GRACE_MS/);
    expect(priceNearPercentFromEnv({})).toBe(10);
    expect(priceNearPercentFromEnv({ PRICE_NEAR_PERCENT: "15" })).toBe(15);
  });
});

describe("currency conversion (AC-7)", () => {
  const rates: CurrencyRates = { asOf: "2026-10-03", perUsd: { USD: 1, ILS: 4, EUR: 0.5 } };
  it("converts through USD and leaves an unlisted pair unapplied", () => {
    expect(convertAmount(400, "ILS", "USD", rates)).toBe(100);
    expect(convertAmount(100, "EUR", "ILS", rates)).toBe(800);
    expect(convertAmount(5, "USD", "USD", rates)).toBe(5);
    expect(convertAmount(100, "JPY", "USD", rates)).toBeNull();
  });

  it("ships a current table: 400 ILS is roughly $131, not a years-old rate (YOY-150 AC-13)", () => {
    expect(CURRENCY_RATES.asOf >= "2026-10-02").toBe(true);
    const usd = convertAmount(400, "ILS", "USD");
    expect(usd).not.toBeNull();
    expect(usd!).toBeGreaterThan(120);
    expect(usd!).toBeLessThan(140);
  });
});

/** A product for the pure composer: one variant per size, all at its price. */
function product(
  productId: string,
  price: number,
  overrides: Partial<WishProduct> = {},
): WishProduct {
  return {
    productId,
    priceMin: price,
    priceMax: price,
    currencyCode: "USD",
    available: true,
    variants: [],
    facts: "",
    ...overrides,
  };
}

const sized = (sizes: Array<[string, boolean]>, name = "Size") =>
  sizes.map(([value, available]) => ({ options: [{ name, value }], available }));

describe("composing the wishes (AC-5 – AC-10, AC-12)", () => {
  const rates: CurrencyRates = { asOf: "2026-10-03", perUsd: { USD: 1, ILS: 4 } };

  it("sorts the whole find set into number tiers before pages are cut, each in find order", () => {
    const products = new Map(
      [
        product("far", 200),
        product("ok1", 90),
        product("near", 105),
        product("ok2", 100),
        product("tail-far", 500),
      ].map((entry) => [entry.productId, entry]),
    );
    const composed = composeWishes(
      ["far", "ok1", "near", "ok2", "tail-far"],
      4,
      products,
      wishes({ priceMax: { amount: 100, raw: "100" } }),
      { rates },
    );
    expect(composed.productIds).toEqual(["ok1", "ok2", "near", "far", "tail-far"]);
    expect(composed.findSetCount).toBe(4);
    expect(composed.labels.get("near")).toEqual({ template: "price-near", values: ["105 USD", "100 USD"] });
    expect(composed.labels.get("far")).toEqual({ template: "price-far", values: ["200 USD", "100 USD"] });
    expect(composed.labels.get("ok1")).toBeUndefined();
  });

  it("tiers only the find front: a candidate past it keeps find order and never jumps ahead (AC-5, 2026-10-03)", () => {
    // Five over-budget dresses lead the find order; two cheap, unrelated
    // products sit past a front of 3.
    const products = new Map(
      [
        product("dress1", 300),
        product("dress2", 310),
        product("dress3", 50),
        product("dress4", 320),
        product("dress5", 330),
        product("cheap-sock", 5),
        product("cheap-tee", 9),
      ].map((entry) => [entry.productId, entry]),
    );
    const ids = ["dress1", "dress2", "dress3", "dress4", "dress5", "cheap-sock", "cheap-tee"];
    const composed = composeWishes(ids, 7, products, wishes({ priceMax: { amount: 100, raw: "100" } }), {
      rates,
      tierFront: 3,
    });
    expect(composed.productIds).toEqual(["dress3", "dress1", "dress2", "dress4", "dress5", "cheap-sock", "cheap-tee"]);
    expect(composed.findSetCount).toBe(7);
    expect(composed.labels.get("dress1")?.template).toBe("price-far");
    // The default front is 48 candidates.
    expect(tierFrontSizeFromEnv({})).toBe(48);
    expect(tierFrontSizeFromEnv({ TIER_FRONT_SIZE: "24" })).toBe(24);
    expect(() => tierFrontSizeFromEnv({ TIER_FRONT_SIZE: "x" })).toThrow(/TIER_FRONT_SIZE/);
  });

  it("counts the front after the walls", () => {
    const products = new Map(
      [product("a", 50, { available: false }), product("b", 200), product("c", 50)].map((entry) => [
        entry.productId,
        entry,
      ]),
    );
    const composed = composeWishes(
      ["a", "b", "c"],
      3,
      products,
      wishes({ priceMax: { amount: 100, raw: "100" }, inStock: true }),
      { rates, tierFront: 2 },
    );
    expect(composed.productIds).toEqual(["c", "b"]);
  });

  it("converts the cap from the stated currency and labels with the cap as stated", () => {
    const products = new Map([product("a", 90), product("b", 120)].map((entry) => [entry.productId, entry]));
    const composed = composeWishes(
      ["b", "a"],
      2,
      products,
      wishes({ priceMax: { amount: 400, raw: "400" }, currency: "ILS" }),
      { rates },
    );
    expect(composed.productIds).toEqual(["a", "b"]);
    expect(composed.labels.get("b")).toEqual({ template: "price-far", values: ["120 USD", "400 ILS"] });
  });

  it("leaves a cap in an unlisted currency unapplied", () => {
    const products = new Map([product("a", 90), product("b", 120)].map((entry) => [entry.productId, entry]));
    const composed = composeWishes(
      ["b", "a"],
      2,
      products,
      wishes({ priceMax: { amount: 400, raw: "400" }, currency: "JPY", priceFirm: true }),
      { rates },
    );
    expect(composed.productIds).toEqual(["b", "a"]);
    expect(composed.labels.size).toBe(0);
  });

  it("walls off a firm price over the cap, and a firm size with no in-stock variant in it", () => {
    const products = new Map(
      [
        product("cheap", 50, { variants: sized([["M", true], ["L", true]]) }),
        product("dear", 150, { variants: sized([["M", true]]) }),
        product("m-sold-out", 50, { variants: sized([["S", true], ["M", false]]) }),
        product("no-sizes", 50),
      ].map((entry) => [entry.productId, entry]),
    );
    const ids = ["cheap", "dear", "m-sold-out", "no-sizes"];
    expect(
      composeWishes(ids, 4, products, wishes({ priceMax: { amount: 100, raw: "100" }, priceFirm: true }), {
        rates,
      }).productIds,
    ).toEqual(["cheap", "m-sold-out", "no-sizes"]);
    expect(
      composeWishes(ids, 4, products, wishes({ size: "m", sizeFirm: true }), { rates }).productIds,
    ).toEqual(["cheap", "dear"]);
  });

  it("matches a size by value, ignoring case: in stock is met, sold out a miss, absent met", () => {
    const products = new Map(
      [
        product("miss", 50, { variants: sized([["XS", true], ["S", false], ["M", false], ["L", true], ["XL", true]]) }),
        product("met", 50, { variants: sized([["m", true]]) }),
        product("unknown", 50, { variants: sized([["One size", true]]) }),
      ].map((entry) => [entry.productId, entry]),
    );
    const composed = composeWishes(["miss", "met", "unknown"], 3, products, wishes({ size: "M" }), { rates });
    expect(composed.productIds).toEqual(["met", "unknown", "miss"]);
    // Nearest in-stock values in the merchant's order: L (one step), then XS (two).
    expect(composed.labels.get("miss")).toEqual({ template: "size-missing", values: ["M", "L", "XS"] });
  });

  it("removes sold-out products from the results and the count on in stock", () => {
    const products = new Map(
      [product("a", 50), product("b", 50, { available: false }), product("c", 50)].map((entry) => [
        entry.productId,
        entry,
      ]),
    );
    const composed = composeWishes(["a", "b", "c"], 2, products, wishes({ inStock: true }), { rates });
    expect(composed.productIds).toEqual(["a", "c"]);
    expect(composed.findSetCount).toBe(1);
  });

  it("excludes on every variant carrying the term, or the card facts stating it, typed or English, as a whole word", () => {
    const products = new Map(
      [
        product("all-black", 50, { variants: sized([["Black", true], ["black", false]], "Color") }),
        product("one-black", 50, { variants: sized([["Black", true], ["White", true]], "Color") }),
        product("facts-black", 50, { facts: "A black linen dress." }),
        product("blackberry", 50, { facts: "Blackberry print." }),
      ].map((entry) => [entry.productId, entry]),
    );
    const ids = ["all-black", "one-black", "facts-black", "blackberry"];
    const english = composeWishes(ids, 4, products, wishes({ excluded: [{ typed: "black", english: "black" }] }), {
      rates,
    });
    expect(english.productIds).toEqual(["one-black", "blackberry"]);
    const hebrew = composeWishes(ids, 4, products, wishes({ excluded: [{ typed: "שחור", english: "black" }] }), {
      rates,
    });
    expect(hebrew.productIds).toEqual(["one-black", "blackberry"]);
    expect(holdsWholeWord("שמלה שחורה", "שחור")).toBe(false);
    expect(holdsWholeWord("צבע: שחור.", "שחור")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Through the orchestrator, on the database.

const embeddings: EmbeddingClient = {
  dimension: DIMENSION,
  embed: async ({ texts }) => texts.map(() => [1, 0, 0]),
};

const untouchable = {
  classifier: { classify: () => Promise.reject(new Error("unexpected classification")) } as QueryClassifier,
  extractor: { extract: () => Promise.reject(new Error("unexpected intent")) } as IntentExtractor,
  retriever: { retrieve: () => Promise.reject(new Error("unexpected retrieval")) } as Retriever,
};

interface Seeded {
  productId: string;
  title: string;
  y: number;
  price?: number;
  available?: boolean;
  facts?: string;
  sizes?: Array<[string, boolean]>;
}

async function seed(db: PrismaClient, products: Seeded[]): Promise<void> {
  for (const entry of products) {
    const price = entry.price ?? 100;
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: entry.productId,
        title: entry.title,
        description: "",
        tags: [],
        vendor: "fixture",
        productType: "",
        priceMin: price,
        priceMax: price,
        currencyCode: "USD",
        available: entry.available ?? true,
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
      `[1,${entry.y},0]`,
    );
    if (entry.facts !== undefined) {
      await db.productCard.create({
        data: {
          shopDomain: SHOP,
          productId: entry.productId,
          status: "written",
          facts: entry.facts,
          asks: {},
          inputHash: "i",
          cardVersion: 1,
          modelId: "m",
          writtenAt: new Date(),
        },
      });
    }
    for (const [index, [size, available]] of (entry.sizes ?? []).entries()) {
      await db.productVariant.create({
        data: {
          shopDomain: SHOP,
          productId: entry.productId,
          variantId: `${entry.productId}-v${index + 1}`,
          position: index + 1,
          options: [{ name: "Size", value: size }],
          price,
          available,
        },
      });
    }
  }
}

/** An extractor answering fixed wishes, after `delayMs`. */
function fixedExtractor(answer: ExtractedWishes, delayMs = 0): WishExtractor & { calls: number } {
  const extractor = {
    modelId: "fake-extract",
    calls: 0,
    extract: () => {
      extractor.calls += 1;
      return new Promise<ExtractedWishes>((resolve) => setTimeout(() => resolve(answer), delayMs));
    },
  };
  return extractor;
}

/** A judge LLM answering `codes` (and excluded numbers `x`) after `delayMs`. */
function judgeLlm(codes: string[], x: number[] = [], delayMs = 0): LlmClient {
  return {
    completeStructured: () =>
      new Promise((resolve) => setTimeout(() => resolve({ c: codes, d: [], x }), delayMs)),
  };
}

describe("wishes on Engine v2 (on the database)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
    await db.productCard.deleteMany();
    await db.productVariant.deleteMany();
    await db.catalogProduct.deleteMany();
    await db.judgeAnswer.deleteMany();
    await db.judgeVerdict.deleteMany();
    await db.extractionAnswer.deleteMany();
    resetPendingLabels();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  function orchestrator(options: {
    extractor?: WishExtractor;
    judge?: LlmClient;
    graceMs?: number;
    judgeDeadlineMs?: number;
  }) {
    return createSearchOrchestrator({
      db,
      ...untouchable,
      classicStore: createPgTrgmClassicStore(db),
      find: createFindStep({ db, embeddings, classicStore: createPgTrgmClassicStore(db) }),
      engineV2: true,
      ...(options.extractor !== undefined ? { wishExtractor: options.extractor } : {}),
      ...(options.judge !== undefined ? { judge: createLlmJudge({ llm: options.judge }) } : {}),
      ...(options.graceMs !== undefined ? { extractionGraceMs: options.graceMs } : {}),
      ...(options.judgeDeadlineMs !== undefined ? { judgeDeadlineMs: options.judgeDeadlineMs } : {}),
    });
  }

  const search = (
    engine: ReturnType<typeof orchestrator>,
    request: Partial<SearchRequest> = {},
  ) => engine.runSearch({ query: "dress under 100, size M, not black", shopDomain: SHOP, ...request });

  const FOUR: Seeded[] = [
    { productId: "p1", title: "Black Dress", y: 0.1, price: 80, facts: "A black dress.", sizes: [["M", true]] },
    { productId: "p2", title: "Dear Dress", y: 0.2, price: 300, sizes: [["M", true]] },
    { productId: "p3", title: "Near Dress", y: 0.3, price: 105, sizes: [["M", true]] },
    { productId: "p4", title: "Sold-out M Dress", y: 0.4, price: 60, sizes: [["S", true], ["M", false], ["L", true]] },
  ];

  const STATED = wishes({
    priceMax: { amount: 100, raw: "100" },
    size: "M",
    excluded: [{ typed: "black", english: "black" }],
  });

  it("applies the stated wishes with chips, code labels and the in-time flag on the wire and in details", async () => {
    await seed(db, FOUR);
    const response = await search(orchestrator({ extractor: fixedExtractor(STATED) }), {
      paging: { page: 1, pageSize: 24 },
    });
    // p1 is excluded; p3 is near the cap (tier 1); p2 is far over it and p4 a
    // size miss (both tier 2, in find order).
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p3", "p2", "p4"]);
    expect(response.totalCount).toBe(3);
    expect(response.extractionInTime).toBe(true);
    expect(response.routeReason).toBe("find-only");
    expect(response.hits.map((hit) => hit.label)).toEqual([
      { template: "price-near", values: ["105 USD", "100 USD"] },
      { template: "price-far", values: ["300 USD", "100 USD"] },
      { template: "size-missing", values: ["M", "S", "L"] },
    ]);
    const wire = serializeProxySearchResponse(response);
    expect(wire.chips).toEqual([
      { field: "priceMax", value: "100" },
      { field: "size", value: "M" },
      { field: "exclude", value: "black" },
    ]);
    const playground = serializePlaygroundSearchResponse(response, {
      routeReason: response.routeReason,
      latencyMs: 1,
      limited: null,
      stages: response.stages,
      intentTier: null,
      engine: "v2",
    });
    expect(playground.details.extractionInTime).toBe(true);
    expect(Object.keys(playground.details.stages)).toContain("compose");
  });

  it("composes without a late extraction: no chips, no ordering, no labels, no exclusion — and records it (AC-3, AC-4)", async () => {
    await seed(db, FOUR);
    const late = fixedExtractor(STATED, 200);
    const response = await search(orchestrator({ extractor: late, graceMs: 20 }));
    expect(late.calls).toBe(1);
    expect(response.extractionInTime).toBe(false);
    expect(response.chips).toEqual([]);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response.hits.every((hit) => hit.label === null)).toBe(true);
    // The late call runs on and fills the cache (AC-18): let it land here,
    // not inside the next test.
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it("records the extraction as not in time when none is wired", async () => {
    await seed(db, FOUR);
    expect((await search(orchestrator({}))).extractionInTime).toBe(false);
  });

  it("does not apply a removed chip's fact, and its chip is absent (AC-15)", async () => {
    await seed(db, FOUR);
    const response = await search(orchestrator({ extractor: fixedExtractor(STATED) }), {
      removedChips: [
        { field: "exclude", value: "black" },
        { field: "priceMax", value: "100" },
      ],
    });
    expect(response.chips).toEqual([{ field: "size", value: "M" }]);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response.hits.map((hit) => hit.label?.template ?? null)).toEqual([null, null, null, "size-missing"]);
  });

  it("lets a code label replace the judge's, and keeps code labels after a judge timeout, error or cap (AC-12, AC-13)", async () => {
    await seed(db, FOUR);
    const stated = wishes({ priceMax: { amount: 100, raw: "100" } });
    const judged = await search(
      orchestrator({ extractor: fixedExtractor(stated), judge: judgeLlm(["CDC", "CDC", "CDC", "CDC"]) }),
    );
    expect(judged.routeReason).toBe("judged");
    const byId = new Map(judged.hits.map((hit) => [hit.productId, hit.label?.template ?? null]));
    expect(byId.get("p2")).toBe("price-far");
    expect(byId.get("p3")).toBe("price-near");
    expect(byId.get("p1")).toBe("close-match");

    await db.judgeAnswer.deleteMany();
    const timedOut = await search(
      orchestrator({
        extractor: fixedExtractor(stated),
        judge: judgeLlm(["E-X", "E-X", "E-X", "E-X"], [], 300),
        judgeDeadlineMs: 20,
      }),
    );
    expect(timedOut.routeReason).toBe("judge-timeout");
    expect(timedOut.hits.find((hit) => hit.productId === "p2")?.label?.template).toBe("price-far");

    const failing: LlmClient = { completeStructured: () => Promise.reject(new Error("503")) };
    const errored = await search(orchestrator({ extractor: fixedExtractor(stated), judge: failing }));
    expect(errored.routeReason).toBe("judge-error");
    expect(errored.hits.find((hit) => hit.productId === "p3")?.label?.template).toBe("price-near");

    const capped = await search(orchestrator({ extractor: fixedExtractor(stated), judge: failing }), {
      forceClassic: true,
    });
    expect(capped.routeReason).toBe("capped");
    expect(capped.hits.find((hit) => hit.productId === "p2")?.label?.template).toBe("price-far");
    expect(capped.chips).toEqual([{ field: "priceMax", value: "100" }]);
  });

  it("drops a product the judge flagged as excluded from the page, unlabelled (AC-11)", async () => {
    await seed(db, FOUR);
    const response = await search(
      orchestrator({ extractor: fixedExtractor(NO_WISHES), judge: judgeLlm(["E-X", "E-X", "E-X", "E-X"], [1]) }),
    );
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p2", "p3", "p4"]);
  });

  it("ignores the judge's excluded flags once an exclude chip is removed, on a fresh or cached answer (AC-15)", async () => {
    await seed(db, FOUR);
    const flagging = () =>
      orchestrator({ extractor: fixedExtractor(NO_WISHES), judge: judgeLlm(["E-X", "E-X", "E-X", "E-X"], [1]) });
    const removed = { removedChips: [{ field: "exclude", value: "black" }] };
    const fresh = await search(flagging(), removed);
    expect(fresh.routeReason).toBe("judged");
    expect(fresh.hits.map((hit) => hit.productId)).toContain("p1");
    expect(fresh.chips.some((chip) => chip.field === "exclude")).toBe(false);

    await db.judgeAnswer.deleteMany();
    const kept = await search(flagging());
    expect(kept.hits.map((hit) => hit.productId)).not.toContain("p1");
    const cached = await search(flagging(), removed);
    expect(cached.routeReason).toBe("judge-cached");
    expect(cached.hits.map((hit) => hit.productId)).toContain("p1");
  });

  it("removes sold-out products from the results and the count on in stock (AC-9)", async () => {
    await seed(db, [
      { productId: "a", title: "A Dress", y: 0.1 },
      { productId: "b", title: "B Dress", y: 0.2, available: false },
    ]);
    const response = await search(orchestrator({ extractor: fixedExtractor(wishes({ inStock: true })) }), {
      paging: { page: 1, pageSize: 24 },
    });
    expect(response.hits.map((hit) => hit.productId)).toEqual(["a"]);
    expect(response.totalCount).toBe(1);
    expect(response.chips).toEqual([{ field: "availability", value: "in stock" }]);
  });
  it("serves a repeat sentence from the extraction cache with no call, and says so (AC-18)", async () => {
    await seed(db, FOUR);
    const extractor = fixedExtractor(STATED);
    const engine = orchestrator({ extractor });
    const first = await search(engine);
    const second = await search(engine, { query: "  Dress UNDER 100, size M,   not black " });
    expect(extractor.calls).toBe(1);
    expect(first).toMatchObject({ extractionInTime: true, extractionCached: false });
    expect(second).toMatchObject({ extractionInTime: true, extractionCached: true });
    expect(second.chips).toEqual(first.chips);
    expect(second.hits.map((hit) => hit.productId)).toEqual(first.hits.map((hit) => hit.productId));
    const playground = serializePlaygroundSearchResponse(second, {
      routeReason: second.routeReason,
      latencyMs: 1,
      limited: null,
      stages: second.stages,
      intentTier: null,
      engine: "v2",
    });
    expect(playground.details).toMatchObject({ extractionInTime: true, extractionCached: true });
  });

  it("lets a late extraction run on and fill the cache, so the next search is warm (AC-18)", async () => {
    await seed(db, FOUR);
    const late = fixedExtractor(STATED, 120);
    const engine = orchestrator({ extractor: late, graceMs: 10 });
    const cold = await search(engine);
    expect(cold).toMatchObject({ extractionInTime: false, extractionCached: false, chips: [] });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const warm = await search(engine);
    expect(late.calls).toBe(1);
    expect(warm).toMatchObject({ extractionInTime: true, extractionCached: true });
    expect(warm.chips.map((chip) => chip.field)).toEqual(["priceMax", "size", "exclude"]);
  });

  it("composes as soon as the extraction lands, not after the whole grace (AC-18)", async () => {
    await seed(db, FOUR);
    const startedAt = Date.now();
    const response = await search(orchestrator({ extractor: fixedExtractor(STATED, 30), graceMs: 2_000 }));
    expect(response.extractionInTime).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("keys the extraction cache on the normalized sentence, its language, the prompt version and the model (AC-18)", () => {
    const key = extractionCacheKey({ sentence: "Dress under 100", modelId: "m", promptVersion: 1 });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(extractionCacheKey({ sentence: "  dress   UNDER 100 ", modelId: "m", promptVersion: 1 })).toBe(key);
    expect(extractionCacheKey({ sentence: "dress under 200", modelId: "m", promptVersion: 1 })).not.toBe(key);
    expect(extractionCacheKey({ sentence: "Dress under 100", modelId: "n", promptVersion: 1 })).not.toBe(key);
    expect(extractionCacheKey({ sentence: "Dress under 100", modelId: "m", promptVersion: 2 })).not.toBe(key);
    expect([sentenceLanguage("שמלה"), sentenceLanguage("платье"), sentenceLanguage("فستان"), sentenceLanguage("robe")]).toEqual([
      "he",
      "ru",
      "ar",
      "en",
    ]);
  });
  it("puts the judge's verdict above the tier within a page, and keeps tier order when the judge times out (AC-5, 2026-10-03)", async () => {
    await seed(db, [
      { productId: "cheap", title: "Cheap Dress", y: 0.1, price: 50 },
      { productId: "dear", title: "Dear Dress", y: 0.2, price: 300 },
    ]);
    const stated = wishes({ priceMax: { amount: 100, raw: "100" } });
    // Tiers put "cheap" (in budget) first; the judge finds "dear" exact and "cheap" only close.
    const judged = await search(
      orchestrator({ extractor: fixedExtractor(stated), judge: judgeLlm(["CDC", "E-X"]) }),
    );
    expect(judged.routeReason).toBe("judged");
    expect(judged.hits.map((hit) => hit.productId)).toEqual(["dear", "cheap"]);
    expect(judged.hits[0]!.label).toEqual({ template: "price-far", values: ["300 USD", "100 USD"] });

    await db.judgeAnswer.deleteMany();
    await db.extractionAnswer.deleteMany();
    const timedOut = await search(
      orchestrator({
        extractor: fixedExtractor(stated),
        judge: judgeLlm(["CDC", "E-X"], [], 300),
        judgeDeadlineMs: 20,
      }),
    );
    expect(timedOut.routeReason).toBe("judge-timeout");
    expect(timedOut.hits.map((hit) => hit.productId)).toEqual(["cheap", "dear"]);
  });
});
