import { chipLabel, formatPrice } from "./format";
import type {
  ProxyChip,
  ProxyResult,
  ProxySearchResponse,
} from "./search-client";
import styles from "./widget.css?inline";

/**
 * The results overlay (YOY-48, extended by YOY-49 with chips, the AI
 * zero-hit state, close matches, and a new-search control): all
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
export const CLOSE_MATCHES_TESTID = "unfiltered-widget-close-matches";
export const NEW_SEARCH_TESTID = "unfiltered-widget-new-search";

/** Card and chip interactions the state machine in main.ts handles. */
export interface ResponseHandlers {
  onCardClick: (result: ProxyResult, position: number) => void;
  onChipRemove: (chip: ProxyChip) => void;
}

export interface Overlay {
  readonly host: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  showLoading(): void;
  /** Clear to the empty-input state: no cards, no chips, no messages. */
  showIdle(): void;
  /** Render one search response: cards, chips, and empty states. */
  showResponse(response: ProxySearchResponse, handlers: ResponseHandlers): void;
  /** Remove the widget from the page entirely (inert degradation). */
  destroy(): void;
}

export interface OverlayOptions {
  locale: string;
  shopDomain: string;
  onClose: () => void;
  /** The "new search" control (YOY-49 AC-5). */
  onNewSearch: () => void;
}

