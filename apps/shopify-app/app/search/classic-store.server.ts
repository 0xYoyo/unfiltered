import type { PrismaClient } from "@prisma/client";
import type {
  ClassicSearchHit,
  ClassicSearchRequest,
  ClassicSearchResult,
  ClassicSearchStore,
} from "@unfiltered/engine";
import { normalizeQuery } from "@unfiltered/engine";

/**
 * Postgres/pg_trgm implementation of the engine's ClassicSearchStore port
 * (YOY-41): trigram keyword search over catalog_search_text(...) — the
 * migration-owned function joining title, tags, vendor, productType, and
 * imageAltTexts — with zero LLM/embedding calls anywhere on this path.
 *
 * Text ranking is title-dominant word similarity (YOY-52 AC-13): a weighted
 * sum of word_similarity against the title and against the full search text,
 * typo-tolerant for one- or two-edit misspellings in any script, `<%`
 * filtered on the full search text so the trigram GIN index drives the plan.
 *
 * ONE statement per search (YOY-115 AC-1). The word-similarity threshold is
 * lowered to 0.30 inside the statement itself: a one-row subquery calling
 * `set_config(..., is_local = true)` is the outer side of a LATERAL join
 * whose inner side is the search and references that row, so the executor
 * must produce the outer row — running set_config — before the inner GIN
 * scan reads `pg_trgm.word_similarity_threshold`. `is_local` scopes the
 * setting to the statement's own transaction, so it cannot leak to other
 * connections through a pooler. The statement also returns the card fields
 * (title, url, image, prices, currency, availability) directly, so the
 * orchestrator serves classic results with no follow-up hydration query:
 * every classic search — every keystroke preview, every rescue — is exactly
 * one round trip to the database.
 *
 * A request with no query text returns every product of the store,
 * scoring every hit 0, ordered deterministically by productId.
 *
 * One hit per product family (YOY-117 AC-2): colourways sharing
 * `familyKey` collapse to one representative inside the statement
 * (`DISTINCT ON`), the best-ranked; the limit applies after the collapse,
 * so pages count families. An empty `familyKey` is its own family.
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

/** The display fields a classic hit carries, read in the same statement. */
export interface ClassicCard {
  title: string;
  url: string | null;
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
}

/**
 * A classic hit with its card folded in (YOY-115 AC-1): the engine port's
 * hit plus the fields the orchestrator would otherwise hydrate with a
 * second query. The port stays vendor-free; this is the app store's richer
 * result, which the orchestrator recognises by the `card` field.
 */
export interface ClassicCardHit extends ClassicSearchHit {
  card: ClassicCard;
}

/** Column list of the card fields, aliased to the ProductCard names. */
const CARD_COLUMNS = `p."title", p."url", p."featuredImageUrl" AS "imageUrl",
        p."priceMin", p."priceMax", p."currencyCode", p."available"`;

/**
 * Build the single SQL statement and bind params for one search. Exported
 * for the plan test proving the trigram index still serves the statement
 * in its LATERAL form.
 */
export function buildClassicSearchSql(request: ClassicSearchRequest): {
  sql: string;
  params: unknown[];
} {
  const query = normalizeQuery(request.query ?? "");
  // Absent limit = the full ranked match set (YOY-107): the parity floor is
  // every product matching the query, and the consumer paginates it. A
  // present limit is still validated.
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

  let select: string;
  let orderBy: string;
  if (query !== "") {
    const queryParam = param(query);
    where.push(`${queryParam} <% ${SEARCH_TEXT}`);
    select = `(${TITLE_WEIGHT} * word_similarity(${queryParam}, p."title")
        + ${SECONDARY_WEIGHT} * word_similarity(${queryParam}, ${SEARCH_TEXT}))::float8 AS score`;
    orderBy = `t.score DESC, t."productId" ASC`;
  } else {
    select = `0::float8 AS score`;
    orderBy = `t."productId" ASC`;
  }
  // Family collapse (YOY-117 AC-2): the family rides the inner select;
  // DISTINCT ON keeps one row per family.
  select += `,\n        COALESCE(NULLIF(p."familyKey", ''), p."productId") AS "family"`;

  // The threshold row: `s."threshold"` is referenced by the inner WHERE, so
  // the LATERAL dependency is real and the executor runs set_config first.
  // Ordering and the cap sit on the outer query over the joined columns —
  // one statement, one plan, one round trip.
  const sql = `SELECT t."productId", t."title", t."url", t."imageUrl",
        t."priceMin", t."priceMax", t."currencyCode", t."available", t.score
     FROM (
       SELECT DISTINCT ON (t."family") t.*
       FROM (SELECT set_config('pg_trgm.word_similarity_threshold', '${WORD_SIMILARITY_THRESHOLD}', true) AS "threshold") s
       CROSS JOIN LATERAL (
         SELECT p."productId", ${CARD_COLUMNS},
          ${select}
         FROM "CatalogProduct" p
         WHERE s."threshold" IS NOT NULL
           AND ${where.join("\n           AND ")}
       ) t
       ORDER BY t."family", ${orderBy}
     ) t
     ORDER BY ${orderBy}${limit === undefined ? "" : `
     LIMIT ${limit}`}`;
  return { sql, params };
}

interface ClassicRow extends ClassicCard {
  productId: string;
  score: number;
}

/** The pg_trgm store's result: the port's shape with every hit carrying its card. */
export interface ClassicCardSearchResult extends ClassicSearchResult {
  hits: ClassicCardHit[];
}

/** The engine port, narrowed to the card-bearing result this store returns. */
export interface PgTrgmClassicStore extends ClassicSearchStore {
  search(request: ClassicSearchRequest): Promise<ClassicCardSearchResult>;
}

export function createPgTrgmClassicStore(db: PrismaClient): PgTrgmClassicStore {
  return {
    async search(request: ClassicSearchRequest): Promise<ClassicCardSearchResult> {
      const { sql, params } = buildClassicSearchSql(request);
      // Exactly one statement, no transaction wrapper (YOY-115 AC-1): the
      // threshold is set inside the statement (see the header comment).
      const rows = await db.$queryRawUnsafe<ClassicRow[]>(sql, ...params);
      const hits: ClassicCardHit[] = rows.map((row) => ({
        productId: row.productId,
        score: row.score,
        card: {
          title: row.title,
          url: row.url,
          imageUrl: row.imageUrl,
          priceMin: row.priceMin,
          priceMax: row.priceMax,
          currencyCode: row.currencyCode,
          available: row.available,
        },
      }));
      return { hits };
    },
  };
}
