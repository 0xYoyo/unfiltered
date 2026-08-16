import { chipLabel, formatPrice } from "./format";
import {
  type NativeRenderConfig,
  type NativeRenderOverrides,
  resolveNativeRenderConfig,
} from "./native-render.config";
import styles from "./native-render.css?inline";
import type { Overlay, ResponseHandlers } from "./overlay";
import type {
  ProxyChip,
  ProxyResult,
  ProxySearchResponse,
} from "./search-client";
import { getStrings, resolveLocale } from "./strings";

/**
 * Theme-native result rendering (YOY-70 spike): the submit tier's ranked
 * results render as the THEME's own product cards, inside the theme's own
 * grid, in the host document — "the host store's design IS the design".
 * Two mechanisms, selected by config/flag:
 *
 * - Variant A — alternate-template fetch: each result's card is fetched
 *   from `/products/<handle>?view=<view>`, an alternate product template
 *   that renders only the theme's card snippet (installed by
 *   scripts/native-render-template.mts). Shopify renders the real card with
 *   the theme's real settings; the widget injects the markup and hoists its
 *   stylesheets. Shopify-specific by mechanism.
 * - Variant B — harvest-clone: one storefront page that already renders the
 *   theme's cards is fetched once; its first card is the template, cloned
 *   per result and refilled with our data through configured selectors.
 *   Pure DOM — the portable (Door-2) analog.
 *
 * Both fill an `Overlay`-shaped surface so main.ts's state machine drives
 * them unchanged; the composite below keeps keystroke previews on the
 * existing shadow overlay (YOY-70 NG-3) and routes submitted responses to
 * the native panel. Everything is off unless a caller opts in
 * (`WidgetConfig.nativeRender`) or the dev flag is set (NG-1).
 */

export const NATIVE_TESTID = "unfiltered-native-results";
export const NATIVE_LIST_TESTID = "unfiltered-native-list";
export const NATIVE_ITEM_TESTID = "unfiltered-native-item";
export const NATIVE_CHIP_TESTID = "unfiltered-native-chip";
export const NATIVE_CHIPS_TESTID = "unfiltered-native-chips";
export const NATIVE_LOADING_TESTID = "unfiltered-native-loading";
export const NATIVE_NO_RESULTS_TESTID = "unfiltered-native-no-results";
export const NATIVE_ZERO_HIT_TESTID = "unfiltered-native-zero-hit";
export const NATIVE_CLOSE_MATCHES_TESTID = "unfiltered-native-close-matches";
export const NATIVE_CLOSE_TESTID = "unfiltered-native-close";
export const NATIVE_NEW_SEARCH_TESTID = "unfiltered-native-new-search";
export const NATIVE_STYLE_ATTR = "data-unfiltered-native-style";

/**
 * Dev flag (spike-only): `?unfiltered_native=A|B` on any storefront URL
 * turns the mechanism on for this browser session (persisted in
 * sessionStorage so navigating the store keeps it); `off` clears it. The
 * embed block passes no config, so without the flag nothing changes for any
 * shopper (NG-1). M6 replaces this with a merchant-facing setting.
 */
export const NATIVE_FLAG_PARAM = "unfiltered_native";
export const NATIVE_FLAG_STORAGE_KEY = "unfiltered:native-render";

type Variant = NativeRenderConfig["variant"];

function isVariant(value: string | null | undefined): value is Variant {
  return value === "A" || value === "B";
}

/**
 * Decide whether native rendering runs, and with which variant: the URL
 * flag wins, then the session's remembered flag, then the caller's config.
 * `null` means off — the existing overlay path, untouched (NG-2).
 */
