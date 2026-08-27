import { createHash } from "node:crypto";

import { isColorwayWord } from "@unfiltered/engine";

/**
 * Shape of one product node as returned by the Admin GraphQL products query
 * in ingest.server.ts. Only the fields the snapshot consumes.
 */
export interface ShopifyProductNode {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  tags: string[];
  vendor: string | null;
  productType: string | null;
  /**
   * Shopify product status ("ACTIVE" | "ARCHIVED" | "DRAFT"). Consumed by the
   * ingest filter (YOY-61 AC-2) before mapping; absent in older fixtures and
   * treated as ACTIVE there. Deliberately not part of the snapshot row or the
   * content hash — only ACTIVE products are ever mapped.
   */
  status?: string;
  /**
   * When the product was published to the Online Store sales channel; null
   * means never published (YOY-67 AC-4) — its storefront page 404s even
   * while ACTIVE, so the ingest filter drops it before mapping. Absent in
   * older fixtures and treated as published as of `updatedAt` there, the
   * same compatibility rule `status` follows.
   */
  publishedAt?: string | null;
  updatedAt: string;
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
  variants: { nodes: Array<{ availableForSale: boolean }> };
  images: { nodes: Array<{ altText: string | null }> };
  featuredImage: { url: string } | null;
  /**
   * The product's Online Store URL as the Admin API resolves it (YOY-87);
   * null when the product has no storefront page. Absent in older fixtures
   * and in webhook-derived nodes, where the storefront form is composed
   * from the shop domain and handle instead.
   */
  onlineStoreUrl?: string | null;
}

/** One snapshot row, before persistence (no DB identity, no shop). */
export interface SnapshotProduct {
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
  /** Storefront handle for result-card links (display-only, YOY-44). */
  handle: string;
  /** Featured-image URL for result cards (display-only, YOY-44). */
  featuredImageUrl: string | null;
  /**
   * Product-family key (YOY-117 AC-1): colourways of one product share it
   * (see `computeFamilyKey`). Display-only like `handle` — outside
   * contentHash, refreshed on every sync.
   */
  familyKey: string;
  /**
   * Server-resolved product link for result cards (YOY-87, LEAK-2):
   * `onlineStoreUrl` when the source carries one, else the storefront form
   * `https://<shopDomain>/products/<handle>` when a shop domain is known,
   * else null. Display-only, outside contentHash like the fields above; a
   * renderer never composes a URL from it.
   */
  url: string | null;
  /**
   * Online Store publication timestamp (YOY-67 AC-4); null means never
   * published. Outside contentHash like the display fields: a re-publish
   * must not dirty the searchable content, and unpublishing removes the row
   * entirely rather than updating it.
   */
  publishedAt: Date | null;
  sourceUpdatedAt: Date;
  contentHash: string;
}

/**
 * Content hash over exactly the searchable fields, in fixed order, so an
 * unchanged product maps to an unchanged hash regardless of field ordering
 * in the API response. sourceUpdatedAt is deliberately excluded: a touched
 * timestamp with identical content must not dirty the row. The display-only
 * fields (handle, featuredImageUrl, url) are excluded too (YOY-44 AC-4,
 * YOY-87 AC-1): a display change alone must not dirty the searchable content
 * and must not trigger re-enrichment or re-embedding.
 */
export function computeContentHash(
  product: Omit<
    SnapshotProduct,
    | "contentHash"
    | "sourceUpdatedAt"
    | "handle"
    | "featuredImageUrl"
    | "familyKey"
    | "url"
    | "publishedAt"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        product.productId,
        product.title,
        product.description,
        [...product.tags].sort(),
        product.vendor,
        product.productType,
        product.priceMin,
        product.priceMax,
        product.currencyCode,
        product.available,
        product.imageAltTexts,
      ]),
    )
    .digest("hex");
}

/**
 * A trailing colourway designator (YOY-117 AC-1): `in <Colour>`,
 * `- <Colour>` (any dash), `/ <Colour>`, or `(<Colour>)` at the end of a
 * title, where `<Colour>` is one or two words whose LAST word is in the
 * committed colourway list ("Pink", "Meteorite Black", "dusty rose"). The
 * marker-less form ("Black Evening Gown") is deliberately not a designator:
 * the colour is part of the name, not a variant of it.
 */
const DESIGNATOR_PATTERNS: RegExp[] = [
  /\s+in\s+([^\s\-–—/()]+(?:\s+[^\s\-–—/()]+)?)\s*$/iu,
  /\s*[-–—]\s*([^\s\-–—/()]+(?:\s+[^\s\-–—/()]+)?)\s*$/u,
  /\s*\/\s*([^\s\-–—/()]+(?:\s+[^\s\-–—/()]+)?)\s*$/u,
  /\s*\(([^()]+)\)\s*$/u,
];

