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
   * `templates/product.<view>.liquid` for a product URL with `?view=<view>`.
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

/**
 * Full-page mirror (YOY-100): the results view IS the theme's own
 * search-results page. The widget fetches that page once per page view —
 * for a term whose results page always carries the results-state furniture
 * — hides the origin page's main content, and shows the fetched page's
 * main content in its place, with the theme's results list replaced by our
 * grid and the theme's own results-count line rewritten to our count and
 * the shopper's query. Every selector below is data, never hardcoded.
 */
export interface NativeRenderPageConfig {
  /**
   * The theme's search route. Used only when the page has no theme search
   * form to read it from: the takeover's own form (`form[action*="/search"]`)
   * carries the locale-aware route (Shopify: `routes.search_url`, e.g.
   * `/he/search`), which always wins.
   */
  searchPath: string;
  /** The query parameter of the search route; the results view's URL is
   * `<searchPath>?<queryParam>=<query>`. */
  queryParam: string;
  /**
   * The term whose theme results page supplies the furniture. Shopify's
   * storefront search treats `*` as "every product", so that page always
   * renders in its results state — heading, count line, results list —
   * whatever the shopper's actual query would have matched natively. Its
   * rendered count and term are rewritten to ours; the term must contain
   * no digits (the count is found as the first digit run).
   */
  shellTerm: string;
  /** Extra query string on the shell fetch (Shopify: `type=product` keeps
   * articles and pages out of the count). */
  shellParams: string;
  /** Inside the fetched page's main content: the theme's results list. Our
   * grid takes its place and inherits its classes. */
  resultsSelector: string;
  /** Elements whose text carries the theme's results-count line (count and
   * term rewritten). Nested matches are handled once, outermost first. */
  countSelector: string;
  /**
   * Elements that only make sense against the theme's own result set —
   * filter facets, sorting, pagination, loading overlays — removed from the
   * mirror. Everything else on the page stays the theme's.
   */
  stripSelector: string;
  /** The template's own search input(s), filled with the shopper's query. */
  termInputSelector: string;
}

export interface NativeRenderConfig {
  /** Which mechanism renders the submit tier. */
  variant: "A" | "B";
  template: NativeRenderTemplateConfig;
  harvest: NativeRenderHarvestConfig;
  page: NativeRenderPageConfig;
  /**
   * The page's main content (first match wins): on the origin page, the
   * element whose children the mirror hides and replaces; in the fetched
   * search page, the element whose children ARE the mirror. When the shell
   * cannot be fetched, the bare results panel is prepended here instead
   * (origin content still hidden).
   */
  mountSelector: string;
  /**
   * Classes on the bare panel — the theme's page-container class, so the
   * grid sits in the theme's content column exactly like its own results.
   * Unused inside a fetched shell, where the theme's own container wraps
   * the grid.
   */
  sectionClass: string;
  /** Classes of the results list / item — the theme's own grid classes. */
  grid: { listClass: string; itemClass: string };
  /** Variant A: parallel alternate-template fetches in flight at once. */
  concurrency: number;
}

/** Everything a caller may override; the rest falls back to Dawn defaults. */
export type NativeRenderOverrides = Partial<
  Omit<NativeRenderConfig, "template" | "harvest" | "page" | "grid">
> & {
  template?: Partial<NativeRenderTemplateConfig>;
  page?: Partial<NativeRenderPageConfig>;
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
      // Every anchor of the theme's card is a product link (Dawn: the
      // heading's `full-unstyled-link` and any media/quick-add link); the
      // widget never assumes a URL scheme to find them (YOY-87 AC-4).
      link: "a[href]",
      title: ".card__heading a",
      image: ".card__media img",
      price: ".price__regular .price-item--regular, .price__sale .price-item--sale",
      priceCompare: "s.price-item, .unit-price",
      badge: ".card__badge",
    },
  },
  page: {
    searchPath: "/search",
    queryParam: "q",
    shellTerm: "*",
    shellParams: "type=product",
    resultsSelector: "ul.product-grid",
    // Dawn renders the count in the search header (filtering/sorting off)
    // or in the facets bar's product-count (filtering on).
    countSelector: '.template-search__header [role="status"], .product-count',
    stripSelector: [
      ".facets__wrapper",
      ".facet-filters",
      ".facets__disclosure-vertical",
      ".mobile-facets__wrapper",
      ".active-facets",
      ".pagination-wrapper",
      ".loading-overlay",
      ".loading-overlay__spinner",
    ].join(", "),
    termInputSelector: 'input[name="q"]',
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
    page: { ...DAWN_NATIVE_RENDER.page, ...overrides.page },
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
    `  own product card for a product URL with ?view=${template.view}.`,
    "{% endcomment %}",
    "{% layout none %}",
    stylesheets,
    `{% render '${template.snippet}', ${template.productParam}: product${
      args === "" ? "" : `, ${args}`
    } %}`,
    "",
  ].join("\n");
}
