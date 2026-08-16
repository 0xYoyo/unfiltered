import {
  createNativeComposite,
  createNativeSurface,
  resolveNativeRender,
} from "./native-render";
import type { NativeRenderOverrides } from "./native-render.config";
import { createOverlay, ROOT_TESTID } from "./overlay";
import {
  createSearchClient,
  type ProxyChip,
  type ProxyIntent,
  type SearchRequestContext,
} from "./search-client";
import { getSessionId } from "./session";
import { getStrings } from "./strings";

export { ROOT_TESTID };

/**
 * Storefront search widget (YOY-48): takes over the theme's own search
 * input — focusing or typing opens a results overlay fed by the app-proxy
 * search endpoint, while the theme's native search-results navigation is
 * suppressed only while the overlay is open.
 *
 * Degradation contract (AC-2, refined by YOY-61 AC-4): no recognizable
 * theme search input, an unexpected DOM failure, or repeated consecutive
 * search failures leave the theme's native search exactly as it was without
 * the app. A SINGLE slow or failed search never destroys the widget — it
 * resolves to a quiet no-results state and the next search runs normally;
 * only structural failure (cannot mount, or every search failing in a row)
 * makes the widget remove itself. The shopper never sees an error caused by
 * us either way.
 */

/** Configuration the theme app embed block passes into `init`. */
export interface WidgetConfig {
  /** Storefront locale ISO code, e.g. "en" or "he". */
  locale: string;
  /**
   * Neutral tenant identifier (YOY-84): the widget core speaks no commerce
   * platform; the Shopify theme-embed adapter passes the shop's permanent
   * .myshopify.com domain as its value.
   */
  storeId: string;
  /** Proxy subpath prefix; the app proxy's default when absent. */
  proxyBasePath?: string;
  /** Abort an unanswered search after this long (harness shortens it). */
  searchTimeoutMs?: number;
  /** Debounce for typing → search (harness shortens it). */
  debounceMs?: number;
  /**
   * Theme-native rendering of the submit tier (YOY-70 spike): opt-in only —
   * absent means the existing overlay path, exactly as before. The dev flag
   * `?unfiltered_native=A|B` overrides for the browser session.
   */
  nativeRender?: NativeRenderOverrides;
}

const DEFAULT_DEBOUNCE_MS = 200;

