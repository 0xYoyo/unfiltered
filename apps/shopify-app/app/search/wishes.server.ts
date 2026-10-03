import type { PrismaClient } from "@prisma/client";
import type { ExtractedWishes } from "@unfiltered/engine";

import currencyRates from "../../../../config/currency-rates.json";

/**
 * Engine v2's stated wishes (YOY-149): what the extraction kept, applied by
 * the three-kinds rule — a firm fact is a wall (it removes products), a soft
 * number orders (the tiers), and a miss the code can compute carries a label
 * the code writes. Everything here is pure arithmetic over the catalog rows:
 * no model call, so it holds after a judge timeout, error or cap (AC-13).
 */

/** Env var naming how long the page waits for a late extraction (AC-3). */
export const EXTRACTION_GRACE_MS_ENV = "EXTRACTION_GRACE_MS";
/** How long the page waits for the extraction after find finished (AC-3). */
export const DEFAULT_EXTRACTION_GRACE_MS = 300;
/** Env var naming how far over the cap a price is still "near" (AC-5, AC-12). */
export const PRICE_NEAR_PERCENT_ENV = "PRICE_NEAR_PERCENT";
/** A price within this percentage over the cap is near; beyond it is far. */
export const DEFAULT_PRICE_NEAR_PERCENT = 10;

function nonNegativeIntFromEnv(
  env: Record<string, string | undefined>,
  variable: string,
  fallback: number,
): number {
  const raw = env[variable];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${variable} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The grace from `EXTRACTION_GRACE_MS`; unset means 300. A malformed value fails at construction. */
export function extractionGraceMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return nonNegativeIntFromEnv(env, EXTRACTION_GRACE_MS_ENV, DEFAULT_EXTRACTION_GRACE_MS);
}

/** The near band from `PRICE_NEAR_PERCENT`; unset means 10. A malformed value fails at construction. */
export function priceNearPercentFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return nonNegativeIntFromEnv(env, PRICE_NEAR_PERCENT_ENV, DEFAULT_PRICE_NEAR_PERCENT);
}

/** The chip fields Engine v2 answers with (AC-14). */
export type WishChipField = "priceMax" | "priceMin" | "size" | "availability" | "exclude";

/**
 * One chip per kept fact (AC-14). A price chip's value is the shopper's own
 * number and `currency` the currency they stated (absent when they named
 * none); an exclude chip's value is the term as typed.
 */
export interface WishChip {
  field: WishChipField;
  value: string;
  currency?: string;
}

/** A chip the shopper removed (AC-15): matched by field and value. */
export interface RemovedChip {
  field: string;
  value: string;
}

/** The code-computed labels (AC-12). */
export type CodeLabelTemplate = "price-near" | "price-far" | "size-missing";

export interface CodeLabel {
  template: CodeLabelTemplate;
  values: string[];
}

/**
 * The wishes minus the facts the shopper removed (AC-15): a removed fact is
 * not applied and its chip is absent.
 */
export function keepUnremoved(
  wishes: ExtractedWishes,
  removed: readonly RemovedChip[],
): ExtractedWishes {
  const gone = (field: WishChipField, value: string) =>
    removed.some(
      (chip) => chip.field === field && chip.value.trim().toLowerCase() === value.trim().toLowerCase(),
    );
  const priceMax = wishes.priceMax !== null && !gone("priceMax", wishes.priceMax.raw) ? wishes.priceMax : null;
  const priceMin = wishes.priceMin !== null && !gone("priceMin", wishes.priceMin.raw) ? wishes.priceMin : null;
  const size = wishes.size !== null && !gone("size", wishes.size) ? wishes.size : null;
  return {
    priceMax,
    priceMin,
    currency: priceMax !== null || priceMin !== null ? wishes.currency : null,
    size,
    inStock: wishes.inStock && !gone("availability", AVAILABILITY_CHIP_VALUE),
    excluded: wishes.excluded.filter((term) => !gone("exclude", term.typed)),
    priceFirm: wishes.priceFirm && (priceMax !== null || priceMin !== null),
    sizeFirm: wishes.sizeFirm && size !== null,
  };
}

