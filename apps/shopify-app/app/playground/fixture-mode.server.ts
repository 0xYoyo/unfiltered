/**
 * Fixture mode for the playground UI lane (YOY-92 AC-8).
 *
 * With `PLAYGROUND_FIXTURES=1` the playground API answers from committed
 * JSON instead of the orchestrator, so the Playwright lane needs no
 * database, no Gemini key, and no network. The fixture is chosen by the
 * query text, which keeps every UI state one `page.goto` away and keeps the
 * selection visible in the test rather than hidden in a harness.
 *
 * The flag is read per request rather than at module load: a route module
 * evaluated once at boot would otherwise freeze the mode for the process,
 * and the tests that assert the guard is off would need a separate server.
 */

import aiChipRemovedFixture from "./fixtures/ai-chip-removed.json";
import aiNegationChipRemovedFixture from "./fixtures/ai-negation-chip-removed.json";
import aiNegationFixture from "./fixtures/ai-negation.json";
import aiReuseFixture from "./fixtures/ai-reuse.json";
import aiZeroHitFixture from "./fixtures/ai-zero-hit.json";
import aiFixture from "./fixtures/ai.json";
import colorUnknownFixture from "./fixtures/color-unknown.json";
import degradedFixture from "./fixtures/degraded.json";
import emptyFixture from "./fixtures/empty.json";
import labelOverflowFixture from "./fixtures/label-overflow.json";
import labelTooLongFixture from "./fixtures/label-too-long.json";
import labelsPendingFixture from "./fixtures/labels-pending.json";
import labelsFixture from "./fixtures/labels.json";
import previewFixture from "./fixtures/preview.json";
import resultsFixture from "./fixtures/results.json";
import v2BudgetFixture from "./fixtures/v2-budget.json";
import v2RefineFixture from "./fixtures/v2-refine.json";
import v2TwoMeaningsFixture from "./fixtures/v2-two-meanings.json";

import type { ProxyLabel } from "../search/proxy.server";
import type { PlaygroundSearchResponse } from "./api.server";

export const PLAYGROUND_FIXTURES_ENV = "PLAYGROUND_FIXTURES";

/** Named fixture behaviours, selected by a token in the query text. */
export type PlaygroundFixtureName =
  | "results"
  | "empty"
  | "error"
  | "timeout"
  | "delayed"
  | "preview"
  // YOY-93: the AI states.
  | "ai"
  | "ai-chip-removed"
  // YOY-133: a negated attribute as a chip, and its removal echo.
  | "ai-negation"
  | "ai-negation-chip-removed"
  | "ai-zero-hit"
  | "ai-delayed"
  | "ai-reuse"
  | "degraded"
  | "color-unknown"
  // YOY-146: a 30-product order served one page at a time, and the same
  // order whose page 2 fails.
  | "paged"
  | "paged-fail"
  | "paged-slow"
  // YOY-149: an engine v2 response — `intent: null`, chips of the v2
  // fields (a price cap with its currency, size, availability, exclude).
  | "v2-budget"
  // YOY-150: an engine v2 response that carries `carry` (a refinement
  // chain), and one that also carries a second reading.
  | "v2-refine"
  | "v2-two-meanings"
  // YOY-151: one card per label template, a label over its maximum, a
  // label wider than its card, and a page whose labels arrive late.
  | "labels"
  | "label-too-long"
  | "label-overflow"
  | "labels-pending"
  // YOY-166: a judged order whose pages each hold matches and close
  // products, the close ones under the page's "Close matches" divider.
  | "v2-close";

/** How long the `delayed` fixture waits — long enough to observe loading. */
export const FIXTURE_DELAY_MS = 700;

/**
 * Long enough that any client timeout fires first, short enough that a hung
 * request cannot outlive the test run.
 */
export const FIXTURE_TIMEOUT_MS = 30_000;

export function playgroundFixturesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PLAYGROUND_FIXTURES_ENV] === "1";
}

