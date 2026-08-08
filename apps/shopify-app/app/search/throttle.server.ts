/**
 * Per-session AI search throttle (YOY-47): an in-process sliding one-minute
 * window per sessionId. Once a session has spent the window's budget of
 * LLM-backed searches, subsequent searches are forced onto the classic path
 * — served degraded, with zero LLM calls — until the window slides clear.
 * Classic-routed searches and chip-removal requests neither consume budget
 * nor get forced (chip removal never makes a classification or intent call
 * to begin with).
 *
 * Deliberately in-process (NG-4): the state is one Map in one Node process,
 * so the limit is per-instance — running multiple app instances multiplies
 * the effective ceiling. Accepted for now; a distributed store is a later
 * milestone's concern. State is also lost on restart, which only ever
 * under-throttles briefly.
 */

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 10;

export interface SessionThrottle {
  /** True when this session's window budget is already spent. */
  shouldThrottle(sessionId: string): boolean;
  /** Record one LLM-backed (AI-routed) search against the session's window. */
  recordAiSearch(sessionId: string): void;
}

export interface SessionThrottleOptions {
  /** AI searches allowed per sliding window; more than this forces classic. */
  limit?: number;
  /** Sliding window length; defaults to one minute. */
  windowMs?: number;
  /** Clock seam for tests; defaults to Date.now. */
  now?: () => number;
}

export function createSessionThrottle(
  options: SessionThrottleOptions = {},
): SessionThrottle {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const now = options.now ?? Date.now;
  const windows = new Map<string, number[]>();

  function prune(sessionId: string): number[] {
    const cutoff = now() - windowMs;
    const kept = (windows.get(sessionId) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (kept.length === 0) {
      // Drop empty sessions so the map only holds actively-searching ones.
      windows.delete(sessionId);
    } else {
      windows.set(sessionId, kept);
    }
    return kept;
  }

  return {
    shouldThrottle(sessionId: string): boolean {
      return prune(sessionId).length >= limit;
    },
    recordAiSearch(sessionId: string): void {
      const kept = prune(sessionId);
      kept.push(now());
      windows.set(sessionId, kept);
    },
  };
}

/** Throttle limit from the environment; invalid or absent values mean 10. */
export function throttleLimitFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SEARCH_AI_THROTTLE_PER_MINUTE;
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

let singleton: SessionThrottle | undefined;

/**
 * The one process-wide throttle the proxy search route consults. Lazily
 * constructed so the env-configured limit is read at first use, not import.
 */
export function getSessionThrottle(): SessionThrottle {
  singleton ??= createSessionThrottle({ limit: throttleLimitFromEnv() });
  return singleton;
}