/**
 * The title with ONE trailing colourway designator stripped, whitespace
 * collapsed, lowercased (YOY-117 AC-1). A designator whose last word is not
 * a colourway word ("Shirt Dress in Linen", "Jacket (Limited Edition)") is
 * kept: it names the product, not its colour.
 */
export function normalizeFamilyTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, " ").trim();
  for (const pattern of DESIGNATOR_PATTERNS) {
    const match = pattern.exec(collapsed);
    if (match === null) {
      continue;
    }
    const words = match[1]!.trim().split(/\s+/);
    const last = words[words.length - 1]!.replace(/[.,!?'"]+$/u, "");
    if (words.length <= 2 && isColorwayWord(last)) {
      const stripped = collapsed.slice(0, match.index).trim();
      if (stripped !== "") {
        return stripped.toLowerCase();
      }
    }
  }
  return collapsed.toLowerCase();
}

/**
 * Product-family key (YOY-117 AC-1): `lower(vendor) + "|" + normalizedTitle`,
 * plus `"|" + lower(productType)` when the product carries a type — two
 * products sharing vendor and title but not type are different products,
 * never colourways of one (co-manager parity note). Computed identically on
 * every ingestion path; rows from before the column carry "" and never
 * collapse.
 */
export function computeFamilyKey(product: {
  vendor: string;
  title: string;
  productType: string;
}): string {
  const vendor = product.vendor.trim().toLowerCase();
  const productType = product.productType.trim().toLowerCase();
  const key = `${vendor}|${normalizeFamilyTitle(product.title)}`;
  return productType === "" ? key : `${key}|${productType}`;
}

/**
 * Storefront product URL for a Shopify product (YOY-87 AC-2): the Admin
 * API's `onlineStoreUrl` when present, else the composed
 * `https://<shopDomain>/products/<handle>` form when both parts are known,
 * else null. This is the ONLY place a Shopify product URL is composed — the
 * adapter resolves it once, and every renderer downstream uses it verbatim.
 */
export function resolveProductUrl(
  node: Pick<ShopifyProductNode, "handle" | "onlineStoreUrl">,
  shopDomain: string | undefined,
): string | null {
  if (typeof node.onlineStoreUrl === "string" && node.onlineStoreUrl !== "") {
    return node.onlineStoreUrl;
  }
  if (shopDomain !== undefined && shopDomain !== "" && node.handle !== "") {
    return `https://${shopDomain}/products/${node.handle}`;
  }
  return null;
}

/**
 * Pure Shopify→snapshot mapping for one product node. Empty/missing text
 * fields normalize to "" so the hash and the row are deterministic. The
 * optional `shopDomain` lets the mapping compose the storefront `url` when
 * the node carries no `onlineStoreUrl` (YOY-87 AC-2).
 */
export function mapProductNode(
  node: ShopifyProductNode,
  options: { shopDomain?: string } = {},
): SnapshotProduct {
  const withoutHash = {
    productId: node.id,
    title: node.title,
    description: node.description ?? "",
    tags: node.tags,
    vendor: node.vendor ?? "",
    productType: node.productType ?? "",
    priceMin: Number(node.priceRangeV2.minVariantPrice.amount),
    priceMax: Number(node.priceRangeV2.maxVariantPrice.amount),
    currencyCode: node.priceRangeV2.minVariantPrice.currencyCode,
    available: node.variants.nodes.some((variant) => variant.availableForSale),
    imageAltTexts: node.images.nodes
      .map((image) => image.altText ?? "")
      .filter((altText) => altText !== ""),
  };
  return {
    ...withoutHash,
    handle: node.handle,
    featuredImageUrl: node.featuredImage?.url ?? null,
    familyKey: computeFamilyKey(withoutHash),
    url: resolveProductUrl(node, options.shopDomain),
    // Absent (legacy fixture) means published, as of the node's own
    // timestamp; explicit null means never published (YOY-67 AC-4) — the
    // ingest and webhook paths drop those before mapping, so a null here is
    // belt-and-braces for any other caller.
    publishedAt:
      node.publishedAt === undefined
        ? new Date(node.updatedAt)
        : node.publishedAt === null
          ? null
          : new Date(node.publishedAt),
    sourceUpdatedAt: new Date(node.updatedAt),
    contentHash: computeContentHash(withoutHash),
  };
}