/**
 * Query text → fixture. A submitted search naming no fixture gets
 * `results`; a preview gets the shorter `preview` set, because a preview
 * that returned the submitted set would hide exactly the difference the
 * lane exists to prove.
 */
export function selectFixture(
  query: string,
  preview: boolean,
): PlaygroundFixtureName {
  // Whole words, not substrings: "ai" appears inside "rail", "plain", and
  // "available", so a substring match routed the `empty rail` query to the
  // AI fixture. Selection has to be predictable from reading the query.
  const words = new Set(query.toLowerCase().split(/[^a-z]+/i));
  const has = (word: string): boolean => words.has(word);

  // A preview is classic-only by contract, so it can never select an AI
  // fixture however it is worded (AC-1: chips never render on a preview).
  if (!preview) {
    if (has("zero")) {
      return "ai-zero-hit";
    }
    if (has("reuse")) {
      // Exact-query intent reuse (YOY-64 AC-4): the AI answer served from a
      // stored intent — reason "intent-reuse", no classify/intent stages.
      return "ai-reuse";
    }
    if (has("degraded")) {
      return "degraded";
    }
    if (has("color")) {
      return "color-unknown";
    }
    if (has("wool")) {
      // A negated attribute (YOY-133 AC-5): "ai winter coat not wool".
      return "ai-negation";
    }
    if (has("refine")) {
      // A refinement chain (YOY-150): "refine black dress", then "refine cheaper".
      return "v2-refine";
    }
    if (has("meanings")) {
      // The second reading (YOY-150): "two meanings wedding dress".
      return "v2-two-meanings";
    }
    if (has("labels") || has("label")) {
      // The label line (YOY-151): "labels", "label too long", "label
      // overflow", "labels pending".
      return has("pending")
        ? "labels-pending"
        : has("long")
          ? "label-too-long"
          : has("overflow")
            ? "label-overflow"
            : "labels";
    }
    if (has("divider")) {
      // Close products under the divider (YOY-166): "divider red gown".
      return "v2-close";
    }
    if (has("budget")) {
      // Engine v2 chips (YOY-149): "budget dress under 400".
      return "v2-budget";
    }
    if (has("ai")) {
      return has("delayed") ? "ai-delayed" : "ai";
    }
  }

  if (has("paged")) {
    return has("fail") ? "paged-fail" : has("slow") ? "paged-slow" : "paged";
  }

  for (const name of ["empty", "error", "timeout", "delayed"] as const) {
    if (has(name)) {
      return name;
    }
  }
  return preview ? "preview" : "results";
}

export interface FixtureOutcome {
  /** Milliseconds to wait before answering. */
  delayMs: number;
  status: number;
  body: PlaygroundSearchResponse | null;
}

/** Products in the `paged` fixture's whole order (YOY-146). */
export const PAGED_FIXTURE_SIZE = 30;

/**
 * The `paged` fixture's whole order: the results fixture's first card
 * repeated with distinguishable ids and titles, so a test can name the card
 * at any position.
 */
function pagedOrder(): PlaygroundSearchResponse {
  const base = asResponse(resultsFixture);
  const template = base.results[0]!;
  return {
    ...base,
    searchId: "fixture-paged",
    results: Array.from({ length: PAGED_FIXTURE_SIZE }, (_, index) => ({
      ...template,
      productId: `paged-${index}`,
      title: `Paged dress ${String(index).padStart(2, "0")}`,
    })),
  };
}

/** Products in the `v2-close` fixture's whole order, and its page size (YOY-166). */
export const CLOSE_DIVIDER_FIXTURE_SIZE = 30;
const CLOSE_DIVIDER_PAGE_SIZE = 24;
/** How many of each `v2-close` page's products are close: the page's last ones. */
const CLOSE_DIVIDER_CLOSE_PER_PAGE: Record<number, number> = { 1: 4, 2: 2 };

/**
 * One page of the `v2-close` fixture (YOY-166 AC-1, AC-3), as a judged
 * Engine v2 page with matches answers: its matched products in `results`,
 * its close ones — each labelled "close match" — in `closeMatches` with
 * `closeMatchesRelaxed: []`, `totalCount` counting both.
 */
