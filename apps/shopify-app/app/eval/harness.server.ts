import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import {
  constraintsFromIntent,
  createEscalatingIntentExtractor,
  createIntentExtractor,
  createQueryClassifier,
  createRetriever,
  DEFAULT_INTENT_ESCALATION_THRESHOLD,
  expandCategoryConstraint,
  type Intent,
  type IntentEscalation,
  type IntentTier,
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
import { createPgTrgmClassicStore } from "../search/classic-store.server";
import {
  createSearchOrchestrator,
  type ProductCard,
} from "../search/orchestrator.server";
import { createPgVectorRetrievalStore } from "../search/retrieval-store.server";
import {
  createReplayEmbeddingClient,
  createReplayLlmClient,
  type EmbeddingRecording,
  type LlmRecording,
} from "./replay.server";

/**
 * The sparse-catalog eval harness (YOY-27): indexes the fixture catalog
 * (enrichment → embedding) from recorded LLM/embedding outputs, then runs
 * every golden query through the hybrid search orchestrator end to end
 * (YOY-45 AC-8) — classification, intent, retrieval, and the classic keyword
 * engine behind one call — entirely offline and deterministic, and scores
 * each golden against its expectations.
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
  occasion: string | null;
  availabilityRequired: boolean;
}

/** One golden query, as checked into goldens.json. */
export interface Golden {
  id: string;
  language: "en" | "he" | "mixed";
  query: string;
  /** Route the classifier must resolve; absent means "ai" (YOY-41 AC-6). */
  expectedRoute?: "classic" | "ai";
  hardConstraints: GoldenConstraints;
  expectedProductIds: string[];
  /**
   * Products that must NOT appear in the top 10 (YOY-117 AC-3): the other
   * colourways of a family whose representative is expected. Each
   * appearance is scored as a violation.
   */
  mustNotProductIds?: string[];
  /**
   * A zero-hit golden (YOY-111 AC-5): the constraints' intersection is
   * empty on the fixture catalog by design, so the golden scores the
   * close-match ladder instead of a rank — hits must be empty, close
   * matches non-empty, none of them may carry the excluded primary colour,
   * and the first relaxed constraint must be `relaxedFirst`. Such a golden
   * lists no expected products.
   */
  zeroHit?: { relaxedFirst: string };
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
  /** Required on this set: the products the query must keep out of its top 10. */
  mustNotProductIds: string[];
}

/** The set's minimum sizes (YOY-118 AC-1), enforced by the loader. */
export const CONSTRUCTOR_SET_MINIMUMS = {
  total: 24,
  perLanguage: 12,
  perGroup: 8,
} as const;

/**
 * The committed Constructor-bar floor (YOY-118 AC-3): the overall hit rate
 * the harness achieved, rounded down to a whole percent. The floor records
 * what the engine does today; raise it only from a measured run.
 */
export interface ConstructorFloor {
  recordedAt: string;
  overallHitRatePercent: number;
  /**
   * The measured `mustNot` leak (AC-3, amended 2026-08-27): the engine has
   * no hard filter for material/sleeve/bridal negations today, so the
   * harness asserts no regression against these — at most this many
   * `mustNotProductIds` appearances, and at least this share of goldens
   * with none — while 0 stays the reported target (moved there by the
   * follow-up engine issue, YOY-133).
   */
  mustNotViolationsMax: number;
  mustNotCleanRatePercent: number;
}

/**
 * One refinement golden (YOY-42): the intent from the shopper's previous
 * query, the follow-up query, and the constraint outcome the extractor must
 * produce for it. `outcome` documents which behavior the golden pins — a
 * refinement of the previous intent, or a fresh intent after a topic change.
 */
export interface RefinementGolden {
  id: string;
  language: "en" | "he" | "mixed";
  /** What this golden demonstrates, for the scorecard and review. */
  note: string;
  previousIntent: Intent;
  query: string;
  outcome: "refinement" | "fresh";
  expectedConstraints: GoldenConstraints;
  /**
   * Comparative-tightening bounds (YOY-52 AC-15). When present, the named
   * price field is scored as an inequality against the previous intent's
   * bound — "cheaper" must land strictly below, "more expensive" strictly
   * above — instead of the exact `expectedConstraints` value, because a live
   * model's exact figure is its own choice; only the direction is the
   * contract.
   */
  expectedPriceMaxBelow?: number;
  expectedPriceMinAbove?: number;
  /** Expected size constraint, when the follow-up states or preserves one. */
  expectedSize?: string;
  /** Soft attributes the merged intent must carry, in order. */
  expectedSoftAttributes: string[];
}

/** The scorecard row for one refinement golden. */
export interface RefinementScore {
  golden: RefinementGolden;
  intent: Intent | null;
  /** Which tier answered the follow-up's intent call (YOY-116). */
  intentTier: IntentTier | null;
  /** Why it escalated, when it did. */
  escalation: IntentEscalation | null;
  /** Constraint outcomes that missed the golden's expectation (empty is clean). */
  violations: string[];
  costUsd: number;
}

/** The scorecard row for one golden query. */
export interface QueryScore {
  golden: Golden;
  route: string;
  routeReason: string;
  intent: Intent | null;
  /** Which tier answered the intent call; null on classic routes (YOY-116). */
  intentTier: IntentTier | null;
  hits: ProductCard[];
  /** The zero-hit rescue, when the response carried one (YOY-111). */
  closeMatches: ProductCard[];
  closeMatchesRelaxed: string[];
  /** 1-based rank of the first expected product in the top 10, or null. */
  firstExpectedRank: number | null;
  /**
   * For a `zeroHit` golden: whether the ladder answered as specified
   * (YOY-111 AC-5). Null for every other golden. A satisfied zero-hit
   * golden counts as a hit in `hitRate` and the baseline.
   */
  zeroHitSatisfied: boolean | null;
  /** Constraint violations found in the top 10 (empty means clean). */
  violations: string[];
  /**
   * The `mustNotProductIds` appearances among `violations` (YOY-117 AC-3),
   * listed on their own so the Constructor bar (YOY-118) can report them
   * apart from the hard-constraint violations.
   */
  mustNotViolations: string[];
  costUsd: number;
}

/** Whether a scored golden counts as a hit: a ranked expected product, or a satisfied zero-hit contract. */
export function goldenHit(score: Pick<QueryScore, "firstExpectedRank" | "zeroHitSatisfied">): boolean {
  return score.firstExpectedRank !== null || score.zeroHitSatisfied === true;
}

/** The outcome of one full eval run. */
export interface EvalRunResult {
  catalogSize: number;
  perQuery: QueryScore[];
  /** One row per refinement golden (YOY-42). */
  perRefinement: RefinementScore[];
  /** Constraint-outcome misses across every refinement golden. */
  refinementViolationCount: number;
  /** True when any replayed LLM recording is hand-written, not live. */
  synthesizedRecordings: boolean;
  /** Fraction of goldens with an expected product in the top 10. */
  hitRate: number;
  /** Total constraint violations across every query's top 10. */
  violationCount: number;
  /** One-time indexing cost: enrichment + catalog embedding, USD. */
  oneTimeCostUsd: number;
  /** Blended per-search cost projected per 1,000 searches, USD. */
  perSearchCostPer1000Usd: number;
  /**
   * The blended figure's denominator (YOY-52 AC-2): AI-routed goldens that
   * ran the full per-search path. Refinement goldens run an intent call
   * only, so they are excluded from the blend and reported separately.
   */
  blendedAiSearchCount: number;
  /** Intent-only refinement cost projected per 1,000 follow-ups, USD. */
  refinementCostPer1000Usd: number;
  /**
   * Lite-first routing (YOY-116): the share of AI-routed goldens whose
   * intent came from the accuracy tier (a class match or a low-confidence
   * escalation), and the same for refinement follow-ups.
   */
  escalationRate: number;
  refinementEscalationRate: number;
  /** Intent-operation ledger rows per tier, by the recordings' model ids. */
  intentCalls: { lite: number; accuracy: number };
  /** The threshold the routed blend was scored under. */
  escalationThreshold: number;
  /** Intent prompt size vs the pre-trim baseline (YOY-64 AC-2). */
  intentInputTokens: { before: number; after: number; reduction: number };
  /** One row per Constructor-bar golden (YOY-118), scored like the goldens. */
  perConstructor: QueryScore[];
  /** The Constructor bar block (YOY-118 AC-3). */
  constructorBar: ConstructorBar;
  /** One row per sparse-product golden (YOY-122 AC-2), scored like the goldens. */
  perSparse: QueryScore[];
  /** Fraction of the sparse goldens with an expected product in the top 10 (bar ≥ 0.8). */
  sparseHitRate: number;
  /** Contamination cases scored (YOY-122 AC-1). */
  contaminationCases: number;
  /** Every contamination violation across the cases (bar: none). */
  contaminationViolations: string[];
  /** Products the vision pass analysed from fixture images. */
  visionProducts: number;
  /** The `vision` ledger rows of the run, USD: one-time indexing cost, reported on its own line. */
  visionCostUsd: number;
}

/** Hit rate over a slice of the Constructor set, with its size. */
export interface ConstructorHitRate {
  hits: number;
  total: number;
  /** hits / total; 0 for an empty slice. */
  rate: number;
}

/** The Constructor bar (YOY-118 AC-3): hit rate per group, per language, overall; violations; escalation; cost. */
export interface ConstructorBar {
  overall: ConstructorHitRate;
  byLanguage: Record<"en" | "he", ConstructorHitRate>;
  byGroup: Record<ConstructorGroup, ConstructorHitRate & { byLanguage: Record<"en" | "he", ConstructorHitRate> }>;
  /** `mustNotProductIds` appearances across the set's top 10s. */
  mustNotViolationCount: number;
  /** Goldens whose top 10 carries none of their `mustNotProductIds`. */
  mustNotCleanRate: ConstructorHitRate;
  /** Hard-constraint violations across the set's top 10s (mustNot excluded). */
  hardConstraintViolationCount: number;
  /** Share of the set's AI-routed goldens answered by the accuracy tier. */
  escalationRate: number;
  /** Full-path per-search cost of the set, projected per 1,000 AI searches. */
  costPer1000Usd: number;
  /** The set's full-path AI searches (the cost denominator). */
  aiSearchCount: number;
}

/**
 * The per-golden zero-regression baseline (YOY-116 AC-5): which goldens hit
 * and which refinements were clean before lite-first routing landed.
 */
export interface BaselineHits {
  recordedAt: string;
  goldens: Record<string, boolean>;
  refinements: Record<string, boolean>;
}

export function loadBaselineHits(): BaselineHits {
  return readJson<BaselineHits>("baseline-hits.json");
}

/** The pre-trim intent prompt size (YOY-64 AC-2). */
export interface IntentTokenBaseline {
  recordedAt: string;
  meanInputTokens: number;
  goldens: number;
}

export function loadIntentTokenBaseline(): IntentTokenBaseline {
  return readJson<IntentTokenBaseline>("intent-token-baseline.json");
}

/**
 * Mean accuracy-tier intent input tokens over the goldens' recordings — the
 * prompt-size metric YOY-64 AC-2 trims — and its reduction vs the baseline.
 */
export function intentInputTokenStats(
  recording: LlmRecording,
  goldens: Golden[],
  baseline: IntentTokenBaseline,
): { before: number; after: number; reduction: number } {
  const samples = goldens
    .map((golden) => recording.entries[golden.query]?.inputTokens)
    .filter((tokens): tokens is number => typeof tokens === "number");
  const after =
    samples.length === 0 ? 0 : samples.reduce((sum, tokens) => sum + tokens, 0) / samples.length;
  return {
    before: baseline.meanInputTokens,
    after,
    reduction: baseline.meanInputTokens === 0 ? 0 : 1 - after / baseline.meanInputTokens,
  };
}

export function loadCatalog(): EvalProduct[] {
  return readJson<EvalProduct[]>("catalog.json");
}

export function loadGoldens(): Golden[] {
  return readJson<Golden[]>("goldens.json");
}

export function loadRefinementGoldens(): RefinementGolden[] {
  return readJson<RefinementGolden[]>("refinement-goldens.json");
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

export function loadConstructorFloor(): ConstructorFloor {
  return readJson<ConstructorFloor>("constructor-floor.json");
}

/** The Constructor bar over the scored set (YOY-118 AC-3). */
export function computeConstructorBar(
  scores: QueryScore[],
  costRows: { searchId: string | null; costUsd: number }[],
): ConstructorBar {
  const goldenOf = (score: QueryScore): ConstructorGolden => score.golden as ConstructorGolden;
  const rate = (slice: QueryScore[]): ConstructorHitRate => {
    const hits = slice.filter(goldenHit).length;
    return { hits, total: slice.length, rate: slice.length === 0 ? 0 : hits / slice.length };
  };
  const byLanguage = (slice: QueryScore[]): Record<"en" | "he", ConstructorHitRate> => ({
    en: rate(slice.filter((score) => goldenOf(score).language === "en")),
    he: rate(slice.filter((score) => goldenOf(score).language === "he")),
  });
  const byGroup = Object.fromEntries(
    CONSTRUCTOR_GROUPS.map((group) => {
      const slice = scores.filter((score) => goldenOf(score).group === group);
      return [group, { ...rate(slice), byLanguage: byLanguage(slice) }];
    }),
  ) as ConstructorBar["byGroup"];
  const mustNotViolationCount = scores.reduce(
    (sum, score) => sum + score.mustNotViolations.length,
    0,
  );
  const clean = scores.filter((score) => score.mustNotViolations.length === 0).length;
  const mustNotCleanRate: ConstructorHitRate = {
    hits: clean,
    total: scores.length,
    rate: scores.length === 0 ? 0 : clean / scores.length,
  };
  const hardConstraintViolationCount =
    scores.reduce((sum, score) => sum + score.violations.length, 0) - mustNotViolationCount;
  const aiScores = scores.filter((score) => score.intentTier !== null);
  const escalationRate =
    aiScores.length === 0
      ? 0
      : aiScores.filter((score) => score.intentTier === "accuracy").length / aiScores.length;
  const searchIds = new Set(scores.map((score) => score.golden.id));
  const total = costRows
    .filter((row) => row.searchId !== null && searchIds.has(row.searchId))
    .reduce((sum, row) => sum + row.costUsd, 0);
  const aiSearchCount = scores.filter((score) => score.route === "ai").length;
  return {
    overall: rate(scores),
    byLanguage: byLanguage(scores),
    byGroup,
    mustNotViolationCount,
    mustNotCleanRate,
    hardConstraintViolationCount,
    escalationRate,
    costPer1000Usd: aiSearchCount === 0 ? 0 : (total / aiSearchCount) * 1000,
    aiSearchCount,
  };
}

/**
 * Score one refinement golden: the merged intent's hard constraints — the
 * ones retrieval would filter on — against the outcome the golden documents.
 * Soft attributes are not filters and are asserted by the harness tests, not
 * counted here.
 */
export function refinementViolations(
  golden: RefinementGolden,
  intent: Intent,
): string[] {
  const expected = golden.expectedConstraints;
  const actual = constraintsFromIntent(intent);
  const violations: string[] = [];
  const compare = (field: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got ?? null) !== JSON.stringify(want ?? null)) {
      violations.push(
        `${golden.id}: ${field} ${JSON.stringify(got ?? null)} ≠ expected ${JSON.stringify(want ?? null)}`,
      );
    }
  };
  const bound = (
    field: string,
    got: number | null | undefined,
    check: (value: number) => boolean,
    want: string,
  ): void => {
    if (got === null || got === undefined || !check(got)) {
      violations.push(
        `${golden.id}: ${field} ${JSON.stringify(got ?? null)} ≠ expected ${want}`,
      );
    }
  };
  compare("category", actual.category, expected.category);
  if (golden.expectedPriceMinAbove !== undefined) {
    const above = golden.expectedPriceMinAbove;
    bound("priceMin", actual.priceMin, (value) => value > above, `> ${above}`);
  } else {
    compare("priceMin", actual.priceMin, expected.priceMin);
  }
  if (golden.expectedPriceMaxBelow !== undefined) {
    const below = golden.expectedPriceMaxBelow;
    bound("priceMax", actual.priceMax, (value) => value < below, `< ${below}`);
  } else {
    compare("priceMax", actual.priceMax, expected.priceMax);
  }
  compare("colorsInclude", actual.colorsInclude, expected.colorsInclude);
  compare("colorsExclude", actual.colorsExclude, expected.colorsExclude);
  compare("occasion", actual.occasion, expected.occasion);
  compare("availableOnly", actual.availableOnly, expected.availabilityRequired);
  // Case-insensitive belt-and-braces (YOY-52): parseIntent already
  // canonicalizes size casing, but the golden's own casing must not matter.
  compare(
    "size",
    intent.size?.toUpperCase(),
    golden.expectedSize?.toUpperCase(),
  );
  return violations;
}

