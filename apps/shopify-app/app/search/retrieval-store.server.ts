import type { PrismaClient } from "@prisma/client";
import type {
  RetrievalStore,
  StoreQueryHit,
  StoreQueryRequest,
} from "@unfiltered/engine";
import { expandCategoryConstraint } from "@unfiltered/engine";

/**
 * Postgres/pgvector implementation of the engine's RetrievalStore port.
 *
 * Every hard constraint is a WHERE predicate inside the similarity query
 * itself — a product violating any constraint is filtered before ranking and
 * can never appear, regardless of similarity (AC-2). The shopDomain predicate
 * is part of the same query, so no other store's products are reachable
 * (AC-4).
 *
 * Attribute constraints (category, colors, occasion) compare against the
 * enrichment row, whose values are normalized lowercase English; constraint
 * values are lowercased in SQL to match. Hard filters enforce only what is
 * KNOWN (YOY-35 AC-1): a positive occasion or colorsInclude constraint keeps
 * products whose enrichment states no occasions/colors — absence of data is
 * not a mismatch, and vector similarity ranks them — while a stated-and-
 * mismatched value still excludes. Exclusions likewise keep unknowns (nothing
 * proves an excluded color). Category stays evidence-required, expanded
 * through the taxonomy's category groups (AC-5) so a parent constraint
 * ("shoes") admits its members ("sneakers"). Price and availability come from
 * the catalog snapshot itself.
 *
 * Vector comparisons cast both sides through the query vector's dimension, so
 * stored vectors of a different dimension fail loudly instead of comparing
 * garbage — same rule as app/catalog/embed.server.ts.
 */
export function createPgVectorRetrievalStore(db: PrismaClient): RetrievalStore {
  return {
    async query(request: StoreQueryRequest): Promise<StoreQueryHit[]> {
      const { shopDomain, constraints, vector, limit } = request;
      const dimension = vector.length;
      if (!Number.isInteger(dimension) || dimension <= 0) {
        throw new RangeError(
          `query vector dimension must be a positive integer, got ${dimension}`,
        );
      }
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer, got ${limit}`);
      }

      const params: unknown[] = [shopDomain, `[${vector.join(",")}]`];
      // status guard (YOY-61 AC-3) and publication guard (YOY-67 AC-4):
      // defense in depth — ingestion should never store a non-active or
      // unpublished product, but one that exists anyway must not serve.
      const where: string[] = [
        `e."shopDomain" = $1`,
        `p."status" = 'ACTIVE'`,
        `p."publishedAt" IS NOT NULL`,
      ];
      const param = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };

      if (constraints.priceMax !== undefined) {
        // Violates the cap when even its cheapest variant is above it.
        where.push(`p."priceMin" <= ${param(constraints.priceMax)}`);
      }
      if (constraints.priceMin !== undefined) {
        where.push(`p."priceMax" >= ${param(constraints.priceMin)}`);
      }
      if (constraints.availableOnly) {
        where.push(`p."available"`);
      }
      if (constraints.category !== undefined) {
        where.push(
          `lower(en."category") IN (SELECT lower(v)
             FROM json_array_elements_text(${param(JSON.stringify(expandCategoryConstraint(constraints.category)))}::json) v)`,
        );
      }
      if (constraints.occasion !== undefined) {
        where.push(
          `(COALESCE(cardinality(en."occasions"), 0) = 0
             OR EXISTS (SELECT 1 FROM unnest(en."occasions") o
               WHERE lower(o) = lower(${param(constraints.occasion)})))`,
        );
      }
      if (constraints.colorsInclude.length > 0) {
        where.push(
          `(COALESCE(cardinality(en."colors"), 0) = 0
             OR EXISTS (SELECT 1 FROM unnest(en."colors") c
               WHERE lower(c) IN (SELECT lower(v)
                 FROM json_array_elements_text(${param(JSON.stringify(constraints.colorsInclude))}::json) v)))`,
        );
      }
      if (constraints.colorsExclude.length > 0) {
        where.push(
          `NOT EXISTS (SELECT 1 FROM unnest(COALESCE(en."colors", '{}')) c
             WHERE lower(c) IN (SELECT lower(v)
               FROM json_array_elements_text(${param(JSON.stringify(constraints.colorsExclude))}::json) v))`,
        );
      }

      // Color-evidence tiering (YOY-67 AC-5): under a color constraint —
      // inclusion or exclusion; both render a color chip — products that
      // passed only on the unknown-passes leniency (enrichment states no
      // colors) rank strictly below evidence-backed hits — inside the
      // query, so an unknown can never displace a known match from the top
      // N — and are flagged for the consumer to render de-emphasized.
      const colorTiering =
        constraints.colorsInclude.length > 0 ||
        constraints.colorsExclude.length > 0;
      const colorUnknownExpr = colorTiering
        ? `(COALESCE(cardinality(en."colors"), 0) = 0)`
        : null;
      const rows = await db.$queryRawUnsafe<
        Array<{ productId: string; distance: number; colorUnknown?: boolean }>
      >(
        `SELECT e."productId",
                ((e."embedding")::vector(${dimension}) <=> $2::vector(${dimension}))::float8 AS distance${
                  colorUnknownExpr === null
                    ? ""
                    : `,\n                ${colorUnknownExpr} AS "colorUnknown"`
                }
         FROM "ProductEmbedding" e
         JOIN "CatalogProduct" p
           ON p."shopDomain" = e."shopDomain" AND p."productId" = e."productId"
         LEFT JOIN "ProductEnrichment" en
           ON en."shopDomain" = e."shopDomain" AND en."productId" = e."productId"
          AND en."status" = 'enriched'
         WHERE ${where.join("\n           AND ")}
         ORDER BY ${colorUnknownExpr === null ? "" : `${colorUnknownExpr} ASC, `}distance ASC
         LIMIT ${limit}`,
        ...params,
      );
      return rows.map((row) => ({
        productId: row.productId,
        distance: row.distance,
        ...(colorTiering ? { colorUnknown: row.colorUnknown === true } : {}),
      }));
    },
  };
}
