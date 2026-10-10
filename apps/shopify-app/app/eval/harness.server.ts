import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  expandCategoryConstraint,
  type EmbeddingClient,
  type LlmClient,
} from "@unfiltered/engine";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import { embedCatalog } from "../catalog/embed.server";
import {
  enrichCatalog,
  visionAttributesFromStored,
  type VisionAttributes,
} from "../catalog/enrich.server";
import { hashImageBytes } from "../catalog/images.server";
import { computeContentHash, computeFamilyKey } from "../catalog/mapping.server";
import {
  createReplayEmbeddingClient,
  createReplayLlmClient,
  type EmbeddingRecording,
  type LlmRecording,
} from "./replay.server";

/**
 * The sparse-catalog eval harness (YOY-27): seeds the fixture catalog and
 * indexes it the way production does — text enrichment, the vision pass
 * over the listing images, product vectors — from recorded model outputs,
 * entirely offline and deterministic. The index evaluation here scores the
 * vision pass (contamination cases, sparse-product goldens); the
 * Constructor-bar set runs on the same index through the search engine in
 * `constructor-v2.server.ts`.
 */

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(fixturesDir, ...segments), "utf8")) as T;
}

/** One sparse fixture product, as checked into catalog.json. */
export interface EvalProduct {
  productId: string;
  title: string;
  description: string;
  tags: string[];
  vendor: string;
  productType: string;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  imageAltTexts: string[];
  sourceUpdatedAt: string;
  /**
   * Listing images under `fixtures/vision/` (YOY-122): the harness seeds
   * one `ProductImage` row per file, hashed like ingestion does, and the
   * vision pass reads the bytes back through `fixtureImageFetch`. Absent
   * for the text-only products.
   */
  images?: string[];
}

/** Where the vision fixture images live; every `EvalProduct.images` entry is a file name in it. */
export const VISION_FIXTURES_DIR = join(fixturesDir, "vision");
/** The size cap on a committed fixture image (YOY-122 AC-1). */
export const VISION_IMAGE_MAX_BYTES = 200 * 1024;
/** The URL scheme the harness stores on `ProductImage` rows for fixture files. */
export const FIXTURE_IMAGE_URL_PREFIX = "fixture://vision/";

/**
 * The fixture image fetcher (YOY-122): the vision pass re-reads image bytes
 * through `ImageFetch`, so the harness answers `fixture://vision/<file>`
 * from disk — a 404 for anything else, exactly as a CDN would.
 */
