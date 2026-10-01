import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * The score fixture (YOY-140 AC-8): one store key's searchable state —
 * CatalogProduct, ProductEnrichment and ProductEmbedding rows — as one JSON
 * file, so the runner (AC-6) can seed an in-process database with the
 * catalog as it stood on `ingestedAt`, and every run scores the same catalog.
 *
 * Row ids and row timestamps are not exported: they are the database's
 * bookkeeping, not catalog state, and the import writes fresh ones.
 * Vectors travel as base64 little-endian Float32 — pgvector stores float4,
 * so the round trip is exact.
 */

export const SCORE_FIXTURE_VERSION = 1;

type Bookkeeping = "id" | "createdAt" | "updatedAt";

/** A CatalogProduct row as the fixture holds it: dates as ISO strings. */
export type FixtureProduct = Omit<
  Prisma.CatalogProductGetPayload<object>,
  Bookkeeping | "publishedAt" | "sourceUpdatedAt"
> & { publishedAt: string | null; sourceUpdatedAt: string };

export type FixtureEnrichment = Omit<
  Prisma.ProductEnrichmentGetPayload<object>,
  Bookkeeping
>;

export interface FixtureEmbedding {
  productId: string;
  contentHash: string;
  /** base64 of the vector as little-endian Float32. */
  vector: string;
}

export interface ScoreFixture {
  version: typeof SCORE_FIXTURE_VERSION;
  storeKey: string;
  /** When the exported catalog was last ingested. */
  ingestedAt: string;
  products: FixtureProduct[];
  enrichments: FixtureEnrichment[];
  embeddings: FixtureEmbedding[];
}

export function encodeVector(vector: readonly number[]): string {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

export function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    vector.push(view.getFloat32(offset, true));
  }
  return vector;
}

function parseVectorText(text: string): number[] {
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((value) => Number(value));
}

function withoutBookkeeping<T extends Record<Bookkeeping, unknown>>(row: T): Omit<T, Bookkeeping> {
  const copy: Partial<T> = { ...row };
  delete copy.id;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, Bookkeeping>;
}

/** Export one store key's catalog state to a fixture. */
export async function exportScoreFixture(
  db: PrismaClient,
  storeKey: string,
  { ingestedAt }: { ingestedAt?: Date } = {},
): Promise<ScoreFixture> {
  const products = await db.catalogProduct.findMany({
    where: { shopDomain: storeKey },
    orderBy: { productId: "asc" },
  });
  const enrichments = await db.productEnrichment.findMany({
    where: { shopDomain: storeKey },
    orderBy: { productId: "asc" },
  });
  const embeddings = await db.$queryRawUnsafe<
    { productId: string; contentHash: string; embedding: string }[]
  >(
    `SELECT "productId", "contentHash", "embedding"::text AS "embedding"
       FROM "ProductEmbedding" WHERE "shopDomain" = $1 ORDER BY "productId"`,
    storeKey,
  );
  const registry = await db.playgroundCatalog.findUnique({
    where: { storeKey },
    select: { lastIngestedAt: true },
  });
  const lastSync = products.reduce<Date | null>(
    (latest, product) =>
      latest === null || product.updatedAt > latest ? product.updatedAt : latest,
    null,
  );

  return {
    version: SCORE_FIXTURE_VERSION,
    storeKey,
    ingestedAt: (ingestedAt ?? registry?.lastIngestedAt ?? lastSync ?? new Date()).toISOString(),
    products: products.map(withoutBookkeeping).map((row) => ({
      ...row,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      sourceUpdatedAt: row.sourceUpdatedAt.toISOString(),
    })),
    enrichments: enrichments.map(withoutBookkeeping),
    embeddings: embeddings.map((row) => ({
      productId: row.productId,
      contentHash: row.contentHash,
      vector: encodeVector(parseVectorText(row.embedding)),
    })),
  };
}

function jsonColumn(value: Prisma.JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/** Seed a database with a fixture's rows, under the fixture's store key. */
export async function importScoreFixture(
  db: PrismaClient,
  fixture: ScoreFixture,
): Promise<void> {
  if (fixture.version !== SCORE_FIXTURE_VERSION) {
    throw new Error(`score fixture: unsupported version ${String(fixture.version)}`);
  }
  const { storeKey } = fixture;
  for (const product of fixture.products) {
    await db.catalogProduct.create({
      data: {
        ...product,
        shopDomain: storeKey,
        publishedAt: product.publishedAt === null ? null : new Date(product.publishedAt),
        sourceUpdatedAt: new Date(product.sourceUpdatedAt),
      },
    });
  }
  for (const enrichment of fixture.enrichments) {
    await db.productEnrichment.create({
      data: {
        ...enrichment,
        shopDomain: storeKey,
        textAttributes: jsonColumn(enrichment.textAttributes),
        visionAttributes: jsonColumn(enrichment.visionAttributes),
      },
    });
  }
  for (const embedding of fixture.embeddings) {
    const vector = decodeVector(embedding.vector);
    await db.$executeRawUnsafe(
      `INSERT INTO "ProductEmbedding"
         ("id", "shopDomain", "productId", "contentHash", "embedding", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::vector(${vector.length}), CURRENT_TIMESTAMP)`,
      randomUUID(),
      storeKey,
      embedding.productId,
      embedding.contentHash,
      `[${vector.join(",")}]`,
    );
  }
}
