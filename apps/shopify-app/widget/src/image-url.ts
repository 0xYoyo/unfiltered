/**
 * Sized card images (YOY-169): Shopify's CDN resizes an image on request
 * through its `width` query parameter, which is how every Shopify theme
 * serves its cards. A card asked for the original (often ~1,400 px wide,
 * 100–400 KB) instead, so a 24-card page pulled megabytes. The playground
 * card and the widget overlay card both read their image attributes here;
 * the theme-native path is the theme's own sized markup and does not.
 */

/** The widths a card image is offered at; the first is its `src`. */
export const CARD_IMAGE_WIDTHS = [360, 540, 720] as const;

/**
 * Cards in the first row load eagerly; every later card is `lazy` (AC-2).
 * Four is the widest first row either grid draws at its usual widths.
 */
export const FIRST_ROW_CARDS = 4;

const SHOPIFY_CDN_HOST = "cdn.shopify.com";

function shopifyCdnUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.hostname === SHOPIFY_CDN_HOST ? parsed : null;
}

/**
 * The image at `width`: a `cdn.shopify.com` URL with its `width` parameter
 * added or replaced, every other parameter (`v=` in particular) kept. Any
 * other host — a crawl-sourced image, a data URI — is returned unchanged.
 */
export function sizedImageUrl(url: string, width: number): string {
  const parsed = shopifyCdnUrl(url);
  if (parsed === null) {
    return url;
  }
  parsed.searchParams.set("width", String(width));
  return parsed.toString();
}

/** A card image's `src`, and its `srcset` when the CDN can size it. */
export interface CardImageSources {
  src: string;
  srcset?: string;
}

/** The `src`/`srcset` pair a card renders (AC-2). */
export function cardImageSources(url: string): CardImageSources {
  if (shopifyCdnUrl(url) === null) {
    return { src: url };
  }
  return {
    src: sizedImageUrl(url, CARD_IMAGE_WIDTHS[0]),
    srcset: CARD_IMAGE_WIDTHS.map((width) => `${sizedImageUrl(url, width)} ${width}w`).join(
      ", ",
    ),
  };
}

/** `loading` for the card at `position` in the whole order (AC-2). */
export function cardImageLoading(position: number): "eager" | "lazy" {
  return position < FIRST_ROW_CARDS ? "eager" : "lazy";
}
