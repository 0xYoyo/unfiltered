import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import type { ImageFetch } from "./images.server";
import { globalImageFetch, syncProductImages } from "./images.server";
import type { ShopifyProductNode, SnapshotProduct } from "./mapping.server";
import { usableImageUrls, mapProductNode } from "./mapping.server";
import type { VariantRecord } from "./variants.server";
import { syncProductVariants } from "./variants.server";

/**
 * Shape of a product webhook payload (`products/create` / `products/update`)
 * as Shopify delivers it: the REST-style product JSON. Only the fields the
 * snapshot consumes.
 */
export interface ProductWebhookPayload {
  id: number;
  admin_graphql_api_id?: string;
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  /** Comma-separated in webhook payloads, unlike the GraphQL string list. */
  tags: string;
  /**
   * "active" | "archived" | "draft". A non-active status removes the product
   * from the snapshot (YOY-61 AC-2) — archiving fires `products/update`, not
   * `products/delete`. Absent in older payloads and treated as active.
   */
  status?: string;
  /**
   * When the product was published to the Online Store sales channel; null
   * means not published (YOY-67 AC-4) — the storefront page 404s even while
   * ACTIVE, so a null removes the product from the snapshot the same way a
   * non-active status does (unpublishing fires `products/update`, not
   * `products/delete`). Absent in older payloads and treated as published.
   */
  published_at?: string | null;
  updated_at: string;
  /**
   * The identity and option fields (YOY-142 AC-3) are absent in older
   * fixtures; only variants carrying an `id` become `ProductVariant` rows.
   */
  variants: Array<{
    id?: number;
    admin_graphql_api_id?: string;
    position?: number | null;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
    updated_at?: string | null;
    price: string;
    inventory_quantity: number | null;
    inventory_policy: string | null;
    inventory_management: string | null;
  }>;
  /**
   * The product's option names; `option1`/`option2`/`option3` on a variant
   * are the values of options 1–3 in this order (YOY-142 AC-3).
   */
  options?: Array<{ name: string; position?: number | null }>;
  /** `src` feeds image capture (YOY-120 AC-1); absent in older payloads. */
  images: Array<{ src?: string | null; alt: string | null }>;
  /** The product's featured image, when it has one. */
  image: { src: string | null } | null;
}

/** `products/delete` delivers only the numeric product ID. */
export interface ProductDeleteWebhookPayload {
  id: number;
}

/** Outcome of applying one product webhook to the snapshot. */
export type WebhookSyncOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped_stale"
  | "deleted"
  | "not_found";

function productGid(payload: { id: number; admin_graphql_api_id?: string }): string {
  return payload.admin_graphql_api_id ?? `gid://shopify/Product/${payload.id}`;
}