const AVAILABILITY_CHIP_VALUE = "in stock";

/** The chips of the kept facts, in a fixed order (AC-14). */
export function wishChips(wishes: ExtractedWishes): WishChip[] {
  const chips: WishChip[] = [];
  const currency = wishes.currency !== null ? { currency: wishes.currency } : {};
  if (wishes.priceMax !== null) {
    chips.push({ field: "priceMax", value: wishes.priceMax.raw, ...currency });
  }
  if (wishes.priceMin !== null) {
    chips.push({ field: "priceMin", value: wishes.priceMin.raw, ...currency });
  }
  if (wishes.size !== null) {
    chips.push({ field: "size", value: wishes.size });
  }
  if (wishes.inStock) {
    chips.push({ field: "availability", value: AVAILABILITY_CHIP_VALUE });
  }
  for (const term of wishes.excluded) {
    chips.push({ field: "exclude", value: term.typed });
  }
  return chips;
}

/** True when any kept fact changes which products are served or how. */
export function hasAppliedWishes(wishes: ExtractedWishes): boolean {
  return (
    wishes.priceMax !== null ||
    wishes.priceMin !== null ||
    wishes.size !== null ||
    wishes.inStock ||
    wishes.excluded.length > 0
  );
}

/** Units of each listed currency per US dollar (AC-7, `config/currency-rates.json`). */
export interface CurrencyRates {
  asOf: string;
  perUsd: Record<string, number>;
}

export const CURRENCY_RATES: CurrencyRates = {
  asOf: currencyRates.asOf,
  perUsd: currencyRates.perUsd,
};

/**
 * Convert an amount between two currencies through USD (AC-7). Null when
 * either side is not listed: the number then stays unapplied.
 */
export function convertAmount(
  amount: number,
  from: string,
  to: string,
  rates: CurrencyRates = CURRENCY_RATES,
): number | null {
  if (from === to) {
    return amount;
  }
  const fromRate = rates.perUsd[from];
  const toRate = rates.perUsd[to];
  if (fromRate === undefined || toRate === undefined || fromRate <= 0) {
    return null;
  }
  return (amount / fromRate) * toRate;
}

/** One variant as the wishes read it. */
export interface WishVariant {
  options: Array<{ name: string; value: string }>;
  available: boolean;
}

/** One product as the wishes read it. */
export interface WishProduct {
  productId: string;
  /** The cheapest variant's price, in `currencyCode`. */
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  /** Variants in merchant (position) order. */
  variants: WishVariant[];
  /** The written card's facts; "" with no card. */
  facts: string;
}