/**
 * Consecutive hard search failures (HTTP error, network failure, timeout,
 * malformed body) before the widget concludes the failure is structural and
 * goes inert (YOY-61 AC-4). Any successful response resets the count.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

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

    // The input placeholder is widget chrome (YOY-50 AC-1/AC-2): the
    // catalog owns it in both locales while the widget is active. Going
    // inert restores the theme's own placeholder — the page must end
    // exactly as without the app (YOY-48 AC-2).
    const strings = getStrings(config.locale);
    const themePlaceholder = input.placeholder;
    input.placeholder = strings.inputPlaceholder;

    const client = createSearchClient({
      basePath: config.proxyBasePath,
      timeoutMs: config.searchTimeoutMs,
    });
    const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    let inert = false;
    // Explicit dismissal (YOY-67 AC-6): with overlay visibility deferred to
    // the first loading state/response, `overlay.isOpen()` no longer means
    // "the widget owns the input" — during the debounce window the overlay
    // is legitimately closed. Enter/submit suppression keys on this flag
    // instead: set by close/Escape (native search returns until the shopper
    // re-engages), cleared by refocusing or typing.
    let dismissed = false;
    let debounceTimer: number | undefined;
    let currentSearchId: string | null = null;
    let requestSequence = 0;
    // Dismissal-race bookkeeping (YOY-69 AC-2): a search is "active" while a
    // debounced preview is pending or a request is in flight — exactly the
    // window in which closing the overlay must cancel work, or a late
    // response would reopen the overlay the shopper just closed.
    let debouncePending = false;
    let settledSequence = 0;
    let consecutiveFailures = 0;
    // Refinement memory (YOY-49 AC-4): the latest response's echoed intent,
    // held in memory only — it lives exactly as long as this page view and
    // never crosses browser sessions (NG-4). The last query text backs chip
    // removal, whose request still needs a query by the endpoint contract.
    let heldIntent: ProxyIntent | null = null;
    let lastQuery = "";

    const surfaceOptions = {
      onClose: () => {
        dismiss();
      },
      onNewSearch: () => {
        // AC-5: clear the held intent, the input, the chips, and the
        // results; the next query is sent without previousIntent.
        heldIntent = null;
        lastQuery = "";
        input.value = "";
        overlay.showIdle();
        input.focus();
      },
    };
    const shadowOverlay = createOverlay({
      locale: config.locale,
      storeId: config.storeId,
      ...surfaceOptions,
    });
    // Theme-native rendering (YOY-70): off unless configured or dev-flagged,
    // in which case submitted responses render as the theme's own cards in
    // the host document while previews keep the shadow overlay (NG-3).
    const nativeConfig = resolveNativeRender(config.nativeRender);
    const overlay =
      nativeConfig === null
        ? shadowOverlay
        : createNativeComposite(
            shadowOverlay,
            createNativeSurface({
              locale: config.locale,
              config: nativeConfig,
              ...surfaceOptions,
            }),
          );

    /** A debounced preview is pending or a request is in flight (YOY-69
     * AC-2): the window in which dismissal must cancel, not just hide. */
    const searchActive = (): boolean =>
      debouncePending || settledSequence !== requestSequence;

    /**
     * Explicit dismissal (YOY-69 AC-2): close the overlay AND cancel every
     * pending search — clear the debounce timer and invalidate in-flight
     * requests by bumping the sequence, so a late response hits the
     * stale-sequence guard and renders nothing. Without the cancellation,
     * showLoading/showPreview/showResponse would reopen the overlay the
     * shopper just closed.
     */
    const dismiss = (): void => {
      dismissed = true;
      debouncePending = false;
      window.clearTimeout(debounceTimer);
      requestSequence += 1;
      settledSequence = requestSequence;
      overlay.close();
    };

    /** AC-2: leave the page exactly as without the app, permanently. */
    const goInert = (): void => {
      inert = true;
      window.clearTimeout(debounceTimer);
      input.placeholder = themePlaceholder;
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

    const runSearch = async (
      query: string,
      context?: SearchRequestContext,
    ): Promise<void> => {
      const preview = context?.preview === true;
      const sequence = ++requestSequence;
      // A preview over an already-open overlay keeps the current results in
      // place until the new ones land — live-search feel, no loading flicker
      // per keystroke. The first render still opens via the loading state
      // (YOY-67 AC-6: nothing shows before there is something to show).
      if (!preview || !overlay.isOpen()) {
        overlay.showLoading();
      }
      try {
        const response = await client.search(query, getSessionId(), context);
        if (inert || sequence !== requestSequence) {
          return; // A newer keystroke (or a dismissal) superseded this.
        }
        settledSequence = sequence;
        consecutiveFailures = 0;
        if (preview) {
          // Previews are not attributable searches (YOY-68 AC-3): no
          // SearchEvent row exists server-side, so the click beacon must
          // not fire against this searchId — and the refinement memory
          // (heldIntent/lastQuery) stays whatever the last SUBMITTED
          // search established, so submit-gated refinement still works.
          currentSearchId = null;
          overlay.showPreview(response, { onCardClick, onChipRemove });
          return;
        }
        currentSearchId = response.searchId;
        lastQuery = query;
        // The response's echoed intent replaces the held one (AC-4) — also
        // when it is null (a classic response holds no intent to refine).
        heldIntent = response.intent;
        overlay.showResponse(response, { onCardClick, onChipRemove });
      } catch {
        if (inert || sequence !== requestSequence) {
          return; // A newer keystroke (or a dismissal) superseded this.
        }
        settledSequence = sequence;
        // Failure containment (YOY-61 AC-4): one slow or failed search
        // resolves to a quiet no-results state and the widget stays alive
        // for the next query. Self-removal is reserved for structural
        // failure — every search failing in a row — preserving YOY-48
        // AC-2's inert-hands-back-the-input behavior when it does fire.
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          goInert();
        } else {
          overlay.showFailure();
        }
      }
    };

    /**
     * Chip removal (AC-2): resend the last query carrying the held intent
     * and the dismissed chip; the server recomputes without that constraint
     * and the whole overlay re-renders from its response.
     */
    const onChipRemove = (chip: ProxyChip): void => {
      if (inert || heldIntent === null) {
        return;
      }
      debouncePending = false;
      window.clearTimeout(debounceTimer);
      void runSearch(lastQuery, {
        previousIntent: heldIntent,
        removeChip: chip,
      });
    };

    const onType = (): void => {
      if (inert) {
        return;
      }
      dismissed = false;
      debouncePending = false;
      window.clearTimeout(debounceTimer);
      const query = input.value.trim();
      if (query === "") {
        overlay.showIdle();
        return;
      }
      debouncePending = true;
      debounceTimer = window.setTimeout(() => {
        debouncePending = false;
        // Typing is preview-only (YOY-68 AC-1): a live, classic-only fetch
        // with no refinement context — the full pipeline (and the held
        // intent riding along, AC-4) waits for the explicit submit.
        void runSearch(query, { preview: true });
      }, debounceMs);
    };

    // Native predictive-search suppression (YOY-60 AC-3): themes attach
    // their predictive-search listeners directly to this input (or its
    // ancestors), rendering a native suggestions dropdown over our overlay
    // and navigating to /search on Enter. While the widget owns the input,
    // its handling runs from document-level CAPTURE listeners that stop
    // propagation before the theme's listeners ever fire — target-phase
    // and bubble listeners included. Once inert, every handler returns
    // without touching the event, restoring native behavior untouched
    // (YOY-48 AC-2).
    // `focus` does not bubble but capture still descends to the target, so
    // this shields listeners attached directly to the input; the `focusin`
    // twin shields delegated ancestor listeners.
    // No overlay.open() here (YOY-67 AC-6): focusing the input renders
    // nothing until a first query produces a loading state or response —
    // the shield below stays, because native predictive suppression
    // (YOY-60 AC-3) is about the theme's listeners, not our overlay.
    document.addEventListener(
      "focus",
      (event) => {
        if (inert || event.target !== input) {
          return;
        }
        event.stopPropagation();
        // Refocusing re-engages the widget (Enter searches in-widget again)
        // without rendering anything (YOY-67 AC-6).
        dismissed = false;
      },
      true,
    );
    document.addEventListener(
      "focusin",
      (event) => {
        if (inert || event.target !== input) {
          return;
        }
        event.stopPropagation();
      },
      true,
    );

    document.addEventListener(
      "input",
      (event) => {
        if (inert || event.target !== input) {
          return;
        }
        event.stopPropagation();
        onType();
      },
      true,
    );

    /**
     * Explicit submit (YOY-52 AC-14, now the YOY-68 AC-2 submit action):
     * Enter or the theme's submit button runs the current query through the
     * FULL pipeline now — classification, AI route, chips, refinement —
     * skipping any pending preview debounce. Navigation stays suppressed by
     * the callers.
     */
    const searchNow = (): void => {
      debouncePending = false;
      window.clearTimeout(debounceTimer);
      const query = input.value.trim();
      if (query === "") {
        overlay.showIdle();
        return;
      }
      void runSearch(
        query,
        heldIntent !== null ? { previousIntent: heldIntent } : undefined,
      );
    };

    // Enter must neither submit the theme's form nor feed a theme keydown
    // listener that navigates to /search itself, while the overlay is open
    // (AC-1/YOY-60 AC-3); once inert or closed, Enter submits natively.
    document.addEventListener(
      "keydown",
      (event) => {
        if (inert || event.target !== input) {
          return;
        }
        event.stopPropagation();
        if (event.key === "Enter" && !dismissed) {
          event.preventDefault();
          searchNow();
        }
        if (event.key === "Escape" && (overlay.isOpen() || searchActive())) {
          // Mirrors the document-level Escape handler below, which this
          // stopPropagation would otherwise starve while the input has
          // focus: preventDefault stops the browser clearing a
          // type="search" input (AC-6). Escape also cancels a pending or
          // in-flight search before the overlay ever opened (YOY-69 AC-2)
          // — otherwise the debounce firing would open the overlay the
          // shopper just declined.
          event.preventDefault();
          dismiss();
        }
      },
      true,
    );

    // The magnifier is a submit button: suppress the form's native
    // navigation to /search while the overlay is open, wherever the submit
    // originates — and run the search it asked for immediately (YOY-52
    // AC-14) instead of leaving the button a no-op.
    document.addEventListener(
      "submit",
      (event) => {
        if (inert || input.form === null || event.target !== input.form) {
          return;
        }
        if (!dismissed) {
          event.preventDefault();
          event.stopPropagation();
          searchNow();
        }
      },
      true,
    );

    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        !inert &&
        (overlay.isOpen() || searchActive())
      ) {
        // preventDefault stops the browser clearing a type="search" input —
        // reopening must retain the query text (AC-6), and the clear would
        // also fire an input event that reopened the overlay. Dismissal
        // cancels pending and in-flight searches too (YOY-69 AC-2).
        event.preventDefault();
        dismiss();
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