/** Named entities Shopify product HTML uses in practice; numeric forms are
 * decoded generically, so this table only needs the symbolic names. Lookup
 * is case-sensitive the way HTML5 defines the references (YOY-29 AC-1):
 * `&Eacute;` is É and `&eacute;` is é — two distinct names — and the spec's
 * uppercase legacy forms (`&AMP;`, `&LT;`, …) are separate entries. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  COPY: "©",
  reg: "®",
  REG: "®",
  trade: "™",
  TRADE: "™",
  deg: "°",
  times: "×",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  agrave: "à",
  Agrave: "À",
  aacute: "á",
  Aacute: "Á",
  acirc: "â",
  Acirc: "Â",
  atilde: "ã",
  Atilde: "Ã",
  auml: "ä",
  Auml: "Ä",
  aring: "å",
  Aring: "Å",
  aelig: "æ",
  AElig: "Æ",
  ccedil: "ç",
  Ccedil: "Ç",
  egrave: "è",
  Egrave: "È",
  eacute: "é",
  Eacute: "É",
  ecirc: "ê",
  Ecirc: "Ê",
  euml: "ë",
  Euml: "Ë",
  igrave: "ì",
  Igrave: "Ì",
  iacute: "í",
  Iacute: "Í",
  icirc: "î",
  Icirc: "Î",
  iuml: "ï",
  Iuml: "Ï",
  ntilde: "ñ",
  Ntilde: "Ñ",
  ograve: "ò",
  Ograve: "Ò",
  oacute: "ó",
  Oacute: "Ó",
  ocirc: "ô",
  Ocirc: "Ô",
  otilde: "õ",
  Otilde: "Õ",
  ouml: "ö",
  Ouml: "Ö",
  oslash: "ø",
  Oslash: "Ø",
  ugrave: "ù",
  Ugrave: "Ù",
  uacute: "ú",
  Uacute: "Ú",
  ucirc: "û",
  Ucirc: "Û",
  uuml: "ü",
  Uuml: "Ü",
  yacute: "ý",
  Yacute: "Ý",
  yuml: "ÿ",
  szlig: "ß",
};

/**
 * Decode HTML entities in a single pass: decimal (`&#8212;`) and hex
 * (`&#x2014;`) references generically, named references via the table above,
 * matched case-sensitively per HTML5 (YOY-29 AC-1) — `&Eacute;` and
 * `&eacute;` differ in case and in meaning, and an invalid-case name like
 * `&EACUTE;` stays literal, exactly as a browser leaves it.
 * One pass means double-encoded text (`&amp;lt;`) decodes exactly once, the
 * way a real HTML-to-text conversion does; unrecognized names pass through.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex !== undefined || dec !== undefined) {
        const codePoint = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
      }
      return NAMED_ENTITIES[named as string] ?? match;
    },
  );
}

/**
 * Reduce `body_html` to the plain text the GraphQL `description` field
 * carries (tags stripped, entities decoded, whitespace collapsed), so a
 * product synced via webhook hashes identically to the same product ingested
 * via GraphQL.
 */
function htmlToPlainText(html: string | null): string {
  if (!html) {
    return "";
  }
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Approximate the GraphQL `availableForSale` flag from REST variant fields:
 * a variant is purchasable when inventory is untracked, oversell is allowed,
 * or stock is positive.
 */
function variantAvailable(variant: ProductWebhookPayload["variants"][number]): boolean {
  return (
    variant.inventory_management == null ||
    variant.inventory_policy === "continue" ||
    (variant.inventory_quantity ?? 0) > 0
  );
}

/**
 * Pure webhook→snapshot mapping: convert the REST-style webhook payload into
 * the GraphQL node shape and reuse the existing `mapProductNode` mapping (and
 * therefore the same content hash). Webhook payloads carry no currency, so
 * `currencyCode` must be supplied — pass the existing row's value to keep the
 * hash stable for unchanged products, or "" for products not yet ingested.
 * Webhook payloads carry no Online Store URL either, so `url` is the
 * composed storefront form when `shopDomain` is given (YOY-87 AC-2), else
 * null.
 */
export function mapWebhookProduct(
  payload: ProductWebhookPayload,
  currencyCode: string,
  shopDomain?: string,
): SnapshotProduct {
  const prices = payload.variants.map((variant) => Number(variant.price));
  const min = prices.length > 0 ? Math.min(...prices) : 0;
  const max = prices.length > 0 ? Math.max(...prices) : 0;

  const node: ShopifyProductNode = {
    id: productGid(payload),
    title: payload.title,
    handle: payload.handle,
    description: htmlToPlainText(payload.body_html),
    tags: payload.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ""),
    vendor: payload.vendor,
    productType: payload.product_type,
    publishedAt: payload.published_at,
    updatedAt: payload.updated_at,
    priceRangeV2: {
      minVariantPrice: { amount: String(min), currencyCode },
      maxVariantPrice: { amount: String(max), currencyCode },
    },
    variants: {
      nodes: payload.variants.map((variant) => ({
        availableForSale: variantAvailable(variant),
      })),
    },
    images: {
      nodes: payload.images.map((image) => ({ url: image.src, altText: image.alt })),
    },
    featuredImage:
      payload.image?.src != null && payload.image.src !== ""
        ? { url: payload.image.src }
        : null,
  };
  return mapProductNode(node, { shopDomain });
}

/**
 * The image URLs a product webhook carries (YOY-120 AC-1): the usable
 * `images[].src`, in order — the whole list; image capture de-duplicates
 * by content and applies the cap. Kept beside the snapshot row, like
 * `snapshotImageUrls` for the Admin ingest.
 */