export function resolveNativeRender(
  configured: NativeRenderOverrides | undefined,
  location: { search: string } = window.location,
): NativeRenderConfig | null {
  let flagged: Variant | "off" | undefined;
  try {
    const param = new URLSearchParams(location.search).get(NATIVE_FLAG_PARAM);
    if (param === "off") {
      window.sessionStorage.removeItem(NATIVE_FLAG_STORAGE_KEY);
      flagged = "off";
    } else if (isVariant(param)) {
      window.sessionStorage.setItem(NATIVE_FLAG_STORAGE_KEY, param);
      flagged = param;
    } else {
      const stored = window.sessionStorage.getItem(NATIVE_FLAG_STORAGE_KEY);
      if (isVariant(stored)) {
        flagged = stored;
      }
    }
  } catch {
    // Storage may be unavailable (privacy modes); the flag is best-effort.
  }
  if (flagged === "off") {
    return null;
  }
  if (flagged !== undefined) {
    return resolveNativeRenderConfig({ ...configured, variant: flagged });
  }
  return configured === undefined ? null : resolveNativeRenderConfig(configured);
}

/** Per-render diagnostics the spike measures (AC-4c); dev-only surface. */
export interface NativeRenderTiming {
  variant: Variant;
  /** Wall-clock from response to cards in the DOM. */
  totalMs: number;
  /** Results rendered by the native mechanism. */
  native: number;
  /** Results that fell back to the plain card. */
  fallback: number;
  /** Variant A: cards served from the per-handle cache. */
  cached: number;
  /** Individual network fetch durations this render performed. */
  fetchMs: number[];
}

declare global {
  interface Window {
    __unfilteredNativeTiming?: NativeRenderTiming;
  }
}

export interface NativeSurfaceOptions {
  locale: string;
  config: NativeRenderConfig;
  onClose: () => void;
  onNewSearch: () => void;
}

/** A theme card produced for one result, or null when the mechanism could
 * not produce one (template missing, harvest failed) — the fallback renders. */
type CardProducer = (
  result: ProxyResult,
) => Promise<{ element: HTMLElement; cached: boolean } | null>;

/**
 * Hoist a stylesheet link into <head> once: the alternate template (and the
 * harvested page) ship the card's CSS as <link> tags; injecting them per
 * card would duplicate them, dropping them would strip the card's styles on
 * pages that never loaded component-card.css.
 */
function ensureStylesheet(link: HTMLLinkElement): void {
  const href = new URL(link.getAttribute("href") ?? "", window.location.href)
    .href;
  for (const existing of document.querySelectorAll<HTMLLinkElement>(
    'link[rel="stylesheet"]',
  )) {
    if (existing.href === href) {
      return;
    }
  }
  const clone = document.createElement("link");
  clone.rel = "stylesheet";
  clone.href = href;
  document.head.appendChild(clone);
}

/** Parse fetched storefront HTML into an inert document (scripts never run). */
function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Variant A producer: fetch the alternate template per handle with a small
 * concurrency window; cache the parsed card per handle for the page view so
 * refinement re-renders reuse it (AC-4c: first-fetch caching).
 */
function createAlternateTemplateProducer(
  config: NativeRenderConfig,
  fetchMs: number[],
): CardProducer {
  const cache = new Map<string, Promise<HTMLElement | null>>();
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (inFlight < config.concurrency) {
        inFlight += 1;
        resolve();
      } else {
        waiters.push(() => {
          inFlight += 1;
          resolve();
        });
      }
    });
  const release = (): void => {
    inFlight -= 1;
    waiters.shift()?.();
  };

  const load = async (handle: string): Promise<HTMLElement | null> => {
    await acquire();
    const started = performance.now();
    try {
      const url = `/products/${encodeURIComponent(handle)}?view=${encodeURIComponent(
        config.template.view,
      )}`;
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) {
        return null;
      }
      const doc = parseHtml(await response.text());
      doc.querySelectorAll("script").forEach((script) => script.remove());
      doc
        .querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
        .forEach((link) => {
          ensureStylesheet(link);
          link.remove();
        });
      const card = doc.body.firstElementChild;
      return card instanceof HTMLElement ? card : null;
    } catch {
      return null;
    } finally {
      fetchMs.push(Math.round(performance.now() - started));
      release();
    }
  };

  return async (result) => {
    const cached = cache.has(result.handle);
    if (!cached) {
      cache.set(result.handle, load(result.handle));
    }
    const template = await cache.get(result.handle)!;
    if (template === null) {
      cache.delete(result.handle); // Let a later render retry.
      return null;
    }
    return { element: template.cloneNode(true) as HTMLElement, cached };
  };
}

