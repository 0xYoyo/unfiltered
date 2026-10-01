import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { LlmClient, StructuredCompletionRequest } from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aggregateCosts } from "../ai/cost-aggregates.server";
import type { SourceProduct } from "../playground/catalog-source.server";
import {
  deletePublicCatalog,
  playgroundStoreKey,
  snapshotPublicCatalog,
} from "../playground/ingest-public.server";
import { createTestDb } from "../testing/helpers.server";
import type { CardResult, CardWriter } from "./card.server";
import {
  buildCardPrompt,
  CARD_VERSION,
  cardLanguagesFromEnv,
  composeCardText,
  formatCardReport,
  MAX_ASKS_PER_LANGUAGE,
  MAX_SUMMARY_CHARS,
  parseCard,
  writeCatalogCards,
} from "./card.server";
import type { ImageFetch } from "./images.server";
import { ingestCatalog } from "./ingest.server";
import { deleteProductFromWebhook, syncProductFromWebhook } from "./webhook-sync.server";

// The card writer (YOY-143) on the embedded PGlite DB, driven by a replay
// client: every model answer is a fixture, so the default run is offline
// and makes no paid call.

const SHOP = "test-shop.myshopify.com";
const LANGUAGES = ["en", "he"];
const MODEL_ID = "gemini-3.5-flash-lite";

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.aiCall.deleteMany();
  await db.productCard.deleteMany();
  await db.productImage.deleteMany();
  await db.productEnrichment.deleteMany();
  await db.catalogProduct.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

const asks = (prefix: string, n = 12) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

/** A valid card answer for a product title. */
function answerFor(title: string) {
  return {
    facts: `${title}. Material: 100% cotton. Looks like a relaxed fit.`,
    look: `A ${title.toLowerCase()} in navy; looks like a small floral print.`,
    read: "Casual, weekend wear, for someone who wants comfort.",
    summary: `A navy cotton ${title.toLowerCase()} for easy weekends.`,
    asks: { en: asks(`${title} en`), he: asks(`${title} he`) },
  };
}

/**
 * The replay client: answers by the product title in the prompt, records
 * every request, and — like the metered adapter — writes one ledger row
 * per call, so the run's cost is read back from the ledger.
 */
function replayWriter(
  options: {
    answer?: (title: string, attempt: number) => unknown;
    costPerCall?: number;
  } = {},
): CardWriter & { requests: StructuredCompletionRequest[]; titles: string[] } {
  const requests: StructuredCompletionRequest[] = [];
  const titles: string[] = [];
  const attempts = new Map<string, number>();
  const llm: LlmClient = {
    async completeStructured(request) {
      requests.push(request);
      const title = /^Title: (.*)$/m.exec(request.prompt)?.[1] ?? "";
      titles.push(title);
      const attempt = attempts.get(title) ?? 0;
      attempts.set(title, attempt + 1);
      await db.aiCall.create({
        data: {
          provider: "replay",
          modelId: MODEL_ID,
          operation: request.operation,
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: options.costPerCall ?? 0.004,
          shopDomain: request.storeId ?? null,
        },
      });
      return (options.answer ?? answerFor)(title, attempt);
    },
  };
  return { llm, modelId: MODEL_ID, requests, titles };
}

let productCounter = 0;

async function seedProduct(
  overrides: Partial<{
    productId: string;
    title: string;
    description: string;
    available: boolean;
    sourceUpdatedAt: Date;
    shopDomain: string;
  }> = {},
) {
  productCounter += 1;
  const title = overrides.title ?? `Dress ${productCounter}`;
  const description = overrides.description ?? "A cotton dress.";
  return db.catalogProduct.create({
    data: {
      shopDomain: overrides.shopDomain ?? SHOP,
      productId: overrides.productId ?? `gid://shopify/Product/${productCounter}`,
      title,
      description,
      tags: [],
      vendor: "V",
      productType: "Dresses",
      priceMin: 100,
      priceMax: 100,
      currencyCode: "USD",
      available: overrides.available ?? true,
      imageAltTexts: [],
      sourceUpdatedAt: overrides.sourceUpdatedAt ?? new Date("2026-09-01T00:00:00Z"),
      contentHash: createHash("sha256").update(`${title}|${description}`).digest("hex"),
    },
  });
}

