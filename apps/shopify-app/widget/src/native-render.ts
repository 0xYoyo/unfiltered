import { chipLabelParts, formatPrice, isNegationChip } from "./format";
import {
  labelLocale,
  labelOverflows,
  labelSegments,
  renderLabel,
  underCloseHeading,
} from "./labels";
import {
  type NativeRenderConfig,
  type NativeRenderOverrides,
  resolveNativeRenderConfig,
} from "./native-render.config";
import styles from "./native-render.css?inline";
import {
  createPageMirror,
  ensureStylesheet,
  parseHtml,
  sanitizeThemeMarkup,
} from "./native-page";
import {
  inlineCloseMatches,
  LABEL_TESTID,
  type Overlay,
  type ResponseHandlers,
} from "./overlay";
import type {
  ProxyChip,
  ProxyLabel,
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
 *   from the product's own server-resolved `url` with `?view=<view>` — an
 *   alternate product template
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
 * them unchanged; the composite below routes submitted responses and their
 * loading state to the native view and leaves keystroke previews to the
 * theme's own predictive search (YOY-101). Everything is off unless a caller opts in
 * (`WidgetConfig.nativeRender`) or the dev flag is set (NG-1).
 *
 * The native view is a full-page mirror (YOY-100, native-page.ts): the
 * results section is not prepended over the origin page but placed inside
 * the theme's own search-results page, whose furniture (heading, count
 * line, containers) is fetched from the theme and rewritten to our count
 * and the shopper's query, with the origin page's content hidden and the
 * URL moved to the theme's search URL — Back returns to the origin page.
 */

export const NATIVE_TESTID = "unfiltered-native-results";
export const NATIVE_LIST_TESTID = "unfiltered-native-list";
export const NATIVE_ITEM_TESTID = "unfiltered-native-item";
export const NATIVE_CHIP_TESTID = "unfiltered-native-chip";
export const NATIVE_CHIPS_TESTID = "unfiltered-native-chips";
export const NATIVE_OTHER_READING_TESTID = "unfiltered-native-other-reading";
export const NATIVE_LOADING_TESTID = "unfiltered-native-loading";
export const NATIVE_NO_RESULTS_TESTID = "unfiltered-native-no-results";
export const NATIVE_ZERO_HIT_TESTID = "unfiltered-native-zero-hit";
/** The "Close matches" divider inside a judged page's grid (YOY-166 AC-2). */
export const NATIVE_CLOSE_MATCHES_DIVIDER_TESTID =
  "unfiltered-native-close-matches-divider";
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
  /** Variant A: cards served from the per-URL cache. */
  cached: number;
  /** Individual network fetch durations this render performed. */
  fetchMs: number[];
  /** 1-based page rendered (YOY-107). */
  page: number;
  /** Pages the full match set spans at the theme's page size. */
  pageCount: number;
  /** Size of the full match set, whatever this page shows. */
  total: number;
}

declare global {
  interface Window {
    __unfilteredNativeTiming?: NativeRenderTiming;
  }
}

export interface NativeSurfaceOptions {
  locale: string;
  config: NativeRenderConfig;
  /** The query of the response being shown — the results view's URL and
   * the theme's count line carry it (YOY-100 AC-2/AC-4). */
  query: () => string;
  /** The shopper navigated out of the results view (Back / Forward past
   * it): cancel whatever this view was still searching for. */
  onLeave: () => void;
}

/** A theme card produced for one result, or null when the mechanism could
 * not produce one (template missing, harvest failed) — the fallback renders. */
type CardProducer = (
  result: ProxyResult,
) => Promise<{ element: HTMLElement; cached: boolean } | null>;

