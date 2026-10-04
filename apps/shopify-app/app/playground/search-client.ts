/**
 * The playground's browser-side search client (YOY-92 AC-5).
 *
 * Same interaction model the widget implements (YOY-68): every keystroke
 * issues a debounced `mode=preview` request — classic-only, no AI budget, no
 * SearchEvent — and Enter or the magnifier issues a submitted search that
 * runs the full pipeline. A per-tab `sessionId` rides every request.
 *
 * Deliberately not shared with `widget/src/search-client.ts` (NG-3): the
 * widget speaks to the Shopify proxy through a storefront origin and this
 * speaks to our own first-party API. Only the response contract types are
 * common, and those come from the server module.
 */

import type {
  ProxyChip,
  ProxyIntent,
  ProxyLabel,
  ProxyLabelsResponse,
} from "../search/proxy.server";
import type { PlaygroundSearchResponse } from "./api.server";

export const PREVIEW_DEBOUNCE_MS = 200;

/**
 * One removed engine v2 chip as it rides `removedChips` (YOY-149): the
 * field and value identify it. Structural, so it does not depend on the
 * server's chip field union.
 */
export interface RemovedChip {
  field: string;
  value: string;
}

const SESSION_STORAGE_KEY = "unfiltered:playground:sessionId";

let inMemorySessionId: string | undefined;

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Per-tab correlation ID in sessionStorage: it survives navigation within
 * the tab and dies with it. Storage access can throw (privacy modes), and a
 * search that works matters more than a correlated one, so that falls back
 * to an in-memory ID for this page view.
 */
export function getPlaygroundSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing !== null && existing !== "") {
      return existing;
    }
    const fresh = generateId();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    inMemorySessionId ??= generateId();
    return inMemorySessionId;
  }
}

export interface PlaygroundSearchRequest {
  query: string;
  /** A preview is the keystroke path; a submit runs the full pipeline. */
  preview: boolean;
  /** Registry slug; absent means the seed catalog. */
  catalog?: string;
  /**
   * The held intent from the last AI response, echoed so a follow-up
   * modifies that search instead of starting a new one (YOY-93 AC-2).
   */
  previousIntent?: ProxyIntent;
  /** Chip the visitor dismissed; the server adjusts `previousIntent`. */
  removeChip?: ProxyChip;
  /**
   * Engine v2 chip removal (YOY-149 AC-15): every chip removed so far in
   * this search chain, the newest included. A v2 response echoes no
   * intent, so the same query is re-asked with this list instead of
   * `previousIntent`/`removeChip`.
   */
  removedChips?: readonly RemovedChip[];
  /**
   * The held `carry` of the last Engine v2 response (YOY-150 AC-1): the
   * search refines or replaces that chain. Never on a preview.
   */
  previousQuery?: string;
  /**
   * The page a submitted search asks for (YOY-146): every submit carries
   * one; a keystroke preview never does.
   */
  paging?: { page: number; pageSize: number };
  signal?: AbortSignal;
}

export function playgroundSearchUrl(request: {
  query: string;
  preview: boolean;
  sessionId: string;
  catalog?: string;
  previousIntent?: ProxyIntent;
  removeChip?: ProxyChip;
  removedChips?: readonly RemovedChip[];
  previousQuery?: string;
  paging?: { page: number; pageSize: number };
}): string {
  const params = new URLSearchParams({
    query: request.query,
    sessionId: request.sessionId,
  });
  if (request.preview) {
    params.set("mode", "preview");
  }
  if (request.catalog !== undefined) {
    params.set("catalog", request.catalog);
  }
  // Refinement rides the wire exactly as the proxy's own parameters do
  // (NG-3: the playground changes no contract).
  if (request.previousIntent !== undefined) {
    params.set("previousIntent", JSON.stringify(request.previousIntent));
  }
  if (request.removeChip !== undefined) {
    params.set("removeChip", JSON.stringify(request.removeChip));
  }
  if (request.removedChips !== undefined && request.removedChips.length > 0) {
    params.set(
      "removedChips",
      JSON.stringify(
        request.removedChips.map((chip) => ({
          field: chip.field,
          value: chip.value,
        })),
      ),
    );
  }
  if (request.previousQuery !== undefined && request.previousQuery !== "" && !request.preview) {
    params.set("previousQuery", request.previousQuery);
  }
  if (request.paging !== undefined && !request.preview) {
    params.set("page", String(request.paging.page));
    params.set("pageSize", String(request.paging.pageSize));
  }
  return `/api/playground/search?${params.toString()}`;
}

/** Throws on a non-200; the caller renders the quiet failure line (AC-7). */
export async function searchPlayground(
  request: PlaygroundSearchRequest,
): Promise<PlaygroundSearchResponse> {
  const url = playgroundSearchUrl({
    query: request.query,
    preview: request.preview,
    sessionId: getPlaygroundSessionId(),
    ...(request.catalog === undefined ? {} : { catalog: request.catalog }),
    ...(request.previousIntent === undefined
      ? {}
      : { previousIntent: request.previousIntent }),
    ...(request.removeChip === undefined
      ? {}
      : { removeChip: request.removeChip }),
    ...(request.removedChips === undefined
      ? {}
      : { removedChips: request.removedChips }),
    ...(request.previousQuery === undefined
      ? {}
      : { previousQuery: request.previousQuery }),
    ...(request.paging === undefined ? {} : { paging: request.paging }),
  });
  const response = await fetch(url, {
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (!response.ok) {
    throw new Error(`playground search failed: ${response.status}`);
  }
  return (await response.json()) as PlaygroundSearchResponse;
}

/**
 * One page's late labels (YOY-148 AC-8, YOY-151 AC-8): the endpoint holds
 * until the judge answers or gives up, then answers a label (or null) per
 * product id — never an order. Throws on a non-200; the caller leaves the
 * reserved lines empty.
 */
export async function fetchPlaygroundLabels(request: {
  searchId: string;
  page: number;
  catalog?: string;
}): Promise<Record<string, ProxyLabel | null>> {
  const params = new URLSearchParams({
    searchId: request.searchId,
    page: String(request.page),
  });
  if (request.catalog !== undefined) {
    params.set("catalog", request.catalog);
  }
  const response = await fetch(`/api/playground/labels?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`playground labels failed: ${response.status}`);
  }
  return ((await response.json()) as ProxyLabelsResponse).labels;
}

/**
 * Click attribution (AC-6). `sendBeacon` where available so the write is not
 * cancelled by the new tab opening; `fetch` with `keepalive` otherwise.
 */
export function sendPlaygroundClick(click: {
  searchId: string;
  productId: string;
  position: number;
  catalog?: string;
}): void {
  const url =
    click.catalog === undefined
      ? "/api/playground/click"
      : `/api/playground/click?catalog=${encodeURIComponent(click.catalog)}`;
  const body = JSON.stringify({
    searchId: click.searchId,
    sessionId: getPlaygroundSessionId(),
    productId: click.productId,
    position: click.position,
  });
  try {
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    // Attribution is best-effort; never let it break the navigation.
  }
}
