import { chipLabelParts, formatPrice, isNegationChip } from "./format";
import { cardImageLoading, cardImageSources } from "./image-url";
import {
  labelLocale,
  labelOverflows,
  labelSegments,
  renderLabel,
  underCloseHeading,
} from "./labels";
import type {
  ProxyChip,
  ProxyLabel,
  ProxyResult,
  ProxySearchResponse,
} from "./search-client";
import { getStrings, resolveLocale } from "./strings";
import styles from "./widget.css?inline";

/**
 * The results overlay (YOY-48, extended by YOY-49 with chips, the AI
 * zero-hit state, and a new-search control): all
 * widget-rendered DOM lives inside an open shadow root on the host element,
 * so theme CSS cannot break the overlay's layout and widget CSS cannot leak
 * onto host elements (AC-7). Inheritable properties (font-family, color)
 * still cross the shadow boundary, so the overlay inherits the theme's
 * typography.
 */

export const ROOT_TESTID = "unfiltered-widget-root";
export const OVERLAY_TESTID = "unfiltered-widget-overlay";
export const RESULTS_TESTID = "unfiltered-widget-results";
export const CARD_TESTID = "unfiltered-widget-card";
export const LOADING_TESTID = "unfiltered-widget-loading";
export const NO_RESULTS_TESTID = "unfiltered-widget-no-results";
export const CLOSE_TESTID = "unfiltered-widget-close";
export const CHIPS_TESTID = "unfiltered-widget-chips";
export const CHIP_TESTID = "unfiltered-widget-chip";
export const ZERO_HIT_TESTID = "unfiltered-widget-zero-hit";
/** The "Close matches" divider inside a judged page's grid (YOY-166 AC-2). */
export const CLOSE_MATCHES_DIVIDER_TESTID =
  "unfiltered-widget-close-matches-divider";
export const NEW_SEARCH_TESTID = "unfiltered-widget-new-search";
export const PREVIEW_EMPTY_TESTID = "unfiltered-widget-preview-empty";
export const LOADING_MORE_TESTID = "unfiltered-widget-loading-more";
export const OTHER_READING_TESTID = "unfiltered-widget-other-reading";
export const LABEL_TESTID = "unfiltered-widget-label";

/**
 * The further pages of a submitted search (YOY-146): the page size the
 * search asked for and a loader for any page of the same search. Absent on
 * a keystroke preview, which is never paged (NG-4).
 */
export interface PageLoader {
  pageSize: number;
  load: (page: number) => Promise<ProxySearchResponse>;
}

/** Card and chip interactions the state machine in main.ts handles. */
export interface ResponseHandlers {
  /** `position` is the card's place in the whole result order (YOY-146 AC-10). */
  onCardClick: (result: ProxyResult, position: number) => void;
  onChipRemove: (chip: ProxyChip) => void;
  /**
   * The second-reading chip was tapped (YOY-150 AC-9): search `reading`
   * afresh. Absent means no reading chip is rendered.
   */
  onPickReading?: (reading: string) => void;
  pages?: PageLoader;
  /**
   * One page's late answer (YOY-151 AC-8; YOY-171 AC-1), asked for once for
   * each page whose response has `labelsPending`: the judged page that
   * replaces it, or — from an endpoint that answers labels only — its
   * labels by product id. Absent means no page waits for any.
   */
  labels?: (page: number) => Promise<LateAnswer>;
}

/** A page's late answer (YOY-171 AC-1): its labels, and the judged page once it landed. */
export interface LateAnswer {
  labels: Record<string, ProxyLabel | null>;
  page: ProxySearchResponse | null;
}

export interface Overlay {
  readonly host: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  showLoading(): void;
  /** Clear to the empty-input state: no cards, no chips, no messages. */
  showIdle(): void;
  /**
   * Resolve a failed/timed-out search to a quiet no-results state (YOY-61
   * AC-4): stale cards and chips are cleared so nothing pretends to answer
   * the failed query, and no error language is shown.
   */
  showFailure(): void;
  /** Render one search response: cards, chips, and empty states. */
  showResponse(response: ProxySearchResponse, handlers: ResponseHandlers): void;
  /**
   * Render a keystroke preview (YOY-68 AC-4): a plain results grid only —
   * no chips, no zero-hit rescue, no close matches. Preview zero hits show
   * a minimal quiet empty state, never the flat "No results" panel.
   */
  showPreview(response: ProxySearchResponse, handlers: ResponseHandlers): void;
  /** Remove the widget from the page entirely (inert degradation). */
  destroy(): void;
}