export function createOverlay(options: OverlayOptions): Overlay {
  const host = document.createElement("div");
  host.setAttribute("data-testid", ROOT_TESTID);
  host.setAttribute("data-locale", options.locale);
  host.setAttribute("data-shop-domain", options.shopDomain);
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
  overlay.setAttribute("aria-label", "Search results");
  overlay.hidden = true;

  const bar = document.createElement("div");
  bar.className = "bar";
  const newSearch = document.createElement("button");
  newSearch.type = "button";
  newSearch.className = "new-search";
  newSearch.setAttribute("data-testid", NEW_SEARCH_TESTID);
  newSearch.textContent = "New search";
  newSearch.addEventListener("click", () => options.onNewSearch());
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.setAttribute("data-testid", CLOSE_TESTID);
  close.setAttribute("aria-label", "Close search");
  close.textContent = "×";
  close.addEventListener("click", () => options.onClose());
  bar.append(newSearch, close);

  const chipsRow = document.createElement("div");
  chipsRow.className = "chips";
  chipsRow.setAttribute("data-testid", CHIPS_TESTID);
  chipsRow.setAttribute("role", "list");
  chipsRow.setAttribute("aria-label", "Applied filters");
  chipsRow.hidden = true;

  const loading = document.createElement("div");
  loading.className = "status";
  loading.setAttribute("data-testid", LOADING_TESTID);
  loading.textContent = "Searching…";
  loading.hidden = true;

  const noResults = document.createElement("div");
  noResults.className = "status";
  noResults.setAttribute("data-testid", NO_RESULTS_TESTID);
  noResults.textContent = "No results";
  noResults.hidden = true;

  const zeroHit = document.createElement("div");
  zeroHit.className = "status";
  zeroHit.setAttribute("data-testid", ZERO_HIT_TESTID);
  zeroHit.textContent = "Nothing matches all of these";
  zeroHit.hidden = true;

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.setAttribute("data-testid", RESULTS_TESTID);

  const closeMatches = document.createElement("section");
  closeMatches.className = "close-matches";
  closeMatches.setAttribute("data-testid", CLOSE_MATCHES_TESTID);
  closeMatches.hidden = true;
  const closeMatchesHeading = document.createElement("h2");
  closeMatchesHeading.className = "close-matches-heading";
  closeMatchesHeading.textContent = "Close matches";
  const closeMatchesGrid = document.createElement("div");
  closeMatchesGrid.className = "grid";
  closeMatches.append(closeMatchesHeading, closeMatchesGrid);

  overlay.append(bar, chipsRow, loading, noResults, zeroHit, grid, closeMatches);
  shadow.appendChild(overlay);

  function card(
    result: ProxyResult,
    position: number,
    onCardClick: ResponseHandlers["onCardClick"],
  ): HTMLAnchorElement {
    const anchor = document.createElement("a");
    anchor.className = "card";
    anchor.setAttribute("data-testid", CARD_TESTID);
    anchor.setAttribute("data-product-id", result.productId);
    anchor.href = `/products/${result.handle}`;

    if (result.imageUrl === null) {
      const placeholder = document.createElement("div");
      placeholder.className = "card-image-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      anchor.appendChild(placeholder);
    } else {
      const image = document.createElement("img");
      image.className = "card-image";
      image.src = result.imageUrl;
      image.alt = result.title;
      image.loading = "lazy";
      anchor.appendChild(image);
    }

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = result.title;
    anchor.appendChild(title);

    const price = document.createElement("div");
    price.className = "card-price";
    price.textContent = formatPrice(
      result.priceMin,
      result.priceMax,
      result.currencyCode,
    );
    anchor.appendChild(price);

    if (!result.available) {
      const soldOut = document.createElement("span");
      soldOut.className = "card-sold-out";
      soldOut.textContent = "Sold out";
      anchor.appendChild(soldOut);
    }

    // The beacon fires and the anchor's own navigation proceeds untouched —
    // never prevented, never awaited (AC-5).
    anchor.addEventListener("click", () => onCardClick(result, position));
    return anchor;
  }

  function chipElement(
    chip: ProxyChip,
    onChipRemove: ResponseHandlers["onChipRemove"],
  ): HTMLElement {
    const label = chipLabel(chip);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.setAttribute("data-testid", CHIP_TESTID);
    button.setAttribute("data-chip-field", chip.field);
    button.setAttribute("data-chip-value", chip.value);
    button.setAttribute("role", "listitem");
    button.setAttribute("aria-label", `Remove filter: ${label}`);

    const text = document.createElement("span");
    text.textContent = label;
    const remove = document.createElement("span");
    remove.className = "chip-remove";
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "×";
    button.append(text, remove);

    button.addEventListener("click", () => onChipRemove(chip));
    return button;
  }

  return {
    host,
    open() {
      overlay.hidden = false;
    },
    close() {
      overlay.hidden = true;
    },
    isOpen() {
      return !overlay.hidden;
    },
    showLoading() {
      loading.hidden = false;
      noResults.hidden = true;
      zeroHit.hidden = true;
    },
    showIdle() {
      loading.hidden = true;
      noResults.hidden = true;
      zeroHit.hidden = true;
      chipsRow.hidden = true;
      chipsRow.replaceChildren();
      grid.replaceChildren();
      closeMatches.hidden = true;
      closeMatchesGrid.replaceChildren();
    },
    showResponse(response, handlers) {
      loading.hidden = true;

      // Chip row (AC-1): AI-resolved responses only. Degraded responses
      // carry no chips by the endpoint contract (AC-6), so this hides the
      // row for them naturally.
      const chips = response.route === "ai" ? response.chips : [];
      chipsRow.replaceChildren(
        ...chips.map((chip) => chipElement(chip, handlers.onChipRemove)),
      );
      chipsRow.hidden = chips.length === 0;

      grid.replaceChildren(
        ...response.results.map((result, index) =>
          card(result, index, handlers.onCardClick),
        ),
      );

      // Empty states: an AI zero-hit keeps the session alive with its chips
      // and close matches (AC-3); a classic empty set is a plain
      // "no results" (YOY-48 AC-8).
      const empty = response.results.length === 0;
      const aiZeroHit = empty && response.route === "ai";
      zeroHit.hidden = !aiZeroHit;
      noResults.hidden = !(empty && response.route === "classic");

      const matches = aiZeroHit ? (response.closeMatches ?? []) : [];
      closeMatchesGrid.replaceChildren(
        ...matches.map((result, index) =>
          card(result, index, handlers.onCardClick),
        ),
      );
      closeMatches.hidden = matches.length === 0;
    },
    destroy() {
      host.remove();
    },
  };
}
