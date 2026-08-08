/**
 * Client for the app-proxy endpoints (YOY-46 contract, consumed here per
 * YOY-48 NG-3: no server changes, the widget speaks the existing contract).
 * Same-origin by construction — the proxy lives on the shop domain.
 */

/** One result card as the proxy serves it. */
export interface ProxyResult {
  productId: string;
  title: string;
  handle: string;
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
}

/** The slice of the search response this issue renders (NG-1: cards only). */
export interface ProxySearchResponse {
  searchId: string;
  route: "classic" | "ai";
  degraded: boolean;
  results: ProxyResult[];
}

export interface SearchClientOptions {
  /** Proxy subpath prefix on the shop domain. */
  basePath?: string;
  /** Abort an unanswered search after this long. */
  timeoutMs?: number;
}

const DEFAULT_BASE_PATH = "/apps/unfiltered";
const DEFAULT_TIMEOUT_MS = 5000;

export interface SearchClient {
  /**
   * Run one search. Rejects on HTTP failure, network failure, timeout, or a
   * body that is not contract-shaped — the caller decides the degradation
   * (YOY-48 AC-2: the widget goes inert).
   */
  search(query: string, sessionId: string): Promise<ProxySearchResponse>;
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
}

export function createSearchClient(
  options: SearchClientOptions = {},
): SearchClient {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async search(query, sessionId) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${basePath}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, sessionId }),
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
          !Array.isArray(body.results)
        ) {
          throw new Error("search response not contract-shaped");
        }
        return body;
      } finally {
        window.clearTimeout(timer);
      }
    },

    sendClickBeacon(beacon) {
      try {
        void fetch(`${basePath}/click`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(beacon),
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
