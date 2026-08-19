import { isMirrorState, pageFromSearch } from "./native-page";
import {
  createNativeComposite,
  createNativeSurface,
  resolveNativeRender,
} from "./native-render";
import type { NativeRenderOverrides } from "./native-render.config";
import { createOverlay, ROOT_TESTID } from "./overlay";
import {
  createSearchClient,
  SearchTimeoutError,
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
  /**
   * Budget for the classic rescue that follows a timed-out search (YOY-108
   * AC-4). Both budgets are init-configurable; neither default changes in
   * this issue (NG-1).
   */
  searchFallbackTimeoutMs?: number;
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
 * EVERY theme search input on the page (YOY-99 AC-1), by the common
 * storefront patterns: dedicated search inputs, and `q` inputs of forms
 * posting to /search — a header modal input and an in-page search bar are
 * both taken over. Document order, deduplicated. The widget's own overlay
 * never carries an input, so a mounted widget can't match.
 */
export function findThemeSearchInputs(): HTMLInputElement[] {
  const found = new Set<HTMLInputElement>();
  for (const direct of document.querySelectorAll<HTMLInputElement>(
    'input[type="search"]',
  )) {
    found.add(direct);
  }
  for (const form of document.querySelectorAll<HTMLFormElement>(
    'form[action*="/search"]',
  )) {
    for (const q of form.querySelectorAll<HTMLInputElement>(
      'input[name="q"]',
    )) {
      found.add(q);
    }
  }
  return [...found];
}

/** The first theme search input, in document order; kept for callers of
 * the pre-YOY-99 single-input contract. */
export function findThemeSearchInput(): HTMLInputElement | null {
  return findThemeSearchInputs()[0] ?? null;
}

/**
 * Reset the theme's own search UI around a taken-over input after a submit
 * (YOY-99 AC-2): a native submit would have navigated away, closing any
 * search modal/drawer and its page dim with the page; a takeover submit
 * stays on the page, so the widget must close it explicitly. Generic by
 * ancestor structure — an open `<details>` (Dawn's `details-modal` header
 * search, closed through the custom element's own `close()` when it has
 * one, so focus traps and body classes unwind the theme's way), an open
 * `<dialog>`, or a `role="dialog"`/`aria-modal` container owned by a custom
 * element with `close()`. Then the body-scroll lock convention
 * (`overflow-hidden*` classes on body/html) is cleared as a fallback.
 * Never throws: a theme whose modal refuses to close leaves the page as a
 * native submit would have left it — that is the theme's own behavior.
 */
export function resetThemeSearchUi(input: HTMLInputElement): void {
  const closeVia = (element: Element | null): boolean => {
    const closer = element as (Element & { close?: unknown }) | null;
    if (closer !== null && typeof closer.close === "function") {
      try {
        (closer.close as () => void).call(closer);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };
  const customHost = (element: Element): Element | null => {
    let node: Element | null = element;
    while (node !== null && node !== document.body) {
      if (node.tagName.includes("-")) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  };
  let node: Element | null = input.parentElement;
  while (node !== null && node !== document.body) {
    if (node instanceof HTMLDetailsElement && node.open) {
      // Prefer the theme's own close routine on the wrapping custom
      // element (Dawn: `<details-modal>` around the `<details>`).
      if (!closeVia(customHost(node.parentElement ?? node))) {
        node.open = false;
      }
    } else if (node instanceof HTMLDialogElement && node.open) {
      node.close();
    } else if (
      node.getAttribute("role") === "dialog" ||
      node.getAttribute("aria-modal") === "true"
    ) {
      closeVia(customHost(node));
    }
    node = node.parentElement;
  }
  for (const root of [document.body, document.documentElement]) {
    for (const className of [...root.classList]) {
      if (className.startsWith("overflow-hidden")) {
        root.classList.remove(className);
      }
    }
  }
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

    const initialInputs = findThemeSearchInputs();
    if (initialInputs.length === 0) {
      return;
    }

    // Global takeover (YOY-99 AC-1): every theme search input is bound, and
    // inputs mounted after init (a lazily rendered header modal) join as
    // they appear. Handlers key on membership, not identity, so typing and
    // Enter/submit behave identically from any of them (AC-3). `input` is
    // the one the shopper engaged last — the one whose value a search
    // reads and a "new search" clears — never a fixed first-match.
    // The input placeholder is widget chrome (YOY-50 AC-1/AC-2): the
    // catalog owns it in both locales while the widget is active. Going
    // inert restores each theme placeholder — the page must end exactly as
    // without the app (YOY-48 AC-2).
    const strings = getStrings(config.locale);
    const themePlaceholders = new Map<HTMLInputElement, string>();
    const bindInput = (candidate: HTMLInputElement): void => {
      if (themePlaceholders.has(candidate)) {
        return;
      }
      themePlaceholders.set(candidate, candidate.placeholder);
      candidate.placeholder = strings.inputPlaceholder;
    };
    const isBound = (target: EventTarget | null): target is HTMLInputElement =>
      target instanceof HTMLInputElement && themePlaceholders.has(target);
    for (const candidate of initialInputs) {
      bindInput(candidate);
    }
    let input: HTMLInputElement = initialInputs[0];
    const engage = (target: HTMLInputElement): void => {
      input = target;
    };
    const inputObserver = new MutationObserver(() => {
      if (inert) {
        return;
      }
      for (const candidate of findThemeSearchInputs()) {
        bindInput(candidate);
      }
    });
    inputObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    const client = createSearchClient({
      basePath: config.proxyBasePath,
      timeoutMs: config.searchTimeoutMs,
      fallbackTimeoutMs: config.searchFallbackTimeoutMs,
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
    /**
     * The query the native results view is currently showing or fetching.
     * Distinct from `lastQuery` (refinement memory, which only a SETTLED
     * submitted response updates): the mirror is entered at the loading
     * state now (YOY-106 AC-1), so its URL, its template input, and the
     * theme's count line must name the query in flight from the moment the
     * search starts — not the previous one.
     */
    let viewQuery = "";
    /**
     * The page a resumed results view opens on (YOY-107): a results-view URL
     * loaded fresh names its own page, and the view must land there rather
     * than silently on page 1. Consumed by the first render and reset, so
     * every later search starts at page 1 — a new set makes the old page
     * meaningless.
     */
    let resumePage = 1;

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
    // the host document and keystroke previews are the theme's own
    // predictive search (YOY-101) — the shadow overlay stays for the
    // loading/failure states that precede a native view.
    const nativeConfig = resolveNativeRender(config.nativeRender);
    const overlay =
      nativeConfig === null
        ? shadowOverlay
        : createNativeComposite(
            shadowOverlay,
            createNativeSurface({
              locale: config.locale,
              config: nativeConfig,
              // The native view owns no close / new-search control (YOY-82
              // AC-1): Back, Escape, and the theme's own input serve them.
              // The submitted query the view is showing: set when the
              // search starts, so the native view's URL and the theme's
              // count line name it (YOY-100 AC-2/AC-4) from the loading
              // state onward (YOY-106 AC-1).
              query: () => viewQuery,
              // Leaving the view (Back, or Forward past it) cancels the
              // search it was showing, exactly as Escape does: the shopper
              // walked away, and a late response must not pull them back
              // into the results view they just left.
              onLeave: () => {
                dismiss();
              },
              initialPage: () => {
                const page = resumePage;
                resumePage = 1;
                return page;
              },
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
      inputObserver.disconnect();
      for (const [bound, themePlaceholder] of themePlaceholders) {
        bound.placeholder = themePlaceholder;
      }
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

    /**
     * The classic rescue (YOY-108 AC-1): re-ask the same query down the
     * zero-LLM keyword path on its own short budget and render the answer
     * as the submitted response it is, in whichever surface is active.
     * Resolves true when the shopper got results, false when the rescue
     * failed in turn and the caller should fall through to the failure
     * state (AC-2).
     *
     * The rescued response is NOT attributable: it rides the wire's
     * existing classic-only mode, which writes no SearchEvent row
     * server-side (YOY-68 AC-3), so `currentSearchId` stays null and a
     * click on a rescued card fires no beacon. That is the cost of adding
     * no server parameter (YOY-108 NG-2) and is called out on the PR.
     */
    const rescueWithClassic = async (
      query: string,
      sequence: number,
    ): Promise<boolean> => {
      let response;
      try {
        response = await client.searchClassic(query, getSessionId());
      } catch {
        return false; // AC-2: the failure state is now the honest answer.
      }
      if (inert || sequence !== requestSequence) {
        return true; // Superseded; rendering nothing is correct, not a fail.
      }
      settledSequence = sequence;
      // AC-3: the shopper got results, so this search is a rescue, not a
      // failure — the self-removal counter must never fire on AI slowness.
      consecutiveFailures = 0;
      currentSearchId = null;
      lastQuery = query;
      // A classic response carries no intent, exactly as a server-degraded
      // one does; refinement has nothing to hold either way.
      heldIntent = response.intent;
      overlay.showResponse(response, { onCardClick, onChipRemove });
      return true;
    };

    const runSearch = async (
      query: string,
      context?: SearchRequestContext,
    ): Promise<void> => {
      const preview = context?.preview === true;
      const sequence = ++requestSequence;
      if (!preview) {
        // The native view enters at the loading state (YOY-106 AC-1), so
        // the query it names has to be known before the request goes out.
        viewQuery = query;
      }
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
      } catch (error) {
        if (inert || sequence !== requestSequence) {
          return; // A newer keystroke (or a dismissal) superseded this.
        }
        // Instant fallback (YOY-108 AC-1, PRD capability 6): a SUBMITTED
        // search that ran out its own budget is not an answer of "nothing
        // exists" — the AI path is merely slow, and the classic path can
        // answer the same query immediately. Rescue it before considering
        // any failure state. Previews are already the classic path, so a
        // preview timing out has nothing to fall back to.
        if (error instanceof SearchTimeoutError && !preview) {
          if (await rescueWithClassic(query, sequence)) {
            return;
          }
          if (inert || sequence !== requestSequence) {
            return; // Superseded while the rescue was in flight.
          }
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
    // Native mode (YOY-101): keystroke previews RIDE the theme's own
    // predictive search — the shopper sees exactly what they would see
    // with the app embed off, and our surface appears only on submit. So
    // focus/focusin/input propagate untouched to the theme's listeners
    // (AC-1), typing sends nothing to the proxy (AC-3), and only Enter and
    // the form submit are intercepted (AC-2). The overlay path keeps the
    // shield and the owned preview box exactly as shipped (AC-4).
    const themePredictive = nativeConfig !== null;

    document.addEventListener(
      "focus",
      (event) => {
        if (inert || !isBound(event.target)) {
          return;
        }
        if (!themePredictive) {
          event.stopPropagation();
        }
        engage(event.target);
        // Refocusing re-engages the widget (Enter searches in-widget again)
        // without rendering anything (YOY-67 AC-6).
        dismissed = false;
      },
      true,
    );
    document.addEventListener(
      "focusin",
      (event) => {
        if (inert || !isBound(event.target)) {
          return;
        }
        if (!themePredictive) {
          event.stopPropagation();
        }
        engage(event.target);
      },
      true,
    );

    document.addEventListener(
      "input",
      (event) => {
        if (inert || !isBound(event.target)) {
          return;
        }
        engage(event.target);
        if (themePredictive) {
          // Typing re-engages the widget for the next Enter (as on the
          // overlay path) and otherwise belongs to the theme: no debounce,
          // no preview request, nothing rendered (YOY-101 AC-1/AC-3).
          dismissed = false;
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
      // Theme search-UI reset (YOY-99 AC-2): on the native view the results
      // render in the page itself, so the theme's search modal/drawer and
      // page dim — which a native submit's navigation would have discarded
      // — must close now, not on a stray click. The overlay path keeps the
      // theme UI as it was: its floating panel sits above the theme's
      // modal, and the input the shopper is typing in lives inside it.
      if (nativeConfig !== null) {
        resetThemeSearchUi(input);
      }
    };

    // Enter must neither submit the theme's form nor feed a theme keydown
    // listener that navigates to /search itself, while the overlay is open
    // (AC-1/YOY-60 AC-3); once inert or closed, Enter submits natively.
    document.addEventListener(
      "keydown",
      (event) => {
        if (inert || !isBound(event.target)) {
          return;
        }
        engage(event.target);
        if (event.key === "Enter" && !dismissed) {
          // The theme's own Enter listener (a scripted /search navigation)
          // must not fire either: on the native path this is the ONLY key
          // the widget takes from the theme (YOY-101 AC-2) — every other
          // keystroke reaches the theme's predictive search untouched.
          event.stopPropagation();
          event.preventDefault();
          searchNow();
        } else if (!themePredictive) {
          event.stopPropagation();
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
        if (inert || !(event.target instanceof HTMLFormElement)) {
          return;
        }
        const form = event.target;
        const submitted = [...themePlaceholders.keys()].find(
          (bound) => bound.form === form,
        );
        if (submitted === undefined) {
          return;
        }
        engage(submitted);
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

    // Coherent URL state for the native view (YOY-100 AC-4): the results
    // view lives at the theme's own search URL under a marked history
    // entry. Reloading it, or returning to it from a product page (a fresh
    // document — the mirror's DOM is gone), re-runs its query, so the URL
    // means the same thing whichever way the shopper reaches it. Without
    // the marker the theme's own results page stays exactly as it is.
    if (nativeConfig !== null && isMirrorState(window.history.state)) {
      const resumed = new URLSearchParams(window.location.search)
        .get(nativeConfig.page.queryParam)
        ?.trim();
      if (resumed !== undefined && resumed !== "") {
        input.value = resumed;
        // The URL names its page as well as its query (YOY-107), so a
        // reloaded or shared results link lands where it says it does.
        resumePage = pageFromSearch(window.location.search);
        void runSearch(resumed);
      }
    }
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
