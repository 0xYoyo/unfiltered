import "./widget.css";

/**
 * Storefront search widget (YOY-43): the scaffold the M3 widget chain builds
 * on. This milestone mounts a root element with a stable test id and a
 * visible search input — no real search behavior, no endpoint calls, no
 * theme-search interception (NG-1). It runs inside merchant themes, so
 * `init` must never throw into the host page: any unexpected DOM failure is
 * contained here.
 */

/** Configuration the theme app embed block passes into `init`. */
export interface WidgetConfig {
  /** Storefront locale ISO code, e.g. "en" or "he". */
  locale: string;
  /** The shop's permanent .myshopify.com domain. */
  shopDomain: string;
}

/** Stable hook for UI tests and later chain issues; never rename casually. */
export const ROOT_TESTID = "unfiltered-widget-root";

/**
 * The theme's own search form, when the host page has one. Absence is normal
 * (password pages, headless-ish themes) and never an error; later issues use
 * this to take over theme search where it exists.
 */
export function findThemeSearchForm(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>('form[action*="/search"]');
}

/**
 * Mount the widget onto the host page. Idempotent: a second call finds the
 * existing root and does nothing. Never throws.
 */
export function init(config: WidgetConfig): void {
  try {
    if (document.querySelector(`[data-testid="${ROOT_TESTID}"]`) !== null) {
      return;
    }

    const themeSearchForm = findThemeSearchForm();

    const root = document.createElement("div");
    root.setAttribute("data-testid", ROOT_TESTID);
    root.setAttribute("data-locale", config.locale);
    root.setAttribute("data-shop-domain", config.shopDomain);
    root.setAttribute(
      "data-theme-search-form",
      themeSearchForm === null ? "absent" : "found",
    );
    root.className = "unfiltered-widget";

    const input = document.createElement("input");
    input.type = "search";
    input.className = "unfiltered-widget__input";
    input.placeholder = "Search";
    input.setAttribute("aria-label", "Search products");

    root.appendChild(input);
    document.body.appendChild(root);
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
