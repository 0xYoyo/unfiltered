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

import type { PlaygroundSearchResponse } from "./api.server";

export const PREVIEW_DEBOUNCE_MS = 200;

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
  signal?: AbortSignal;
}

export function playgroundSearchUrl(request: {
  query: string;
  preview: boolean;
  sessionId: string;
  catalog?: string;
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