/**
 * Variant A producer: fetch the alternate template per product with a small
 * concurrency window; cache the parsed card per product URL for the page
 * view so refinement re-renders reuse it (AC-4c: first-fetch caching). The
 * template address is the product's server-resolved `url` (YOY-87 AC-4)
 * with the `view` parameter added, fetched by same-origin path so a
 * primary-domain URL still resolves on the domain the shopper is browsing;
 * the widget composes no product path itself. A card without a URL has no
 * template to fetch and falls back.
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

  const load = async (productUrl: string): Promise<HTMLElement | null> => {
    await acquire();
    const started = performance.now();
    try {
      const url = new URL(productUrl, window.location.href);
      url.searchParams.set("view", config.template.view);
      const response = await fetch(url.pathname + url.search, {
        credentials: "same-origin",
      });
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
      if (!(card instanceof HTMLElement)) {
        return null;
      }
      // The card is injected into the host's light DOM: strip the inline
      // handlers and javascript: URLs that would go live with it (AC-1).
      sanitizeThemeMarkup(card);
      return card;
    } catch {
      return null;
    } finally {
      fetchMs.push(Math.round(performance.now() - started));
      release();
    }
  };

  return async (result) => {
    if (result.url === null) {
      return null;
    }
    const cached = cache.has(result.url);
    if (!cached) {
      cache.set(result.url, load(result.url));
    }
    const template = await cache.get(result.url)!;
    if (template === null) {
      cache.delete(result.url); // Let a later render retry.
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
      // Every clone of this template lands in the host's light DOM (AC-1).
      sanitizeThemeMarkup(card);
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
    // The link is the server-resolved `url`, verbatim (YOY-87 AC-4); a card
    // without one keeps the theme's anchors but strips their targets.
    card
      .querySelectorAll<HTMLAnchorElement>(selectors.link)
      .forEach((anchor) => {
        if (result.url === null) {
          anchor.removeAttribute("href");
        } else {
          anchor.setAttribute("href", result.url);
        }
      });
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
  // A storefront language with no templates shows no label (YOY-151 AC-7).
  const labelsShown = labelLocale(options.locale) !== null;

  const section = document.createElement("section");
  section.className = `unfiltered-native ${config.sectionClass}`.trim();
  section.setAttribute("data-testid", NATIVE_TESTID);
  section.setAttribute("data-variant", config.variant);
  section.setAttribute("role", "region");
  section.setAttribute("aria-label", strings.searchResults);
  section.setAttribute("dir", locale === "he" ? "rtl" : "ltr");

  // No owned buttons above the results (YOY-82 AC-1, Mirror Bar): closing
  // the view rides browser Back / navigating away (and Escape), a new
  // search rides the theme's own search input. The only owned elements are
  // the filter chips with their remove control, and status text.
  const chipsRow = document.createElement("div");
  chipsRow.className = "unfiltered-native__chips";
  chipsRow.setAttribute("data-testid", NATIVE_CHIPS_TESTID);
  chipsRow.setAttribute("role", "list");
  chipsRow.setAttribute("aria-label", strings.appliedFilters);
  chipsRow.hidden = true;
  // Chip geometry derived from the host (YOY-82 AC-2): the theme's own
  // button radius and border width, read through the configured custom
  // properties; the stylesheet's neutral values apply when the host exposes
  // neither. Font and color are inherited outright.
  chipsRow.style.setProperty(
    "--unfiltered-chip-radius",
    `var(${config.chip.radiusVar}, 999px)`,
  );
  chipsRow.style.setProperty(
    "--unfiltered-chip-border-width",
    `var(${config.chip.borderWidthVar}, 1px)`,
  );

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

  section.append(
    chipsRow,
    loading,
    noResults,
    zeroHit,
    previewEmpty,
    list,
  );

  // The full-page mirror (YOY-100): the theme's search-results page around
  // this section. Its results list hands the section its place and its
  // classes — the theme's real search grid, which beats both the configured
  // default and (Variant B) the harvest page's list, whose density can
  // differ from the search page's.
  let gridFromShell = false;
  const mirror = createPageMirror({
    config,
    section,
    onListClass(className) {
      gridFromShell = true;
      list.className = className;
    },
    onLeave: options.onLeave,
  });
  /** The query the view currently shows (URL, count line, template input). */
  let currentQuery = "";
  /**
   * The search the view is showing (YOY-146): its first response (chips,
   * route and reading come from it), the size of the whole
   * result order, and every page fetched for it so far. The server serves
   * one page per request; a page already fetched in this search is shown
   * again without a request (AC-3), and card fetches happen only for the
   * page on screen (YOY-107 AC-4). Null until a response has been rendered.
   */
  interface HeldSearch {
    response: ProxySearchResponse;
    handlers: ResponseHandlers;
    preview: boolean;
    total: number;
    pageSize: number;
    pages: Map<number, Promise<HeldPage>>;
    /** Pages whose response had `labelsPending` (YOY-151 AC-8). */
    pendingLabels: Set<number>;
    /** Each pending page's labels, asked for once and held. */
    labelFetches: Map<number, Promise<Record<string, ProxyLabel | null>>>;
  }
  /**
   * One page's cards: its results, and the close products that sit under
   * the page's "Close matches" divider inside its grid (YOY-166).
   */
  interface HeldPage {
    results: ProxyResult[];
    closeMatches: ProxyResult[];
  }
  let current: HeldSearch | null = null;
  /** The 1-based page of that set currently on screen. */
  let currentPage = 1;
  /** Watches the last row of cards (YOY-146 AC-4); one per rendered page. */
  let lastRowObserver: IntersectionObserver | null = null;
  const stopWatching = (): void => {
    lastRowObserver?.disconnect();
    lastRowObserver = null;
  };

  /**
   * One page of the held search: from memory when it was fetched before
   * (AC-3), else requested once and held. A failed request is forgotten, so
   * selecting the page later asks again.
   */
  function fetchPage(held: HeldSearch, page: number): Promise<HeldPage> {
    const known = held.pages.get(page);
    if (known !== undefined) {
      return known;
    }
    const loader = held.handlers.pages;
    if (loader === undefined) {
      return Promise.resolve({ results: [], closeMatches: [] });
    }
    const pending = loader.load(page).then((next) => {
      if (next.labelsPending === true) {
        held.pendingLabels.add(page);
      }
      return {
        results: next.results,
        closeMatches: inlineCloseMatches(next).map(underCloseHeading),
      };
    });
    held.pages.set(page, pending);
    pending.catch(() => {
      if (held.pages.get(page) === pending) {
        held.pages.delete(page);
      }
    });
    return pending;
  }

  /**
   * When the last row of cards enters the viewport (YOY-146 AC-4): with the
   * theme's pagination, the next page is requested once and held, so
   * selecting it shows it without waiting; with none to mirror, the next
   * page's cards are appended below, page after page up to `totalCount` —
   * the whole set stays reachable with no control of ours (AC-11).
   */
  function watchLastRow(
    held: HeldSearch,
    token: number,
    page: number,
    pageCount: number,
    append: boolean,
  ): void {
    stopWatching();
    const last = list.lastElementChild;
    if (
      page >= pageCount ||
      last === null ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    lastRowObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      stopWatching();
      const next = page + 1;
      if (!append) {
        fetchPage(held, next).catch(() => {
          // A failed prefetch is retried when the page is selected.
        });
        return;
      }
      fetchPage(held, next)
        .then((pageData) =>
          buildPage(
            pageData,
            held.handlers,
            (next - 1) * held.pageSize,
            labellingFor(held, next),
          ),
        )
        .then(
          (built) => {
            if (token !== renderToken || current !== held) {
              return;
            }
            list.append(...built.elements);
            settleLabels(built.items);
            fillLateLabels(held, next, built.items, token);
            if (built.items.length > 0) {
              watchLastRow(held, token, next, pageCount, true);
            }
          },
          () => {
            // The shown cards stay; no error reaches the shopper.
          },
        );
    });
    lastRowObserver.observe(last);
  }

  const fetchMs: number[] = [];
  const produce: CardProducer =
    config.variant === "A"
      ? createAlternateTemplateProducer(config, fetchMs)
      : createHarvestCloneProducer(config, strings, fetchMs, (className) => {
          // The harvested list's classes are the theme's real grid classes;
          // prefer them over the configured default (never over the shell's).
          if (!gridFromShell) {
            list.className = className;
          }
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

  /**
   * Show the results view for the current query: the mirror hides the
   * origin page's content and places this section inside the theme's own
   * search page (or bare, until the shell arrives / when it never does),
   * recording the history entry on first entry.
   */
  function ensureMounted(): void {
    ensureStyles();
    currentQuery = options.query();
    mirror.enter(currentQuery);
  }

  /** Leave the results view: origin content back, and the history entry
   * the mirror pushed popped so the URL returns to the origin page. */
  function leaveView(): void {
    mirror.exit();
  }

  function fallbackCard(result: ProxyResult): HTMLElement {
    // Server-resolved `url` verbatim, or a linkless block (YOY-87 AC-4).
    const anchor =
      result.url === null
        ? document.createElement("div")
        : document.createElement("a");
    anchor.className = "unfiltered-native__fallback";
    if (anchor instanceof HTMLAnchorElement && result.url !== null) {
      anchor.href = result.url;
    }
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

  /**
   * How a page of the held search carries labels (YOY-151): none on a
   * keystroke preview (NG-2), a reserved line on every card while its
   * labels are pending (AC-8).
   */
  function labellingFor(
    held: HeldSearch,
    page: number,
  ): { pending: boolean } | null {
    if (held.preview) {
      return null;
    }
    return {
      pending:
        labelsShown &&
        held.pendingLabels.has(page) &&
        held.handlers.labels !== undefined,
    };
  }

  /**
   * Drop every shown label wider than its card (YOY-151 AC-6): absent,
   * never truncated or wrapped. A reserved line keeps its height empty.
   */
  function settleLabels(items: readonly HTMLElement[]): void {
    for (const item of items) {
      const label = item.querySelector<HTMLElement>(
        ".unfiltered-native__label",
      );
      if (label === null || label.textContent === "" || !labelOverflows(label)) {
        continue;
      }
      if (label.hasAttribute("data-label-slot")) {
        label.textContent = "";
        label.removeAttribute("data-testid");
      } else {
        label.remove();
      }
    }
  }

  /**
   * A pending page's late labels (YOY-151 AC-8, AC-9): asked for once per
   * page and held, then filled into the lines its cards reserved — no card
   * moves and nothing re-orders. A failed request leaves the lines empty.
   */
  function fillLateLabels(
    held: HeldSearch,
    page: number,
    items: readonly HTMLElement[],
    token: number,
  ): void {
    const loader = held.handlers.labels;
    if (loader === undefined || labellingFor(held, page)?.pending !== true) {
      return;
    }
    let request = held.labelFetches.get(page);
    if (request === undefined) {
      request = loader(page);
      held.labelFetches.set(page, request);
    }
    request.then(
      (labels) => {
        if (token !== renderToken || current !== held) {
          return;
        }
        for (const item of items) {
          const productId = item.getAttribute("data-product-id") ?? "";
          const slot = item.querySelector<HTMLElement>(
            "[data-label-slot]",
          );
          if (slot === null || !(productId in labels)) {
            continue;
          }
          const segments = labelSegments(strings, labels[productId], options.locale);
          renderLabel(slot, segments ?? []);
          if (segments === null) {
            slot.removeAttribute("data-testid");
          } else {
            slot.setAttribute("data-testid", LABEL_TESTID);
          }
        }
        settleLabels(items);
      },
      () => {
        // The reserved lines stay empty; no error reaches the shopper.
      },
    );
  }

  /**
   * Where a card's label line goes (YOY-164 AC-1): the configured block
   * that holds the card's price, else the last such block, else the card's
   * last element — always inside the card, never after it on the grid item.
   */
  function labelHost(card: Element): Element {
    const { label: blockSelector, price } = config.harvest.fill;
    const priced = card.querySelector(price)?.closest(blockSelector);
    if (priced !== null && priced !== undefined && card.contains(priced)) {
      return priced;
    }
    const blocks = card.querySelectorAll(blockSelector);
    return blocks[blocks.length - 1] ?? card.lastElementChild ?? card;
  }

  /**
   * One page's grid content (YOY-166 AC-2, AC-3): its results, then — when
   * it carries close products — the "Close matches" divider and those
   * products, inside the page's grid. The divider is a full-row list item,
   * so the theme's own pagination and the appended pages each show it under
   * their own results. `items` are the cards alone, in order.
   */
  async function buildPage(
    pageData: HeldPage,
    handlers: ResponseHandlers,
    offset: number,
    labelling: { pending: boolean } | null,
  ): Promise<{
    elements: HTMLLIElement[];
    items: HTMLLIElement[];
    native: number;
    cached: number;
  }> {
    const [matched, close] = await Promise.all([
      buildItems(pageData.results, handlers, offset, labelling),
      buildItems(
        pageData.closeMatches,
        handlers,
        offset + pageData.results.length,
        labelling,
      ),
    ]);
    const items = [...matched.items, ...close.items];
    const totals = {
      items,
      native: matched.native + close.native,
      cached: matched.cached + close.cached,
    };
    if (close.items.length === 0) {
      return { elements: items, ...totals };
    }
    const divider = document.createElement("li");
    divider.className = "unfiltered-native__close-matches-divider";
    divider.setAttribute("data-testid", NATIVE_CLOSE_MATCHES_DIVIDER_TESTID);
    const heading = document.createElement("h2");
    heading.className = "unfiltered-native__close-matches-heading";
    heading.textContent = strings.closeMatchesHeading;
    divider.append(heading);
    return { elements: [...matched.items, divider, ...close.items], ...totals };
  }

  /** Build the grid items for a result list; resolves when every card is
   * ready so the grid swaps in one paint. */
  async function buildItems(
    results: ProxyResult[],
    handlers: ResponseHandlers,
    /** The first card's place in the whole result order (YOY-146 AC-10). */
    offset = 0,
    /** The label line (YOY-151); null on a preview. */
    labelling: { pending: boolean } | null = null,
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
      item.setAttribute("data-position", String(offset + index));
      const produced = cards[index];
      if (produced === null) {
        item.setAttribute("data-fallback", "true");
        item.appendChild(fallbackCard(result));
      } else {
        item.appendChild(produced.element);
      }
      // The label line (YOY-151 AC-5, W-11): the only element this adds to a
      // theme card, styled as the overlay's (one quiet line, inherited
      // colour, no hue) — inside the card's own information block after the
      // price, so the theme's card grows to hold it (YOY-164 AC-1).
      if (labelling !== null && labelsShown) {
        const segments = labelSegments(strings, result.label, options.locale);
        if (segments !== null || labelling.pending) {
          const label = document.createElement("div");
          label.className = "unfiltered-native__label";
          if (labelling.pending) {
            label.setAttribute("data-label-slot", "");
          }
          if (segments !== null) {
            label.setAttribute("data-testid", LABEL_TESTID);
            renderLabel(label, segments);
          }
          labelHost(item.firstElementChild ?? item).appendChild(label);
        }
      }
      // The beacon fires and the theme card's own anchor navigation proceeds
      // untouched — never prevented, never awaited (YOY-48 AC-5).
      item.addEventListener("click", (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("a") !== null
        ) {
          handlers.onCardClick(result, offset + index);
        }
      });
      return item;
    });
    return { items, native, cached };
  }

  function chipElement(
    chip: ProxyChip,
    onChipRemove: ResponseHandlers["onChipRemove"],
  ): HTMLElement {
    const { negator, value } = chipLabelParts(chip, { locale });
    const label = negator === null ? value : `${negator} ${value}`;
    const negated = isNegationChip(chip);
    const button = document.createElement("button");
    button.type = "button";
    button.className = negated
      ? "unfiltered-native__chip unfiltered-native__chip--negated"
      : "unfiltered-native__chip";
    button.setAttribute("data-testid", NATIVE_CHIP_TESTID);
    button.setAttribute("data-chip-field", chip.field);
    // The field under its short name too (YOY-149 verify steps).
    button.setAttribute("data-field", chip.field);
    button.setAttribute("data-chip-value", chip.value);
    if (negated) {
      button.setAttribute("data-chip-negated", "true");
    }
    button.setAttribute("role", "listitem");
    button.setAttribute(
      "aria-label",
      strings.removeFilter.replace("{label}", label),
    );
    // An exclusion strikes the excluded VALUE and leaves the negator
    // upright. Achromatic by construction (W-3): the strike and the
    // heavier border are drawn in the theme's own currentColor.
    const text = document.createElement("span");
    if (negator === null) {
      text.textContent = value;
    } else {
      const word = document.createElement("span");
      word.className = "unfiltered-native__chip-negator";
      word.textContent = `${negator} `;
      const struck = document.createElement("s");
      struck.className = "unfiltered-native__chip-value";
      struck.textContent = value;
      text.append(word, struck);
    }
    const remove = document.createElement("span");
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "×";
    button.append(text, remove);
    button.addEventListener("click", () => onChipRemove(chip));
    return button;
  }

  /**
   * The second-reading chip (YOY-150 AC-8): the native chip anatomy with no
   * remove glyph, reading "{reading} instead?"; tapping it is a new search
   * (AC-9). No owned control besides (NG-2): it lives in the chip row.
   */
  function readingElement(
    reading: string,
    onPickReading: (reading: string) => void,
  ): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "unfiltered-native__chip unfiltered-native__chip--reading";
    button.setAttribute("data-testid", NATIVE_OTHER_READING_TESTID);
    button.setAttribute("role", "listitem");
    // The reading is the shopper's phrase in any script: isolated in a
    // <bdi>, so a Latin reading in Hebrew chrome keeps its "?" in place.
    const [before = "", after = ""] = strings.otherReading.split("{reading}");
    const phrase = document.createElement("bdi");
    phrase.textContent = reading;
    // One flex item, so the chip's gap never splits the sentence.
    const text = document.createElement("span");
    text.append(before, phrase, after);
    button.append(text);
    button.addEventListener("click", () => onPickReading(reading));
    return button;
  }

  // Async renders race: a newer response, an idle, or a close must win over
  // cards still being fetched for an older one.
  let renderToken = 0;

  function clearAll(): void {
    renderToken += 1;
    stopWatching();
    current = null;
    currentPage = 1;
    mirror.setResult(currentQuery, null);
    mirror.setPages({ pageCount: 1, current: 1, onSelect: () => {} });
    loading.hidden = true;
    noResults.hidden = true;
    zeroHit.hidden = true;
    previewEmpty.hidden = true;
    chipsRow.hidden = true;
    chipsRow.replaceChildren();
    list.replaceChildren();
  }

  /**
   * Render one page of the held search. The count line always states the
   * TRUE total (YOY-107 AC-1/AC-2, now `totalCount`, YOY-146 AC-2) — the
   * page is a window on it, never the number of matches — and the theme's
   * page links number 1 to ceil(totalCount / pageSize). A page not yet in
   * hand is requested from the server; one fetched before is shown again
   * without a request (AC-3). Only this page's cards are fetched or cloned
   * (YOY-107 AC-4). A judged page's close products sit under its own
   * divider inside its grid (YOY-166 AC-3).
   */
  async function renderPage(page: number): Promise<void> {
    if (current === null) {
      return;
    }
    const held = current;
    const { response, handlers, preview, total, pageSize } = held;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const target = Math.min(Math.max(1, Math.trunc(page)), pageCount);
    const moved = target !== currentPage;

    ensureStyles();
    currentQuery = options.query();
    const query = currentQuery;
    const token = ++renderToken;
    stopWatching();
    const started = performance.now();
    const fetchesBefore = fetchMs.length;
    // Cards are fetched/cloned before the grid swaps: the loading state
    // stays up meanwhile so the panel never shows an empty grid mid-render.
    loading.hidden = false;
    noResults.hidden = true;
    zeroHit.hidden = true;
    previewEmpty.hidden = true;

    // A response carries chips on whichever route its judge took
    // (YOY-149); it sends none it did not apply.
    const chips = !preview ? response.chips : [];
    const empty = total === 0;

    // The page's results and the shell (first render only — cached
    // afterwards) are awaited together, then the cards, so the theme's page
    // and our grid appear in one paint.
    let pageData: HeldPage;
    try {
      [pageData] = await Promise.all([
        fetchPage(held, target),
        mirror.ready(),
      ]);
    } catch {
      // A failed page request (YOY-146 AC-9's rule, on this path too): the
      // page on screen stays as it is, and no error reaches the shopper.
      if (token === renderToken) {
        loading.hidden = true;
      }
      return;
    }
    if (token !== renderToken) {
      return; // Superseded while fetching.
    }
    const built = await buildPage(
      pageData,
      handlers,
      (target - 1) * pageSize,
      labellingFor(held, target),
    );
    if (token !== renderToken) {
      return; // Superseded while fetching.
    }

    // With no theme pagination to mirror, a second page would be
    // unreachable through a control — so the next pages append as the
    // shopper scrolls instead (no control of ours, AC-11). Known only once
    // the shell has settled, which this render already waited for.
    const paged = mirror.canPage();
    const shownPageCount = paged ? pageCount : 1;
    currentPage = target;
    mirror.enter(query, paged ? target : 1);

    loading.hidden = true;
    // The theme's own count line now states OUR count for the shopper's
    // query (AC-2).
    mirror.setResult(query, total);
    // The theme's own pagination, over our set (YOY-107 AC-1/NG-3).
    mirror.setPages({
      pageCount: shownPageCount,
      current: target,
      onSelect: (next) => {
        void renderPage(next);
      },
    });
    if (moved) {
      // A page change is a navigation on the theme's own results page, and
      // its own pagination lands the shopper at the top of the new page.
      window.scrollTo(0, 0);
    }
    const reading =
      response.otherReading !== undefined && handlers.onPickReading !== undefined
        ? readingElement(response.otherReading, handlers.onPickReading)
        : null;
    chipsRow.replaceChildren(
      ...(reading === null ? [] : [reading]),
      ...chips.map((chip) => chipElement(chip, handlers.onChipRemove)),
    );
    chipsRow.hidden = chips.length === 0 && reading === null;
    list.replaceChildren(...built.elements);
    settleLabels(built.items);
    fillLateLabels(held, target, built.items, token);
    zeroHit.hidden = !(!preview && empty && response.route === "ai");
    noResults.hidden = !(!preview && empty && response.route === "classic");
    previewEmpty.hidden = !(preview && empty);
    watchLastRow(held, token, target, pageCount, !paged);

    // Per-PAGE render diagnostics (AC-4): the cards this page cost, not the
    // whole set's.
    const rendered = built.items.length;
    const nativeCount = built.native;
    section.setAttribute("data-native-count", String(nativeCount));
    section.setAttribute("data-fallback-count", String(rendered - nativeCount));
    section.setAttribute("data-total-count", String(total));
    section.setAttribute("data-page", String(target));
    section.setAttribute("data-page-count", String(shownPageCount));
    window.__unfilteredNativeTiming = {
      variant: config.variant,
      totalMs: Math.round(performance.now() - started),
      native: nativeCount,
      fallback: rendered - nativeCount,
      cached: built.cached,
      fetchMs: fetchMs.slice(fetchesBefore),
      page: target,
      pageCount: shownPageCount,
      total,
    };
  }

  /**
   * Show a response: hold its page and the size of the whole order, then
   * render it. A submitted response is the page the search asked for — page
   * 1, or the page a resumed results URL names (YOY-146 AC-5); a refinement
   * recomputes the set, so it starts over (YOY-107 AC-3). A response with no
   * `totalCount` (a keystroke preview, or a server predating pages) is the
   * whole set, paged here.
   */
  function render(
    response: ProxySearchResponse,
    handlers: ResponseHandlers,
    preview: boolean,
  ): void {
    ensureMounted();
    const pageSize = handlers.pages?.pageSize ?? config.page.pageSize;
    const pages = new Map<number, Promise<HeldPage>>();
    let first = response.page ?? 1;
    const total = response.totalCount ?? response.results.length;
    if (response.totalCount === undefined) {
      first = 1;
      const count = Math.max(1, Math.ceil(response.results.length / pageSize));
      for (let page = 1; page <= count; page += 1) {
        pages.set(
          page,
          Promise.resolve({
            results: response.results.slice((page - 1) * pageSize, page * pageSize),
            closeMatches: [],
          }),
        );
      }
    } else {
      pages.set(
        first,
        Promise.resolve({
          results: response.results,
          closeMatches: preview ? [] : inlineCloseMatches(response).map(underCloseHeading),
        }),
      );
    }
    const pendingLabels = new Set<number>(
      response.labelsPending === true ? [first] : [],
    );
    current = {
      response,
      handlers,
      preview,
      total,
      pageSize,
      pages,
      pendingLabels,
      labelFetches: new Map(),
    };
    currentPage = 1;
    void renderPage(first);
  }

  return {
    host: section,
    open() {
      ensureMounted();
    },
    close() {
      renderToken += 1;
      stopWatching();
      leaveView();
    },
    isOpen() {
      return mirror.isEntered();
    },
    showLoading() {
      if (!mirror.isEntered()) {
        ensureMounted();
      }
      renderToken += 1;
      stopWatching();
      if (mirror.isEntered()) {
        // A submitted query on an already-entered view (YOY-96 AC-5): the
        // count line must never state the previous query while this one
        // loads, and the template's input shows the new query now. No
        // `enter`, no URL change — the URL moves once, in showResponse.
        // (Previews never reach here while entered: main.ts skips
        // showLoading for a preview over an open view.)
        currentQuery = options.query();
        mirror.setResult(currentQuery, null);
      }
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
      render(response, handlers, false);
    },
    showPreview(response, handlers) {
      render(response, handlers, true);
    },
    destroy() {
      renderToken += 1;
      stopWatching();
      leaveView();
      mirror.destroy();
      section.remove();
    },
  };
}

