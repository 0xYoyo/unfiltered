/**
 * Polite fetch (YOY-88 AC-5): the one HTTP helper every public catalog
 * source reads through. It identifies itself, times out, backs off when the
 * host asks, keeps pagination to one request in flight per host, and honors
 * `robots.txt` — a disallowed path is never fetched (it is counted and
 * reported as `RobotsDisallowedError`, so an operator sees exactly why a
 * catalog is unreachable). Platform-free: it knows URLs, not stores.
 */

export const POLITE_USER_AGENT_PRODUCT = "UnfilteredBot/1.0";
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const MAX_RETRIES = 3;
/** Base of the exponential backoff (ms) when no `Retry-After` is given. */
export const BACKOFF_BASE_MS = 1_000;
/** Ceiling on any single wait, however large `Retry-After` is. */
export const MAX_BACKOFF_MS = 60_000;

/** The `fetch` slice the helper needs; the global by default, a stub in tests. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/** Thrown when robots.txt disallows the requested path for our agent. */
export class RobotsDisallowedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`robots.txt disallows ${url} for ${POLITE_USER_AGENT_PRODUCT}`);
    this.name = "RobotsDisallowedError";
    this.url = url;
  }
}

/** Thrown when a request still fails after every retry, or times out. */
export class PoliteFetchError extends Error {
  readonly url: string;
  readonly status: number | null;
  constructor(url: string, message: string, status: number | null = null) {
    super(`${message}: ${url}`);
    this.name = "PoliteFetchError";
    this.url = url;
    this.status = status;
  }
}

/** Counters an operator report reads after a run. */
export interface PoliteFetchStats {
  requests: number;
  retries: number;
  /** Paths robots.txt disallowed — skipped, never fetched. */
  robotsSkipped: number;
}

export interface PoliteFetch {
  /** Fetch a URL politely; resolves to the (possibly non-2xx) final response. */
  fetch(url: string): Promise<Response>;
  readonly userAgent: string;
  readonly stats: PoliteFetchStats;
}

interface RobotsRule {
  allow: boolean;
  path: string;
}

/**
 * Parse robots.txt into the rule group that applies to us: the group naming
 * our agent (substring match, case-insensitive) when present, else the `*`
 * group; no group means everything is allowed. Longest-match wins between
 * Allow and Disallow, per the de-facto standard.
 */
export function parseRobotsRules(
  body: string,
  userAgentProduct: string = POLITE_USER_AGENT_PRODUCT,
): RobotsRule[] {
  const agentName = userAgentProduct.split("/")[0].toLowerCase();
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) {
      continue;
    }
    if (field === "disallow" || field === "allow") {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  const ours = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && agentName.includes(agent)),
  );
  const applicable =
    ours.length > 0
      ? ours
      : groups.filter((group) => group.agents.includes("*"));
  return applicable.flatMap((group) => group.rules);
}

/** Whether `pathWithQuery` is allowed under the parsed rules. */
export function robotsAllows(rules: RobotsRule[], pathWithQuery: string): boolean {
  let bestLength = -1;
  let allowed = true;
  for (const rule of rules) {
    if (rule.path === "") {
      // "Disallow:" (empty) allows everything; "Allow:" (empty) is a no-op.
      continue;
    }
    if (!matchesRobotsPath(rule.path, pathWithQuery)) {
      continue;
    }
    if (rule.path.length > bestLength) {
      bestLength = rule.path.length;
      allowed = rule.allow;
    } else if (rule.path.length === bestLength && rule.allow) {
      allowed = true;
    }
  }
  return allowed;
}

function matchesRobotsPath(pattern: string, path: string): boolean {
  // `*` wildcards and `$` end anchor, per Google's robots.txt spec.
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const anchored = escaped.endsWith("\\$")
    ? `^${escaped.slice(0, -2)}$`
    : `^${escaped}`;
  return new RegExp(anchored).test(path);
}

/** Seconds or HTTP-date `Retry-After` → wait in ms; null when absent/invalid. */
export function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | null {
  if (header === null || header.trim() === "") {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, date - now);
}

/**
 * Build the helper. `contactUrl` lands in the User-Agent (`(+<url>)`) so a
 * host operator can find out who is crawling; `sleep` and `fetch` are
 * injectable so tests run instantly and offline.
 */
export function createPoliteFetch({
  contactUrl,
  fetch: fetchImpl = globalThis.fetch as FetchLike,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  respectRobots = true,
}: {
  contactUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  respectRobots?: boolean;
}): PoliteFetch {
  const userAgent = `${POLITE_USER_AGENT_PRODUCT} (+${contactUrl})`;
  const stats: PoliteFetchStats = { requests: 0, retries: 0, robotsSkipped: 0 };
  // One request in flight per host: each host's requests chain behind the
  // previous one, so pagination never fans out against a store.
  const hostQueues = new Map<string, Promise<unknown>>();
  const robotsByHost = new Map<string, Promise<RobotsRule[]>>();

  const rawFetch = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      stats.requests += 1;
      return await fetchImpl(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json, text/plain, */*" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PoliteFetchError(url, `timed out after ${timeoutMs} ms`);
      }
      throw new PoliteFetchError(
        url,
        `network failure (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchWithRetries = async (url: string): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await rawFetch(url);
      if (response.status !== 429 && response.status !== 503) {
        return response;
      }
      if (attempt >= MAX_RETRIES) {
        throw new PoliteFetchError(
          url,
          `still ${response.status} after ${MAX_RETRIES} retries`,
          response.status,
        );
      }
      const retryAfter = parseRetryAfterMs(response.headers.get("Retry-After"));
      const backoff = BACKOFF_BASE_MS * 2 ** attempt;
      stats.retries += 1;
      await sleep(Math.min(MAX_BACKOFF_MS, Math.max(retryAfter ?? 0, backoff)));
    }
  };

  const robotsRulesFor = (origin: string): Promise<RobotsRule[]> => {
    let pending = robotsByHost.get(origin);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const response = await fetchWithRetries(`${origin}/robots.txt`);
          if (!response.ok) {
            // No robots.txt (404) or an unreadable one: nothing is disallowed.
            return [];
          }
          return parseRobotsRules(await response.text());
        } catch {
          return [];
        }
      })();
      robotsByHost.set(origin, pending);
    }
    return pending;
  };

  const enqueue = <T>(host: string, task: () => Promise<T>): Promise<T> => {
    const previous = hostQueues.get(host) ?? Promise.resolve();
    const run = previous.then(task, task);
    hostQueues.set(
      host,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };

  return {
    userAgent,
    stats,
    fetch(url: string): Promise<Response> {
      const parsed = new URL(url);
      return enqueue(parsed.host, async () => {
        if (respectRobots) {
          const rules = await robotsRulesFor(parsed.origin);
          if (!robotsAllows(rules, `${parsed.pathname}${parsed.search}`)) {
            stats.robotsSkipped += 1;
            throw new RobotsDisallowedError(url);
          }
        }
        return fetchWithRetries(url);
      });
    },
  };
}
