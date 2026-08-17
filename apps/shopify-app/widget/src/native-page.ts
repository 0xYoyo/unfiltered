import type { NativeRenderConfig } from "./native-render.config";

/**
 * Full-page mirror (YOY-100, the Mirror Bar): after a takeover submit the
 * shopper is on the THEME's own search-results page — its heading, its
 * results-count line, its containers and layout — holding OUR ranked
 * results, whatever page the search was submitted from. No content of the
 * previously viewed page stays visible.
 *
 * Mechanism: the theme's search page is fetched once per page view for a
 * term whose results page always renders in its results state
 * (`page.shellTerm`, Shopify: `*` = every product), parsed inert, and its
 * main content becomes the "shell". Entering the results view hides the
 * origin page's main-content children in place (inline `display:none`,
 * restored exactly on leave — nodes are never moved, so the theme's own
 * scripts keep their references), appends the shell, and puts the widget's
 * results section where the theme's results list was; the theme's count
 * line is rewritten to our count and the shopper's query. Navigation is
 * `history.pushState` to the theme's search URL for the query, so Back
 * returns the shopper to the page they searched from (same document, no
 * reload) and Forward re-enters the results view; a fresh load of that URL
 * carries the mirror's history state, which main.ts uses to re-run the
 * query. When the shell cannot be fetched (network, unrecognizable page)
 * the section shows bare in the same place — origin content still hidden.
 */

/** Marker on `history.state` for the results-view entry. */
export const MIRROR_HISTORY_KEY = "unfilteredNativeMirror";
/** Attribute on every shell root node in the host document. */
export const MIRROR_SHELL_ATTR = "data-unfiltered-mirror";
/** Attribute on origin main-content elements hidden by the mirror. */
export const MIRROR_HIDDEN_ATTR = "data-unfiltered-origin-hidden";

export function isMirrorState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)[MIRROR_HISTORY_KEY] === true
  );
}

/** Parse fetched storefront HTML into an inert document (scripts never run). */
export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Hoist a stylesheet link into <head> once: fetched theme markup (the
 * alternate card template, the harvested page, the search-page shell) ships
 * its CSS as <link> tags; injecting them per fragment would duplicate them,
 * dropping them would strip the theme's styles on pages that never loaded
 * that stylesheet.
 */
