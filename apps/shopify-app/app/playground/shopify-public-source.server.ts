import type {
  CatalogSource,
  SourceProduct,
} from "./catalog-source.server";
import { usableImageUrls } from "../catalog/mapping.server";
import type { VariantRecord } from "../catalog/variants.server";
import { htmlToPlainText } from "./catalog-source.server";
import type { PoliteFetch } from "./polite-fetch.server";

/**
 * Shopify public storefront source (YOY-88 AC-4): reads a store's public
 * `/products.json` feed — no app install, no Admin API, no token — and maps
 * it onto the platform-free `SourceProduct` shape. This file is the adapter:
 * every Shopify-specific field name, URL scheme, and endpoint lives here and
 * nowhere else in the playground ingestion path.
 */

export const SHOPIFY_PUBLIC_SOURCE_KIND = "shopify-public";
export const PRODUCTS_JSON_PAGE_SIZE = 250;

/** The `products.json` product shape, only the fields the mapping consumes. */
export interface ShopifyPublicProduct {
  id: number | string;
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  tags: string[] | string | null;
  updated_at?: string | null;
  /** Identity and option fields (YOY-142 AC-4) are absent in older fixtures. */
  variants: Array<{
    id?: number | string;
    position?: number | null;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
    updated_at?: string | null;
    price: string | number | null;
    available?: boolean;
  }>;
  /** The product's option names; a variant's option1–3 are their values, in this order. */
  options?: Array<{ name: string; position?: number | null }>;
  images: Array<{ src: string; alt: string | null }>;
}

/** Storefront-level facts the feed does not carry per product. */
export interface ShopifyPublicStoreMeta {
  name: string | null;
  currency: string;
}

/**
 * Whether the URL is a Shopify storefront readable through the public feed
 * (AC-6 detection): `/products.json?limit=1` answers JSON with a `products`
 * array. Anything else — HTML, a 404, JSON of another shape — is not.
 */
/**
 * The base every feed and product URL is read under (YOY-117 AC-4): the
 * origin, plus `--path-prefix` when a localised storefront was asked for
 * (`https://store.example/uk`).
 */
function baseOf(storeUrl: string, pathPrefix: string | null | undefined): string {
  return `${originOf(storeUrl)}${pathPrefix ?? ""}`;
}

export async function detectShopifyPublicStore(
  storeUrl: string,
  fetch: PoliteFetch,
  options: { pathPrefix?: string | null } = {},
): Promise<boolean> {
  const base = baseOf(storeUrl, options.pathPrefix);
  const response = await fetch.fetch(`${base}/products.json?limit=1`);
  if (!response.ok) {
    return false;
  }
  try {
    const body = (await response.json()) as { products?: unknown };
    return Array.isArray(body?.products);
  } catch {
    return false;
  }
}

/**
 * Store name and currency: `/meta.json` (`name`, `currency`) first, `/cart.js`
 * (`currency`) as the currency fallback. Fails loudly when neither answers a
 * currency — every price row needs one and guessing would corrupt every
 * price filter downstream.
 */
export async function fetchShopifyPublicStoreMeta(
  storeUrl: string,
  fetch: PoliteFetch,
): Promise<ShopifyPublicStoreMeta> {
  const origin = originOf(storeUrl);
  let name: string | null = null;
  let currency: string | null = null;
  const meta = await readJson<{ name?: unknown; currency?: unknown }>(
    fetch,
    `${origin}/meta.json`,
  );
  if (meta !== null) {
    name = typeof meta.name === "string" && meta.name !== "" ? meta.name : null;
    currency =
      typeof meta.currency === "string" && meta.currency !== ""
        ? meta.currency
        : null;
  }
  if (currency === null) {
    const cart = await readJson<{ currency?: unknown }>(fetch, `${origin}/cart.js`);
    if (cart !== null && typeof cart.currency === "string" && cart.currency !== "") {
      currency = cart.currency;
    }
  }
  if (currency === null) {
    throw new Error(
      `Shopify public source: no currency from ${origin}/meta.json or ${origin}/cart.js`,
    );
  }
  return { name, currency };
}

/**
 * The variants of one feed product (YOY-142 AC-4): each variant's
 * `option1`/`option2`/`option3` paired, in order, with the product's option
 * names — verbatim (AC-6) — its price and `available`, `quantity` null (the
 * public feed exposes no stock). A variant without an id or a readable
 * price is skipped.
 */
export function mapShopifyPublicVariants(product: ShopifyPublicProduct): VariantRecord[] {
  const names = [...(product.options ?? [])]
    .map((option, index) => ({ name: option.name, position: option.position ?? index + 1 }))
    .sort((a, b) => a.position - b.position)
    .map((option) => option.name);
  const productUpdatedAt =
    typeof product.updated_at === "string" && product.updated_at !== ""
      ? new Date(product.updated_at)
      : null;
  const variants: VariantRecord[] = [];
  product.variants.forEach((variant, index) => {
    const price = Number(variant.price);
    if (variant.id === undefined || variant.id === null || variant.price === null || !Number.isFinite(price)) {
      return;
    }
    const options = [variant.option1, variant.option2, variant.option3].flatMap(
      (value, optionIndex) => {
        const name = names[optionIndex];
        return typeof value === "string" && name !== undefined ? [{ name, value }] : [];
      },
    );
    variants.push({
      variantId: String(variant.id),
      position: variant.position ?? index + 1,
      options,
      price,
      available: variant.available === true,
      quantity: null,
      sourceUpdatedAt:
        typeof variant.updated_at === "string" && variant.updated_at !== ""
          ? new Date(variant.updated_at)
          : productUpdatedAt,
    });
  });
  return variants;
}

