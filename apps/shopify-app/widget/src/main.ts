import { createOverlay, ROOT_TESTID } from "./overlay";
import { createSearchClient } from "./search-client";
import { getSessionId } from "./session";

export { ROOT_TESTID };

/**
 * Storefront search widget (YOY-48): takes over the theme's own search
 * input — focusing or typing opens a results overlay fed by the app-proxy
 * search endpoint, while the theme's native search-results navigation is
 * suppressed only while the overlay is open.
 *
 * Degradation contract (AC-2): no recognizable theme search input, a failed
 * or timed-out search request, or any unexpected DOM failure leaves the
 * theme's native search exactly as it was without the app. The widget
 * removes itself rather than showing error UI — the shopper never sees an
 * error caused by us.
 */

/** Configuration the theme app embed block passes into `init`. */
export interface WidgetConfig {
  /** Storefront locale ISO code, e.g. "en" or "he". */
  locale: string;
  /** The shop's permanent .myshopify.com domain. */
  shopDomain: string;
  /** Proxy subpath prefix; the app proxy's default when absent. */
  proxyBasePath?: string;
  /** Abort an unanswered search after this long (harness shortens it). */
  searchTimeoutMs?: number;
  /** Debounce for typing → search (harness shortens it). */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;

/**
 * The theme's search input, by the common storefront patterns: a dedicated
 * search input, or a form posting to /search with a `q` input. The widget's
 * own overlay never carries an input, so a mounted widget can't match.
 */
export function findThemeSearchInput(): HTMLInputElement | null {
  const direct = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  );
  if (direct !== null) {
    return direct;
  }
  for (const form of document.querySelectorAll<HTMLFormElement>(
    'form[action*="/search"]',
  )) {
    const q = form.querySelector<HTMLInputElement>('input[name="q"]');
    if (q !== null) {
      return q;
    }
  }
  return null;
}

/**
 * Mount the widget onto the host page. Idempotent: a second call finds the
 * existing root and does nothing. Never throws into the host page. With no
 * recognizable theme search input the widget mounts nothing at all (AC-2).
 */
export function init(config: WidgetConfig): void {
  try {
    if (document.querySelector(`[data-testid="${ROOT_TESTID}"]`) !== null) {
      return;
    }

    const foundInput = findThemeSearchInput();
    if (foundInput === null) {
      return;
    }
    const input: HTMLInputElement = foundInput;

    const client = createSearchClient({
      basePath: config.proxyBasePath,
      timeoutMs: config.searchTimeoutMs,
    });
    const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    let inert = false;
    let debounceTimer: number | undefined;
    let currentSearchId: string | null = null;
    let requestSequence = 0;

    const overlay = createOverlay({
      locale: config.locale,
      shopDomain: config.shopDomain,
      onClose: () => overlay.close(),
    });

    /** AC-2: leave the page exactly as without the app, permanently. */
    const goInert = (): void => {
      inert = true;
      window.clearTimeout(debounceTimer);
      overlay.destroy();
    };

    const onCardClick = (
      result: { productId: string },
      position: number,
    ): void => {
      // Fire-and-forget (AC-5): the anchor's navigation proceeds without
      // waiting on — or even observing — the beacon's outcome.
      if (currentSearchId !== null) {
        client.sendClickBeacon({
          searchId: currentSearchId,
          sessionId: getSessionId(),
          productId: result.productId,
          position,
        });
      }
    };

    const runSearch = async (query: string): Promise<void> => {
      const sequence = ++requestSequence;
      overlay.showLoading();
      try {
        const response = await client.search(query, getSessionId());
        if (inert || sequence !== requestSequence) {
          return; // A newer keystroke superseded this request.
        }
        currentSearchId = response.searchId;
        overlay.showResults(response.results, onCardClick);
      } catch {
        if (sequence === requestSequence) {
          goInert();
        }
      }
    };

    const onType = (): void => {
      if (inert) {
        return;
      }
      overlay.open();
      window.clearTimeout(debounceTimer);
      const query = input.value.trim();
      if (query === "") {
        overlay.showIdle();
        return;
      }
      debounceTimer = window.setTimeout(() => {
        void runSearch(query);
      }, debounceMs);
    };

    input.addEventListener("focus", () => {
      if (!inert) {
        overlay.open();
      }
    });
    input.addEventListener("input", onType);

    // Suppress the theme's native search navigation only while the overlay
    // is open (AC-1); once inert or closed, Enter submits natively (AC-2).
    input.form?.addEventListener("submit", (event) => {
      if (!inert && overlay.isOpen()) {
        event.preventDefault();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !inert && overlay.isOpen()) {
        // preventDefault stops the browser clearing a type="search" input —
        // reopening must retain the query text (AC-6), and the clear would
        // also fire an input event that reopened the overlay.
        event.preventDefault();
        overlay.close();
      }
    });

    document.body.appendChild(overlay.host);
  } catch {
    // Never break the merchant's storefront: a widget that fails to mount
    // must degrade to the theme's own search, silently.
  }
}

declare global {
  interface Window {
    UnfilteredWidget?: { init: typeof init };
  }
}

window.UnfilteredWidget = { init };