/** The enrichment facts the violation scorer reads per product. */
export interface ScoredEnrichment {
  category: string | null;
  colors: string[];
  occasions: string[];
  /** The primary/displayed colour (YOY-110); exclusions are judged on it. */
  primaryColor: string | null;
}

/** Check one returned product against a golden's hard constraints. Exported
 * for the harness's own scoring tests (YOY-29 AC-11). Mirrors the retrieval
 * filter's semantics (YOY-35 AC-2): empty enrichment occasions/colors are
 * unknown, not violations of positive constraints — only stated-and-mismatched
 * values violate — and a category constraint admits its taxonomy group's
 * members (AC-5), the same expansion retrieval filters through. An excluded
 * colour is judged by the primary colour alone (YOY-110 AC-5): a product that
 * also comes in the excluded colour is not a violation, and a null primary
 * colour is unknown. */
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

/** Run the full eval and print the per-query scorecard (AC-6). */
export async function runEval(db: PrismaClient): Promise<EvalRunResult> {
  const shopDomain = "eval-shop.example.com";
  const catalog = loadCatalog();
  const goldens = loadGoldens();
  const refinementGoldens = loadRefinementGoldens();
  const constructorGoldens = loadConstructorGoldens();
  // Refinement extractions are ordinary "intent" port calls, so their
  // recordings merge into the intent recording the replay client looks up.
  // They live in their own file to keep their provenance visible (YOY-42): a
  // key present in both would silently replay the wrong answer, so a
  // collision is an error rather than a precedence rule.
  const intentRecording = readJson<LlmRecording>("recorded", "intent.json");
  const refinementRecording = readJson<LlmRecording>(
    "recorded",
    "intent-refinement.json",
  );
  const collisions = Object.keys(refinementRecording.entries).filter(
    (key) => key in intentRecording.entries,
  );
  if (collisions.length > 0) {
    throw new Error(
      `eval: refinement recordings collide with base intent recordings on ${collisions.join(", ")}`,
    );
  }
  // Synthesized classification completions (YOY-67 AC-2): the non-Latin
  // heuristic guard re-routed the Hebrew short-query goldens to the model,
  // which had never been asked about them, so no live recording exists until
  // the run-8 regeneration. Same separate-file pattern as the refinement
  // intents: own provenance, collision is an error, and the regenerate flow
  // empties this file once the live answers land in classification.json.
  const classificationRecording = readJson<LlmRecording>(
    "recorded",
    "classification.json",
  );
  const classificationSynthesized = readJson<LlmRecording>(
    "recorded",
    "classification-synthesized.json",
  );
  const classificationCollisions = Object.keys(
    classificationSynthesized.entries,
  ).filter((key) => key in classificationRecording.entries);
  if (classificationCollisions.length > 0) {
    throw new Error(
      `eval: synthesized classification recordings collide with live ones on ${classificationCollisions.join(", ")} — empty classification-synthesized.json after regenerating`,
    );
  }
  // Lite-tier recordings (YOY-116): the same query set answered by the lite
  // model, each answer carrying its `confidence`, so the routed blend —
  // lite first, accuracy on a class match or low confidence — replays
  // deterministically. Own files, same collision rule.
  const liteRecording = readJson<LlmRecording>("recorded", "intent-lite.json");
  const liteRefinementRecording = readJson<LlmRecording>(
    "recorded",
    "intent-lite-refinement.json",
  );
  const liteCollisions = Object.keys(liteRefinementRecording.entries).filter(
    (key) => key in liteRecording.entries,
  );
  if (liteCollisions.length > 0) {
    throw new Error(
      `eval: lite refinement recordings collide with base lite recordings on ${liteCollisions.join(", ")}`,
    );
  }
  // Vision recordings (YOY-122): the vision pass's answers per product title,
  // replayed through the same client under operation "vision".
  const visionRecording = readJson<LlmRecording>("recorded", "vision.json");
  const visionGoldens = loadVisionGoldens();
  const contaminationCases = loadContaminationCases();
  const recordings: Record<string, LlmRecording> = {
    enrichment: readJson<LlmRecording>("recorded", "enrichment.json"),
    vision: visionRecording,
    classification: {
      modelId: classificationRecording.modelId,
      entries: {
        ...classificationRecording.entries,
        ...classificationSynthesized.entries,
      },
    },
    intent: {
      modelId: intentRecording.modelId,
      entries: { ...intentRecording.entries, ...refinementRecording.entries },
    },
  };
  const liteRecordings: Record<string, LlmRecording> = {
    intent: {
      modelId: liteRecording.modelId,
      entries: {
        ...liteRecording.entries,
        ...liteRefinementRecording.entries,
      },
    },
  };
  const embeddingRecording = readJson<EmbeddingRecording>(
    "recorded",
    "embeddings.json",
  );

  const costRecorder = createPrismaCostRecorder(db);
  const llm = createReplayLlmClient({ recordings, costRecorder });
  const liteLlm = createReplayLlmClient({ recordings: liteRecordings, costRecorder });
  const embeddings = createReplayEmbeddingClient({
    recording: embeddingRecording,
    costRecorder,
  });

  // Index the sparse catalog exactly the way production does: seed the
  // snapshot, then run the real enrichment and embedding pipelines.
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
      `eval vision pass failed for ${enrichResult.vision?.failed} products — a vision recording is missing or broken; regenerate with REGEN_SCOPE=goldens`,
    );
  }
  await embedCatalog({ db, shopDomain, embeddings });

  const classifier = createQueryClassifier({ llm });
  // The production ladder over the two replay tiers (YOY-116 AC-5): the
  // committed classes and threshold decide which recording answers, exactly
  // as they decide which model is called live.
  const escalationThreshold = DEFAULT_INTENT_ESCALATION_THRESHOLD;
  const extractor = createEscalatingIntentExtractor({
    lite: createIntentExtractor({ llm: liteLlm }),
    accuracy: createIntentExtractor({ llm }),
    threshold: escalationThreshold,
  });
  // Goldens run through the orchestrator end to end (YOY-45 AC-8): the same
  // routing and fallback ladder production takes, over the replay ports.
  const orchestrator = createSearchOrchestrator({
    db,
    classifier,
    extractor,
    retriever: createRetriever({
      embeddings,
      store: createPgVectorRetrievalStore(db),
    }),
    classicStore: createPgTrgmClassicStore(db),
  });

  const products = new Map(catalog.map((product) => [product.productId, product]));
  const enrichmentRows = await db.productEnrichment.findMany({
    where: { shopDomain },
  });
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
    enrichmentRows.map((row) => [
      row.productId,
      visionAttributesFromStored(row.visionAttributes),
    ]),
  );
  const contamination = contaminationCases.flatMap((kase) =>
    contaminationViolations(kase, visionByProduct.get(kase.productId) ?? null),
  );

  const scoreGolden = async (golden: Golden): Promise<QueryScore> => {
    const searchId = golden.id;
    const response = await orchestrator.runSearch({
      query: golden.query,
      shopDomain,
      searchId,
      limit: 10,
    });
    // The eval is offline and deterministic: a degraded response means a
    // replay recording is missing or broken, and the silent fallback would
    // otherwise let classic results masquerade as the AI path's quality.
    if (response.degraded) {
      throw new Error(
        `eval: golden ${golden.id} degraded to classic — a replay recording is missing or failed`,
      );
    }

    const hits = response.hits;
    const rankIndex = hits.findIndex((hit) =>
      golden.expectedProductIds.includes(hit.productId),
    );
    const violations = hits.flatMap((hit) =>
      findViolations(golden, hit.productId, products, enrichments),
    );
    // Family collapse (YOY-117 AC-3) and the Constructor bar (YOY-118): a
    // golden may name products that must never share its top 10 with the
    // expected ones.
    const mustNotViolations = hits
      .filter((hit) => golden.mustNotProductIds?.includes(hit.productId))
      .map((hit) => `${hit.productId}: must not appear (forbidden by the golden)`);
    violations.push(...mustNotViolations);
    // Close matches may relax anything but an explicit exclusion (YOY-111
    // AC-1): a close match carrying an excluded primary colour is a
    // hard-constraint violation like any other.
    const exclusionOnly: Golden = {
      ...golden,
      hardConstraints: {
        category: null,
        priceMin: null,
        priceMax: null,
        colorsInclude: [],
        colorsExclude: golden.hardConstraints.colorsExclude,
        occasion: null,
        availabilityRequired: false,
      },
    };
    violations.push(
      ...response.closeMatches.flatMap((card) =>
        findViolations(exclusionOnly, card.productId, products, enrichments).map(
          (violation) => `close match ${violation}`,
        ),
      ),
    );
    const zeroHitSatisfied =
      golden.zeroHit === undefined
        ? null
        : hits.length === 0 &&
          response.closeMatches.length > 0 &&
          response.closeMatchesRelaxed[0] === golden.zeroHit.relaxedFirst &&
          !violations.some((violation) => violation.startsWith("close match "));
    const ledger = await db.aiCall.findMany({ where: { searchId } });
    return {
      golden,
      route: response.route,
      routeReason: response.routeReason,
      intent: response.intent,
      intentTier: response.intentTier,
      hits,
      closeMatches: response.closeMatches,
      closeMatchesRelaxed: [...response.closeMatchesRelaxed],
      firstExpectedRank: rankIndex === -1 ? null : rankIndex + 1,
      zeroHitSatisfied,
      violations,
      mustNotViolations,
      costUsd: ledger.reduce((sum, row) => sum + row.costUsd, 0),
    };
  };

  const perQuery: QueryScore[] = [];
  for (const golden of goldens) {
    perQuery.push(await scoreGolden(golden));
  }
  // The Constructor bar (YOY-118): the same end-to-end scoring over its own
  // set, kept out of the main bars — its hit rate has its own floor, and its
  // spend is reported on its own line rather than blended.
  const perConstructor: QueryScore[] = [];
  for (const golden of constructorGoldens) {
    perConstructor.push(await scoreGolden(golden));
  }
  // The sparse-product goldens (YOY-122 AC-2): title-only products whose
  // only searchable attributes came from their images, scored end to end
  // like the goldens and kept out of the main bars and the blend.
  const perSparse: QueryScore[] = [];
  for (const golden of visionGoldens) {
    perSparse.push(await scoreGolden(golden));
  }

  // Refinement goldens (YOY-42): one intent call each, with the previous
  // intent supplied by the golden — no classification or retrieval, because a
  // follow-up is scored on the constraints it merges, not on ranking.
  const perRefinement: RefinementScore[] = [];
  for (const golden of refinementGoldens) {
    const { intent, tier, escalation } = await extractor.extractDetailed(golden.query, {
      storeId: shopDomain,
      searchId: golden.id,
      previousIntent: golden.previousIntent,
    });
    const ledger = await db.aiCall.findMany({ where: { searchId: golden.id } });
    perRefinement.push({
      golden,
      intent,
      intentTier: tier,
      escalation,
      violations: refinementViolations(golden, intent),
      costUsd: ledger.reduce((sum, row) => sum + row.costUsd, 0),
    });
  }

  // Cost split (AC-4): rows with a searchId serve one search (classification,
  // intent, query embedding); rows without one are the one-time indexing cost
  // (enrichment, catalog embedding).
  const allRows = await db.aiCall.findMany();
  const oneTimeCostUsd = allRows
    .filter((row) => row.searchId === null)
    .reduce((sum, row) => sum + row.costUsd, 0);
  // Refinement goldens run an intent call only — no classification, no query
  // embedding, no retrieval — so blending them in would understate what a
  // production follow-up search costs (YOY-52 AC-2). The blend covers only
  // the AI-routed goldens that ran the full per-search path; refinement cost
  // is reported as its own line. Classic-routed goldens spend nothing by
  // construction (YOY-41 AC-5), so counting them in the denominator would
  // understate the cost of the searches that do pay.
  const refinementSearchIds = new Set(
    refinementGoldens.map((golden) => golden.id),
  );
  const constructorSearchIds = new Set(
    constructorGoldens.map((golden) => golden.id),
  );
  const sparseSearchIds = new Set(visionGoldens.map((golden) => golden.id));
  const perSearchTotal = allRows
    .filter(
      (row) =>
        row.searchId !== null &&
        !refinementSearchIds.has(row.searchId) &&
        !constructorSearchIds.has(row.searchId) &&
        !sparseSearchIds.has(row.searchId),
    )
    .reduce((sum, row) => sum + row.costUsd, 0);
  const refinementTotal = allRows
    .filter(
      (row) => row.searchId !== null && refinementSearchIds.has(row.searchId),
    )
    .reduce((sum, row) => sum + row.costUsd, 0);
  const blendedAiSearchCount = perQuery.filter(
    (score) => score.route === "ai",
  ).length;
  const perSearchCostPer1000Usd =
    blendedAiSearchCount === 0
      ? 0
      : (perSearchTotal / blendedAiSearchCount) * 1000;
  const refinementCostPer1000Usd =
    refinementGoldens.length === 0
      ? 0
      : (refinementTotal / refinementGoldens.length) * 1000;

  const hitCount = perQuery.filter(goldenHit).length;
  // Escalation metrics (YOY-116): over the goldens that ran an intent call.
  const aiScores = perQuery.filter((score) => score.intentTier !== null);
  const escalationRate =
    aiScores.length === 0
      ? 0
      : aiScores.filter((score) => score.intentTier === "accuracy").length /
        aiScores.length;
  const refinementEscalationRate =
    perRefinement.length === 0
      ? 0
      : perRefinement.filter((score) => score.intentTier === "accuracy").length /
        perRefinement.length;
  const intentRows = allRows.filter((row) => row.operation === "intent");
  const intentCalls = {
    lite: intentRows.filter((row) => row.modelId === liteRecording.modelId).length,
    accuracy: intentRows.filter((row) => row.modelId === intentRecording.modelId)
      .length,
  };
  const result: EvalRunResult = {
    catalogSize: catalog.length,
    perQuery,
    perRefinement,
    refinementViolationCount: perRefinement.reduce(
      (sum, score) => sum + score.violations.length,
      0,
    ),
    synthesizedRecordings:
      intentRecording.provenance === "synthesized" ||
      visionRecording.provenance === "synthesized" ||
      refinementRecording.provenance === "synthesized" ||
      Object.keys(classificationSynthesized.entries).length > 0,
    hitRate: hitCount / goldens.length,
    violationCount: perQuery.reduce((sum, score) => sum + score.violations.length, 0),
    oneTimeCostUsd,
    perSearchCostPer1000Usd,
    blendedAiSearchCount,
    refinementCostPer1000Usd,
    escalationRate,
    refinementEscalationRate,
    intentCalls,
    escalationThreshold,
    intentInputTokens: intentInputTokenStats(
      intentRecording,
      goldens,
      loadIntentTokenBaseline(),
    ),
    perConstructor,
    constructorBar: computeConstructorBar(perConstructor, allRows),
    perSparse,
    sparseHitRate:
      perSparse.length === 0 ? 0 : perSparse.filter(goldenHit).length / perSparse.length,
    contaminationCases: contaminationCases.length,
    contaminationViolations: contamination,
    visionProducts,
    visionCostUsd: allRows
      .filter((row) => row.operation === "vision")
      .reduce((sum, row) => sum + row.costUsd, 0),
  };
  printScorecard(result);
  return result;
}