/**
 * The composite the widget runs when native rendering is on: submitted
 * responses AND the loading state that precedes them render natively — the
 * theme's own results page is the only surface a search ever shows (YOY-106
 * AC-1/AC-2, the Mirror Bar). The shadow overlay stays for the one state
 * YOY-106 leaves where it was: a search that fails before any native
 * results existed (NG-2). Keystroke previews are the THEME's on this path
 * (YOY-101): typing rides the theme's own predictive search and main.ts
 * never asks for a preview, so `showPreview` renders nothing — the owned
 * preview box is the overlay path's fallback surface only (YOY-101 AC-4).
 * The native view is a page (YOY-100): it stays until the shopper leaves it
 * (Back, Escape, close) or submits again. main.ts drives this exactly as it
 * drives the plain overlay.
 */
export function createNativeComposite(overlay: Overlay, native: Overlay): Overlay {
  /**
   * Whether the native view holds a rendered response, as opposed to
   * having just been entered for a loading state. Since the loading state
   * is the native surface's from the first search (YOY-106 AC-1),
   * `native.isOpen()` alone no longer separates "the shopper is looking at
   * native results" from "we entered to show loading" — and failure
   * routing must keep its pre-YOY-106 behavior (YOY-106 NG-2).
   */
  let nativeShowingResults = false;
  return {
    host: overlay.host,
    open() {
      overlay.open();
    },
    close() {
      nativeShowingResults = false;
      overlay.close();
      native.close();
    },
    isOpen() {
      return overlay.isOpen() || native.isOpen();
    },
    showLoading() {
      // Mirror Bar (YOY-106 AC-1): the loading state renders in the theme's
      // own results region from the very first search — never in the owned
      // overlay panel, which on this path never becomes visible at all.
      if (!native.isOpen()) {
        // Entering fresh for this search: no results are on screen yet.
        nativeShowingResults = false;
      }
      native.showLoading();
    },
    showIdle() {
      overlay.showIdle();
      native.showIdle();
    },
    showFailure() {
      // Unchanged from before YOY-106 (NG-2): a failure resolves inside the
      // native view only when that view already held results; a search that
      // fails before any native results existed withdraws the view it had
      // entered for loading and resolves quietly on the overlay, exactly as
      // it did when loading itself lived there.
      if (native.isOpen() && nativeShowingResults) {
        native.showFailure();
      } else {
        native.close();
        // `overlay.showFailure` assumes the panel is already open — the
        // overlay's own loading state used to open it. It no longer runs on
        // this path (AC-1), so the composite opens the panel itself and the
        // shopper sees exactly the quiet no-results panel they saw before.
        overlay.open();
        overlay.showFailure();
      }
    },
    showResponse(response, handlers) {
      overlay.close();
      nativeShowingResults = true;
      native.showResponse(response, handlers);
    },
    showPreview() {
      // Previews are the theme's on the native path (YOY-101 AC-1): the
      // owned preview box never appears here.
    },
    destroy() {
      nativeShowingResults = false;
      overlay.destroy();
      native.destroy();
    },
  };
}