export interface OverlayOptions {
  locale: string;
  storeId: string;
  onClose: () => void;
  /** The "new search" control (YOY-49 AC-5). */
  onNewSearch: () => void;
}

export function createOverlay(options: OverlayOptions): Overlay {
  const locale = resolveLocale(options.locale);
  const strings = getStrings(options.locale);
  // A storefront language with no templates shows no label (YOY-151 AC-7),
  // even though its chrome falls back to English.
  const labelsShown = labelLocale(options.locale) !== null;

  const host = document.createElement("div");
  host.setAttribute("data-testid", ROOT_TESTID);
  host.setAttribute("data-locale", options.locale);
  host.setAttribute("data-store-id", options.storeId);
  // Hebrew chrome mirrors the whole overlay (YOY-50 AC-3): dir on the root
  // flips every logical property in widget.css, so the chip row, grid,
  // controls, and text alignment flow right-to-left with no RTL stylesheet.
  host.setAttribute("dir", locale === "he" ? "rtl" : "ltr");
  // Inline display guard: broad host rules like `div { display: none }`
  // must not be able to hide the widget's mount point (AC-7).
  host.style.display = "block";

  const shadow = host.attachShadow({ mode: "open" });

  const styleElement = document.createElement("style");
  styleElement.textContent = styles;
  shadow.appendChild(styleElement);

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.setAttribute("data-testid", OVERLAY_TESTID);
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", strings.searchResults);
  overlay.hidden = true;

  const bar = document.createElement("div");
  bar.className = "bar";
  const newSearch = document.createElement("button");
  newSearch.type = "button";
  newSearch.className = "new-search";
  newSearch.setAttribute("data-testid", NEW_SEARCH_TESTID);
  newSearch.textContent = strings.newSearch;
  newSearch.addEventListener("click", () => options.onNewSearch());
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.setAttribute("data-testid", CLOSE_TESTID);
  close.setAttribute("aria-label", strings.closeSearch);
  close.textContent = "×";
  close.addEventListener("click", () => options.onClose());
  bar.append(newSearch, close);

  const chipsRow = document.createElement("div");
  chipsRow.className = "chips";
  chipsRow.setAttribute("data-testid", CHIPS_TESTID);
  chipsRow.setAttribute("role", "list");
  chipsRow.setAttribute("aria-label", strings.appliedFilters);
  chipsRow.hidden = true;

  const loading = document.createElement("div");
  loading.className = "status";
  loading.setAttribute("data-testid", LOADING_TESTID);
  loading.textContent = strings.loading;
  loading.hidden = true;

  const noResults = document.createElement("div");
  noResults.className = "status";
  noResults.setAttribute("data-testid", NO_RESULTS_TESTID);
  noResults.textContent = strings.noResults;
  noResults.hidden = true;

  const zeroHit = document.createElement("div");
  zeroHit.className = "status";
  zeroHit.setAttribute("data-testid", ZERO_HIT_TESTID);
  zeroHit.textContent = strings.zeroHit;
  zeroHit.hidden = true;

  // Preview zero hits (YOY-68 AC-4): a quiet nudge, visually softer than
  // the submitted no-results panel — the shopper is mid-keystroke.
  const previewEmpty = document.createElement("div");
  previewEmpty.className = "status status-quiet";
  previewEmpty.setAttribute("data-testid", PREVIEW_EMPTY_TESTID);
  previewEmpty.textContent = strings.previewEmpty;
  previewEmpty.hidden = true;

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.setAttribute("data-testid", RESULTS_TESTID);

  // The next page's quiet line (YOY-146 AC-7): plain status text below the
  // grid while a page loads — no spinner, no skeleton, no control.
  const loadingMore = document.createElement("div");
  loadingMore.className = "status status-quiet";
  loadingMore.setAttribute("data-testid", LOADING_MORE_TESTID);
  loadingMore.setAttribute("role", "status");
  loadingMore.textContent = strings.loadingMore;
  loadingMore.hidden = true;

  overlay.append(
    bar,
    chipsRow,
    loading,
    noResults,
    zeroHit,
    previewEmpty,
    grid,
    loadingMore,
  );
  shadow.appendChild(overlay);

  /**
   * Further pages, appended as the shopper scrolls (YOY-146 AC-6 to AC-9):
   * when the last card enters the viewport the next page is requested and
   * its cards go below the ones shown, which never move. Appending stops at
   * `totalCount`; a failed page leaves every shown card in place and says
   * nothing. Each render starts a new generation, so a page that lands for
   * an older response is dropped.
   */
  let generation = 0;
  let observer: IntersectionObserver | null = null;
  // Re-watch the grid's last card after a late page swapped the one being
  // watched out (YOY-171 AC-1); a no-op while a page loads or once done.
  let rewatchLast = (): void => {};
  const stopAppending = (): void => {
    observer?.disconnect();
    observer = null;
    loadingMore.hidden = true;
  };
  const appendPages = (
    response: ProxySearchResponse,
    handlers: ResponseHandlers,
  ): void => {
    stopAppending();
    const mine = (generation += 1);
    const pages = handlers.pages;
    const total = response.totalCount ?? response.results.length;
    if (pages === undefined || typeof IntersectionObserver === "undefined") {
      return;
    }
    let shown =
      response.results.length + inlineCloseMatches(response).length;
    let nextPage = (response.page ?? 1) + 1;
    let loadingPage = false;
    rewatchLast = () => {
      if (mine === generation && !loadingPage && observer !== null) {
        observer.disconnect();
        observer = null;
        watchLast();
      }
    };
    const watchLast = (): void => {
      const last = grid.lastElementChild;
      if (shown >= total || last === null) {
        return;
      }
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        observer?.disconnect();
        observer = null;
        loadingMore.hidden = false;
        const page = nextPage;
        loadingPage = true;
        pages.load(page).then(
          (next) => {
            if (mine !== generation) {
              return;
            }
            loadingPage = false;
            loadingMore.hidden = true;
            const offset = (page - 1) * pages.pageSize;
            const pending = waitsForLabels(next, handlers);
            const appended = pageCards(next, offset, handlers, pending);
            grid.append(...appended.elements);
            settleLabels(appended.cards);
            if (pending) {
              fillLateLabels(appended, page, offset, handlers, mine);
            }
            shown += appended.cards.length;
            nextPage = page + 1;
            if (appended.cards.length > 0) {
              watchLast();
            }
          },
          () => {
            // AC-9: the shown cards stay, and no error reaches the shopper.
            if (mine === generation) {
              loadingPage = false;
              loadingMore.hidden = true;
            }
          },
        );
      });
      observer.observe(last);
    };
    watchLast();
  };

  /**
   * One page's grid content (YOY-166 AC-2, AC-3): its results, then — when
   * the page has matches and close products both — the "Close matches"
   * divider and the close products, each still carrying its label. The
   * divider spans the grid, so every appended page repeats it under its
   * own results. Positions count on from the page's place in the order.
   */
  function pageCards(
    page: ProxySearchResponse,
    offset: number,
    handlers: ResponseHandlers,
    pending: boolean,
  ): { elements: HTMLElement[]; cards: HTMLElement[] } {
    // Under the heading, the heading is the label (YOY-168 AC-3).
    const close = inlineCloseMatches(page).map(underCloseHeading);
    const cards = [...page.results, ...close].map((result, index) =>
      card(result, offset + index, handlers.onCardClick, { pending }),
    );
    if (close.length === 0) {
      return { elements: cards, cards };
    }
    const divider = document.createElement("h2");
    divider.className = "close-matches-heading grid-divider";
    divider.setAttribute("data-testid", CLOSE_MATCHES_DIVIDER_TESTID);
    divider.textContent = strings.closeMatchesHeading;
    const split = page.results.length;
    return {
      elements: [...cards.slice(0, split), divider, ...cards.slice(split)],
      cards,
    };
  }

  /** Whether this page's labels arrive later (YOY-151 AC-8). */
  function waitsForLabels(
    response: ProxySearchResponse,
    handlers: ResponseHandlers,
  ): boolean {
    return (
      labelsShown &&
      response.labelsPending === true &&
      handlers.labels !== undefined
    );
  }

  /**
   * Drop every shown label wider than its card (YOY-151 AC-6), once the
   * cards are laid out: never truncated, never wrapped — absent. A reserved
   * line keeps its height and simply stays empty.
   */
  function settleLabels(cards: readonly HTMLElement[]): void {
    for (const element of cards) {
      const label = element.querySelector<HTMLElement>(".card-label");
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
   * Ask once for a page's late answer (YOY-151 AC-8; YOY-171 AC-1). The
   * judged page replaces the page's cards in one swap — its order, the
   * not-relevant cards gone, the close ones under the heading — with the
   * panel's scroll held. An endpoint that answers labels only fills the
   * reserved lines in place instead, so no card moves. A failed or
   * superseded request leaves the lines empty and says nothing.
   */
  function fillLateLabels(
    shown: { elements: HTMLElement[]; cards: HTMLElement[] },
    page: number,
    offset: number,
    handlers: ResponseHandlers,
    mine: number,
  ): void {
    const { cards } = shown;
    handlers.labels?.(page).then(
      ({ labels, page: late }) => {
        if (mine !== generation) {
          return;
        }
        if (late !== null) {
          const scrolled = overlay.scrollTop;
          const replaced = pageCards(late, offset, handlers, false);
          shown.elements[0]?.before(...replaced.elements);
          for (const element of shown.elements) {
            element.remove();
          }
          settleLabels(replaced.cards);
          overlay.scrollTop = scrolled;
          rewatchLast();
          return;
        }
        for (const element of cards) {
          const productId = element.getAttribute("data-product-id") ?? "";
          const slot = element.querySelector<HTMLElement>("[data-label-slot]");
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
        settleLabels(cards);
      },
      () => {
        // The reserved lines stay empty; no error reaches the shopper.
      },
    );
  }

  function card(
    result: ProxyResult,
    position: number,
    onCardClick: ResponseHandlers["onCardClick"],
    labelling: { pending: boolean } | null = { pending: false },
  ): HTMLElement {
    // The link target is the server-resolved `url`, verbatim (YOY-87 AC-4):
    // the widget composes no URL. Without one the card is a plain block —
    // same image/title/price/availability, no anchor, no click beacon.
    const anchor =
      result.url === null
        ? document.createElement("div")
        : document.createElement("a");
    anchor.className = "card";
    anchor.setAttribute("data-testid", CARD_TESTID);
    anchor.setAttribute("data-product-id", result.productId);
    if (anchor instanceof HTMLAnchorElement && result.url !== null) {
      anchor.href = result.url;
    }

    if (result.imageUrl === null) {
      const placeholder = document.createElement("div");
      placeholder.className = "card-image-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      anchor.appendChild(placeholder);
    } else {
      // Sized by the CDN where it can (YOY-169): the overlay card is ~200 px
      // wide, the full panel on a phone.
      const image = document.createElement("img");
      image.className = "card-image";
      const sources = cardImageSources(result.imageUrl);
      if (sources.srcset !== undefined) {
        image.srcset = sources.srcset;
        image.sizes = "(max-width: 440px) 100vw, 220px";
      }
      image.src = sources.src;
      image.alt = result.title;
      image.loading = cardImageLoading(position);
      image.decoding = "async";
      anchor.appendChild(image);
    }

    // dir="auto" isolates each title and price bidi-wise (AC-3): Latin
    // product text inside an RTL overlay keeps its own direction and stays
    // readable, and vice versa in LTR chrome.
    const title = document.createElement("div");
    title.className = "card-title";
    title.dir = "auto";
    title.textContent = result.title;
    anchor.appendChild(title);

    const price = document.createElement("div");
    price.className = "card-price";
    price.dir = "auto";
    price.textContent = formatPrice(
      result.priceMin,
      result.priceMax,
      result.currencyCode,
    );
    anchor.appendChild(price);

    // The label line (YOY-151 AC-4, W-11): directly under the price, one
    // quiet line in the inherited colour. A page waiting for its labels
    // reserves the line on every card (AC-8), so they land without moving
    // anything. Keystroke previews carry none (NG-2). The line is a
    // sentence in the chrome's language, so it takes the overlay's
    // direction; its values are isolated inside it (renderLabel).
    if (labelling !== null && labelsShown) {
      const segments = labelSegments(strings, result.label, options.locale);
      if (segments !== null || labelling.pending) {
        const label = document.createElement("div");
        label.className = "card-label";
        if (labelling.pending) {
          label.setAttribute("data-label-slot", "");
        }
        if (segments !== null) {
          label.setAttribute("data-testid", LABEL_TESTID);
          renderLabel(label, segments);
        }
        anchor.appendChild(label);
      }
    }

    if (!result.available) {
      const soldOut = document.createElement("span");
      soldOut.className = "card-sold-out";
      soldOut.textContent = strings.soldOut;
      anchor.appendChild(soldOut);
    }

    // The beacon fires and the anchor's own navigation proceeds untouched —
    // never prevented, never awaited (AC-5). A linkless card (null url) is
    // not a click target: no navigation, no beacon (YOY-87 AC-4).
    if (anchor instanceof HTMLAnchorElement) {
      anchor.addEventListener("click", () => onCardClick(result, position));
    }
    return anchor;
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
    button.className = negated ? "chip chip--negated" : "chip";
    button.setAttribute("data-testid", CHIP_TESTID);
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
    // upright (W-3: weight and this strike, never a hue of ours). The
    // accessible name above is the whole label, unstruck.
    const text = document.createElement("span");
    if (negator === null) {
      text.textContent = value;
    } else {
      const word = document.createElement("span");
      word.className = "chip-negator";
      word.textContent = `${negator} `;
      const struck = document.createElement("s");
      struck.className = "chip-value";
      struck.textContent = value;
      text.append(word, struck);
    }
    const remove = document.createElement("span");
    remove.className = "chip-remove";
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "×";
    button.append(text, remove);

    button.addEventListener("click", () => onChipRemove(chip));
    return button;
  }

  /**
   * The second-reading chip (YOY-150 AC-8): the chip anatomy with no remove
   * glyph — it is not a filter — reading "{reading} instead?". Tapping it
   * is a new search (AC-9); nothing opens and nothing blocks (AC-10).
   */
  function readingElement(
    reading: string,
    onPickReading: (reading: string) => void,
  ): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip chip--reading";
    button.setAttribute("data-testid", OTHER_READING_TESTID);
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

  return {
    host,
    open() {
      overlay.hidden = false;
    },
    close() {
      overlay.hidden = true;
      generation += 1;
      stopAppending();
    },
    isOpen() {
      return !overlay.hidden;
    },
    showLoading() {
      // First open happens here or in showResponse (YOY-67 AC-6): the
      // overlay never renders before there is something — at least a
      // loading state — to show.
      generation += 1;
      stopAppending();
      overlay.hidden = false;
      loading.hidden = false;
      noResults.hidden = true;
      zeroHit.hidden = true;
      previewEmpty.hidden = true;
    },
    showIdle() {
      generation += 1;
      stopAppending();
      loading.hidden = true;
      noResults.hidden = true;
      zeroHit.hidden = true;
      previewEmpty.hidden = true;
      chipsRow.hidden = true;
      chipsRow.replaceChildren();
      grid.replaceChildren();
    },
    showFailure() {
      this.showIdle();
      noResults.hidden = false;
    },
    showResponse(response, handlers) {
      overlay.hidden = false;
      loading.hidden = true;
      previewEmpty.hidden = true;

      // Chip row (AC-1): a response carries chips on whichever route its
      // judge took (YOY-149) and sends none it did not apply; degraded
      // responses carry none by the endpoint contract (AC-6), so this hides
      // the row for them naturally.
      const chips = response.chips;
      const reading =
        response.otherReading !== undefined && handlers.onPickReading !== undefined
          ? readingElement(response.otherReading, handlers.onPickReading)
          : null;
      chipsRow.replaceChildren(
        ...(reading === null ? [] : [reading]),
        ...chips.map((chip) =>
          chipElement(chip, handlers.onChipRemove),
        ),
      );
      chipsRow.hidden = chips.length === 0 && reading === null;

      // Positions count from the page's place in the whole order (AC-10).
      const offset =
        ((response.page ?? 1) - 1) * (handlers.pages?.pageSize ?? 0);
      const pending = waitsForLabels(response, handlers);
      const first = pageCards(response, offset, handlers, pending);
      grid.replaceChildren(...first.elements);
      settleLabels(first.cards);
      appendPages(response, handlers);
      if (pending) {
        fillLateLabels(first, response.page ?? 1, offset, handlers, generation);
      }

      // Empty states: an AI zero-hit keeps the session alive with its chips
      // (AC-3); a classic empty set is a plain "no results" (YOY-48 AC-8).
      const empty = response.results.length === 0;
      zeroHit.hidden = !(empty && response.route === "ai");
      noResults.hidden = !(empty && response.route === "classic");
    },
    showPreview(response, handlers) {
      // A preview is the plain-grid subset of showResponse (YOY-68 AC-4):
      // every full-response surface — chips, the zero-hit line, the flat
      // no-results panel — stays hidden, so the preview→submitted
      // transition swaps grids without ever stacking panels (AC-5).
      overlay.hidden = false;
      loading.hidden = true;
      noResults.hidden = true;
      zeroHit.hidden = true;
      chipsRow.hidden = true;
      chipsRow.replaceChildren();
      // A preview is never paged (NG-4).
      generation += 1;
      stopAppending();

      grid.replaceChildren(
        ...response.results.map((result, index) =>
          card(result, index, handlers.onCardClick, null),
        ),
      );
      previewEmpty.hidden = response.results.length !== 0;
    },
    destroy() {
      generation += 1;
      stopAppending();
      host.remove();
    },
  };
}

/**
 * A page's close products that sit inside its grid under the divider
 * (YOY-166): a judged page with matches carries them in `closeMatches`
 * beside non-empty `results`.
 */
export function inlineCloseMatches(page: ProxySearchResponse): ProxyResult[] {
  return page.results.length > 0 ? (page.closeMatches ?? []) : [];
}