/** Per-query scorecard (AC-6): rank, violations, and cost per golden. */
function printScorecard(result: EvalRunResult): void {
  const lines = [
    "",
    "eval scorecard — sparse catalog quality harness",
    "query                                     | lang  | route      | tier     | rank | viol | cost USD",
    "------------------------------------------+-------+------------+----------+------+------+---------",
  ];
  for (const score of result.perQuery) {
    const query =
      score.golden.query.length > 40
        ? `${score.golden.query.slice(0, 39)}…`
        : score.golden.query.padEnd(40);
    lines.push(
      [
        query.padEnd(41),
        score.golden.language.padEnd(5),
        `${score.route}/${score.routeReason}`.padEnd(10),
        (score.intentTier ?? "-").padEnd(8),
        String(
          score.zeroHitSatisfied === null
            ? (score.firstExpectedRank ?? "MISS")
            : score.zeroHitSatisfied
              ? "0-ok"
              : "0-XX",
        ).padStart(4),
        String(score.violations.length).padStart(4),
        score.costUsd.toFixed(6),
      ].join(" | "),
    );
    for (const violation of score.violations) {
      lines.push(`  VIOLATION: ${violation}`);
    }
  }
  lines.push(
    "",
    "refinement goldens — follow-up query merged into the previous intent",
    "id  | lang  | outcome    | tier     | viol | cost USD | what it pins",
    "----+-------+------------+----------+------+----------+-------------",
  );
  for (const score of result.perRefinement) {
    lines.push(
      [
        score.golden.id.padEnd(3),
        score.golden.language.padEnd(5),
        score.golden.outcome.padEnd(10),
        (score.intentTier ?? "-").padEnd(8),
        String(score.violations.length).padStart(4),
        score.costUsd.toFixed(6).padStart(8),
        score.golden.note,
      ].join(" | "),
    );
    for (const violation of score.violations) {
      lines.push(`  VIOLATION: ${violation}`);
    }
  }
  lines.push(
    "",
    "Constructor bar — negations, price caps, occasion ≠ category (YOY-118)",
    "id   | group              | lang  | route      | tier     | rank | must | viol | cost USD | query",
    "-----+--------------------+-------+------------+----------+------+------+------+----------+------",
  );
  for (const score of result.perConstructor) {
    const golden = score.golden as ConstructorGolden;
    lines.push(
      [
        golden.id.padEnd(4),
        golden.group.padEnd(18),
        golden.language.padEnd(5),
        `${score.route}/${score.routeReason}`.padEnd(10),
        (score.intentTier ?? "-").padEnd(8),
        String(score.firstExpectedRank ?? "MISS").padStart(4),
        String(score.mustNotViolations.length).padStart(4),
        String(score.violations.length - score.mustNotViolations.length).padStart(4),
        score.costUsd.toFixed(6).padStart(8),
        golden.query,
      ].join(" | "),
    );
    for (const violation of score.violations) {
      lines.push(`  VIOLATION: ${violation}`);
    }
  }
  const bar = result.constructorBar;
  const percent = (rate: ConstructorHitRate): string =>
    `${(rate.rate * 100).toFixed(0)} % (${rate.hits}/${rate.total})`;
  const groupLine = (group: ConstructorGroup): string => {
    const slice = bar.byGroup[group];
    return `${group} ${percent(slice)}; EN ${percent(slice.byLanguage.en)}, HE ${percent(slice.byLanguage.he)}`;
  };
  lines.push(
    `Constructor bar: overall ${percent(bar.overall)} (${CONSTRUCTOR_GROUPS.map((group) => `${group} ${(bar.byGroup[group].rate * 100).toFixed(0)} %`).join(", ")}), mustNot violations ${bar.mustNotViolationCount}`,
    `  EN ${percent(bar.byLanguage.en)}, HE ${percent(bar.byLanguage.he)}`,
    ...CONSTRUCTOR_GROUPS.map((group) => `  ${groupLine(group)}`),
    `  hard-constraint violations: ${bar.hardConstraintViolationCount} (bar: 0); mustNot violations: ${bar.mustNotViolationCount} (target 0; floor: no regression), mustNot-clean goldens ${percent(bar.mustNotCleanRate)}`,
    `  intent escalation rate: ${(bar.escalationRate * 100).toFixed(0)} % of the set's AI searches`,
    `  per-search cost per 1,000 AI searches (${bar.aiSearchCount} full-path searches): $${bar.costPer1000Usd.toFixed(2)}`,
  );
  lines.push(
    "",
    "sparse-product goldens — title-only products, attributes from their images (YOY-122)",
    "id   | lang  | route      | tier     | rank | viol | cost USD | query",
    "-----+-------+------------+----------+------+------+----------+------",
  );
  for (const score of result.perSparse) {
    lines.push(
      [
        score.golden.id.padEnd(4),
        score.golden.language.padEnd(5),
        `${score.route}/${score.routeReason}`.padEnd(10),
        (score.intentTier ?? "-").padEnd(8),
        String(score.firstExpectedRank ?? "MISS").padStart(4),
        String(score.violations.length).padStart(4),
        score.costUsd.toFixed(6).padStart(8),
        score.golden.query,
      ].join(" | "),
    );
    for (const violation of score.violations) {
      lines.push(`  VIOLATION: ${violation}`);
    }
  }
  const sparseHits = result.perSparse.filter(goldenHit).length;
  lines.push(
    `sparse goldens: ${sparseHits}/${result.perSparse.length} (${(result.sparseHitRate * 100).toFixed(0)} %; bar: ≥ 80 %)`,
    `contamination violations: ${result.contaminationViolations.length} over ${result.contaminationCases} cases (bar: 0)`,
    ...result.contaminationViolations.map((violation) => `  VIOLATION: ${violation}`),
    `one-time vision cost (${result.visionProducts} products with images, reported separately): $${result.visionCostUsd.toFixed(4)}`,
  );
  if (result.synthesizedRecordings) {
    lines.push(
      "",
      "NOTE: some replayed LLM recordings are synthesized, not live model",
      "output — regenerate them (LIVE_LLM_TESTS=1) before trusting these rows",
      "as evidence of model behavior.",
    );
  }
  lines.push(
    "",
    `hit rate (expected product in top 10): ${(result.hitRate * 100).toFixed(0)}% (bar: ≥80%)`,
    `refinement constraint misses: ${result.refinementViolationCount} (bar: 0)`,
    `hard-constraint violations in any top 10: ${result.violationCount} (bar: 0)`,
    `one-time indexing cost (enrichment + embedding, ${result.catalogSize} products): $${result.oneTimeCostUsd.toFixed(4)}`,
    `blended per-search cost per 1,000 AI searches (${result.blendedAiSearchCount} full-path searches): $${result.perSearchCostPer1000Usd.toFixed(2)} (bar: ≤ $0.60)`,
    `refinement-only intent cost per 1,000 follow-ups (reported separately, not blended): $${result.refinementCostPer1000Usd.toFixed(2)}`,
    `intent escalation rate (lite → accuracy, threshold ${result.escalationThreshold}): ${(result.escalationRate * 100).toFixed(0)}% of AI searches, ${(result.refinementEscalationRate * 100).toFixed(0)}% of follow-ups`,
    `intent calls per tier: lite ${result.intentCalls.lite}, accuracy ${result.intentCalls.accuracy}`,
    `intent input tokens: before ${result.intentInputTokens.before.toFixed(0)} / after ${result.intentInputTokens.after.toFixed(0)} (−${(result.intentInputTokens.reduction * 100).toFixed(0)} %; bar: −≥30 %)`,
    "",
  );
  console.log(lines.join("\n"));
}
