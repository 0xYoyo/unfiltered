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

/**
 * Calls between opportunistic full-map sweeps (YOY-52 AC-6). Same-session
 * revisits prune their own entry on every call; the sweep exists for
 * abandoned shopper-controlled sessionIds that would otherwise accumulate
 * unboundedly. Amortized: one sweep per SWEEP_EVERY calls keeps the map
 * proportional to window-active sessions at O(1) average cost per call.
 */
const SWEEP_EVERY = 1_000;

export interface SessionThrottle {
  /** True when this session's window budget is already spent. */
  shouldThrottle(sessionId: string): boolean;
  /** Record one LLM-backed (AI-routed) search against the session's window. */
  recordAiSearch(sessionId: string): void;
  /** Sessions currently held in the map (diagnostic; tests assert the bound). */
  sessionCount(): number;
}

export interface SessionThrottleOptions {
  /** AI searches allowed per sliding window; more than this forces classic. */
  limit?: number;
  /** Sliding window length; defaults to one minute. */
  windowMs?: number;
  /** Clock seam for tests; defaults to Date.now. */
  now?: () => number;
  /** Calls between opportunistic full sweeps; tests shrink it. */
  sweepEvery?: number;
}

export function createSessionThrottle(
  options: SessionThrottleOptions = {},
): SessionThrottle {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const now = options.now ?? Date.now;
  const sweepEvery = options.sweepEvery ?? SWEEP_EVERY;
  const windows = new Map<string, number[]>();
  let callsSinceSweep = 0;

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

  /**
   * Opportunistic full-map sweep (YOY-52 AC-6): every `sweepEvery` calls,
   * drop every session whose window slid clear — abandoned sessionIds never
   * revisit, so per-session pruning alone would leak them forever.
   */
  function maybeSweep(): void {
    callsSinceSweep += 1;
    if (callsSinceSweep < sweepEvery) {
      return;
    }
    callsSinceSweep = 0;
    const cutoff = now() - windowMs;
    for (const [sessionId, timestamps] of windows) {
      if (!timestamps.some((timestamp) => timestamp > cutoff)) {
        windows.delete(sessionId);
      }
    }
  }

  return {
    shouldThrottle(sessionId: string): boolean {
      maybeSweep();
      return prune(sessionId).length >= limit;
    },
    recordAiSearch(sessionId: string): void {
      maybeSweep();
      const kept = prune(sessionId);
      kept.push(now());
      windows.set(sessionId, kept);
    },
    sessionCount(): number {
      return windows.size;
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
