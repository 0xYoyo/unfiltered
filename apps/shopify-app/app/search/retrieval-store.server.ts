import type { PrismaClient } from "@prisma/client";
import type {
  RetrievalStore,
  StoreQueryHit,
  StoreQueryRequest,
} from "@unfiltered/engine";
import {
  attributeEvidenceTerms,
  expandCategoryConstraint,
} from "@unfiltered/engine";

import { withTenantVectorScan } from "../catalog/hnsw.server";

/**
 * The text an attribute constraint is judged on (YOY-133): the product's
 * platform-free snapshot text — title, tags, description — and the
 * enrichment evidence — `fit`, `styleTags`, and the five vision attribute
 * values. `concat_ws` skips NULLs, so an unenriched product (the LEFT JOIN
 * leaves `en` NULL) is judged on its snapshot text alone and a product
 * with no evidence of a word simply does not match it.
 */
const ATTRIBUTE_EVIDENCE_TEXT = `concat_ws(' ', p."title", array_to_string(p."tags", ' '), p."description",
               en."fit", array_to_string(en."styleTags", ' '), en."sleeveLength", en."neckline",
               en."garmentLength", en."pattern", en."materialAppearance")`;

/** A letter or digit in either script the catalogs carry: what a whole word may not touch. */
const WORD_CHAR = "[[:alnum:]\\u05D0-\\u05EA]";

/**
 * Negation markers, EN + HE: a term right after one of these is a statement
 * of ABSENCE, not evidence — "ללא צמר" (without wool) on a nylon coat,
 * "no sleeves" in a tank top's description — and must not exclude the
 * product from "not wool" / "no sleeves".
 */
const NEGATION_MARKERS = ["no", "not", "without", "non", "ללא", "בלי", "לא"];

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The POSIX-ARE pattern that is evidence of one attribute word (YOY-133),
 * bound as a parameter and matched case-insensitively (`~*`) against
 * `ATTRIBUTE_EVIDENCE_TEXT`. Every surface form of the word from the
 * engine's lexicon (EN and HE; the word itself, singular and plural, when
 * unlisted) matches as a WHOLE word — "sleeveless" is not "sleeves",
 * "Sleeveless Linen Tank Top" survives "no sleeves" — optionally carrying
 * one attached Hebrew preposition/article (מצמר, העור, ובצמר), and never
 * when it follows a negation marker or reads "<term>-free". Null for a
 * word the lexicon cannot turn into a term (an empty or multi-word value),
 * which the caller skips: a filter that can match nothing must not be
 * applied. Exported for the classic store, so the two never drift.
 */
export function attributeEvidencePattern(word: string): string | null {
  const terms = attributeEvidenceTerms(word);
  if (terms.length === 0) {
    return null;
  }
  const negated = `(^|[^${WORD_CHAR.slice(1)})(${NEGATION_MARKERS.join("|")})[ -]`;
  return (
    `(?<!${WORD_CHAR})(?<!${negated})` +
    `(ו?[בכלמהש])?(${terms.map(escapeRegex).join("|")})` +
    `(?!${WORD_CHAR})(?!-free)`
  );
}

/**
 * The WHERE predicates for an intent's attribute constraints (YOY-133),
 * identical in both stores: one `NOT (evidence ~* pattern)` per excluded
 * word — absent evidence passes, as for every enrichment constraint — and
 * one `(evidence ~* pattern)` per required category-like word, which is
 * evidence-required exactly as a category is. `param` binds each pattern
 * and returns its placeholder.
 */
export function attributeConstraintSql(
  constraints: { attributesExclude: string[]; attributesInclude: string[] },
  param: (value: unknown) => string,
): string[] {
  const predicates: string[] = [];
  for (const word of constraints.attributesExclude) {
    const pattern = attributeEvidencePattern(word);
    if (pattern !== null) {
      predicates.push(`NOT (${ATTRIBUTE_EVIDENCE_TEXT} ~* ${param(pattern)})`);
    }
  }
  for (const word of constraints.attributesInclude) {
    const pattern = attributeEvidencePattern(word);
    if (pattern !== null) {
      predicates.push(`(${ATTRIBUTE_EVIDENCE_TEXT} ~* ${param(pattern)})`);
    }
  }
  return predicates;
}

/**
 * The colour-evidence flag's SQL (YOY-67 AC-5, YOY-110 AC-3): under an
 * exclusion-only colour constraint the evidence is the primary colour —
 * `colorUnknown` means the enrichment states no primary colour — while a
 * positive constraint reads the full `colors` list as before. Shared with
 * the classic store so the two never drift.
 */