/**
 * Map one feed product to the port shape. Prices are the min/max over the
 * variants' `price` (strings in the feed); availability is any variant
 * `available`; the first image is the card image; alt texts are every
 * non-empty image alt. Tags arrive as an array or a comma-separated string
 * depending on the storefront's feed version.
 */
export function mapShopifyPublicProduct(
  product: ShopifyPublicProduct,
  { origin, currency }: { origin: string; currency: string },
): SourceProduct {
  const prices = product.variants
    .map((variant) => Number(variant.price))
    .filter((price) => Number.isFinite(price));
  const tags = Array.isArray(product.tags)
    ? product.tags
    : typeof product.tags === "string"
      ? product.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag !== "")
      : [];
  return {
    sourceId: String(product.id),
    title: product.title ?? "",
    description: htmlToPlainText(product.body_html),
    tags,
    vendor: product.vendor ?? "",
    productType: product.product_type ?? "",
    priceMin: prices.length > 0 ? Math.min(...prices) : Number.NaN,
    priceMax: prices.length > 0 ? Math.max(...prices) : Number.NaN,
    currencyCode: currency,
    available: product.variants.some((variant) => variant.available === true),
    imageAltTexts: product.images
      .map((image) => image.alt ?? "")
      .filter((alt) => alt !== ""),
    imageUrl: product.images[0]?.src ?? null,
    imageUrls: usableImageUrls(product.images.map((image) => image.src)),
    variants: mapShopifyPublicVariants(product),
    url:
      product.handle !== undefined && product.handle !== ""
        ? `${origin}/products/${product.handle}`
        : null,
    sourceUpdatedAt:
      typeof product.updated_at === "string" && product.updated_at !== ""
        ? new Date(product.updated_at)
        : null,
  };
}

/**
 * The source: pages `/products.json?limit=250&page=N` until an empty page
 * (or until `maxProducts` are in hand — the pipeline enforces the bound),
 * with the store meta fetched once up front.
 */
export function createShopifyPublicSource({
  storeUrl,
  fetch,
  meta,
  pathPrefix = null,
}: {
  storeUrl: string;
  fetch: PoliteFetch;
  /** Pre-fetched meta (the CLI reads it for the store name); fetched when absent. */
  meta?: ShopifyPublicStoreMeta;
  /**
   * Localised storefront path (YOY-117 AC-4): the feed is read from
   * `<origin><prefix>/products.json` and product URLs are composed as
   * `<origin><prefix>/products/<handle>`. Store meta stays at the origin.
   */
  pathPrefix?: string | null;
}): CatalogSource {
  // `origin` here is the base every feed and product URL hangs off — the
  // origin plus the locale prefix when one was given.
  const origin = baseOf(storeUrl, pathPrefix);
  return {
    kind: SHOPIFY_PUBLIC_SOURCE_KIND,
    async fetchProducts({ maxProducts, onProgress }) {
      const { currency } =
        meta ?? (await fetchShopifyPublicStoreMeta(storeUrl, fetch));
      const products: SourceProduct[] = [];
      for (let page = 1; ; page += 1) {
        const url = `${origin}/products.json?limit=${PRODUCTS_JSON_PAGE_SIZE}&page=${page}`;
        const response = await fetch.fetch(url);
        if (!response.ok) {
          throw new Error(
            `Shopify public source: ${url} answered HTTP ${response.status}`,
          );
        }
        const body = (await response.json()) as { products?: unknown };
        if (!Array.isArray(body?.products)) {
          throw new Error(
            `Shopify public source: ${url} did not answer a products array`,
          );
        }
        const pageProducts = body.products as ShopifyPublicProduct[];
        if (pageProducts.length === 0) {
          return products;
        }
        for (const product of pageProducts) {
          products.push(mapShopifyPublicProduct(product, { origin, currency }));
        }
        onProgress?.({ fetched: products.length, stage: `page ${page}` });
        if (products.length >= maxProducts) {
          // Enough in hand: the pipeline drops the overflow and reports it;
          // pages beyond this one are never requested.
          return products;
        }
      }
    },
  };
}

function originOf(storeUrl: string): string {
  const url = new URL(storeUrl.includes("://") ? storeUrl : `https://${storeUrl}`);
  return url.origin;
}

async function readJson<T>(fetch: PoliteFetch, url: string): Promise<T | null> {
  try {
    const response = await fetch.fetch(url);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    // A disallowed or unreachable meta endpoint is not fatal on its own —
    // the caller decides whether the missing fact is.
    return null;
  }
}