const imageFetch: ImageFetch = async (url) =>
  new Response(new TextEncoder().encode(`bytes:${url}`), { headers: { "Content-Type": "image/jpeg" } });

async function run(writer: CardWriter, extra: Partial<Parameters<typeof writeCatalogCards>[0]> = {}): Promise<CardResult> {
  return writeCatalogCards({ db, shopDomain: SHOP, writer, fetchImage: imageFetch, languages: LANGUAGES, ...extra });
}

describe("card sections (AC-1, AC-3, AC-4)", () => {
  it("stores every section, the card text and its hash, the input hash, version, model and written-at", async () => {
    const product = await seedProduct({ title: "Wrap Dress" });
    const writer = replayWriter();
    const writtenAt = new Date("2026-10-01T12:00:00Z");
    const result = await run(writer, { now: () => writtenAt });
    expect(result).toEqual({ written: 1, cached: 0, failed: 0, costUsd: 0.004 });

    const row = await db.productCard.findUniqueOrThrow({
      where: { shopDomain_productId: { shopDomain: SHOP, productId: product.productId } },
    });
    const expected = answerFor("Wrap Dress");
    expect(row).toMatchObject({
      status: "written",
      facts: expected.facts,
      look: expected.look,
      read: expected.read,
      summary: expected.summary,
      asks: expected.asks,
      cardVersion: CARD_VERSION,
      modelId: MODEL_ID,
      writtenAt,
    });
    expect(row.cardText).toBe(composeCardText({ ...expected }));
    expect(row.cardText).toContain("Asks (he): Wrap Dress he 1 | Wrap Dress he 2");
    expect(row.cardTextHash).toBe(createHash("sha256").update(row.cardText).digest("hex"));
    expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes one card call per product with the text, the enrichment and up to four images", async () => {
    const product = await seedProduct({ title: "Linen Shirt", description: "Made of 100% linen." });
    await db.productEnrichment.create({
      data: {
        shopDomain: SHOP,
        productId: product.productId,
        contentHash: product.contentHash,
        status: "enriched",
        category: "shirt",
        colors: ["white"],
        occasions: [],
        styleTags: ["minimal"],
        seasons: ["summer"],
        sleeveLength: "long",
      },
    });
    for (let position = 0; position < 4; position += 1) {
      await db.productImage.create({
        data: {
          shopDomain: SHOP,
          productId: product.productId,
          position,
          url: `https://cdn.example/${position}.jpg`,
          contentHash: `hash-${position}`,
          fetchedAt: new Date(),
        },
      });
    }
    const writer = replayWriter();
    await run(writer);

    expect(writer.requests).toHaveLength(1);
    const [request] = writer.requests;
    expect(request!.operation).toBe("card");
    expect(request!.storeId).toBe(SHOP);
    expect(request!.images).toHaveLength(4);
    expect(request!.prompt).toContain("Description: Made of 100% linen.");
    expect(request!.prompt).toContain("- category: shirt");
    expect(request!.prompt).toContain("- sleeve length: long");
    expect(request!.prompt).toContain("Photos: 4, shown before this text");
  });

  it('instructs "looks like" for a photo-only detail, material first, and keeps the marking', async () => {
    await seedProduct({ title: "Plain Tee", description: "A t-shirt." });
    const writer = replayWriter({
      answer: () => ({
        ...answerFor("Plain Tee"),
        facts: "A t-shirt. Looks like cotton jersey (not stated by the merchant).",
      }),
    });
    await run(writer);
    const prompt = writer.requests[0]!.prompt;
    expect(prompt).toMatch(/only see in a photo[\s\S]*written as "looks like …"/);
    expect(prompt).toMatch(/material first/);
    expect(prompt).toMatch(/style, the occasions it suits and who wears it/);
    const row = await db.productCard.findFirstOrThrow();
    expect(row.facts).toContain("Looks like cotton jersey");
  });

  it("asks for prose in the product's own language and asks in every configured language (AC-4, AC-5)", () => {
    const prompt = buildCardPrompt(
      {
        productId: "p",
        title: "שמלת ערב",
        description: "שמלה שחורה",
        tags: [],
        vendor: "V",
        productType: "",
        imageAltTexts: [],
        contentHash: "h",
      },
      null,
      ["en", "he", "ar"],
      0,
    );
    expect(prompt).toContain("in the language of the product's own");
    expect(prompt).toContain("if the text is Hebrew, write them in Hebrew");
    expect(prompt).toContain("en, he, ar");
    expect(prompt).toContain("between\n  10 and 20");
    expect(prompt).toContain("Photos: none");
  });

  it("validates the answer: 10–20 asks per language, a ≤ 300-character summary, every section present", () => {
    const valid = answerFor("Coat");
    expect(parseCard(valid, LANGUAGES)).not.toBeNull();
    // Fewer than ten distinct asks in a language is not a card.
    expect(parseCard({ ...valid, asks: { en: asks("x", 9), he: asks("y") } }, LANGUAGES)).toBeNull();
    expect(
      parseCard({ ...valid, asks: { en: [...asks("x", 9), "X 1", " x 1 "], he: asks("y") } }, LANGUAGES),
    ).toBeNull();
    // A missing language, or an empty prose section, is not a card.
    expect(parseCard({ ...valid, asks: { en: asks("x") } }, LANGUAGES)).toBeNull();
    expect(parseCard({ ...valid, read: "  " }, LANGUAGES)).toBeNull();
    // Over twenty asks keeps the first twenty.
    const many = parseCard({ ...valid, asks: { en: asks("x", 25), he: asks("y") } }, LANGUAGES);
    expect(many!.asks.en).toHaveLength(MAX_ASKS_PER_LANGUAGE);
    expect(many!.asks.en![0]).toBe("x 1");
    // A long summary is cut at a word boundary to at most 300 characters.
    const long = parseCard({ ...valid, summary: "word ".repeat(100) }, LANGUAGES);
    expect(long!.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(long!.summary.endsWith("word")).toBe(true);
  });

  it("reads the ask languages from CARD_ASK_LANGUAGES, en and he by default", () => {
    expect(cardLanguagesFromEnv({})).toEqual(["en", "he"]);
    expect(cardLanguagesFromEnv({ CARD_ASK_LANGUAGES: "en, AR ,he,en" })).toEqual(["en", "ar", "he"]);
    expect(() => cardLanguagesFromEnv({ CARD_ASK_LANGUAGES: " , " })).toThrow(/CARD_ASK_LANGUAGES/);
    expect(() => cardLanguagesFromEnv({ CARD_ASK_LANGUAGES: "english" })).toThrow(/CARD_ASK_LANGUAGES/);
  });
});

describe("priority order (AC-6)", () => {
  it("writes in-stock cards first, then the most recently updated", async () => {
    await seedProduct({ title: "Old in stock", available: true, sourceUpdatedAt: new Date("2026-01-01") });
    await seedProduct({ title: "New sold out", available: false, sourceUpdatedAt: new Date("2026-09-30") });
    await seedProduct({ title: "New in stock", available: true, sourceUpdatedAt: new Date("2026-09-01") });
    await seedProduct({ title: "Old sold out", available: false, sourceUpdatedAt: new Date("2026-02-01") });
    const writer = replayWriter();
    await run(writer);
    expect(writer.titles).toEqual(["New in stock", "Old in stock", "New sold out", "Old sold out"]);
  });
});

describe("caching (AC-7)", () => {
  it("makes zero calls for products whose input hash and card version are current", async () => {
    for (let i = 0; i < 8; i += 1) {
      await seedProduct();
    }
    const first = await run(replayWriter());
    expect(formatCardReport(first)).toBe("cards: written 8, cached 0, failed 0, cost $0.032000");
    const writer = replayWriter();
    const second = await run(writer);
    expect(writer.requests).toHaveLength(0);
    expect(formatCardReport(second)).toBe("cards: written 0, cached 8, failed 0, cost $0.000000");
  });

  it("rewrites exactly the changed product; the text hash moves only when the card text does", async () => {
    const changed = await seedProduct({ title: "Skirt" });
    await seedProduct({ title: "Top" });
    await run(replayWriter());
    const before = await db.productCard.findUniqueOrThrow({
      where: { shopDomain_productId: { shopDomain: SHOP, productId: changed.productId } },
    });

    // A content change makes a new input hash: one call. The model answers
    // the same card, so the text hash stays.
    await db.catalogProduct.update({
      where: { id: changed.id },
      data: { description: "Now in wool.", contentHash: "changed-hash" },
    });
    const sameText = replayWriter();
    expect(await run(sameText)).toMatchObject({ written: 1, cached: 1 });
    expect(sameText.titles).toEqual(["Skirt"]);
    const sameRow = await db.productCard.findUniqueOrThrow({ where: { id: before.id } });
    expect(sameRow.inputHash).not.toBe(before.inputHash);
    expect(sameRow.cardTextHash).toBe(before.cardTextHash);

    // Another change, and the model writes different text: the hash moves.
    await db.catalogProduct.update({ where: { id: changed.id }, data: { contentHash: "changed-again" } });
    await run(replayWriter({ answer: (title) => ({ ...answerFor(title), summary: "Now in wool." }) }));
    const newRow = await db.productCard.findUniqueOrThrow({ where: { id: before.id } });
    expect(newRow.cardTextHash).not.toBe(before.cardTextHash);
  });

  it("rewrites every card once when CARD_VERSION moves past the stored version", async () => {
    const product = await seedProduct();
    await run(replayWriter());
    await db.productCard.update({
      where: { shopDomain_productId: { shopDomain: SHOP, productId: product.productId } },
      data: { cardVersion: CARD_VERSION - 1 },
    });
    expect(await run(replayWriter())).toMatchObject({ written: 1, cached: 0 });
  });
});

describe("failures (AC-8)", () => {
  it("marks a product failed after two bad answers without failing the run, and retries only on changed inputs", async () => {
    const bad = await seedProduct({ title: "Broken" });
    await seedProduct({ title: "Fine" });
    const writer = replayWriter({
      answer: (title) => (title === "Broken" ? { facts: "only facts" } : answerFor(title)),
    });
    expect(await run(writer)).toMatchObject({ written: 1, failed: 1, cached: 0 });
    expect(writer.titles.filter((title) => title === "Broken")).toHaveLength(2);
    const failed = await db.productCard.findUniqueOrThrow({
      where: { shopDomain_productId: { shopDomain: SHOP, productId: bad.productId } },
    });
    expect(failed).toMatchObject({ status: "failed", facts: "", cardText: "", cardVersion: CARD_VERSION });

    // Unchanged inputs: no retry.
    const again = replayWriter();
    expect(await run(again)).toMatchObject({ written: 0, failed: 0, cached: 2 });
    expect(again.requests).toHaveLength(0);

    // Changed inputs: retried, and written this time.
    await db.catalogProduct.update({ where: { id: bad.id }, data: { contentHash: "fixed" } });
    const retry = replayWriter();
    expect(await run(retry)).toMatchObject({ written: 1, cached: 1 });
    expect(retry.titles).toEqual(["Broken"]);
  });

  it("retries once after a thrown call and keeps the second answer", async () => {
    await seedProduct({ title: "Flaky" });
    const writer = replayWriter({
      answer: (title, attempt) => {
        if (attempt === 0) {
          throw new Error("503");
        }
        return answerFor(title);
      },
    });
    expect(await run(writer)).toMatchObject({ written: 1, failed: 0 });
    expect(writer.requests).toHaveLength(2);
  });

  it("makes no call and writes no row when none of a product's images can be fetched", async () => {
    const product = await seedProduct();
    await db.productImage.create({
      data: { shopDomain: SHOP, productId: product.productId, position: 0, url: "https://cdn/x.jpg", contentHash: "h", fetchedAt: new Date() },
    });
    const writer = replayWriter();
    const result = await run(writer, { fetchImage: async () => new Response("gone", { status: 404 }) });
    expect(result).toMatchObject({ written: 0, failed: 1 });
    expect(writer.requests).toHaveLength(0);
    expect(await db.productCard.count()).toBe(0);
  });
});

describe("cost (AC-9)", () => {
  it("reports the run's card cost from the ledger, and /internal/costs groups the card operation", async () => {
    await seedProduct();
    await seedProduct();
    const result = await run(replayWriter({ costPerCall: 0.0025 }));
    expect(result.costUsd).toBeCloseTo(0.005, 9);
    const aggregates = await aggregateCosts(db);
    expect(aggregates.byOperation).toContainEqual({ key: "card", calls: 2, costUsd: 0.005 });
  });
});

describe("deletes (AC-10)", () => {
  it("removes the card with the product on products/delete", async () => {
    const product = await seedProduct({ productId: "gid://shopify/Product/9001" });
    await run(replayWriter());
    expect(await db.productCard.count()).toBe(1);
    expect(await deleteProductFromWebhook({ db, shopDomain: SHOP, payload: { id: 9001 } })).toBe("deleted");
    expect(await db.productCard.count({ where: { productId: product.productId } })).toBe(0);
  });

  it("removes the card when an archived or unpublished product leaves the snapshot", async () => {
    await seedProduct({ productId: "gid://shopify/Product/9002" });
    await seedProduct({ productId: "gid://shopify/Product/9003" });
    await run(replayWriter());
    const payload = (id: number, extra: Record<string, unknown>) =>
      ({
        id,
        title: "t",
        handle: "t",
        body_html: "",
        vendor: "",
        product_type: "",
        tags: "",
        updated_at: "2026-10-01T00:00:00Z",
        variants: [],
        images: [],
        image: null,
        ...extra,
      }) as Parameters<typeof syncProductFromWebhook>[0]["payload"];
    expect(await syncProductFromWebhook({ db, shopDomain: SHOP, payload: payload(9002, { status: "archived" }) })).toBe("deleted");
    expect(await syncProductFromWebhook({ db, shopDomain: SHOP, payload: payload(9003, { published_at: null }) })).toBe("deleted");
    expect(await db.productCard.count()).toBe(0);
  });

  it("removes the cards of products gone from the Admin catalog", async () => {
    await seedProduct();
    await run(replayWriter());
    const result = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: async () =>
        Response.json({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }),
    });
    expect(result.deleted).toBe(1);
    expect(await db.productCard.count()).toBe(0);
  });

  it("removes the cards of products gone from a public source, and of a deleted catalog", async () => {
    const storeKey = playgroundStoreKey("cards");
    const source = (id: string): SourceProduct => ({
      sourceId: id,
      title: `Item ${id}`,
      description: "d",
      tags: [],
      vendor: "V",
      productType: "",
      priceMin: 1,
      priceMax: 1,
      currencyCode: "USD",
      available: true,
      imageAltTexts: [],
      imageUrl: null,
      imageUrls: [],
      variants: [],
      url: null,
      sourceUpdatedAt: null,
    });
    await snapshotPublicCatalog({ db, storeKey, products: [source("a"), source("b")], maxProducts: 10 });
    await writeCatalogCards({ db, shopDomain: storeKey, writer: replayWriter(), languages: LANGUAGES });
    expect(await db.productCard.count({ where: { shopDomain: storeKey } })).toBe(2);

    await snapshotPublicCatalog({ db, storeKey, products: [source("b")], maxProducts: 10 });
    expect(await db.productCard.findMany({ where: { shopDomain: storeKey }, select: { productId: true } })).toEqual([
      { productId: "b" },
    ]);

    const deletion = await deletePublicCatalog({ db, slug: "cards" });
    expect(deletion.cards).toBe(1);
    expect(await db.productCard.count({ where: { shopDomain: storeKey } })).toBe(0);
  });
});
