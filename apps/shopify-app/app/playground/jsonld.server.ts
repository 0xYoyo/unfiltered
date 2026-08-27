import type { SourceProduct } from "./catalog-source.server";
import { capImageUrls } from "../catalog/mapping.server";
import { htmlToPlainText } from "./catalog-source.server";

/**
 * schema.org Product extraction from a fetched HTML page (YOY-89 AC-3/AC-4):
 * every `<script type="application/ld+json">` is parsed (top-level arrays
 * and `@graph` included), `Product` nodes become `SourceProduct`s, and a
 * `ProductGroup` (or a Product carrying `hasVariant`) collapses to one
 * product spanning its variants' prices and availability. Nothing here is
 * platform-specific — WooCommerce, Magento, and hand-rolled stores all emit
 * this vocabulary. No JavaScript rendering, no microdata/RDFa fallback
 * (YOY-89 NG-1/NG-2).
 */

type JsonNode = Record<string, unknown>;

/** Every JSON-LD block on the page, parsed; unparseable blocks are skipped. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(match[1])) {
      continue;
    }
    const body = match[2].trim();
    if (body === "") {
      continue;
    }
    try {
      blocks.push(JSON.parse(body));
    } catch {
      // Malformed JSON-LD: the page's problem, not a crawl failure.
    }
  }
  return blocks;
}

/** The page's `<link rel="canonical">` href, absolute, or null. */
export function extractCanonicalUrl(html: string, pageUrl: string): string | null {
  const linkPattern = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?canonical["']?/i.test(tag)) {
      continue;
    }
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (href === null) {
      continue;
    }
    try {
      return new URL(href[1], pageUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

const typesOf = (node: JsonNode): string[] => {
  const type = node["@type"];
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
};

const hasType = (node: JsonNode, wanted: string): boolean =>
  typesOf(node).some((type) => type.toLowerCase() === wanted.toLowerCase());

/** Flatten blocks into candidate nodes: arrays, `@graph`, plain objects. */
function candidateNodes(blocks: unknown[]): JsonNode[] {
  const nodes: JsonNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const node = value as JsonNode;
    if (Array.isArray(node["@graph"])) {
      (node["@graph"] as unknown[]).forEach(visit);
    }
    nodes.push(node);
  };
  blocks.forEach(visit);
  return nodes;
}

const asString = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

/** Resolve `value` against `base`; null when the pair is not a valid URL. */
const resolveUrl = (value: string, base: string): string | null => {
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Every image URL an `image` value names, in order (YOY-120 AC-1): a URL
 * string, an ImageObject (`url` / `contentUrl`), or an array of either.
 */
const allImages = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : [value];
  const urls: string[] = [];
  for (const item of items) {
    if (typeof item === "string" && item !== "") {
      urls.push(item);
    } else if (item !== null && typeof item === "object") {
      const url = asString((item as JsonNode)["url"]) ?? asString((item as JsonNode)["contentUrl"]);
      if (url !== null) {
        urls.push(url);
      }
    }
  }
  return urls;
};

/** `image` may be a URL string, an ImageObject, or an array of either. */
const firstImage = (value: unknown): string | null => {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (typeof item === "string" && item !== "") {
      return item;
    }
    if (item !== null && typeof item === "object") {
      const url = asString((item as JsonNode)["url"]) ?? asString((item as JsonNode)["contentUrl"]);
      if (url !== null) {
        return url;
      }
    }
  }
  return null;
};

/** `brand` may be a string or a Brand/Organization node. */
const brandName = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object") {
    return asString((value as JsonNode)["name"]) ?? "";
  }
  return "";
};

/** `category` may be a string, a Thing, or an array; the first readable wins. */
const categoryName = (value: unknown): string => {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (typeof item === "string" && item !== "") {
      return item;
    }
    if (item !== null && typeof item === "object") {
      const name = asString((item as JsonNode)["name"]);
      if (name !== null) {
        return name;
      }
    }
  }
  return "";
};

/** Price facts read from one product's offers (any Offer/AggregateOffer). */
interface OfferFacts {
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  available: boolean;
}

const availableFrom = (value: unknown): boolean => {
  const items = Array.isArray(value) ? value : [value];
  return items.some(
    (item) => typeof item === "string" && /(InStock|PreOrder|OnlineOnly|InStoreOnly|LimitedAvailability)$/i.test(item),
  );
};

/** Read Offer / AggregateOffer nodes (single or array) into price facts. */
export function readOffers(offers: unknown): OfferFacts {
  const facts: OfferFacts = { priceMin: null, priceMax: null, currency: null, available: false };
  const items = Array.isArray(offers) ? offers : [offers];
  const prices: number[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const offer = item as JsonNode;
    // Nested `offers` inside an AggregateOffer are read too.
    if (offer["offers"] !== undefined) {
      const nested = readOffers(offer["offers"]);
      if (nested.priceMin !== null) prices.push(nested.priceMin);
      if (nested.priceMax !== null) prices.push(nested.priceMax);
      facts.currency ??= nested.currency;
      facts.available ||= nested.available;
    }
    for (const key of ["price", "lowPrice", "highPrice"]) {
      const price = asNumber(offer[key]);
      if (price !== null) {
        prices.push(price);
      }
    }
    // Google's PriceSpecification form.
    const spec = offer["priceSpecification"];
    if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
      const price = asNumber((spec as JsonNode)["price"]);
      if (price !== null) prices.push(price);
      facts.currency ??= asString((spec as JsonNode)["priceCurrency"]);
    }
    facts.currency ??= asString(offer["priceCurrency"]);
    facts.available ||= availableFrom(offer["availability"]);
  }
  if (prices.length > 0) {
    facts.priceMin = Math.min(...prices);
    facts.priceMax = Math.max(...prices);
  }
  return facts;
}

