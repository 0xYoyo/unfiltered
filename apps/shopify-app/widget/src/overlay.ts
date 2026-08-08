import { formatPrice } from "./format";
import type { ProxyResult } from "./search-client";
import styles from "./widget.css?inline";

/**
 * The results overlay (YOY-48): all widget-rendered DOM lives inside an
 * open shadow root on the host element, so theme CSS cannot break the
 * overlay's layout and widget CSS cannot leak onto host elements (AC-7).
 * Inheritable properties (font-family, color) still cross the shadow
 * boundary, so the overlay inherits the theme's typography.
 */

export const ROOT_TESTID = "unfiltered-widget-root";
export const OVERLAY_TESTID = "unfiltered-widget-overlay";
export const RESULTS_TESTID = "unfiltered-widget-results";
export const CARD_TESTID = "unfiltered-widget-card";
export const LOADING_TESTID = "unfiltered-widget-loading";
export const NO_RESULTS_TESTID = "unfiltered-widget-no-results";
export const CLOSE_TESTID = "unfiltered-widget-close";

export interface Overlay {
  readonly host: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  showLoading(): void;
  /** Clear to the empty-input state: no cards, no messages. */
  showIdle(): void;
  /** Render result cards (or the no-results message for an empty set). */
  showResults(
    results: ProxyResult[],
    onCardClick: (result: ProxyResult, position: number) => void,
  ): void;
  /** Remove the widget from the page entirely (inert degradation). */
  destroy(): void;
}

export interface OverlayOptions {
  locale: string;
  shopDomain: string;
  onClose: () => void;
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
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.setAttribute("data-testid", CLOSE_TESTID);
  close.setAttribute("aria-label", "Close search");
  close.textContent = "×";
  close.addEventListener("click", () => options.onClose());
  bar.appendChild(close);

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

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.setAttribute("data-testid", RESULTS_TESTID);

  overlay.append(bar, loading, noResults, grid);
  shadow.appendChild(overlay);

  function card(
    result: ProxyResult,
    position: number,
    onCardClick: (result: ProxyResult, position: number) => void,
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
    },
    showIdle() {
      loading.hidden = true;
      noResults.hidden = true;
      grid.replaceChildren();
    },
    showResults(results, onCardClick) {
      loading.hidden = true;
      grid.replaceChildren(
        ...results.map((result, index) => card(result, index, onCardClick)),
      );
      noResults.hidden = results.length > 0;
    },
    destroy() {
      host.remove();
    },
  };
}