function closeDividerPage(page: number): PlaygroundSearchResponse {
  const base = asResponse(labelsFixture);
  const template = { ...base.results[0]!, label: null };
  const start = (page - 1) * CLOSE_DIVIDER_PAGE_SIZE;
  const products = Array.from(
    { length: Math.max(0, Math.min(CLOSE_DIVIDER_PAGE_SIZE, CLOSE_DIVIDER_FIXTURE_SIZE - start)) },
    (_, index) => start + index,
  );
  const closeCount = CLOSE_DIVIDER_CLOSE_PER_PAGE[page] ?? 0;
  const matched = products.slice(0, products.length - closeCount);
  const close = products.slice(products.length - closeCount);
  const card = (index: number, isClose: boolean) => ({
    ...template,
    productId: `divider-${index}`,
    title: isClose
      ? `Close dress ${String(index).padStart(2, "0")}`
      : `Red gown ${String(index).padStart(2, "0")}`,
    // A matched card keeps its label (the page's first carries one); a close
    // card's `close-match` label is dropped under the heading (YOY-168 AC-3).
    label: isClose
      ? { template: "close-match" as const, values: [] }
      : index === start
        ? { template: "price-near" as const, values: ["420 ILS", "400 ILS"] }
        : null,
  });
  return {
    ...base,
    searchId: "fixture-v2-close",
    route: "ai",
    intent: null,
    chips: [],
    results: matched.map((index) => card(index, false)),
    ...(close.length === 0
      ? {}
      : { closeMatches: close.map((index) => card(index, true)), closeMatchesRelaxed: [] }),
    page,
    totalCount: CLOSE_DIVIDER_FIXTURE_SIZE,
  };
}

/**
 * One page of a fixture's answer, as the endpoint serves it (YOY-145
 * AC-4): with page parameters the response holds that page plus `page` and
 * `totalCount`; without them it is unchanged.
 */
export function pageOfFixture(
  outcome: FixtureOutcome,
  paging: { page: number; pageSize: number } | undefined,
): FixtureOutcome {
  // A fixture that pages itself (`v2-close`) is already one page.
  if (paging === undefined || outcome.body === null || outcome.body.page !== undefined) {
    return outcome;
  }
  const start = (paging.page - 1) * paging.pageSize;
  return {
    ...outcome,
    body: {
      ...outcome.body,
      results: outcome.body.results.slice(start, start + paging.pageSize),
      page: paging.page,
      totalCount: outcome.body.results.length,
    },
  };
}

