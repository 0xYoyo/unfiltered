/**
 * Per-browser-session correlation ID (YOY-48 AC-3, NG-4): held in
 * sessionStorage only — it survives navigation within the tab and dies with
 * it. Storage access can throw (sandboxed iframes, privacy modes); the
 * widget then falls back to an in-memory ID for this page view.
 */

const STORAGE_KEY = "unfiltered:sessionId";

let inMemoryId: string | undefined;

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing !== null && existing !== "") {
      return existing;
    }
    const fresh = generateId();
    window.sessionStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    inMemoryId ??= generateId();
    return inMemoryId;
  }
}
