import { createHash } from "node:crypto";

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