/** Product nodes on the page: `Product` (any subtype) or `ProductGroup`. */
export function findProductNodes(blocks: unknown[]): JsonNode[] {
  const nodes = candidateNodes(blocks);
  const groups = nodes.filter((node) => hasType(node, "ProductGroup"));
  // Variants listed under a group are the group's, not separate products.
  const variantNodes = new Set<JsonNode>();
  for (const group of groups) {
    for (const variant of Array.isArray(group["hasVariant"]) ? (group["hasVariant"] as unknown[]) : []) {
      if (variant !== null && typeof variant === "object") {
        variantNodes.add(variant as JsonNode);
      }
    }
  }
  return nodes.filter(
    (node) =>
      (hasType(node, "ProductGroup") ||
        typesOf(node).some((type) => /product$/i.test(type) && !/ProductGroup$/i.test(type))) &&
      !variantNodes.has(node),
  );
}

export interface PageExtraction {
  products: SourceProduct[];
  /** Product nodes skipped for a missing price or currency (AC-4). */
  skippedNoPrice: number;
}

/**
 * Map one Product / ProductGroup node to a `SourceProduct`. A group (or a
 * product with `hasVariant`) collapses to one record: min/max price and
 * any-in-stock across the variants' offers, the group's own offers
 * included. Returns null when no price or currency can be read (AC-4).
 */
export function mapProductNode(
  node: JsonNode,
  { pageUrl, canonicalUrl }: { pageUrl: string; canonicalUrl: string | null },
): SourceProduct | null {
  const variants = Array.isArray(node["hasVariant"])
    ? (node["hasVariant"] as unknown[]).filter(
        (variant): variant is JsonNode => variant !== null && typeof variant === "object",
      )
    : [];
  const offerSets = [node["offers"], ...variants.map((variant) => variant["offers"])].filter(
    (offers) => offers !== undefined && offers !== null,
  );
  const facts: OfferFacts = { priceMin: null, priceMax: null, currency: null, available: false };
  for (const offers of offerSets) {
    const read = readOffers(offers);
    if (read.priceMin !== null) {
      facts.priceMin = facts.priceMin === null ? read.priceMin : Math.min(facts.priceMin, read.priceMin);
    }
    if (read.priceMax !== null) {
      facts.priceMax = facts.priceMax === null ? read.priceMax : Math.max(facts.priceMax, read.priceMax);
    }
    facts.currency ??= read.currency;
    facts.available ||= read.available;
  }
  if (facts.priceMin === null || facts.priceMax === null || facts.currency === null) {
    return null;
  }

  const title = asString(node["name"]) ?? "";
  // An unparseable JSON-LD `url` falls back to the page's canonical/fetched
  // URL instead of throwing out of the whole crawl (YOY-96 AC-7).
  const jsonLdUrl = asString(node["url"]);
  const url = (jsonLdUrl !== null ? resolveUrl(jsonLdUrl, pageUrl) : null) ?? canonicalUrl ?? pageUrl;
  // Deterministic per page: the product's own identifier when it has one,
  // else the page (canonical) URL — the same page always maps to the same id.
  const sourceId =
    asString(node["sku"]) ??
    asString(node["productID"]) ??
    asString(node["productId"]) ??
    asString(node["@id"]) ??
    (canonicalUrl ?? pageUrl);
  const image = firstImage(node["image"]) ?? variants.map((v) => firstImage(v["image"])).find((v) => v !== null) ?? null;
  // Up to four `image` entries (YOY-120 AC-1): the product's own first,
  // then the variants' — resolved like `imageUrl`, an unparseable one
  // dropped rather than failing the page.
  const imageUrls = capImageUrls(
    [...allImages(node["image"]), ...variants.flatMap((v) => allImages(v["image"]))].map(
      (candidate) => resolveUrl(candidate, pageUrl),
    ),
  );
  const description = htmlToPlainText(asString(node["description"]) ?? "");
  const keywords = node["keywords"];
  const tags = Array.isArray(keywords)
    ? keywords.filter((tag): tag is string => typeof tag === "string")
    : typeof keywords === "string"
      ? keywords.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "")
      : [];
  return {
    sourceId,
    title,
    description,
    tags,
    vendor: brandName(node["brand"]) || variants.map((v) => brandName(v["brand"])).find((v) => v !== "") || "",
    productType: categoryName(node["category"]),
    priceMin: facts.priceMin,
    priceMax: facts.priceMax,
    currencyCode: facts.currency,
    available: facts.available,
    imageAltTexts: [],
    // Likewise an unparseable image URL yields no image, not a failed page.
    imageUrl: image !== null ? resolveUrl(image, pageUrl) : null,
    imageUrls,
    url,
    sourceUpdatedAt: null,
  };
}

/**
 * Everything one fetched page contributes: its Product/ProductGroup nodes as
 * `SourceProduct`s (deduplicated by `sourceId` within the page — a page
 * yielding two Products with the same id counts once, AC-4) plus the count
 * of nodes skipped for a missing price/currency. A page without a Product
 * node contributes nothing.
 */
export function extractProductsFromPage(html: string, pageUrl: string): PageExtraction {
  const blocks = extractJsonLdBlocks(html);
  const canonicalUrl = extractCanonicalUrl(html, pageUrl);
  const products: SourceProduct[] = [];
  const seen = new Set<string>();
  let skippedNoPrice = 0;
  for (const node of findProductNodes(blocks)) {
    const product = mapProductNode(node, { pageUrl, canonicalUrl });
    if (product === null) {
      skippedNoPrice += 1;
      continue;
    }
    if (seen.has(product.sourceId)) {
      continue;
    }
    seen.add(product.sourceId);
    products.push(product);
  }
  return { products, skippedNoPrice };
}