export function fixtureOutcome(
  name: PlaygroundFixtureName,
  paging?: { page: number },
): FixtureOutcome {
  switch (name) {
    case "paged":
      return { delayMs: 0, status: 200, body: pagedOrder() };
    case "paged-slow":
      // Later pages answer slowly, so the quiet loading line is observable.
      return {
        delayMs: (paging?.page ?? 1) > 1 ? FIXTURE_DELAY_MS : 0,
        status: 200,
        body: pagedOrder(),
      };
    case "paged-fail":
      // Page 1 answers; every later page fails (YOY-146 AC-9).
      return (paging?.page ?? 1) > 1
        ? { delayMs: 0, status: 500, body: null }
        : { delayMs: 0, status: 200, body: pagedOrder() };
    case "empty":
      return { delayMs: 0, status: 200, body: asResponse(emptyFixture) };
    case "error":
      return { delayMs: 0, status: 500, body: null };
    case "timeout":
      return { delayMs: FIXTURE_TIMEOUT_MS, status: 200, body: null };
    case "delayed":
      return {
        delayMs: FIXTURE_DELAY_MS,
        status: 200,
        body: asResponse(resultsFixture),
      };
    case "preview":
      return { delayMs: 0, status: 200, body: asResponse(previewFixture) };
    case "results":
      return { delayMs: 0, status: 200, body: asResponse(resultsFixture) };
    case "ai":
      return { delayMs: 0, status: 200, body: asResponse(aiFixture) };
    case "ai-chip-removed":
      return {
        delayMs: 0,
        status: 200,
        body: asResponse(aiChipRemovedFixture),
      };
    case "ai-negation":
      return { delayMs: 0, status: 200, body: asResponse(aiNegationFixture) };
    case "ai-negation-chip-removed":
      return {
        delayMs: 0,
        status: 200,
        body: asResponse(aiNegationChipRemovedFixture),
      };
    case "ai-reuse":
      return { delayMs: 0, status: 200, body: asResponse(aiReuseFixture) };
    case "ai-zero-hit":
      return { delayMs: 0, status: 200, body: asResponse(aiZeroHitFixture) };
    case "ai-delayed":
      return {
        delayMs: FIXTURE_DELAY_MS,
        status: 200,
        body: asResponse(aiFixture),
      };
    case "degraded":
      return { delayMs: 0, status: 200, body: asResponse(degradedFixture) };
    case "v2-budget":
      return { delayMs: 0, status: 200, body: asResponse(v2BudgetFixture) };
    case "v2-refine":
      return { delayMs: 0, status: 200, body: asResponse(v2RefineFixture) };
    case "v2-two-meanings":
      return { delayMs: 0, status: 200, body: asResponse(v2TwoMeaningsFixture) };
    case "labels":
      return { delayMs: 0, status: 200, body: asResponse(labelsFixture) };
    case "label-too-long":
      return { delayMs: 0, status: 200, body: asResponse(labelTooLongFixture) };
    case "label-overflow":
      return { delayMs: 0, status: 200, body: asResponse(labelOverflowFixture) };
    case "labels-pending":
      return { delayMs: 0, status: 200, body: asResponse(labelsPendingFixture) };
    case "v2-close":
      return { delayMs: 0, status: 200, body: closeDividerPage(paging?.page ?? 1) };
    case "color-unknown":
      return {
        delayMs: 0,
        status: 200,
        body: asResponse(colorUnknownFixture),
      };
  }
}

function asResponse(fixture: unknown): PlaygroundSearchResponse {
  return fixture as PlaygroundSearchResponse;
}

/**
 * Chip removal answers a contract-correct echo (AC-7): the same search with
 * the dismissed constraint gone from BOTH the chip row and the intent, and
 * the products it had excluded back in the set. Serving the unchanged AI
 * fixture would let a broken remove-and-re-render pass its test.
 *
 * Only the `colorsExclude` chip and the `attributesExclude` chip (YOY-133)
 * have recorded echoes, because those are the ones the specs remove; any
 * other chip falls through to the plain AI fixture rather than pretending
 * to a change the fixture cannot represent.
 */
export function selectFixtureForRemoval(
  removeChip: { field: string; value: string } | null,
): PlaygroundFixtureName {
  if (removeChip === null) {
    return "ai";
  }
  switch (removeChip.field) {
    case "colorsExclude":
      return "ai-chip-removed";
    case "attributesExclude":
      return "ai-negation-chip-removed";
    default:
      return "ai";
  }
}

/** A removed engine v2 chip as `removedChips` carries it (YOY-149). */
export interface FixtureRemovedChip {
  field: string;
  value: string;
}

/**
 * The `removedChips` query parameter, read the way the endpoint's parse
 * layer reads it: a JSON array of `{field, value}`. Anything else is
 * treated as absent — fixture mode answers, it does not validate.
 */
export function parseFixtureRemovedChips(
  raw: string | null,
): FixtureRemovedChip[] | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter(
      (chip): chip is FixtureRemovedChip =>
        typeof chip === "object" &&
        chip !== null &&
        typeof (chip as FixtureRemovedChip).field === "string" &&
        typeof (chip as FixtureRemovedChip).value === "string",
    );
  } catch {
    return null;
  }
}

