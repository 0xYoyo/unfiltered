/**
 * Catalog-source port (YOY-88 AC-2): the platform-free contract every public
 * catalog source fulfils for the playground's generic ingestion. A source
 * turns whatever it reads — a storefront JSON feed, a sitemap of product
 * pages (YOY-89) — into `SourceProduct` records; the pipeline in
 * ingest-public.server.ts maps those to catalog snapshot rows and reuses the
 * existing enrichment and embedding steps unchanged. Nothing here names a
 * commerce platform: adapters (shopify-public-source.server.ts) live beside
 * this port and are the only place platform knowledge is allowed.
 */

/** One product as a source hands it to the pipeline: no DB identity, no tenant. */
export interface SourceProduct {
  /** The source's own stable product identifier; becomes `productId`. */
  sourceId: string;
  title: string;
  /** Plain text — sources strip any HTML before handing it over. */
  description: string;
  tags: string[];
  vendor: string;
  productType: string;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  imageAltTexts: string[];
  imageUrl: string | null;
  /**
   * Every usable image URL in source order (YOY-120 AC-1), the input of
   * image capture, which de-duplicates by content and keeps the first four
   * distinct images; the first is normally `imageUrl`. Empty when the
   * source lists none.
   */
  imageUrls: string[];
  /** The product's public page, resolved by the source; null when unknown. */
  url: string | null;
  sourceUpdatedAt: Date | null;
}

/** Progress callback a long fetch reports through, for operator output. */
export type SourceProgress = (event: {
  /** Products fetched so far. */
  fetched: number;
  /** Free-text stage description, e.g. "page 3". */
  stage: string;
}) => void;

/** A public catalog source: what it is, and how to read its products. */
export interface CatalogSource {
  /** Free-form source kind, recorded on the registry row (e.g. "shopify-public"). */
  readonly kind: string;
  /**
   * Read the catalog. Sources may stop reading once `maxProducts` records
   * are in hand (they need not exhaust the source to count what lies
   * beyond); the pipeline enforces the bound either way.
   */
  fetchProducts(options: {
    maxProducts: number;
    onProgress?: SourceProgress;
  }): Promise<SourceProduct[]>;
}

/**
 * HTML → plain text for product descriptions: tags removed, block-level
 * boundaries turned into whitespace, common entities decoded, whitespace
 * collapsed. Deliberately small — sources feed rich-text product bodies, not
 * arbitrary documents.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (html === null || html === undefined || html === "") {
    return "";
  }
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|table|section|article)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/\s+/g, " ")
    .trim();
}
