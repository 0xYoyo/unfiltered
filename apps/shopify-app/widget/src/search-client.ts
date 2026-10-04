/**
 * Client for the app-proxy endpoints (YOY-46 contract, consumed here per
 * YOY-48 NG-3: no server changes, the widget speaks the existing contract).
 * Same-origin by construction — the proxy lives on the shop domain.
 *
 * Transport is GET with query parameters (YOY-60 AC-1): Shopify's
 * shop-domain app-proxy edge rejects any proxy POST carrying an `Origin`
 * header with a bodied 400 before forwarding, and browsers attach `Origin`
 * to every fetch POST — so no browser POST can ride the proxy. GET with the
 * same `Origin` header forwards fine (header-bisection evidence on the
 * YOY-60 issue), so both the search request and the click beacon ride GET.
 */

/** One result card as the proxy serves it. */
export interface ProxyResult {
  productId: string;
  title: string;
  /**
   * Server-resolved product link (YOY-87, LEAK-2), rendered verbatim as the
   * card's href; null means the card renders without a link. The widget
   * never composes a product URL itself.
   */
  url: string | null;
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  /**
   * The product passed a color filter without color evidence (YOY-67 AC-5):
   * rendered de-emphasized with a label. Optional so the widget tolerates
   * responses from a server predating the field.
   */
  colorUnknown?: boolean;
  /**
   * How the result misses a stated wish (YOY-147 AC-9, YOY-149 AC-12): a
   * template name and its values, rendered as the card's one label line
   * (YOY-151). Null when it misses nothing; absent from the old engine.
   */
  label?: ProxyLabel | null;
}

/** A label as the proxy serves it; the widget fills the template (YOY-151). */
export interface ProxyLabel {
  template: string;
  values: string[];
}

/** One applied-constraint chip as the proxy serves it. */
export interface ProxyChip {
  field:
    | "category"
    | "priceMin"
    | "priceMax"
    | "colorsInclude"
    | "colorsExclude"
    | "attributesExclude"
    | "attributesInclude"
    | "occasion"
    | "availability"
    // Engine v2 (YOY-149): the shopper's size as typed, and one exclusion
    // field for any excluded term.
    | "size"
    | "exclude";
  value: string;
  /**
   * The ISO currency of an engine v2 price chip's number (YOY-149), when
   * the shopper's query or the store named one. Display-only; absent on
   * v1 chips, whose currency rides the echoed intent.
   */
  currency?: string;
}

/**
 * One removed engine v2 chip as it rides `removedChips` (YOY-149 AC-15):
 * the field and value are what identify it; a currency is harmless.
 */
export type RemovedChip = Pick<ProxyChip, "field" | "value">;

/**
 * The proxy's echoed intent (YOY-49): held client-side between requests and
 * sent back verbatim as `previousIntent` — the widget never reads inside it.
 */
export type ProxyIntent = Record<string, unknown>;

/** The search response as the widget consumes it (YOY-46 contract). */
export interface ProxySearchResponse {
  searchId: string;
  route: "classic" | "ai";
  degraded: boolean;
  results: ProxyResult[];
  chips: ProxyChip[];
  intent: ProxyIntent | null;
  /** Classic near-misses; present only on AI zero-hit responses. */
  closeMatches?: ProxyResult[];
  /** Constraint names the server relaxed to find them (YOY-111). */
  closeMatchesRelaxed?: string[];
  /**
   * The page `results` holds and the size of the whole result order
   * (YOY-146): present on every paged response. Absent from a server that
   * predates server-side pages, whose `results` is then the whole set.
   */
  page?: number;
  totalCount?: number;
  /**
   * The text the next submitted search sends as `previousQuery` (YOY-150
   * AC-3): present on Engine v2 responses; held in memory only (AC-6).
   */
  carry?: string;
  /**
   * A second reading of the search (YOY-150 AC-7), rendered as the chip
   * "{reading} instead?" at the start of the chip row.
   */
  otherReading?: string;
  /**
   * Present (true) only when the judge missed its deadline (YOY-148 AC-7):
   * this page's labels arrive later from the labels endpoint (YOY-151 AC-8).
   */
  labelsPending?: true;
}

/** One page of a submitted search (YOY-146 AC-1): 1-based, and its size. */
export interface PageRequest {
  page: number;
  pageSize: number;
}

