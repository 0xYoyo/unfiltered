import { createHash } from "node:crypto";

/**
 * Shape of one product node as returned by the Admin GraphQL products query
 * in ingest.server.ts. Only the fields the snapshot consumes.
 */
export interface ShopifyProductNode {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  vendor: string | null;
  productType: string | null;
  updatedAt: string;
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
  variants: { nodes: Array<{ availableForSale: boolean }> };
  images: { nodes: Array<{ altText: string | null }> };
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
  sourceUpdatedAt: Date;
  contentHash: string;
}

/**
 * Content hash over exactly the searchable fields, in fixed order, so an
 * unchanged product maps to an unchanged hash regardless of field ordering
 * in the API response. sourceUpdatedAt is deliberately excluded: a touched
 * timestamp with identical content must not dirty the row.
 */
export function computeContentHash(
  product: Omit<SnapshotProduct, "contentHash" | "sourceUpdatedAt">,
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
 * Pure Shopify→snapshot mapping for one product node. Empty/missing text
 * fields normalize to "" so the hash and the row are deterministic.
 */
export function mapProductNode(node: ShopifyProductNode): SnapshotProduct {
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
    sourceUpdatedAt: new Date(node.updatedAt),
    contentHash: computeContentHash(withoutHash),
  };
}