/** Read the rows the wishes need for these products (any order). */
export async function loadWishProducts(
  db: PrismaClient,
  shopDomain: string,
  productIds: readonly string[],
): Promise<Map<string, WishProduct>> {
  if (productIds.length === 0) {
    return new Map();
  }
  const ids = [...productIds];
  const [products, variants, cards] = await Promise.all([
    db.catalogProduct.findMany({
      where: { shopDomain, productId: { in: ids } },
      select: { productId: true, priceMin: true, priceMax: true, currencyCode: true, available: true },
    }),
    db.productVariant.findMany({
      where: { shopDomain, productId: { in: ids } },
      select: { productId: true, options: true, available: true },
      orderBy: [{ productId: "asc" }, { position: "asc" }],
    }),
    db.productCard.findMany({
      where: { shopDomain, productId: { in: ids }, status: "written" },
      select: { productId: true, facts: true },
    }),
  ]);
  const variantsOf = new Map<string, WishVariant[]>();
  for (const variant of variants) {
    const list = variantsOf.get(variant.productId) ?? [];
    variantsOf.set(variant.productId, list);
    const options = Array.isArray(variant.options)
      ? variant.options.flatMap((raw) => {
          const { name, value } = (raw ?? {}) as { name?: unknown; value?: unknown };
          return typeof name === "string" && typeof value === "string" ? [{ name, value }] : [];
        })
      : [];
    list.push({ options, available: variant.available });
  }
  const factsOf = new Map(cards.map((card) => [card.productId, card.facts]));
  return new Map(
    products.map((product) => [
      product.productId,
      {
        ...product,
        variants: variantsOf.get(product.productId) ?? [],
        facts: factsOf.get(product.productId) ?? "",
      },
    ]),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` holds `term` as a whole word, ignoring case, in any script (AC-10). */
export function holdsWholeWord(text: string, term: string): boolean {
  const needle = term.trim();
  if (needle === "") {
    return false;
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * Whether the shopper excluded this product (AC-10): every one of its
 * variants carries the term as an option value, or its card facts state
 * it — the typed or the English form, as a whole word.
 */
export function isExcluded(product: WishProduct, wishes: ExtractedWishes): boolean {
  return wishes.excluded.some((term) => {
    const forms = [term.typed, term.english];
    const inFacts = forms.some((form) => holdsWholeWord(product.facts, form));
    const inEveryVariant =
      product.variants.length > 0 &&
      product.variants.every((variant) =>
        variant.options.some((option) => forms.some((form) => holdsWholeWord(option.value, form))),
      );
    return inFacts || inEveryVariant;
  });
}

/** How a product stands against a stated size (AC-8). */
interface SizeStanding {
  /** Some variant carries the size as an option value. */
  offered: boolean;
  /** Some available variant carries it. */
  inStock: boolean;
}

function sizeStanding(product: WishProduct, size: string): SizeStanding {
  const wanted = size.trim().toLowerCase();
  const carries = (variant: WishVariant) =>
    variant.options.some((option) => option.value.trim().toLowerCase() === wanted);
  return {
    offered: product.variants.some(carries),
    inStock: product.variants.some((variant) => variant.available && carries(variant)),
  };
}

/**
 * Up to two in-stock values nearest the asked size in the merchant's own
 * order (AC-12): the values of the option that carries the size, in variant
 * order, ranked by distance from the asked value.
 */
function nearestInStockSizes(product: WishProduct, size: string): string[] {
  const wanted = size.trim().toLowerCase();
  const optionName = product.variants
    .flatMap((variant) => variant.options)
    .find((option) => option.value.trim().toLowerCase() === wanted)?.name;
  if (optionName === undefined) {
    return [];
  }
  const values: string[] = [];
  const inStock = new Set<string>();
  for (const variant of product.variants) {
    const option = variant.options.find((entry) => entry.name === optionName);
    if (option === undefined) {
      continue;
    }
    if (!values.includes(option.value)) {
      values.push(option.value);
    }
    if (variant.available) {
      inStock.add(option.value);
    }
  }
  const at = values.findIndex((value) => value.trim().toLowerCase() === wanted);
  return values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.index !== at && inStock.has(entry.value))
    .sort((a, b) => Math.abs(a.index - at) - Math.abs(b.index - at) || a.index - b.index)
    .slice(0, 2)
    .map((entry) => entry.value);
}

/** The price wishes in one product's currency; null where the pair is unlisted (AC-7). */
function capsFor(
  product: WishProduct,
  wishes: ExtractedWishes,
  rates: CurrencyRates,
): { max: number | null; min: number | null } {
  const from = wishes.currency ?? product.currencyCode;
  const convert = (amount: number | undefined) =>
    amount === undefined ? null : convertAmount(amount, from, product.currencyCode, rates);
  return { max: convert(wishes.priceMax?.amount), min: convert(wishes.priceMin?.amount) };
}

export interface ComposeOptions {
  nearPercent?: number;
  rates?: CurrencyRates;
}

/** Where a product stands against the kept wishes. */
interface Standing {
  /** A firm fact, "in stock" or an exclusion removes it (AC-6, AC-9, AC-10). */
  removed: boolean;
  /** 0: every number wish met; 1: only the price, within the near band over the cap; 2: other misses (AC-5). */
  tier: 0 | 1 | 2;
  label: CodeLabel | null;
}

function formatAmount(amount: number, currency: string): string {
  return `${String(Math.round(amount * 100) / 100)} ${currency}`;
}

function standingOf(
  product: WishProduct,
  wishes: ExtractedWishes,
  options: Required<ComposeOptions>,
): Standing {
  const caps = capsFor(product, wishes, options.rates);
  const nearFactor = 1 + options.nearPercent / 100;
  let removed = false;
  if (wishes.inStock && !product.available) {
    removed = true;
  }
  if (wishes.priceFirm && caps.max !== null && product.priceMin > caps.max) {
    removed = true;
  }
  const size = wishes.size === null ? null : sizeStanding(product, wishes.size);
  if (wishes.sizeFirm && size !== null && !size.inStock) {
    removed = true;
  }
  if (isExcluded(product, wishes)) {
    removed = true;
  }

  const overCap = caps.max !== null && product.priceMin > caps.max;
  const nearCap = overCap && product.priceMin <= caps.max! * nearFactor;
  const underMin = caps.min !== null && product.priceMax < caps.min;
  const sizeMissed = size !== null && size.offered && !size.inStock;
  const tier: Standing["tier"] =
    !overCap && !underMin && !sizeMissed ? 0 : nearCap && !underMin && !sizeMissed ? 1 : 2;

  let label: CodeLabel | null = null;
  if (overCap && wishes.priceMax !== null) {
    const stated = formatAmount(wishes.priceMax.amount, wishes.currency ?? product.currencyCode);
    label = {
      template: nearCap ? "price-near" : "price-far",
      values: [formatAmount(product.priceMin, product.currencyCode), stated],
    };
  } else if (sizeMissed && wishes.size !== null) {
    label = { template: "size-missing", values: [wishes.size, ...nearestInStockSizes(product, wishes.size)] };
  }
  return { removed, tier, label };
}

export interface ComposedResults {
  /** The served order: walls applied, the find set sorted into tiers, the keyword tail after it. */
  productIds: string[];
  /** How many of `productIds`, from the front, are the find set. */
  findSetCount: number;
  /** The code label of each served product that carries one (AC-12). */
  labels: Map<string, CodeLabel>;
}

/**
 * Apply the kept wishes to the find step's merged order (AC-5 – AC-10,
 * AC-12): walls remove products from the results and the count; the find
 * set is sorted into number tiers before pages are cut, each tier in find
 * order; the keyword tail keeps its order after it. A product with no
 * catalog row is kept where it stands, unlabelled.
 */
export function composeWishes(
  productIds: readonly string[],
  findSetCount: number,
  products: ReadonlyMap<string, WishProduct>,
  wishes: ExtractedWishes,
  options: ComposeOptions = {},
): ComposedResults {
  const resolved: Required<ComposeOptions> = {
    nearPercent: options.nearPercent ?? DEFAULT_PRICE_NEAR_PERCENT,
    rates: options.rates ?? CURRENCY_RATES,
  };
  const labels = new Map<string, CodeLabel>();
  const rank = (ids: readonly string[]) =>
    ids.flatMap((productId, index) => {
      const product = products.get(productId);
      if (product === undefined) {
        return [{ productId, tier: 0, index }];
      }
      const standing = standingOf(product, wishes, resolved);
      if (standing.removed) {
        return [];
      }
      if (standing.label !== null) {
        labels.set(productId, standing.label);
      }
      return [{ productId, tier: standing.tier, index }];
    });
  const findSet = rank(productIds.slice(0, findSetCount)).sort(
    (a, b) => a.tier - b.tier || a.index - b.index,
  );
  const tail = rank(productIds.slice(findSetCount));
  return {
    productIds: [...findSet, ...tail].map((entry) => entry.productId),
    findSetCount: findSet.length,
    labels,
  };
}
