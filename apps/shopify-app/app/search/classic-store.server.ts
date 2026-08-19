import type { PrismaClient } from "@prisma/client";
import type {
  ClassicSearchHit,
  ClassicSearchRequest,
  ClassicSearchResult,
  ClassicSearchStore,
  RetrievalConstraints,
} from "@unfiltered/engine";
import { expandCategoryConstraint, normalizeQuery } from "@unfiltered/engine";

/**
 * Postgres/pg_trgm implementation of the engine's ClassicSearchStore port
 * (YOY-41): trigram keyword search over catalog_search_text(...) — the
 * migration-owned function joining title, tags, vendor, productType, and
 * imageAltTexts — with zero LLM/embedding calls anywhere on this path.
 *
 * Text ranking is title-dominant word similarity (YOY-52 AC-13): a weighted
 * sum of word_similarity against the title and against the full search text,
 * typo-tolerant for one- or two-edit misspellings in any script, `<%`
 * filtered on the full search text so the trigram GIN index drives the plan. The word-similarity threshold is lowered to 0.30
 * via a transaction-local set_config, run in the same interactive
 * transaction as the search so the setting cannot leak to other pooled
 * connections.
 *
 * Constraint predicates mirror the pgvector RetrievalStore
 * (retrieval-store.server.ts) verbatim — the two stores must never drift,
 * because the orchestrator falls back from one to the other: unknown
 * enrichment passes positive occasion/color constraints, category stays
 * evidence-required and expands through the taxonomy's category groups, and
 * a price cap compares against `priceMin`. Constraint-only requests (no
 * query text) filter without ranking and score every hit 0, ordered
 * deterministically by productId.
 */

/** word_similarity floor for a row to count as a keyword match. */
const WORD_SIMILARITY_THRESHOLD = 0.3;

/**
 * Ranking weights (YOY-52 AC-13): title similarity must dominate — the M3
 * live run ranked "Gift Card" above actual snowboards for "snowbaord" via
 * tag/alt-text matches. A pure title match scores at least TITLE_WEIGHT
 * while a pure secondary-field match tops out at SECONDARY_WEIGHT, so a
 * title match always outranks a tags/vendor/type/alt-text-only match. The
 * `<%` candidate filter stays on the full search text, so the trigram GIN
 * index still drives the plan and secondary-field-only matches remain
 * findable — they just rank below title matches.
 */
const TITLE_WEIGHT = 0.7;
const SECONDARY_WEIGHT = 0.3;

/**
 * The searchable-text expression; must match the migration's index exactly.
 * Exported for the EXPLAIN test proving the index serves this expression.
 */
export const SEARCH_TEXT = `catalog_search_text(p."title", p."tags", p."vendor", p."productType", p."imageAltTexts")`;

const NO_CONSTRAINTS: RetrievalConstraints = {
  colorsInclude: [],
  colorsExclude: [],
  availableOnly: false,
};

/** Build the SQL and bind params for one search. */
function buildClassicSearchSql(request: ClassicSearchRequest): {
  sql: string;
  params: unknown[];
} {
  const constraints = request.constraints ?? NO_CONSTRAINTS;
  const query = normalizeQuery(request.query ?? "");
  // Absent limit = the full ranked match set (YOY-107): the parity floor is
  // every product matching the query and constraints, and the consumer
  // paginates it. A present limit is still validated.
  const limit = request.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }

  const params: unknown[] = [request.storeId];
  // status guard (YOY-61 AC-3) and publication guard (YOY-67 AC-4): defense
  // in depth — ingestion should never store a non-active or unpublished
  // product, but one that exists anyway must not serve.
  const where: string[] = [
    `p."shopDomain" = $1`,
    `p."status" = 'ACTIVE'`,
    `p."publishedAt" IS NOT NULL`,
  ];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Color-evidence tiering (YOY-67 AC-5), mirroring the pgvector store:
  // under a color constraint — inclusion or exclusion; both render a color
  // chip — unknown-passes hits rank strictly below evidence-backed hits and
  // are flagged for the consumer.
  const colorUnknownExpr =
    constraints.colorsInclude.length > 0 || constraints.colorsExclude.length > 0
      ? `(COALESCE(cardinality(en."colors"), 0) = 0)`
      : null;
  const colorTierPrefix =
    colorUnknownExpr === null ? "" : `${colorUnknownExpr} ASC, `;

  let select: string;
  let orderBy: string;
  if (query !== "") {
    const queryParam = param(query);
    where.push(`${queryParam} <% ${SEARCH_TEXT}`);
    select = `(${TITLE_WEIGHT} * word_similarity(${queryParam}, p."title")
        + ${SECONDARY_WEIGHT} * word_similarity(${queryParam}, ${SEARCH_TEXT}))::float8 AS score`;
    orderBy = `${colorTierPrefix}score DESC, p."productId" ASC`;
  } else {
    select = `0::float8 AS score`;
    orderBy = `${colorTierPrefix}p."productId" ASC`;
  }
  if (colorUnknownExpr !== null) {
    select += `,\n        ${colorUnknownExpr} AS "colorUnknown"`;
  }

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

  const sql = `SELECT p."productId", ${select}
     FROM "CatalogProduct" p
     LEFT JOIN "ProductEnrichment" en
       ON en."shopDomain" = p."shopDomain" AND en."productId" = p."productId"
      AND en."status" = 'enriched'
     WHERE ${where.join("\n       AND ")}
     ORDER BY ${orderBy}${limit === undefined ? "" : `
     LIMIT ${limit}`}`;
  return { sql, params };
}

export function createPgTrgmClassicStore(db: PrismaClient): ClassicSearchStore {
  return {
    async search(request: ClassicSearchRequest): Promise<ClassicSearchResult> {
      const { sql, params } = buildClassicSearchSql(request);
      // Same interactive transaction: the threshold set_config is
      // transaction-local (is_local = true) and the search must see it.
      const [, rows] = await db.$transaction([
        db.$queryRawUnsafe(
          `SELECT set_config('pg_trgm.word_similarity_threshold', '${WORD_SIMILARITY_THRESHOLD}', true)`,
        ),
        db.$queryRawUnsafe<
          Array<{ productId: string; score: number; colorUnknown?: boolean }>
        >(sql, ...params),
      ]);
      return {
        hits: (
          rows as Array<{
            productId: string;
            score: number;
            colorUnknown?: boolean;
          }>
        ).map(
          (row): ClassicSearchHit => ({
            productId: row.productId,
            score: row.score,
            ...(row.colorUnknown !== undefined
              ? { colorUnknown: row.colorUnknown === true }
              : {}),
          }),
        ),
      };
    },
  };
}