export function colorUnknownSql(constraints: {
  colorsInclude: string[];
  colorsExclude: string[];
}): string {
  return constraints.colorsInclude.length === 0 &&
    constraints.colorsExclude.length > 0
    ? `(en."primaryColor" IS NULL)`
    : `(COALESCE(cardinality(en."colors"), 0) = 0)`;
}

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
 * the catalog snapshot itself. A colour EXCLUSION compares against the
 * enrichment's `primaryColor` only (YOY-110): a pink dress that also comes
 * in black is not "black"; a null primary colour passes.
 *
 * One hit per product family (YOY-117 AC-2): colourways of one product share
 * `CatalogProduct.familyKey`, and the query collapses each family to one
 * representative INSIDE the SQL — `DISTINCT ON (family)` over the ranked
 * candidates — so `limit` and any pagination count families, never
 * colourways. The representative is the best-ranked member whose primary
 * colour is one of `colorsInclude` when the query names colours, else the
 * best-ranked member. A row with an empty `familyKey` (pre-YOY-117) is its
 * own family; the collapse never hides a different product.
 *
 * Negated attributes are hard exclusions and category-like attributes hard
 * inclusions (YOY-133; PRD §3 amendment (d)): `attributeConstraintSql`
 * above judges each word on the product's text and enrichment evidence,
 * whole-word, EN and HE, a negated mention never counting as evidence.
 *
 * Vector comparisons cast both sides through the query vector's dimension, so
 * stored vectors of a different dimension fail loudly instead of comparing
 * garbage — same rule as app/catalog/embed.server.ts.
 *
 * The shared HNSW index post-filters, so the shopDomain predicate alone does
 * not guarantee a small tenant its own nearest neighbours; the query runs
 * under iterative index scans for that (see catalog/hnsw.server.ts, YOY-105).
 */
export function createPgVectorRetrievalStore(db: PrismaClient): RetrievalStore {
  return {
    async query(request: StoreQueryRequest): Promise<StoreQueryHit[]> {
      const { storeId: shopDomain, constraints, vector, limit } = request;
      const dimension = vector.length;
      if (!Number.isInteger(dimension) || dimension <= 0) {
        throw new RangeError(
          `query vector dimension must be a positive integer, got ${dimension}`,
        );
      }
      // Absent limit = the full ranked match set (YOY-107): the parity floor
      // is every product satisfying the constraints, and the consumer
      // paginates it. A present limit is still validated.
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
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
      where.push(...attributeConstraintSql(constraints, param));
      if (constraints.colorsExclude.length > 0) {
        // Exclusion by PRIMARY colour (YOY-110 AC-3): a product is dropped
        // only when its primary/displayed colour is an excluded one; the
        // other colourways it comes in do not count, and a null primary
        // colour passes (unknown passes).
        where.push(
          `(en."primaryColor" IS NULL
             OR lower(en."primaryColor") NOT IN (SELECT lower(v)
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
        ? colorUnknownSql(constraints)
        : null;
      // Ranking keys, shared by the candidate scan and the re-rank below.
      const orderBy = `${colorUnknownExpr === null ? "" : `"colorUnknown" ASC, `}distance ASC`;
      // Family representative (YOY-117 AC-2): the member matching a
      // requested colour ranks first inside its family; a query without
      // colour inclusions keeps the best-ranked member.
      const preferredExpr =
        constraints.colorsInclude.length > 0
          ? `(lower(en."primaryColor") IN (SELECT lower(v)
                 FROM json_array_elements_text(${param(JSON.stringify(constraints.colorsInclude))}::json) v))`
          : `false`;
      // The candidate scan runs inside a MATERIALIZED CTE so its rows are
      // produced once and then re-sorted: iterative HNSW scans use
      // `relaxed_order` (YOY-105), which may emit candidates slightly out of
      // distance order, and the outer ORDER BY restores exact ordering
      // without changing which rows are selected. The family collapse and
      // the limit sit OUTSIDE the scan (YOY-117): the scan must see every
      // colourway to pick the right representative, and a limit applied
      // before collapsing would count colourways, not families.
      const rows = await withTenantVectorScan(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ productId: string; distance: number; colorUnknown?: boolean }>
        >(
          `WITH candidates AS MATERIALIZED (
           SELECT e."productId",
                ((e."embedding")::vector(${dimension}) <=> $2::vector(${dimension}))::float8 AS distance,
                COALESCE(NULLIF(p."familyKey", ''), p."productId") AS "family",
                COALESCE(${preferredExpr}, false) AS "preferred"${
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
         ORDER BY ${orderBy}
         ),
         families AS (
           SELECT DISTINCT ON ("family") *
           FROM candidates
           ORDER BY "family", "preferred" DESC, ${orderBy}
         )
         SELECT "productId", distance${colorUnknownExpr === null ? "" : `, "colorUnknown"`}
         FROM families ORDER BY ${orderBy}${
           limit === undefined
             ? ""
             : `
         LIMIT ${limit}`
         }`,
          ...params,
        ),
      );
      return rows.map((row) => ({
        productId: row.productId,
        distance: row.distance,
        ...(colorTiering ? { colorUnknown: row.colorUnknown === true } : {}),
      }));
    },
  };
}
