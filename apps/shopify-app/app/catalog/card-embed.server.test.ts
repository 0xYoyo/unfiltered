import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient, EmbeddingRequest } from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SourceProduct } from "../playground/catalog-source.server";
import {
  deletePublicCatalog,
  playgroundStoreKey,
  snapshotPublicCatalog,
} from "../playground/ingest-public.server";
import { createTestDb } from "../testing/helpers.server";
import {
  asksSection,
  cardEmbeddingSections,
  embedCatalogCards,
  formatCardVectorReport,
  PROSE_SECTION,
} from "./card-embed.server";
import { ingestCatalog } from "./ingest.server";
import { deleteProductFromWebhook, syncProductFromWebhook } from "./webhook-sync.server";

// Card vectors (YOY-144 AC-1, AC-2, AC-8, AC-9) on the embedded PGlite DB,
// driven by a stub embedding client: offline, no paid call.

const SHOP = "test-shop.myshopify.com";
const DIMENSION = 3;

let db: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
  await db.$executeRawUnsafe(`DELETE FROM "ProductEmbedding"`);
  await db.productCard.deleteMany();
  await db.catalogProduct.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Deterministic vector from a text's char codes. */
function textVector(text: string, dimension = DIMENSION): number[] {
  return Array.from({ length: dimension }, (_, axis) => {
    let value = 1;
    for (const char of text) {
      value = (value * 31 + char.charCodeAt(0) * (axis + 1)) % 997;
    }
    return value / 997 + 0.001;
  });
}

function embeddingStub(dimension = DIMENSION) {
  const calls: EmbeddingRequest[] = [];
  const client: EmbeddingClient = {
    dimension,
    async embed(request) {
      calls.push(request);
      return request.texts.map((text) => textVector(text, dimension));
    },
  };
  return { client, calls, texts: () => calls.flatMap((call) => call.texts) };
}

const asks = (prefix: string, n = 10) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

let counter = 0;

async function seedProduct(productId: string, shopDomain = SHOP) {
  counter += 1;
  return db.catalogProduct.create({
    data: {
      shopDomain,
      productId,
      title: `Item ${counter}`,
      description: "",
      tags: [],
      vendor: "V",
      productType: "",
      priceMin: 10,
      priceMax: 10,
      currencyCode: "USD",
      available: true,
      imageAltTexts: [],
      sourceUpdatedAt: new Date("2026-09-01T00:00:00Z"),
      contentHash: createHash("sha256").update(productId).digest("hex"),
    },
  });
}

async function seedCard(
  productId: string,
  overrides: Partial<{ status: string; facts: string; asks: Record<string, string[]>; shopDomain: string }> = {},
) {
  const data = {
    status: overrides.status ?? "written",
    facts: overrides.facts ?? `Facts of ${productId}. Material: cotton.`,
    look: `Look of ${productId}.`,
    read: `Read of ${productId}.`,
    summary: "s",
    asks: overrides.asks ?? { en: asks(`${productId} en`), he: asks(`${productId} he`) },
    inputHash: "h",
    cardVersion: 1,
    modelId: "m",
    writtenAt: new Date(),
  };
  const shopDomain = overrides.shopDomain ?? SHOP;
  await db.productCard.upsert({
    where: { shopDomain_productId: { shopDomain, productId } },
    create: { shopDomain, productId, ...data },
    update: data,
  });
}

async function vectorRows(shopDomain = SHOP) {
  return db.$queryRawUnsafe<Array<{ productId: string; section: string; textHash: string }>>(
    `SELECT "productId", "section", "textHash" FROM "CardEmbedding" WHERE "shopDomain" = $1 ORDER BY "productId", "section"`,
    shopDomain,
  );
}

const run = (client: EmbeddingClient, shopDomain = SHOP) => embedCatalogCards({ db, shopDomain, embeddings: client });