/** The product the `v2-budget` cap keeps out until its chip is removed. */
const OVER_BUDGET_CARD = {
  productId: "p-v2-over",
  title: "Silk Evening Dress",
  url: "https://example.test/products/p-v2-over",
  imageUrl:
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 4'><rect width='4' height='4' fill='%23bdb6ab'/></svg>",
  priceMin: 640,
  priceMax: 640,
  currencyCode: "ILS",
  available: true,
  colorUnknown: false,
};

/**
 * An engine v2 removal (YOY-149 AC-15) answers a contract-correct echo: the
 * same response with every chip in `removedChips` gone — the server
 * re-runs the same query without those constraints — and, once the price
 * cap is among them, the product the cap kept out back in the set. A
 * fixture with no v2 chips answers unchanged.
 */
export function withoutRemovedChips(
  outcome: FixtureOutcome,
  removed: readonly FixtureRemovedChip[],
): FixtureOutcome {
  if (outcome.body === null || outcome.body.intent !== null) {
    return outcome;
  }
  const gone = (chip: { field: string; value: string }): boolean =>
    removed.some(
      (entry) => entry.field === chip.field && entry.value === chip.value,
    );
  const capRemoved = outcome.body.chips.some(
    (chip) => chip.field === "priceMax" && gone(chip),
  );
  const results = capRemoved
    ? [...outcome.body.results, OVER_BUDGET_CARD]
    : outcome.body.results;
  return {
    ...outcome,
    body: {
      ...outcome.body,
      searchId: `${outcome.body.searchId}-removed-${removed.length}`,
      chips: outcome.body.chips.filter((chip) => !gone(chip)),
      results,
      ...(outcome.body.totalCount === undefined
        ? {}
        : { totalCount: results.length }),
    },
  };
}

/**
 * The `carry` a fixture answers (YOY-150 AC-3), as the server would build it
 * for a refinement: the request's `previousQuery` and the query, one per
 * line — or the query alone with no previous chain. Only a fixture that
 * already carries a `carry` gets one; the rest answer unchanged.
 */
export function withFixtureCarry(
  outcome: FixtureOutcome,
  query: string,
  previousQuery: string | undefined,
): FixtureOutcome {
  if (outcome.body === null || outcome.body.carry === undefined) {
    return outcome;
  }
  const sentence = query.trim();
  return {
    ...outcome,
    body: {
      ...outcome.body,
      carry: previousQuery === undefined ? sentence : `${previousQuery}\n${sentence}`,
    },
  };
}

/**
 * The labels endpoint in fixture mode (YOY-151 AC-8): the `labels-pending`
 * search's late labels — the `labels` fixture's, by product id — after a
 * delay long enough to observe the reserved lines first; every other
 * searchId answers an empty set, as the real endpoint does for a search
 * it holds nothing for.
 */
export function fixtureLabels(searchId: string): {
  delayMs: number;
  labels: Record<string, ProxyLabel | null>;
} {
  if (searchId !== asResponse(labelsPendingFixture).searchId) {
    return { delayMs: 0, labels: {} };
  }
  return {
    delayMs: FIXTURE_DELAY_MS,
    labels: Object.fromEntries(
      asResponse(labelsFixture).results.map((card) => [
        card.productId,
        card.label ?? null,
      ]),
    ),
  };
}

export function sleep(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The catalog registry the UI lane sees (YOY-94 AC-4). Fixture mode answers
 * from this map instead of `PlaygroundCatalog`, so the store-preload page
 * and its unknown-slug path are both reachable without a database. Exactly
 * one slug is known; everything else is unknown, which is what makes the
 * 404 page testable.
 */
export const FIXTURE_CATALOGS: Record<
  string,
  { name: string; productCount: number; storeKey: string }
> = {
  "demo-store": {
    name: "Demo Store",
    productCount: 120,
    storeKey: "playground:demo-store",
  },
};

export function fixtureCatalog(
  slug: string,
): { name: string; productCount: number; storeKey: string } | null {
  return FIXTURE_CATALOGS[slug] ?? null;
}