/**
 * Variant B producer: harvest the theme's rendered card once, then clone and
 * refill it per result through the configured selectors. Falls back to null
 * (plain card) when the harvest page has no recognizable card.
 */
function createHarvestCloneProducer(
  config: NativeRenderConfig,
  strings: ReturnType<typeof getStrings>,
  fetchMs: number[],
  onListClass: (className: string) => void,
): CardProducer {
  let harvest: Promise<HTMLElement | null> | undefined;
  let counter = 0;

  const load = async (): Promise<HTMLElement | null> => {
    const started = performance.now();
    try {
      const response = await fetch(config.harvest.url, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        return null;
      }
      const doc = parseHtml(await response.text());
      const card = doc.querySelector(config.harvest.cardSelector);
      if (!(card instanceof HTMLElement)) {
        return null;
      }
      // The grid classes come from the list that actually contains the
      // harvested card — a page can hold several `product-grid` lists
      // (collection lists, featured sections) with different column counts.
      const list =
        card.closest(config.harvest.listSelector) ??
        doc.querySelector(config.harvest.listSelector);
      if (list !== null && list.className.trim() !== "") {
        onListClass(list.className);
      }
      card.querySelectorAll("script").forEach((script) => script.remove());
      return card;
    } catch {
      return null;
    } finally {
      fetchMs.push(Math.round(performance.now() - started));
    }
  };

  const fill = (template: HTMLElement, result: ProxyResult): HTMLElement => {
    const card = template.cloneNode(true) as HTMLElement;
    const suffix = `--unf${(counter += 1)}`;
    // Harvested ids would collide across clones and with the harvested
    // page's own card; suffix every id and rewrite the aria references.
    const idMap = new Map<string, string>();
    card.querySelectorAll<HTMLElement>("[id]").forEach((element) => {
      const next = element.id + suffix;
      idMap.set(element.id, next);
      element.id = next;
    });
    for (const attribute of ["aria-labelledby", "aria-describedby", "for"]) {
      card.querySelectorAll(`[${attribute}]`).forEach((element) => {
        const value = element.getAttribute(attribute) ?? "";
        element.setAttribute(
          attribute,
          value
            .split(/\s+/)
            .map((token) => idMap.get(token) ?? token)
            .join(" "),
        );
      });
    }
    const { fill: selectors } = config.harvest;
    const href = `/products/${encodeURIComponent(result.handle)}`;
    card
      .querySelectorAll<HTMLAnchorElement>(selectors.link)
      .forEach((anchor) => anchor.setAttribute("href", href));
    card.querySelectorAll(selectors.title).forEach((element) => {
      element.textContent = result.title;
    });
    card
      .querySelectorAll<HTMLImageElement>(selectors.image)
      .forEach((image) => {
        if (result.imageUrl === null) {
          image.remove();
          return;
        }
        image.removeAttribute("srcset");
        image.removeAttribute("sizes");
        image.src = result.imageUrl;
        image.alt = result.title;
      });
    const price = formatPrice(
      result.priceMin,
      result.priceMax,
      result.currencyCode,
    );
    card.querySelectorAll(selectors.price).forEach((element) => {
      element.textContent = price;
    });
    card.querySelectorAll(selectors.priceCompare).forEach((element) => {
      element.textContent = "";
    });
    const badge = card.querySelector(selectors.badge);
    if (badge !== null) {
      badge.replaceChildren();
      if (!result.available) {
        const span = document.createElement("span");
        span.className = "badge";
        span.textContent = strings.soldOut;
        badge.appendChild(span);
      }
    }
    return card;
  };

  return async (result) => {
    if (harvest === undefined) {
      harvest = load();
    }
    const template = await harvest;
    if (template === null) {
      harvest = undefined; // Let a later render retry the harvest.
      return null;
    }
    return { element: fill(template, result), cached: false };
  };
}

