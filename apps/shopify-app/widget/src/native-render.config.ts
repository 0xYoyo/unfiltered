/**
 * Theme-native rendering config (YOY-70 spike) — the ONE place every
 * theme-specific name lives, in the docs/PORTABILITY.md LEAK-3 spirit: the
 * alternate-template view name, the theme's card snippet and its arguments,
 * the harvest selectors, and the results-grid classes are data, never
 * hardcoded in the rendering code. `scripts/native-render-template.mts`
 * generates the alternate product template from `template`, and the widget
 * bundle reads the same object at build time, so the template Shopify
 * renders and the view the widget fetches cannot drift apart.
 *
 * The defaults describe Dawn (and Shopify's Dawn-derived generated-data
 * theme on the dev store). A non-Dawn theme overrides fields via
 * `WidgetConfig.nativeRender` — the full merchant-facing config surface is
 * M6 work; the spike only proves the shape.
 */

export interface NativeRenderTemplateConfig {
  /**
   * Alternate template suffix: Shopify serves
   * `templates/product.<view>.liquid` for `/products/<handle>?view=<view>`.
   */
  view: string;
  /** The theme's product-card snippet name (`{% render '<snippet>' %}`). */
  snippet: string;
  /** The snippet parameter that receives the product object. */
  productParam: string;
  /**
   * Extra snippet arguments, verbatim Liquid — mirrors what the theme's own
   * search section passes so the fetched card matches the native results
   * page (Dawn: templates/search.json `main-search` settings).
   */
  snippetArgs: string;
  /**
   * Theme stylesheets the card depends on. Emitted as `stylesheet_tag`s at
   * the top of the alternate template so an injected card carries its own
   * CSS onto pages that never loaded it; the widget dedupes them into
   * <head> once per href.
   */
  stylesheets: string[];
}

export interface NativeRenderHarvestConfig {
  /**
   * Variant B harvest source: a storefront page that renders the theme's
   * product cards. Fetched once per page view; the first card and its list
   * become the clone template.
   */
  url: string;
  /** Selector for one rendered product card on the harvest page. */
  cardSelector: string;
  /** Selector for the list element wrapping the cards (grid classes). */
  listSelector: string;
  /** Selectors, inside a harvested card, of the parts we refill. */
  fill: {
    /** Anchors whose href becomes the result's product URL. */
    link: string;
    /** Elements whose text becomes the result title. */
    title: string;
    /** The product image. */
    image: string;
    /** Elements whose text becomes the formatted price. */
    price: string;
    /** Compare-at / stale price elements to blank. */
    priceCompare: string;
    /** The badge container (sold-out marker). */
    badge: string;
  };
}

export interface NativeRenderConfig {
  /** Which mechanism renders the submit tier. */
  variant: "A" | "B";
  template: NativeRenderTemplateConfig;
  harvest: NativeRenderHarvestConfig;
  /**
   * Where the native results panel mounts (first match wins); prepended so
   * results appear directly under the header the search input lives in.
   */
  mountSelector: string;
  /**
   * Classes on the panel itself — the theme's page-container class, so the
   * grid sits in the theme's content column exactly like its own results.
   */
  sectionClass: string;
  /** Classes of the results list / item — the theme's own grid classes. */
  grid: { listClass: string; itemClass: string };
  /** Variant A: parallel alternate-template fetches in flight at once. */
  concurrency: number;
}

/** Everything a caller may override; the rest falls back to Dawn defaults. */
export type NativeRenderOverrides = Partial<
  Omit<NativeRenderConfig, "template" | "harvest" | "grid">
> & {
  template?: Partial<NativeRenderTemplateConfig>;
  harvest?: Partial<Omit<NativeRenderHarvestConfig, "fill">> & {
    fill?: Partial<NativeRenderHarvestConfig["fill"]>;
  };
  grid?: Partial<NativeRenderConfig["grid"]>;
};

export const DAWN_NATIVE_RENDER: NativeRenderConfig = {
  variant: "A",
  template: {
    view: "unfiltered-card",
    snippet: "card-product",
    productParam: "card_product",
    snippetArgs:
      "media_aspect_ratio: 'portrait', show_secondary_image: false, show_vendor: false, show_rating: false, lazy_load: true",
    stylesheets: ["component-card.css", "component-price.css"],
  },
  harvest: {
    url: "/collections/all",
    // Product cards only: Dawn's collection cards share `.card-wrapper`, and
    // on /collections/all a collection card precedes the first product card
    // in document order (found live on the dev store) — matching it would
    // clone a text-only card and its 3-column list.
    cardSelector: ".product-card-wrapper",
    listSelector: "ul.product-grid",
    fill: {
      link: 'a[href*="/products/"]',
      title: ".card__heading a",
      image: ".card__media img",
      price: ".price__regular .price-item--regular, .price__sale .price-item--sale",
      priceCompare: "s.price-item, .unit-price",
      badge: ".card__badge",
    },
  },
  mountSelector: "main, #MainContent",
  sectionClass: "page-width",
  grid: {
    listClass:
      "grid product-grid grid--2-col-tablet-down grid--4-col-desktop",
    itemClass: "grid__item",
  },
  concurrency: 6,
};

/** Merge caller overrides over the Dawn defaults. */
export function resolveNativeRenderConfig(
  overrides: NativeRenderOverrides = {},
): NativeRenderConfig {
  return {
    ...DAWN_NATIVE_RENDER,
    ...overrides,
    template: { ...DAWN_NATIVE_RENDER.template, ...overrides.template },
    harvest: {
      ...DAWN_NATIVE_RENDER.harvest,
      ...overrides.harvest,
      fill: { ...DAWN_NATIVE_RENDER.harvest.fill, ...overrides.harvest?.fill },
    },
    grid: { ...DAWN_NATIVE_RENDER.grid, ...overrides.grid },
  };
}

/**
 * The alternate product template's Liquid source: no layout, the card's
 * stylesheets, then the theme's own card snippet for `product`. Shopify
 * renders it with the theme's real settings — no scraping, no theme code
 * edited by hand.
 */
export function alternateTemplateSource(
  template: NativeRenderTemplateConfig,
): string {
  const stylesheets = template.stylesheets
    .map((name) => `{{ '${name}' | asset_url | stylesheet_tag }}`)
    .join("\n");
  const args = template.snippetArgs.trim();
  return [
    "{% comment %}",
    `  Generated by apps/shopify-app/scripts/native-render-template.mts from`,
    `  widget/src/native-render.config.ts (YOY-70). Renders only the theme's`,
    `  own product card for /products/<handle>?view=${template.view}.`,
    "{% endcomment %}",
    "{% layout none %}",
    stylesheets,
    `{% render '${template.snippet}', ${template.productParam}: product${
      args === "" ? "" : `, ${args}`
    } %}`,
    "",
  ].join("\n");
}