export function webhookImageUrls(
  payload: Pick<ProductWebhookPayload, "images">,
): string[] {
  return usableImageUrls(payload.images.map((image) => image.src));
}

/**
 * The variants a product webhook carries (YOY-142 AC-3): each variant's
 * `option1`/`option2`/`option3` paired, in order, with the product's option
 * names — both verbatim (AC-6) — its price, availability by the same
 * `variantAvailable` rule the snapshot's `available` uses, and
 * `inventory_quantity` as given. The variant id is its Admin GID, the same
 * key the Admin ingest stores, so a product synced by either path keeps one
 * row per variant.
 */
export function webhookVariants(
  payload: Pick<ProductWebhookPayload, "variants" | "options">,
): VariantRecord[] {
  const names = [...(payload.options ?? [])]
    .map((option, index) => ({ name: option.name, position: option.position ?? index + 1 }))
    .sort((a, b) => a.position - b.position)
    .map((option) => option.name);
  const variants: VariantRecord[] = [];
  payload.variants.forEach((variant, index) => {
    const variantId =
      variant.admin_graphql_api_id ??
      (variant.id !== undefined ? `gid://shopify/ProductVariant/${variant.id}` : null);
    const price = Number(variant.price);
    if (variantId === null || !Number.isFinite(price)) {
      return;
    }
    const options = [variant.option1, variant.option2, variant.option3].flatMap(
      (value, optionIndex) => {
        const name = names[optionIndex];
        return typeof value === "string" && name !== undefined ? [{ name, value }] : [];
      },
    );
    variants.push({
      variantId,
      position: variant.position ?? index + 1,
      options,
      price,
      available: variantAvailable(variant),
      quantity: typeof variant.inventory_quantity === "number" ? variant.inventory_quantity : null,
      sourceUpdatedAt:
        typeof variant.updated_at === "string" && variant.updated_at !== ""
          ? new Date(variant.updated_at)
          : null,
    });
  });
  return variants;
}

/**
 * Apply a `products/create` or `products/update` webhook to the shop's
 * snapshot. Idempotent and tolerant of out-of-order delivery: a payload whose
 * `updated_at` is older than the stored row's `sourceUpdatedAt` is dropped,
 * and a redelivery with an unchanged content hash leaves the row untouched
 * (advancing only `sourceUpdatedAt` when the payload is newer, so a stale
 * update can never sneak in behind an unchanged redelivery).
 */