/** Optional context a search request carries (YOY-49). */
export interface SearchRequestContext {
  /** The previous response's echoed intent, for refinement. */
  previousIntent?: ProxyIntent;
  /** Chip the shopper dismissed; requires `previousIntent`. */
  removeChip?: ProxyChip;
  /**
   * Engine v2 chip removal (YOY-149 AC-15): EVERY chip the shopper has
   * removed in this search chain, the newest included. A v2 response
   * echoes no intent, so the same query is re-asked with this list instead
   * of `previousIntent`/`removeChip`.
   */
  removedChips?: readonly RemovedChip[];
  /**
   * The held `carry` of the last Engine v2 response (YOY-150 AC-1): the
   * search refines or replaces that chain. Never on a preview or the
   * classic rescue.
   */
  previousQuery?: string;
  /**
   * A new search the shopper submitted (YOY-150): its response's `carry`
   * replaces the held one. Client-side only, never on the wire.
   */
  submitted?: boolean;
  /**
   * Keystroke preview (YOY-68): the request rides `mode=preview` and the
   * server serves classic-only results with no logging and no AI spend.
   * Mutually exclusive with `previousIntent`/`removeChip` by contract.
   */
  preview?: boolean;
  /**
   * The classic rescue of a SUBMITTED search (YOY-96 AC-9): the request
   * rides `mode=classic` and the server serves the same zero-LLM keyword
   * results as a preview, but logs it as a real SearchEvent (routeReason
   * "client-timeout-rescue") and returns an attributable searchId. Mutually
   * exclusive with `preview`, `previousIntent`, and `removeChip`.
   */
  classic?: boolean;
  /**
   * The page to fetch (YOY-146 AC-1): every submitted search carries one;
   * a keystroke preview never does (NG-4).
   */
  paging?: PageRequest;
}

export interface SearchClientOptions {
  /** Proxy subpath prefix on the shop domain. */
  basePath?: string;
  /** Abort an unanswered search after this long. */
  timeoutMs?: number;
  /**
   * Budget for the classic rescue that follows a timed-out search (YOY-108
   * AC-4). Short by design: the rescue exists because the shopper has
   * already waited out the primary budget, and the classic path answers in
   * well under a second — a rescue that itself hangs is worse than the
   * quiet no-results state it was meant to prevent.
   */
  fallbackTimeoutMs?: number;
}

const DEFAULT_BASE_PATH = "/apps/unfiltered";
/**
 * Generous by design (YOY-61 AC-4): the live AI route measured 8–24s
 * (YOY-52 AC-12), and an aborted request can never render. Config-driven via
 * `timeoutMs` (the embed block's `searchTimeoutMs`), so the value can drop
 * once the server-side latency work lands.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The classic rescue's own budget (YOY-108). Unrelated to the primary
 * budget above, which stays untouched in this issue (NG-1): the rescue runs
 * the zero-LLM keyword path, measured in hundreds of milliseconds.
 */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 3_000;

/**
 * The request hit its own budget and the widget aborted it — distinct from
 * a network failure, an HTTP error, or a malformed body, because only a
 * timeout is rescuable: the server may still be working on an AI answer
 * while the classic path can answer the same query immediately (YOY-108
 * AC-1). Every other failure means the endpoint itself is unreachable or
 * broken, and a second request would fail the same way.
 */
export class SearchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`search timed out after ${timeoutMs}ms`);
    this.name = "SearchTimeoutError";
  }
}

/**
 * Serialize one search request onto the wire. Objects (previousIntent,
 * removeChip) travel as JSON inside their query parameter; the parse layer
 * (`parseProxySearchParams`) is the exact mirror, and the YOY-60 contract
 * test pins this pair with no stub between them.
 */
export function buildSearchParams(
  query: string,
  sessionId: string,
  context?: SearchRequestContext,
): URLSearchParams {
  const params = new URLSearchParams({ query, sessionId });
  // previousIntent is OMITTED (not null) when nothing is held —
  // "no previousIntent field" is the new-search contract (YOY-49 AC-5).
  if (context?.previousIntent !== undefined) {
    params.set("previousIntent", JSON.stringify(context.previousIntent));
  }
  if (context?.removeChip !== undefined) {
    params.set("removeChip", JSON.stringify(context.removeChip));
  }
  if (context?.removedChips !== undefined && context.removedChips.length > 0) {
    params.set(
      "removedChips",
      JSON.stringify(
        context.removedChips.map((chip) => ({
          field: chip.field,
          value: chip.value,
        })),
      ),
    );
  }
  if (
    context?.previousQuery !== undefined &&
    context.previousQuery !== "" &&
    context.preview !== true &&
    context.classic !== true
  ) {
    params.set("previousQuery", context.previousQuery);
  }
  // `mode` is OMITTED on ordinary submitted searches — its absence is what
  // makes the full pipeline run (YOY-68 AC-2). `classic` is the submitted
  // rescue (YOY-96 AC-9), the only other mode a submit ever carries.
  if (context?.preview === true) {
    params.set("mode", "preview");
  } else if (context?.classic === true) {
    params.set("mode", "classic");
  }
  if (context?.paging !== undefined && context.preview !== true) {
    params.set("page", String(context.paging.page));
    params.set("pageSize", String(context.paging.pageSize));
  }
  return params;
}