export async function fixtureImageFetch(url: string): Promise<Response> {
  if (!url.startsWith(FIXTURE_IMAGE_URL_PREFIX)) {
    return new Response("not a fixture image", { status: 404 });
  }
  const path = join(VISION_FIXTURES_DIR, url.slice(FIXTURE_IMAGE_URL_PREFIX.length));
  if (!existsSync(path)) {
    return new Response("missing fixture image", { status: 404 });
  }
  return new Response(readFileSync(path), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

/**
 * One contamination case (YOY-122 AC-1): a listing photo where a model wears
 * other garments, footwear, jewellery, or a bag beside the sold item. The
 * vision answer is scored against what the photo actually shows.
 */
export interface ContaminationCase {
  productId: string;
  sold: {
    item: string;
    /** Canonical categories the sold item may be labelled as. */
    categories: string[];
    /** Every colour that appears on the sold item itself. */
    colors: string[];
  };
  otherItems: Array<{ item: string; colors: string[] }>;
}

export function loadContaminationCases(): ContaminationCase[] {
  return readJson<{ cases: ContaminationCase[] }>("vision", "cases.json").cases;
}

/** The sparse-product goldens only vision can satisfy (YOY-122 AC-2). */
export function loadVisionGoldens(): Golden[] {
  return readJson<Golden[]>("vision-goldens.json");
}

/**
 * Footwear, jewellery, and bag words a sold garment's `styleTags` must never
 * carry (YOY-122 AC-1): a tag naming one of these on a hoodie or a dress is
 * the model's shoes or necklace leaking into the product.
 */
export const CONTAMINATION_TERMS: readonly string[] = [
  "sneaker", "sneakers", "trainer", "trainers", "shoe", "shoes", "boot", "boots",
  "heel", "heels", "sandal", "sandals", "pump", "pumps", "loafer", "loafers",
  "footwear", "necklace", "choker", "jewelry", "jewellery", "earring", "earrings",
  "bracelet", "bangle", "watch", "wristwatch", "ring", "pendant", "chain",
  "bag", "handbag", "tote", "purse", "clutch", "backpack", "satchel",
];

/** Lowercase, trimmed; grey and gray are one colour. */
export function normalizeColorWord(color: string): string {
  const word = color.trim().toLowerCase();
  return word === "gray" ? "grey" : word;
}

/**
 * Score one contamination case against the product's recorded vision answer
 * (YOY-122 AC-1): the category must be the sold item's; no answered colour —
 * `colors` or `primaryColor` — may be one that appears only on the other
 * items in the photo (their colours minus the sold item's); no `styleTag`
 * may name footwear, jewellery, or a bag. A missing answer is a violation:
 * a case the vision pass never scored proves nothing.
 */
export function contaminationViolations(
  kase: ContaminationCase,
  vision: VisionAttributes | null,
): string[] {
  const id = kase.productId;
  if (vision === null) {
    return [`${id}: no vision answer recorded`];
  }
  const violations: string[] = [];
  const categories = kase.sold.categories.map((category) => category.toLowerCase());
  if (!categories.includes(vision.category.toLowerCase())) {
    violations.push(
      `${id}: category "${vision.category}" is not the sold item's [${categories.join(", ")}] (${kase.sold.item})`,
    );
  }
  const soldColors = new Set(kase.sold.colors.map(normalizeColorWord));
  const foreign = new Map<string, string>();
  for (const other of kase.otherItems) {
    for (const color of other.colors) {
      const word = normalizeColorWord(color);
      if (!soldColors.has(word) && !foreign.has(word)) {
        foreign.set(word, other.item);
      }
    }
  }
  const answered = new Set(
    [...vision.colors, ...(vision.primaryColor === null ? [] : [vision.primaryColor])].map(
      normalizeColorWord,
    ),
  );
  for (const color of answered) {
    const owner = foreign.get(color);
    if (owner !== undefined) {
      violations.push(`${id}: colour "${color}" belongs to the ${owner}, not the ${kase.sold.item}`);
    }
  }
  for (const tag of vision.styleTags) {
    const tokens = tag.toLowerCase().split(/[^a-z]+/).filter((token) => token !== "");
    const leaked = tokens.find((token) => CONTAMINATION_TERMS.includes(token));
    if (leaked !== undefined) {
      violations.push(`${id}: styleTag "${tag}" names ${leaked} on a ${kase.sold.item}`);
    }
  }
  return violations;
}

/** The hard constraints a golden query's results are checked against. */
export interface GoldenConstraints {
  category: string | null;
  priceMin: number | null;
  priceMax: number | null;
  colorsInclude: string[];
  colorsExclude: string[];
  /**
   * Negated / required attribute words (YOY-133); absent reads as none. The
   * Constructor-bar goldens pin the negation outcome through
   * `mustNotProductIds` instead.
   */
  attributesExclude?: string[];
  attributesInclude?: string[];
  occasion: string | null;
  availabilityRequired: boolean;
}

/** One golden query: its text, the products it expects, and its hard constraints. */
export interface Golden {
  id: string;
  language: "en" | "he" | "mixed";
  query: string;
  hardConstraints: GoldenConstraints;
  expectedProductIds: string[];
}

/**
 * The three Constructor-bar groups (YOY-118): the hardest public
 * natural-language search bar (docs/COMPETITORS.md) — negations, price caps,
 * and "dress for a wedding ≠ wedding dress".
 */
export const CONSTRUCTOR_GROUPS = ["negation", "priceCap", "occasionVsCategory"] as const;
export type ConstructorGroup = (typeof CONSTRUCTOR_GROUPS)[number];

/** One Constructor-bar golden: an ordinary golden tagged with its group. */
export interface ConstructorGolden extends Golden {
  language: "en" | "he";
  group: ConstructorGroup;
  /** The products the query must keep out of its results. */
  mustNotProductIds: string[];
}

/** The set's minimum sizes (YOY-118 AC-1), enforced by the loader. */
export const CONSTRUCTOR_SET_MINIMUMS = {
  total: 24,
  perLanguage: 12,
  perGroup: 8,
} as const;

export function loadCatalog(): EvalProduct[] {
  return readJson<EvalProduct[]>("catalog.json");
}

/**
 * Load and validate the Constructor-bar set (YOY-118 AC-1): every golden
 * carries a known group and a `mustNotProductIds` list, and the set meets
 * its minimum sizes overall, per language, and per group. A malformed set
 * throws rather than silently scoring a smaller bar.
 */
export function loadConstructorGoldens(): ConstructorGolden[] {
  const goldens = readJson<ConstructorGolden[]>("constructor-goldens.json");
  const problems: string[] = [];
  for (const golden of goldens) {
    if (!CONSTRUCTOR_GROUPS.includes(golden.group)) {
      problems.push(`${golden.id}: unknown group ${JSON.stringify(golden.group)}`);
    }
    if (golden.language !== "en" && golden.language !== "he") {
      problems.push(`${golden.id}: language must be en or he`);
    }
    if (!Array.isArray(golden.mustNotProductIds)) {
      problems.push(`${golden.id}: mustNotProductIds missing`);
    }
    if (!Array.isArray(golden.expectedProductIds) || golden.expectedProductIds.length === 0) {
      problems.push(`${golden.id}: expectedProductIds missing or empty`);
    }
    if (golden.hardConstraints === undefined) {
      problems.push(`${golden.id}: hardConstraints missing`);
    }
  }
  const count = (predicate: (golden: ConstructorGolden) => boolean): number =>
    goldens.filter(predicate).length;
  if (goldens.length < CONSTRUCTOR_SET_MINIMUMS.total) {
    problems.push(`set has ${goldens.length} goldens, minimum ${CONSTRUCTOR_SET_MINIMUMS.total}`);
  }
  for (const language of ["en", "he"] as const) {
    const size = count((golden) => golden.language === language);
    if (size < CONSTRUCTOR_SET_MINIMUMS.perLanguage) {
      problems.push(`${language}: ${size} goldens, minimum ${CONSTRUCTOR_SET_MINIMUMS.perLanguage}`);
    }
  }
  for (const group of CONSTRUCTOR_GROUPS) {
    const size = count((golden) => golden.group === group);
    if (size < CONSTRUCTOR_SET_MINIMUMS.perGroup) {
      problems.push(`${group}: ${size} goldens, minimum ${CONSTRUCTOR_SET_MINIMUMS.perGroup}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`eval: constructor-goldens.json is malformed:\n${problems.join("\n")}`);
  }
  return goldens;
}

/** The enrichment facts the violation scorer reads per product. */
export interface ScoredEnrichment {
  category: string | null;
  colors: string[];
  occasions: string[];
  /** The primary/displayed colour (YOY-110); exclusions are judged on it. */
  primaryColor: string | null;
}

/** Check one indexed product against a golden's hard constraints. Exported
 * for the harness's own scoring tests (YOY-29 AC-11). Empty enrichment
 * occasions/colors are unknown, not violations of positive constraints —
 * only stated-and-mismatched values violate (YOY-35 AC-2) — and a category
 * constraint admits its taxonomy group's members (AC-5). An excluded colour
 * is judged by the primary colour alone (YOY-110 AC-5): a product that also
 * comes in the excluded colour is not a violation, and a null primary colour
 * is unknown. */
export function findViolations(
  golden: Golden,
  productId: string,
  products: Map<string, EvalProduct>,
  enrichments: Map<string, ScoredEnrichment>,
): string[] {
  const constraints = golden.hardConstraints;
  const product = products.get(productId);
  if (product === undefined) {
    return [`${productId}: not in the fixture catalog`];
  }
  const enrichment = enrichments.get(productId);
  const violations: string[] = [];
  if (constraints.priceMax !== null && product.priceMin > constraints.priceMax) {
    violations.push(`${productId}: price ${product.priceMin} > cap ${constraints.priceMax}`);
  }
  if (constraints.priceMin !== null && product.priceMax < constraints.priceMin) {
    violations.push(`${productId}: price ${product.priceMax} < floor ${constraints.priceMin}`);
  }
  if (constraints.availabilityRequired && !product.available) {
    violations.push(`${productId}: unavailable despite availability requirement`);
  }
  if (constraints.category !== null) {
    const category = enrichment?.category?.toLowerCase() ?? null;
    const admitted = expandCategoryConstraint(constraints.category);
    if (category === null || !admitted.includes(category)) {
      violations.push(`${productId}: category "${category}" ∉ [${admitted.join(", ")}]`);
    }
  }
  if (constraints.occasion !== null) {
    const occasions = (enrichment?.occasions ?? []).map((occasion) =>
      occasion.toLowerCase(),
    );
    if (
      occasions.length > 0 &&
      !occasions.includes(constraints.occasion.toLowerCase())
    ) {
      violations.push(
        `${productId}: occasions [${occasions.join(", ")}] miss "${constraints.occasion}"`,
      );
    }
  }
  const colors = new Set(
    (enrichment?.colors ?? []).map((color) => color.toLowerCase()),
  );
  const primaryColor = enrichment?.primaryColor?.toLowerCase() ?? null;
  for (const excluded of constraints.colorsExclude) {
    if (primaryColor !== null && primaryColor === excluded.toLowerCase()) {
      violations.push(
        `${productId}: primary color is the excluded color "${excluded}"`,
      );
    }
  }
  if (
    constraints.colorsInclude.length > 0 &&
    colors.size > 0 &&
    !constraints.colorsInclude.some((color) => colors.has(color.toLowerCase()))
  ) {
    violations.push(`${productId}: carries none of the required colors`);
  }
  return violations;
}

/**
 * Seed the eval catalog into `shopDomain` and index it exactly the way
 * production does: the snapshot rows and listing images, then the real
 * enrichment (text and vision) and embedding pipelines over the given
 * ports. Shared by the index eval and the Engine v2 Constructor suite
 * (YOY-153 AC-2). Returns how many products carry listing images.
 */
export async function indexEvalCatalog({
  db,
  shopDomain,
  catalog,
  llm,
  embeddings,
}: {
  db: PrismaClient;
  shopDomain: string;
  catalog: EvalProduct[];
  llm: LlmClient;
  embeddings: EmbeddingClient;
}): Promise<number> {
  let visionProducts = 0;
  for (const { sourceUpdatedAt, images, ...product } of catalog) {
    await db.catalogProduct.create({
      data: {
        ...product,
        shopDomain,
        sourceUpdatedAt: new Date(sourceUpdatedAt),
        contentHash: computeContentHash(product),
        // Same family rule every ingestion path applies (YOY-117 AC-1).
        familyKey: computeFamilyKey(product),
      },
    });
    // Listing images (YOY-122): one ProductImage row per fixture file, its
    // bytes hashed exactly as image capture hashes a CDN's — the key the
    // vision pass re-analyses on.
    for (const [position, file] of (images ?? []).entries()) {
      const bytes = readFileSync(join(VISION_FIXTURES_DIR, file));
      await db.productImage.create({
        data: {
          shopDomain,
          productId: product.productId,
          position,
          url: `${FIXTURE_IMAGE_URL_PREFIX}${file}`,
          contentHash: hashImageBytes(bytes),
          fetchedAt: new Date(sourceUpdatedAt),
        },
      });
    }
    if ((images ?? []).length > 0) {
      visionProducts += 1;
    }
  }
  // Text enrichment plus the vision pass (YOY-122), both answered from
  // recordings: the same replay client serves operation "vision".
  const enrichResult = await enrichCatalog({
    db,
    shopDomain,
    llm,
    vision: { llm, fetchImage: fixtureImageFetch },
  });
  if (enrichResult.failed > 0) {
    throw new Error(`eval enrichment failed for ${enrichResult.failed} products`);
  }
  if ((enrichResult.vision?.failed ?? 0) > 0) {
    throw new Error(
      `eval vision pass failed for ${enrichResult.vision?.failed} products — a vision recording is missing or broken; regenerate with REGEN_SCOPE=vision`,
    );
  }
  await embedCatalog({ db, shopDomain, embeddings });
  return visionProducts;
}

/** One sparse-product golden scored on the index (YOY-122 AC-2). */
export interface SparseScore {
  golden: Golden;
  /** The expected products whose indexed facts satisfy the query, in golden order. */
  satisfied: string[];
  /** Why each other expected product falls short (empty when every one satisfies it). */
  gaps: string[];
}

/**
 * The facts a sparse golden asks of one expected product (YOY-122 AC-2):
 * its hard constraints hold on the indexed product (`findViolations`), and
 * the colour it asks for is stated — on a title-only product only the
 * vision pass can state it, so an unknown colour is a gap here, not a pass.
 */
export function sparseGaps(
  golden: Golden,
  productId: string,
  products: Map<string, EvalProduct>,
  enrichments: Map<string, ScoredEnrichment>,
): string[] {
  const gaps = findViolations(golden, productId, products, enrichments);
  const colors = enrichments.get(productId)?.colors ?? [];
  if (golden.hardConstraints.colorsInclude.length > 0 && colors.length === 0) {
    gaps.push(`${productId}: no colour stated`);
  }
  return gaps;
}

/** The outcome of one index evaluation run. */
export interface IndexEvalResult {
  catalogSize: number;
  /** Contamination cases scored (YOY-122 AC-1). */
  contaminationCases: number;
  /** Every contamination violation across the cases (bar: none). */
  contaminationViolations: string[];
  /** One row per sparse-product golden (YOY-122 AC-2). */
  perSparse: SparseScore[];
  /** Fraction of the sparse goldens with a satisfied expected product (bar ≥ 0.8). */
  sparseHitRate: number;
  /** Products the vision pass analysed from fixture images. */
  visionProducts: number;
  /** The `vision` ledger rows of the run, USD: one-time indexing cost, reported on its own line. */
  visionCostUsd: number;
  /** The whole indexing run, USD: enrichment, vision and product vectors. */
  oneTimeCostUsd: number;
}

/**
 * Index the fixture catalog from the committed enrichment, vision and
 * product-vector recordings, then score the vision pass: every
 * contamination case on the vision answer, and every sparse-product golden
 * on the merged facts its expected products were indexed with.
 */
export async function runIndexEval(db: PrismaClient): Promise<IndexEvalResult> {
  const shopDomain = "eval-shop.example.com";
  const catalog = loadCatalog();
  const visionGoldens = loadVisionGoldens();
  const contaminationCases = loadContaminationCases();
  const costRecorder = createPrismaCostRecorder(db);
  const llm = createReplayLlmClient({
    recordings: {
      enrichment: readJson<LlmRecording>("recorded", "enrichment.json"),
      vision: readJson<LlmRecording>("recorded", "vision.json"),
    },
    costRecorder,
  });
  const embeddings = createReplayEmbeddingClient({
    recording: readJson<EmbeddingRecording>("recorded", "embeddings.json"),
    costRecorder,
  });

  const visionProducts = await indexEvalCatalog({ db, shopDomain, catalog, llm, embeddings });

  const products = new Map(catalog.map((product) => [product.productId, product]));
  const enrichmentRows = await db.productEnrichment.findMany({ where: { shopDomain } });
  const enrichments = new Map(
    enrichmentRows.map((row) => [
      row.productId,
      {
        category: row.category,
        colors: row.colors,
        occasions: row.occasions,
        primaryColor: row.primaryColor,
      },
    ]),
  );
  // Contamination (YOY-122 AC-1): scored on the vision pass's OWN answer
  // (`visionAttributes`), not the merged columns — the question is what the
  // model attributed to the sold item, before the text answer had its say.
  const visionByProduct = new Map(
    enrichmentRows.map((row) => [row.productId, visionAttributesFromStored(row.visionAttributes)]),
  );
  const contamination = contaminationCases.flatMap((kase) =>
    contaminationViolations(kase, visionByProduct.get(kase.productId) ?? null),
  );
  // Sparse goldens (YOY-122 AC-2): on the MERGED facts, the ones search reads.
  const perSparse = visionGoldens.map((golden): SparseScore => {
    const satisfied: string[] = [];
    const gaps: string[] = [];
    for (const productId of golden.expectedProductIds) {
      const found = sparseGaps(golden, productId, products, enrichments);
      if (found.length === 0) {
        satisfied.push(productId);
      } else {
        gaps.push(...found);
      }
    }
    return { golden, satisfied, gaps };
  });

  const rows = await db.aiCall.findMany();
  const result: IndexEvalResult = {
    catalogSize: catalog.length,
    contaminationCases: contaminationCases.length,
    contaminationViolations: contamination,
    perSparse,
    sparseHitRate:
      perSparse.length === 0
        ? 0
        : perSparse.filter((score) => score.satisfied.length > 0).length / perSparse.length,
    visionProducts,
    visionCostUsd: rows
      .filter((row) => row.operation === "vision")
      .reduce((sum, row) => sum + row.costUsd, 0),
    oneTimeCostUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
  };
  printIndexReport(result);
  return result;
}

/** The index scorecard: sparse goldens, contamination, and the indexing cost. */
function printIndexReport(result: IndexEvalResult): void {
  const lines = [
    "",
    "index eval — the vision pass over the sparse catalog (YOY-122)",
    "id   | lang  | satisfied | query",
    "-----+-------+-----------+------",
  ];
  for (const score of result.perSparse) {
    lines.push(
      [
        score.golden.id.padEnd(4),
        score.golden.language.padEnd(5),
        (score.satisfied.join(",") || "MISS").padEnd(9),
        score.golden.query,
      ].join(" | "),
    );
    for (const gap of score.gaps) {
      lines.push(`  GAP: ${gap}`);
    }
  }
  const sparseHits = result.perSparse.filter((score) => score.satisfied.length > 0).length;
  lines.push(
    `sparse goldens: ${sparseHits}/${result.perSparse.length} (${(result.sparseHitRate * 100).toFixed(0)} %; bar: ≥ 80 %)`,
    `contamination violations: ${result.contaminationViolations.length} over ${result.contaminationCases} cases (bar: 0)`,
    ...result.contaminationViolations.map((violation) => `  VIOLATION: ${violation}`),
    `one-time vision cost (${result.visionProducts} products with images): $${result.visionCostUsd.toFixed(4)}`,
    `one-time indexing cost (enrichment + vision + embedding, ${result.catalogSize} products): $${result.oneTimeCostUsd.toFixed(4)}`,
    "",
  );
  console.log(lines.join("\n"));
}