export function ensureStylesheet(link: HTMLLinkElement): void {
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

/**
 * The theme's search route: the takeover's own search form carries the
 * locale-aware route (Shopify: `routes.search_url`, `/he/search` on a
 * Hebrew storefront), so it wins over the configured default.
 */
export function resolveSearchPath(config: NativeRenderConfig): string {
  const form = document.querySelector<HTMLFormElement>(
    `form[action*="${config.page.searchPath}"]`,
  );
  const action = form?.getAttribute("action");
  if (action !== null && action !== undefined && action !== "") {
    try {
      return new URL(action, window.location.href).pathname;
    } catch {
      // Fall through to the configured route.
    }
  }
  return config.page.searchPath;
}

/** The results view's URL for a query: the theme's own search URL. */
export function resultsViewUrl(config: NativeRenderConfig, query: string): string {
  const params = new URLSearchParams();
  params.set(config.page.queryParam, query);
  return `${resolveSearchPath(config)}?${params.toString()}`;
}

/**
 * Rewrite one run of the theme's results-count text: the first digit run
 * (the theme's count) becomes ours, then every occurrence of the shell
 * term becomes the shopper's query — in that order, so digits inside the
 * query can never be mistaken for the count. Wording, language, and
 * markup stay the theme's.
 */
export function substituteCountText(
  text: string,
  values: { count: number; term: string; query: string },
): string {
  let out = text.replace(/\d[\d.,]*/, String(values.count));
  if (values.term !== "") {
    out = out.split(values.term).join(values.query);
  }
  return out;
}

interface Shell {
  /** The fetched page's main-content children, imported into this document. */
  nodes: Node[];
  /** The theme's results list, which the results section replaces. */
  list: HTMLElement;
  /** Text runs of the theme's count line, with their pristine text. */
  countTexts: Array<{ node: Text; original: string }>;
  /** Outermost count-line elements (hidden while no count is known). */
  countElements: HTMLElement[];
  termInputs: HTMLInputElement[];
}

export interface PageMirrorOptions {
  config: NativeRenderConfig;
  /** The widget's results section (chips, statuses, grid). */
  section: HTMLElement;
  /** Called with the theme's results-list classes when the shell attaches. */
  onListClass: (className: string) => void;
}

export interface PageMirror {
  /**
   * Enter the results view for `query` now — bare until the shell arrives
   * (fetched on first entry, in parallel with the cards), then wrapped —
   * and record the history entry. Idempotent while entered: a new query
   * only updates the URL in place, so Back always returns to the origin.
   */
  enter(query: string): void;
  /** Resolves once the shell has settled (attached, or unavailable). */
  ready(): Promise<void>;
  /** Rewrite the theme's furniture: count line (hidden while `null`) and
   * the template's own search input. */
  setResult(query: string, count: number | null): void;
  /** Leave the results view: origin content restored, shell detached but
   * kept (Forward re-enters it). Never touches history. */
  leave(): void;
  isEntered(): boolean;
  /** Leave for good: also drop the popstate listener. */
  destroy(): void;
}

export function createPageMirror(options: PageMirrorOptions): PageMirror {
  const { config, section } = options;
  const { page } = config;

  let entered = false;
  let target: HTMLElement | null = null;
  let hidden: Array<{ element: HTMLElement; display: string }> = [];
  let shellPromise: Promise<Shell | null> | undefined;
  let shell: Shell | null | undefined; // undefined = not settled yet
  let shellAttached = false;
  let query = "";
  let count: number | null = null;
  let everEntered = false;

  async function loadShell(): Promise<Shell | null> {
    try {
      const params = new URLSearchParams();
      params.set(page.queryParam, page.shellTerm);
      const url = `${resolveSearchPath(config)}?${params.toString()}${
        page.shellParams === "" ? "" : `&${page.shellParams}`
      }`;
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) {
        return null;
      }
      const doc = parseHtml(await response.text());
      const main = doc.querySelector(config.mountSelector);
      if (!(main instanceof HTMLElement)) {
        return null;
      }
      const root = document.importNode(main, true);
      root.querySelectorAll("script").forEach((script) => script.remove());
      root
        .querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
        .forEach((link) => {
          ensureStylesheet(link);
          link.remove();
        });
      if (page.stripSelector.trim() !== "") {
        root
          .querySelectorAll(page.stripSelector)
          .forEach((element) => element.remove());
      }
      const list = root.querySelector(page.resultsSelector);
      if (!(list instanceof HTMLElement)) {
        return null;
      }
      const countElements: HTMLElement[] = [];
      if (page.countSelector.trim() !== "") {
        for (const element of root.querySelectorAll<HTMLElement>(
          page.countSelector,
        )) {
          if (!countElements.some((outer) => outer.contains(element))) {
            countElements.push(element);
          }
        }
      }
      const countTexts: Shell["countTexts"] = [];
      for (const element of countElements) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node !== null) {
          if (node instanceof Text) {
            countTexts.push({ node, original: node.data });
          }
          node = walker.nextNode();
        }
      }
      const termInputs =
        page.termInputSelector.trim() === ""
          ? []
          : [
              ...root.querySelectorAll<HTMLInputElement>(
                page.termInputSelector,
              ),
            ];
      const nodes = [...root.childNodes];
      for (const node of nodes) {
        if (node instanceof Element) {
          node.setAttribute(MIRROR_SHELL_ATTR, "");
        }
      }
      return { nodes, list, countTexts, countElements, termInputs };
    } catch {
      return null;
    }
  }

  function ensureShell(): Promise<Shell | null> {
    if (shellPromise === undefined) {
      shellPromise = loadShell().then((loaded) => {
        shell = loaded;
        if (entered && loaded !== null && !shellAttached) {
          attachShell(loaded);
        }
        return loaded;
      });
    }
    return shellPromise;
  }

  function applyFurniture(): void {
    if (shell === null || shell === undefined) {
      return;
    }
    for (const element of shell.countElements) {
      element.hidden = count === null;
    }
    if (count !== null) {
      for (const { node, original } of shell.countTexts) {
        node.data = substituteCountText(original, {
          count,
          term: page.shellTerm,
          query,
        });
      }
    }
    for (const input of shell.termInputs) {
      input.value = query;
    }
  }

  function attachBare(): void {
    if (target === null) {
      return;
    }
    section.className = `unfiltered-native ${config.sectionClass}`.trim();
    target.prepend(section);
  }

  function attachShell(loaded: Shell): void {
    if (target === null) {
      return;
    }
    if (loaded.list.parentNode !== null) {
      // First attach: the theme's list gives way to our section, which
      // inherits its classes (the theme's real grid classes).
      options.onListClass(loaded.list.className);
      section.className = "unfiltered-native";
      loaded.list.replaceWith(section);
      loaded.nodes = loaded.nodes.map((node) =>
        node === loaded.list ? section : node,
      );
    }
    target.append(...loaded.nodes);
    shellAttached = true;
    applyFurniture();
  }

  function hideOrigin(): void {
    if (target === null) {
      return;
    }
    hidden = [];
    for (const child of [...target.children]) {
      if (!(child instanceof HTMLElement) || child === section) {
        continue;
      }
      hidden.push({ element: child, display: child.style.display });
      child.style.display = "none";
      child.setAttribute(MIRROR_HIDDEN_ATTR, "");
    }
  }

  function restoreOrigin(): void {
    for (const { element, display } of hidden) {
      element.style.display = display;
      element.removeAttribute(MIRROR_HIDDEN_ATTR);
    }
    hidden = [];
  }

  function attach(): void {
    const found = document.querySelector<HTMLElement>(config.mountSelector);
    target = found ?? document.body;
    // A page with no recognizable main content keeps its content: hiding
    // the whole body would take the theme's header — and the search input
    // the shopper is using — with it.
    if (found !== null) {
      hideOrigin();
    }
    entered = true;
    everEntered = true;
    if (shell !== null && shell !== undefined) {
      attachShell(shell);
    } else {
      attachBare();
      void ensureShell();
    }
    window.scrollTo(0, 0);
  }

  function detach(): void {
    if (shellAttached && shell !== null && shell !== undefined) {
      for (const node of shell.nodes) {
        node.parentNode?.removeChild(node);
      }
      shellAttached = false;
    } else {
      section.remove();
    }
    restoreOrigin();
    entered = false;
    target = null;
  }

  function onPopState(event: PopStateEvent): void {
    if (isMirrorState(event.state)) {
      if (!entered && everEntered) {
        attach();
      }
    } else if (entered) {
      detach();
    }
  }
  window.addEventListener("popstate", onPopState);

  return {
    enter(next) {
      if (next !== query) {
        // A different query: the count line stays hidden until its results
        // land, never stating the previous query's count for this one.
        count = null;
      }
      query = next;
      const url = resultsViewUrl(config, next);
      if (!entered) {
        attach();
        try {
          if (isMirrorState(window.history.state)) {
            window.history.replaceState({ [MIRROR_HISTORY_KEY]: true }, "", url);
          } else {
            window.history.pushState({ [MIRROR_HISTORY_KEY]: true }, "", url);
          }
        } catch {
          // History unavailable (sandboxed document): the view still shows.
        }
      } else {
        try {
          const current = window.location.pathname + window.location.search;
          if (current !== url) {
            window.history.replaceState({ [MIRROR_HISTORY_KEY]: true }, "", url);
          }
        } catch {
          // As above.
        }
      }
      applyFurniture();
    },
    async ready() {
      await ensureShell();
    },
    setResult(nextQuery, nextCount) {
      query = nextQuery;
      count = nextCount;
      applyFurniture();
    },
    leave() {
      if (entered) {
        detach();
      }
    },
    isEntered() {
      return entered;
    },
    destroy() {
      window.removeEventListener("popstate", onPopState);
      if (entered) {
        detach();
      }
    },
  };
}