export async function syncProductFromWebhook({
  db,
  shopDomain,
  payload,
  fetchImage = globalImageFetch,
}: {
  db: PrismaClient;
  shopDomain: string;
  payload: ProductWebhookPayload;
  /** Image-byte fetcher for `ProductImage` hashing (YOY-120); the platform fetch by default, a stub in tests. */
  fetchImage?: ImageFetch;
}): Promise<WebhookSyncOutcome> {
  const productId = productGid(payload);
  // Image capture (YOY-120) and variant capture (YOY-142 AC-3) run after
  // every outcome that leaves the product in the snapshot — created,
  // updated, unchanged — because both sit outside the content hash; a stale
  // or deleted product captures nothing.
  const withImages = async (outcome: WebhookSyncOutcome): Promise<WebhookSyncOutcome> => {
    await syncProductImages({
      db,
      shopDomain,
      productId,
      imageUrls: webhookImageUrls(payload),
      fetchImage,
    });
    await syncProductVariants({
      db,
      shopDomain,
      productId,
      variants: webhookVariants(payload),
    });
    return outcome;
  };

  // Non-active products leave the snapshot (YOY-61 AC-2), and so do
  // products unpublished from the Online Store (YOY-67 AC-4 — status and
  // channel publication are independent axes): archiving, drafting, or
  // unpublishing fires `products/update`, and serving the product afterwards
  // means 404s on click. Same deletion set as `products/delete` —
  // enrichment and embedding rows go with the product.
  if (
    (payload.status !== undefined && payload.status !== "active") ||
    payload.published_at === null
  ) {
    const [, , , , , { count }] = await db.$transaction([
      db.productEnrichment.deleteMany({ where: { shopDomain, productId } }),
      db.productEmbedding.deleteMany({ where: { shopDomain, productId } }),
      db.productImage.deleteMany({ where: { shopDomain, productId } }),
      db.productVariant.deleteMany({ where: { shopDomain, productId } }),
      db.productCard.deleteMany({ where: { shopDomain, productId } }),
      db.catalogProduct.deleteMany({ where: { shopDomain, productId } }),
    ]);
    return count > 0 ? "deleted" : "not_found";
  }

  const findExisting = () =>
    db.catalogProduct.findUnique({
      where: { shopDomain_productId: { shopDomain, productId } },
      select: {
        contentHash: true,
        currencyCode: true,
        sourceUpdatedAt: true,
        handle: true,
        featuredImageUrl: true,
        familyKey: true,
        url: true,
        publishedAt: true,
      },
    });

  let existing = await findExisting();

  if (existing === null) {
    try {
      await db.catalogProduct.create({
        data: { shopDomain, ...mapWebhookProduct(payload, "", shopDomain) },
      });
      return withImages("created");
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      // Lost a create race: a concurrent delivery for the same product
      // inserted the row between our read and our create. The winner's row
      // exists now, so re-read it and fall through to the update path.
      existing = await findExisting();
      if (existing === null) {
        throw error;
      }
    }
  }

  const product = mapWebhookProduct(
    payload,
    existing.currencyCode,
    shopDomain,
  );

  if (product.sourceUpdatedAt < existing.sourceUpdatedAt) {
    return "skipped_stale";
  }
  if (product.contentHash === existing.contentHash) {
    // Searchable content unchanged — but the display-only fields (handle,
    // featuredImageUrl, url — YOY-87) and the publication timestamp (YOY-67 AC-4) sit
    // outside contentHash, so an update that changed only them must still
    // land on the row (YOY-44 AC-3).
    if (
      product.handle !== existing.handle ||
      product.featuredImageUrl !== existing.featuredImageUrl ||
      product.familyKey !== existing.familyKey ||
      product.url !== existing.url ||
      (product.publishedAt?.getTime() ?? null) !==
        (existing.publishedAt?.getTime() ?? null)
    ) {
      await db.catalogProduct.update({
        where: { shopDomain_productId: { shopDomain, productId } },
        data: {
          handle: product.handle,
          featuredImageUrl: product.featuredImageUrl,
          familyKey: product.familyKey,
          url: product.url,
          publishedAt: product.publishedAt,
          sourceUpdatedAt: product.sourceUpdatedAt,
        },
      });
      return withImages("updated");
    }
    if (product.sourceUpdatedAt > existing.sourceUpdatedAt) {
      await db.catalogProduct.update({
        where: { shopDomain_productId: { shopDomain, productId } },
        data: { sourceUpdatedAt: product.sourceUpdatedAt },
      });
    }
    return withImages("unchanged");
  }
  await db.catalogProduct.update({
    where: { shopDomain_productId: { shopDomain, productId } },
    data: product,
  });
  return withImages("updated");
}

/**
 * Apply a `products/delete` webhook: remove the snapshot row if present.
 * Redeliveries and deletes for never-ingested products are no-ops.
 */
export async function deleteProductFromWebhook({
  db,
  shopDomain,
  payload,
}: {
  db: PrismaClient;
  shopDomain: string;
  payload: ProductDeleteWebhookPayload;
}): Promise<WebhookSyncOutcome> {
  // Enrichment and embedding rows are keyed by shopDomain+productId with no
  // FK cascade, so they must go in the same operation as the product
  // (YOY-29 AC-5, YOY-61 AC-2).
  const productId = productGid(payload);
  const [, , , , , { count }] = await db.$transaction([
    db.productEnrichment.deleteMany({ where: { shopDomain, productId } }),
    db.productEmbedding.deleteMany({ where: { shopDomain, productId } }),
    db.productImage.deleteMany({ where: { shopDomain, productId } }),
    db.productVariant.deleteMany({ where: { shopDomain, productId } }),
    db.productCard.deleteMany({ where: { shopDomain, productId } }),
    db.catalogProduct.deleteMany({ where: { shopDomain, productId } }),
  ]);
  return count > 0 ? "deleted" : "not_found";
}