/** Serialize one click beacon onto the wire; mirrored by `parseClickBeaconParams`. */
export function buildClickParams(beacon: {
  searchId: string;
  sessionId: string;
  productId: string;
  position: number;
}): URLSearchParams {
  return new URLSearchParams({
    searchId: beacon.searchId,
    sessionId: beacon.sessionId,
    productId: beacon.productId,
    position: String(beacon.position),
  });
}

export interface SearchClient {
  /**
   * Run one search. Rejects on HTTP failure, network failure, timeout, or a
   * body that is not contract-shaped — the caller decides the degradation
   * (YOY-48 AC-2: the widget goes inert).
   */
  search(
    query: string,
    sessionId: string,
    context?: SearchRequestContext,
  ): Promise<ProxySearchResponse>;
  /**
   * The classic rescue (YOY-108 AC-1): the same query down the zero-LLM
   * keyword path, on the short fallback budget. Rides `mode=classic`
   * (YOY-96 AC-9) — a SUBMITTED classic-only search the server logs with an
   * attributable searchId — and rejects exactly like `search` when it fails
   * in turn (AC-2).
   */
  searchClassic(
    query: string,
    sessionId: string,
    paging?: PageRequest,
  ): Promise<ProxySearchResponse>;
  /**
   * Fire the click beacon and return immediately (AC-5): the request is
   * keepalive so it survives the navigation that follows, and any failure
   * is swallowed — a beacon must never block or delay the shopper.
   */
  sendClickBeacon(beacon: {
    searchId: string;
    sessionId: string;
    productId: string;
    position: number;
  }): void;
  /**
   * One page's late labels (YOY-148 AC-8, YOY-151 AC-8): the labels
   * endpoint holds until the judge answers or gives up, then answers a
   * label (or null) per product id — never an order. Rejects on any
   * failure; the caller leaves the reserved lines empty.
   */
  fetchLabels(
    searchId: string,
    page: number,
  ): Promise<Record<string, ProxyLabel | null>>;
}

export function createSearchClient(
  options: SearchClientOptions = {},
): SearchClient {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallbackTimeoutMs =
    options.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;

  const request = async (
    query: string,
    sessionId: string,
    context: SearchRequestContext | undefined,
    budgetMs: number,
  ): Promise<ProxySearchResponse> => {
    const controller = new AbortController();
    // Whether OUR timer aborted, as opposed to any other abort reason: the
    // rescue is offered for a timeout alone (YOY-108 AC-1), so the cause
    // has to be known rather than inferred from the abort itself.
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budgetMs);
    try {
      const params = buildSearchParams(query, sessionId, context);
      const response = await fetch(`${basePath}/search?${params}`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`search failed: ${response.status}`);
      }
      const body = (await response.json()) as ProxySearchResponse;
      if (
        typeof body !== "object" ||
        body === null ||
        typeof body.searchId !== "string" ||
        !Array.isArray(body.results) ||
        !Array.isArray(body.chips)
      ) {
        throw new Error("search response not contract-shaped");
      }
      return body;
    } catch (error) {
      if (timedOut) {
        throw new SearchTimeoutError(budgetMs);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  };

  return {
    async search(query, sessionId, context) {
      return request(query, sessionId, context, timeoutMs);
    },

    async searchClassic(query, sessionId, paging) {
      // `mode=classic` (YOY-96 AC-9): keyword results, zero LLM calls, no
      // throttle budget — like a preview — but a submitted search the
      // server writes a SearchEvent for, so the response's searchId is one
      // the click beacon can attribute to.
      return request(
        query,
        sessionId,
        { classic: true, ...(paging !== undefined ? { paging } : {}) },
        fallbackTimeoutMs,
      );
    },

    async fetchLabels(searchId, page) {
      const params = new URLSearchParams({ searchId, page: String(page) });
      const response = await fetch(`${basePath}/labels?${params}`, {
        method: "GET",
      });
      if (!response.ok) {
        throw new Error(`labels failed: ${response.status}`);
      }
      const body = (await response.json()) as {
        labels?: Record<string, ProxyLabel | null>;
      };
      if (typeof body !== "object" || body === null || typeof body.labels !== "object" || body.labels === null) {
        throw new Error("labels response not contract-shaped");
      }
      return body.labels;
    },

    sendClickBeacon(beacon) {
      try {
        const params = buildClickParams(beacon);
        void fetch(`${basePath}/click?${params}`, {
          method: "GET",
          keepalive: true,
        }).catch(() => {
          // Fire-and-forget by contract.
        });
      } catch {
        // Even a synchronous fetch failure must never block navigation.
      }
    },
  };
}