describe("card vector rows (AC-1)", () => {
  it("stores one row per section with its text hash, and builds the HNSW cosine index", async () => {
    await seedProduct("p1");
    await seedCard("p1");
    await run(embeddingStub().client);

    const rows = await vectorRows();
    expect(rows.map((row) => row.section)).toEqual([PROSE_SECTION, asksSection("en"), asksSection("he")].sort());
    const prose = cardEmbeddingSections({
      facts: "Facts of p1. Material: cotton.",
      look: "Look of p1.",
      read: "Read of p1.",
      asks: {},
    })[0]!.text;
    expect(rows.find((row) => row.section === PROSE_SECTION)?.textHash).toBe(
      createHash("sha256").update(prose).digest("hex"),
    );

    const indexes = await db.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'CardEmbedding'`,
    );
    const cosine = indexes.find((index) => index.indexname === `CardEmbedding_cosine_${DIMENSION}_idx`);
    expect(cosine?.indexdef).toMatch(/USING hnsw .*vector\(3\).*vector_cosine_ops/);
  });

  it("is unique on store, product and section", async () => {
    await seedProduct("p1");
    await seedCard("p1");
    await run(embeddingStub().client);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES ('dup', $1, 'p1', 'prose', 'x', '[1,0,0]', CURRENT_TIMESTAMP)`,
        SHOP,
      ),
    ).rejects.toThrow();
  });

  it("rebuilds the index for a new dimension", async () => {
    await seedProduct("p1");
    await seedCard("p1");
    await run(embeddingStub(4).client);
    const names = (
      await db.$queryRawUnsafe<Array<{ indexname: string }>>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'CardEmbedding' AND indexname LIKE 'CardEmbedding_cosine_%'`,
      )
    ).map((row) => row.indexname);
    expect(names).toEqual(["CardEmbedding_cosine_4_idx"]);
    // Leave the configured dimension's index for the other tests.
    await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
    await run(embeddingStub().client);
  });
});

describe("embedding the card's sections (AC-2)", () => {
  it("embeds the prose as facts + look + read, and each language's asks as one text", async () => {
    await seedProduct("p1");
    await seedCard("p1", { asks: { en: ["red dress", "dress for a party"], he: ["שמלה אדומה"] } });
    const stub = embeddingStub();
    const result = await run(stub.client);

    expect(stub.texts()).toEqual([
      "Facts of p1. Material: cotton.\nLook of p1.\nRead of p1.",
      "red dress\ndress for a party",
      "שמלה אדומה",
    ]);
    expect(stub.calls.every((call) => call.storeId === SHOP)).toBe(true);
    expect(result).toEqual({ embedded: 3, cached: 0, deleted: 0 });
  });

  it("makes zero embedding calls on a re-run over unchanged cards", async () => {
    await seedProduct("p1");
    await seedProduct("p2");
    await seedCard("p1");
    await seedCard("p2");
    await run(embeddingStub().client);

    const again = embeddingStub();
    expect(await run(again.client)).toEqual({ embedded: 0, cached: 6, deleted: 0 });
    expect(again.calls).toHaveLength(0);
  });

  it("re-embeds exactly the section whose text changed", async () => {
    await seedProduct("p1");
    await seedCard("p1");
    await run(embeddingStub().client);
    const before = await vectorRows();

    await seedCard("p1", { facts: "New facts. Material: wool." });
    const again = embeddingStub();
    expect(await run(again.client)).toEqual({ embedded: 1, cached: 2, deleted: 0 });
    expect(again.texts()).toEqual(["New facts. Material: wool.\nLook of p1.\nRead of p1."]);
    const after = await vectorRows();
    expect(after.find((row) => row.section === PROSE_SECTION)?.textHash).not.toBe(
      before.find((row) => row.section === PROSE_SECTION)?.textHash,
    );
  });

  it("embeds no failed card, and drops the vectors of a card that failed or lost a language", async () => {
    await seedProduct("p1");
    await seedProduct("p2");
    await seedCard("p1");
    await seedCard("p2", { status: "failed", asks: {} });
    const first = embeddingStub();
    expect(await run(first.client)).toEqual({ embedded: 3, cached: 0, deleted: 0 });
    expect((await vectorRows()).every((row) => row.productId === "p1")).toBe(true);

    await seedCard("p1", { asks: { en: asks("p1 en") } });
    expect(await run(embeddingStub().client)).toEqual({ embedded: 0, cached: 2, deleted: 1 });
    expect((await vectorRows()).map((row) => row.section)).toEqual([asksSection("en"), PROSE_SECTION]);

    await seedCard("p1", { status: "failed", asks: {} });
    expect(await run(embeddingStub().client)).toEqual({ embedded: 0, cached: 0, deleted: 2 });
    expect(await vectorRows()).toEqual([]);
  });

  it("keeps each store's vectors to itself", async () => {
    await seedProduct("p1");
    await seedProduct("p1", "other-shop.myshopify.com");
    await seedCard("p1");
    await seedCard("p1", { shopDomain: "other-shop.myshopify.com" });
    await run(embeddingStub().client);
    expect(await vectorRows("other-shop.myshopify.com")).toEqual([]);
    await run(embeddingStub().client, "other-shop.myshopify.com");
    expect(await vectorRows("other-shop.myshopify.com")).toHaveLength(3);
    expect(await vectorRows()).toHaveLength(3);
  });
});

describe("report (AC-9)", () => {
  it("prints card vectors: embedded N, cached M", () => {
    expect(formatCardVectorReport({ embedded: 7, cached: 3, deleted: 1 })).toBe("card vectors: embedded 7, cached 3");
  });
});

describe("deletes (AC-8)", () => {
  async function seedEmbedded(productId: string) {
    await seedProduct(productId);
    await seedCard(productId);
    await run(embeddingStub().client);
  }
  const countFor = async (productId: string) => (await vectorRows()).filter((row) => row.productId === productId).length;

  it("removes the card vectors with the product on products/delete", async () => {
    await seedEmbedded("gid://shopify/Product/9001");
    expect(await countFor("gid://shopify/Product/9001")).toBe(3);
    expect(await deleteProductFromWebhook({ db, shopDomain: SHOP, payload: { id: 9001 } })).toBe("deleted");
    expect(await countFor("gid://shopify/Product/9001")).toBe(0);
  });

  it("removes the card vectors when an archived product leaves the snapshot", async () => {
    await seedEmbedded("gid://shopify/Product/9002");
    const payload = {
      id: 9002,
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
      status: "archived",
    } as Parameters<typeof syncProductFromWebhook>[0]["payload"];
    expect(await syncProductFromWebhook({ db, shopDomain: SHOP, payload })).toBe("deleted");
    expect(await vectorRows()).toEqual([]);
  });

  it("removes the card vectors of products gone from the Admin catalog", async () => {
    await seedEmbedded("gid://shopify/Product/9003");
    const result = await ingestCatalog({
      db,
      shopDomain: SHOP,
      graphql: async () =>
        Response.json({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }),
    });
    expect(result.deleted).toBe(1);
    expect(await vectorRows()).toEqual([]);
  });

  it("removes the card vectors of products gone from a public source, and of a deleted catalog", async () => {
    const storeKey = playgroundStoreKey("card-vectors");
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
    await seedCard("a", { shopDomain: storeKey });
    await seedCard("b", { shopDomain: storeKey });
    await run(embeddingStub().client, storeKey);
    expect(await vectorRows(storeKey)).toHaveLength(6);

    await snapshotPublicCatalog({ db, storeKey, products: [source("b")], maxProducts: 10 });
    expect(new Set((await vectorRows(storeKey)).map((row) => row.productId))).toEqual(new Set(["b"]));

    const deletion = await deletePublicCatalog({ db, slug: "card-vectors" });
    expect(deletion.cardVectors).toBe(3);
    expect(await vectorRows(storeKey)).toEqual([]);
  });
});
