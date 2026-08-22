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

/** Attributes whose value is a URL the browser will follow or execute. */
const URL_ATTRIBUTES = new Set(["href", "src", "action"]);

/**
 * Strip the inline-script vectors from fetched theme markup before it is
 * attached to the live document (YOY-96 AC-1 / AC-4). `parseHtml` parses
 * inertly and the callers drop `<script>` elements, but an element injected
 * into the host's light DOM arrives with its `on*` handler attributes and
 * `javascript:` URLs intact — and those become live the moment it is
 * attached. So, for the root and every element under it: drop every
 * attribute whose name starts with `on`, and drop `href` / `src` / `action`
 * whose trimmed value starts with `javascript:` (case-insensitively). One
 * implementation for the alternate-template card, the harvested card, and
 * the full-page shell; nothing else about the markup is touched.
 */
export function sanitizeThemeMarkup(root: Element): void {
  const elements = [root, ...root.querySelectorAll("*")];
  for (const element of elements) {
    // Snapshot first: removing while iterating `attributes` skips entries.
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
      } else if (
        URL_ATTRIBUTES.has(name) &&
        attribute.value.trim().toLowerCase().startsWith("javascript:")
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
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

/**
 * The results view's URL for a query, on the given page: the theme's own
 * search URL. Page 1 carries no `page` parameter, exactly as the theme's own
 * first results page does (YOY-107).
 */
export function resultsViewUrl(
  config: NativeRenderConfig,
  query: string,
  page = 1,
): string {
  const params = new URLSearchParams();
  params.set(config.page.queryParam, query);
  if (page > 1) {
    params.set(PAGE_PARAM, String(page));
  }
  return `${resolveSearchPath(config)}?${params.toString()}`;
}

/**
 * The theme's own page parameter (Shopify: `page`, 1-based). The results
 * view's URL carries it so a reload or a shared link lands on the same page
 * of the same query.
 */
export const PAGE_PARAM = "page";

/** Read a 1-based page number from a URL's search params; 1 when absent or
 * unusable — a URL is shopper-editable and must never render nothing. */
export function pageFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get(PAGE_PARAM);
  const page = Number(raw);
  return Number.isInteger(page) && page > 0 ? page : 1;
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
  /**
   * The theme's pagination container and the pieces needed to rebuild it for
   * our result set (YOY-107): the list its items live in, and a detached
   * clone of one item to stamp per page. Null when the theme's search page
   * rendered no pagination — a single-page shell — in which case the view
   * shows every result on one page rather than inventing a control.
   */
  pagination: {
    wrapper: HTMLElement;
    list: HTMLElement;
    item: HTMLElement;
  } | null;
}

export interface PageMirrorOptions {
  config: NativeRenderConfig;
  /** The widget's results section (chips, statuses, grid). */
  section: HTMLElement;
  /** Called with the theme's results-list classes when the shell attaches. */
  onListClass: (className: string) => void;
  /**
   * The shopper navigated out of the results view (Back, or Forward past
   * it): the view is gone and any search still running for it is work they
   * have walked away from — the widget cancels it, exactly as it cancels on
   * Escape. Without this a response landing after the shopper left would
   * re-enter the view and push a fresh history entry over the page they
   * went back to.
   */
  onLeave: () => void;
}

export interface PageMirror {
  /**
   * Enter the results view for `query` now — bare until the shell arrives
   * (fetched on first entry, in parallel with the cards), then wrapped —
   * and record the history entry. Idempotent while entered: a new query
   * only updates the URL in place, so Back always returns to the origin.
   */
  enter(query: string, page?: number): void;
  /** Resolves once the shell has settled (attached, or unavailable). */
  ready(): Promise<void>;
  /** Rewrite the theme's furniture: count line (hidden while `null`) and
   * the template's own search input. */
  setResult(query: string, count: number | null): void;
  /**
   * Page our result set with the THEME's own pagination markup (YOY-107):
   * one item per page, cloned from the theme's own item, the current one
   * marked the theme's way. `pageCount <= 1` hides the control, exactly as
   * a theme renders no pagination for a single page. A shell without usable
   * pagination markup renders none — the results still all exist, on one
   * page. Selecting a page calls `onSelect`; the widget re-renders that
   * page's cards and moves the URL, so no navigation happens.
   */
  setPages(options: {
    pageCount: number;
    current: number;
    onSelect: (page: number) => void;
  }): void;
  /**
   * Leave the results view — origin content restored, shell detached but
   * kept (Forward re-enters it) — and pop the history entry this mirror
   * pushed, so the URL returns to the origin page.
   *
   * `history.back()` is asynchronous, and the shopper can start a new
   * search before its popstate lands (the view is entered from the loading
   * state now, YOY-106): that popstate is this mirror's own, so it never
   * tears the view down, and when a new search has already re-entered, the
   * results entry the late back stole is pushed again.
   */
  exit(): void;
  isEntered(): boolean;
  /**
   * Whether the theme's search page gave us pagination markup to mirror
   * (YOY-107). False until the shell settles, and false forever when the
   * shell is unavailable or renders none — in which case the consumer must
   * show the whole set on one page rather than leaving results behind a
   * control that does not exist.
   */
  canPage(): boolean;
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
  /** History pops this mirror asked for itself and has yet to see. */
  let selfBacks = 0;

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
      // The whole of the theme's main content is about to be attached live:
      // inline handlers and javascript: URLs go with the scripts (AC-4).
      sanitizeThemeMarkup(root);
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
      // The theme's pagination, kept and rewired rather than stripped
      // (YOY-107). Its rendered links describe the SHELL's result set, so it
      // starts hidden and stays hidden until our own page count is known.
      let pagination: Shell["pagination"] = null;
      const wrapper = root.querySelector<HTMLElement>(
        page.pagination.selector,
      );
      const paginationList = wrapper?.querySelector<HTMLElement>(
        page.pagination.listSelector,
      );
      const paginationItem = paginationList?.querySelector<HTMLElement>(
        page.pagination.itemSelector,
      );
      if (
        wrapper !== null &&
        wrapper !== undefined &&
        paginationList !== null &&
        paginationList !== undefined &&
        paginationItem !== null &&
        paginationItem !== undefined
      ) {
        wrapper.hidden = true;
        pagination = {
          wrapper,
          list: paginationList,
          item: paginationItem.cloneNode(true) as HTMLElement,
        };
      } else if (wrapper !== null && wrapper !== undefined) {
        // A wrapper with no recognizable item template is furniture we
        // cannot drive; hiding it beats showing the theme's own page links.
        wrapper.hidden = true;
      }

      const nodes = [...root.childNodes];
      for (const node of nodes) {
        if (node instanceof Element) {
          node.setAttribute(MIRROR_SHELL_ATTR, "");
        }
      }
      return {
        nodes,
        list,
        countTexts,
        countElements,
        termInputs,
        pagination,
      };
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

  function pushEntry(): void {
    try {
      window.history.pushState(
        { [MIRROR_HISTORY_KEY]: true },
        "",
        resultsViewUrl(config, query),
      );
    } catch {
      // History unavailable (sandboxed document): the view still shows.
    }
  }

  function onPopState(event: PopStateEvent): void {
    if (selfBacks > 0 && !isMirrorState(event.state)) {
      // Our own `exit()` back, landing late. `exit()` already detached, so
      // there is nothing to tear down. A new search may have re-entered the
      // view meanwhile: if this back also undid the entry that search
      // pushed — the live state is no longer the mirror's — push it again.
      selfBacks -= 1;
      if (entered && !isMirrorState(window.history.state)) {
        pushEntry();
      }
      return;
    }
    if (isMirrorState(event.state)) {
      if (!entered && everEntered) {
        attach();
      }
    } else if (entered) {
      detach();
      options.onLeave();
    }
  }
  window.addEventListener("popstate", onPopState);

  return {
    enter(next, nextPage = 1) {
      if (next !== query) {
        // A different query: the count line stays hidden until its results
        // land, never stating the previous query's count for this one.
        count = null;
      }
      query = next;
      const url = resultsViewUrl(config, next, nextPage);
      if (!entered) {
        attach();
        try {
          if (isMirrorState(window.history.state)) {
            window.history.replaceState({ [MIRROR_HISTORY_KEY]: true }, "", url);
          } else {
            pushEntry();
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
    setPages({ pageCount, current, onSelect }) {
      const pagination = shell?.pagination;
      if (pagination === null || pagination === undefined) {
        return; // No theme pagination to mirror; one page holds everything.
      }
      if (pageCount <= 1) {
        pagination.wrapper.hidden = true;
        pagination.list.replaceChildren();
        return;
      }
      const { currentClass, linkSelector } = config.page.pagination;
      const items: HTMLElement[] = [];
      for (let number = 1; number <= pageCount; number += 1) {
        const item = pagination.item.cloneNode(true) as HTMLElement;
        const link = item.matches(linkSelector)
          ? item
          : item.querySelector<HTMLElement>(linkSelector);
        if (link === null) {
          continue;
        }
        link.textContent = String(number);
        if (link instanceof HTMLAnchorElement) {
          // A real theme URL: opening it in a new tab lands on the theme's
          // own results page for the same query and page.
          link.href = resultsViewUrl(config, query, number);
        }
        if (currentClass !== "") {
          link.classList.toggle(currentClass, number === current);
        }
        if (number === current) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
        link.addEventListener("click", (event) => {
          // In-place paging: the results are already in memory, so this is
          // a render, not a navigation.
          event.preventDefault();
          onSelect(number);
        });
        items.push(item);
      }
      pagination.list.replaceChildren(...items);
      pagination.wrapper.hidden = items.length === 0;
    },
    exit() {
      const onOwnEntry = entered && isMirrorState(window.history.state);
      if (entered) {
        detach();
      }
      if (!onOwnEntry) {
        return;
      }
      selfBacks += 1;
      try {
        window.history.back();
      } catch {
        selfBacks -= 1; // The origin content is restored regardless.
      }
    },
    isEntered() {
      return entered;
    },
    canPage() {
      return shell !== null && shell !== undefined && shell.pagination !== null;
    },
    destroy() {
      window.removeEventListener("popstate", onPopState);
      if (entered) {
        detach();
      }
    },
  };
}