export function createNativeSurface(options: NativeSurfaceOptions): Overlay {
  const { config } = options;
  const locale = resolveLocale(options.locale);
  const strings = getStrings(options.locale);

  const section = document.createElement("section");
  section.className = `unfiltered-native ${config.sectionClass}`.trim();
  section.setAttribute("data-testid", NATIVE_TESTID);
  section.setAttribute("data-variant", config.variant);
  section.setAttribute("role", "region");
  section.setAttribute("aria-label", strings.searchResults);
  section.setAttribute("dir", locale === "he" ? "rtl" : "ltr");
  section.hidden = true;

  const bar = document.createElement("div");
  bar.className = "unfiltered-native__bar";
  const newSearch = document.createElement("button");
  newSearch.type = "button";
  newSearch.className = "unfiltered-native__new-search";
  newSearch.setAttribute("data-testid", NATIVE_NEW_SEARCH_TESTID);
  newSearch.textContent = strings.newSearch;
  newSearch.addEventListener("click", () => options.onNewSearch());
  const close = document.createElement("button");
  close.type = "button";
  close.className = "unfiltered-native__close";
  close.setAttribute("data-testid", NATIVE_CLOSE_TESTID);
  close.setAttribute("aria-label", strings.closeSearch);
  close.textContent = "×";
  close.addEventListener("click", () => options.onClose());
  bar.append(newSearch, close);

  const chipsRow = document.createElement("div");
  chipsRow.className = "unfiltered-native__chips";
  chipsRow.setAttribute("data-testid", NATIVE_CHIPS_TESTID);
  chipsRow.setAttribute("role", "list");
  chipsRow.setAttribute("aria-label", strings.appliedFilters);
  chipsRow.hidden = true;

  const status = (testId: string, text: string): HTMLElement => {
    const element = document.createElement("div");
    element.className = "unfiltered-native__status";
    element.setAttribute("data-testid", testId);
    element.textContent = text;
    element.hidden = true;
    return element;
  };
  const loading = status(NATIVE_LOADING_TESTID, strings.loading);
  const noResults = status(NATIVE_NO_RESULTS_TESTID, strings.noResults);
  const zeroHit = status(NATIVE_ZERO_HIT_TESTID, strings.zeroHit);
  const previewEmpty = status(
    "unfiltered-native-preview-empty",
    strings.previewEmpty,
  );

  const list = document.createElement("ul");
  list.className = config.grid.listClass;
  list.setAttribute("role", "list");
  list.setAttribute("data-testid", NATIVE_LIST_TESTID);

  const closeMatches = document.createElement("section");
  closeMatches.className = "unfiltered-native__close-matches";
  closeMatches.setAttribute("data-testid", NATIVE_CLOSE_MATCHES_TESTID);
  closeMatches.hidden = true;
  const closeMatchesHeading = document.createElement("h2");
  closeMatchesHeading.className = "unfiltered-native__close-matches-heading";
  closeMatchesHeading.textContent = strings.closeMatchesHeading;
  const closeMatchesList = document.createElement("ul");
  closeMatchesList.className = config.grid.listClass;
  closeMatchesList.setAttribute("role", "list");
  closeMatches.append(closeMatchesHeading, closeMatchesList);

  section.append(
    bar,
    chipsRow,
    loading,
    noResults,
    zeroHit,
    previewEmpty,
    list,
    closeMatches,
  );

  const fetchMs: number[] = [];
  const produce: CardProducer =
    config.variant === "A"
      ? createAlternateTemplateProducer(config, fetchMs)
      : createHarvestCloneProducer(config, strings, fetchMs, (className) => {
          // The harvested list's classes are the theme's real grid classes;
          // prefer them over the configured default.
          list.className = className;
          closeMatchesList.className = className;
        });

  /** Chrome styles go into the host document once. */
  function ensureStyles(): void {
    if (document.head.querySelector(`style[${NATIVE_STYLE_ATTR}]`) === null) {
      const style = document.createElement("style");
      style.setAttribute(NATIVE_STYLE_ATTR, "");
      style.textContent = styles;
      document.head.appendChild(style);
    }
  }

  /** Mount lazily on first show — prepended into the theme's main content. */
  function ensureMounted(): void {
    if (section.isConnected) {
      return;
    }
    ensureStyles();
    const target =
      document.querySelector(config.mountSelector) ?? document.body;
    target.prepend(section);
  }

  function fallbackCard(result: ProxyResult): HTMLElement {
    const anchor = document.createElement("a");
    anchor.className = "unfiltered-native__fallback";
    anchor.href = `/products/${encodeURIComponent(result.handle)}`;
    if (result.imageUrl !== null) {
      const image = document.createElement("img");
      image.className = "unfiltered-native__fallback-image";
      image.src = result.imageUrl;
      image.alt = result.title;
      image.loading = "lazy";
      anchor.appendChild(image);
    }
    const title = document.createElement("div");
    title.className = "unfiltered-native__fallback-title";
    title.dir = "auto";
    title.textContent = result.title;
    const price = document.createElement("div");
    price.dir = "auto";
    price.textContent = formatPrice(
      result.priceMin,
      result.priceMax,
      result.currencyCode,
    );
    anchor.append(title, price);
    if (!result.available) {
      const soldOut = document.createElement("div");
      soldOut.textContent = strings.soldOut;
      anchor.appendChild(soldOut);
    }
    return anchor;
  }

  /** Build the grid items for a result list; resolves when every card is
   * ready so the grid swaps in one paint. */
  async function buildItems(
    results: ProxyResult[],
    handlers: ResponseHandlers,
  ): Promise<{ items: HTMLLIElement[]; native: number; cached: number }> {
    let native = 0;
    let cached = 0;
    const cards = await Promise.all(
      results.map(async (result) => {
        const produced = await produce(result);
        if (produced !== null) {
          native += 1;
          if (produced.cached) {
            cached += 1;
          }
        }
        return produced;
      }),
    );
    const items = results.map((result, index) => {
      const item = document.createElement("li");
      item.className = config.grid.itemClass;
      item.setAttribute("data-testid", NATIVE_ITEM_TESTID);
      item.setAttribute("data-product-id", result.productId);
      item.setAttribute("data-position", String(index));
      const produced = cards[index];
      if (produced === null) {
        item.setAttribute("data-fallback", "true");
        item.appendChild(fallbackCard(result));
      } else {
        item.appendChild(produced.element);
      }
      if (result.colorUnknown === true) {
        item.classList.add("unfiltered-native__item--color-unknown");
        const note = document.createElement("span");
        note.className = "unfiltered-native__note";
        note.setAttribute("data-testid", "unfiltered-widget-color-note");
        note.textContent = strings.colorNotConfirmed;
        item.appendChild(note);
      }
      // The beacon fires and the theme card's own anchor navigation proceeds
      // untouched — never prevented, never awaited (YOY-48 AC-5).
      item.addEventListener("click", (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("a") !== null
        ) {
          handlers.onCardClick(result, index);
        }
      });
      return item;
    });
    return { items, native, cached };
  }

  function chipElement(
    chip: ProxyChip,
    currency: string | undefined,
    onChipRemove: ResponseHandlers["onChipRemove"],
  ): HTMLElement {
    const label = chipLabel(chip, { locale, currency });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "unfiltered-native__chip";
    button.setAttribute("data-testid", NATIVE_CHIP_TESTID);
    button.setAttribute("data-chip-field", chip.field);
    button.setAttribute("data-chip-value", chip.value);
    button.setAttribute("role", "listitem");
    button.setAttribute(
      "aria-label",
      strings.removeFilter.replace("{label}", label),
    );
    const text = document.createElement("span");
    text.textContent = label;
    const remove = document.createElement("span");
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "×";
    button.append(text, remove);
    button.addEventListener("click", () => onChipRemove(chip));
    return button;
  }

  // Async renders race: a newer response, an idle, or a close must win over
  // cards still being fetched for an older one.
  let renderToken = 0;

  function clearAll(): void {
    renderToken += 1;
    loading.hidden = true;
    noResults.hidden = true;
    zeroHit.hidden = true;
    previewEmpty.hidden = true;
    chipsRow.hidden = true;
    chipsRow.replaceChildren();
    list.replaceChildren();
    closeMatches.hidden = true;
    closeMatchesList.replaceChildren();
  }

  async function render(
    response: ProxySearchResponse,
    handlers: ResponseHandlers,
    preview: boolean,
  ): Promise<void> {
    ensureMounted();
    section.hidden = false;
    const token = ++renderToken;
    const started = performance.now();
    const fetchesBefore = fetchMs.length;
    // Cards are fetched/cloned before the grid swaps: the loading state
    // stays up meanwhile so the panel never shows an empty grid mid-render.
    loading.hidden = false;
    noResults.hidden = true;
    zeroHit.hidden = true;
    previewEmpty.hidden = true;

    const chips = !preview && response.route === "ai" ? response.chips : [];
    const currency =
      response.intent !== null &&
      typeof response.intent["currency"] === "string"
        ? response.intent["currency"]
        : undefined;
    const empty = response.results.length === 0;
    const aiZeroHit = !preview && empty && response.route === "ai";
    const matches = aiZeroHit ? (response.closeMatches ?? []) : [];

    const [built, builtMatches] = await Promise.all([
      buildItems(response.results, handlers),
      buildItems(matches, handlers),
    ]);
    if (token !== renderToken) {
      return; // Superseded while fetching.
    }

    loading.hidden = true;
    chipsRow.replaceChildren(
      ...chips.map((chip) => chipElement(chip, currency, handlers.onChipRemove)),
    );
    chipsRow.hidden = chips.length === 0;
    list.replaceChildren(...built.items);
    closeMatchesList.replaceChildren(...builtMatches.items);
    closeMatches.hidden = builtMatches.items.length === 0;
    zeroHit.hidden = !aiZeroHit;
    noResults.hidden = !(!preview && empty && response.route === "classic");
    previewEmpty.hidden = !(preview && empty);

    const total = built.items.length + builtMatches.items.length;
    const nativeCount = built.native + builtMatches.native;
    section.setAttribute("data-native-count", String(nativeCount));
    section.setAttribute("data-fallback-count", String(total - nativeCount));
    window.__unfilteredNativeTiming = {
      variant: config.variant,
      totalMs: Math.round(performance.now() - started),
      native: nativeCount,
      fallback: total - nativeCount,
      cached: built.cached + builtMatches.cached,
      fetchMs: fetchMs.slice(fetchesBefore),
    };
  }

  return {
    host: section,
    open() {
      ensureMounted();
      section.hidden = false;
    },
    close() {
      renderToken += 1;
      section.hidden = true;
    },
    isOpen() {
      return !section.hidden;
    },
    showLoading() {
      ensureMounted();
      section.hidden = false;
      renderToken += 1;
      loading.hidden = false;
      noResults.hidden = true;
      zeroHit.hidden = true;
      previewEmpty.hidden = true;
    },
    showIdle() {
      clearAll();
    },
    showFailure() {
      clearAll();
      noResults.hidden = false;
    },
    showResponse(response, handlers) {
      void render(response, handlers, false);
    },
    showPreview(response, handlers) {
      void render(response, handlers, true);
    },
    destroy() {
      renderToken += 1;
      section.remove();
    },
  };
}

/**
 * The composite the widget runs when native rendering is on: keystroke
 * previews stay on the existing shadow overlay (NG-3 — the preview tier is
 * untouched), submitted responses render natively, and the two never show
 * together. main.ts drives this exactly as it drives the plain overlay.
 */
export function createNativeComposite(overlay: Overlay, native: Overlay): Overlay {
  return {
    host: overlay.host,
    open() {
      overlay.open();
    },
    close() {
      overlay.close();
      native.close();
    },
    isOpen() {
      return overlay.isOpen() || native.isOpen();
    },
    showLoading() {
      if (native.isOpen()) {
        native.showLoading();
      } else {
        overlay.showLoading();
      }
    },
    showIdle() {
      overlay.showIdle();
      native.showIdle();
    },
    showFailure() {
      if (native.isOpen()) {
        native.showFailure();
      } else {
        overlay.showFailure();
      }
    },
    showResponse(response, handlers) {
      overlay.close();
      native.showResponse(response, handlers);
    },
    showPreview(response, handlers) {
      native.close();
      overlay.showPreview(response, handlers);
    },
    destroy() {
      overlay.destroy();
      native.destroy();
    },
  };
}
