import type { PrismaClient } from "@prisma/client";

import { PLAYGROUND_STORE_KEY_PREFIX } from "./ingest-public.server";
import type { JudgeVerdictCode } from "@unfiltered/engine";

import type { JudgeCallTimes } from "../search/judge-step.server";
import {
  SEARCH_STAGES,
  type SearchResponse,
  type SearchStages,
  type V2RouteReason,
} from "../search/orchestrator.server";
import {
  serializeProxySearchResponse,
  type ProxySearchResponse,
} from "../search/proxy.server";
import {
  createSessionThrottle,
  type SessionThrottle,
} from "../search/throttle.server";

/**
 * The playground's own search API (YOY-90): a first-party, unauthenticated
 * endpoint on our origin that runs the SAME orchestrator the Shopify proxy
 * runs, over a chosen catalog — the seed tenant or a preloaded public store
 * from the registry — and returns the same card contract plus the engine
 * details the playground shows on demand.
 *
 * Unauthenticated means the abuse surface is the AI bill, so this module
 * owns three guards, all of which resolve to the orchestrator's existing
 * `forceClassic` path rather than to an error the visitor sees:
 *
 * - per-IP rate, in-process, reusing the proxy's sliding-window throttle,
 *   keyed by the last trusted `X-Forwarded-For` hop (see `clientIp`);
 * - a global daily AI ceiling across every playground tenant;
 * - a per-catalog daily AI ceiling.
 *
 * The daily ceilings are counted from `SearchEvent` rows rather than from
 * process memory, so they survive a restart and hold across instances — the
 * per-IP throttle deliberately does not (it is the same in-process limiter
 * the proxy uses, and its NG-4 note still applies).
 */

/** Env var naming the seed catalog's tenant key; absent means no seed. */
export const SEED_STORE_KEY_ENV = "PLAYGROUND_SEED_STORE_KEY";

/** Primary hits one playground search returns (YOY-90 AC-2). */
export const PLAYGROUND_RESULT_LIMIT = 24;

const DEFAULT_IP_THROTTLE_PER_MINUTE = 10;
const DEFAULT_DAILY_AI_CAP = 2000;
const DEFAULT_CATALOG_DAILY_AI_CAP = 500;

/** Why a response was served classic against the visitor's wishes. */
export type PlaygroundLimit = "ip" | "daily-global" | "daily-catalog";

/** The engine details the playground surfaces beside the cards (AC-2). */
export interface PlaygroundSearchDetails {
  routeReason: string;
  latencyMs: number;
  limited: PlaygroundLimit | null;
  /** Whole ms per pipeline stage actually run, in pipeline order (YOY-114). */
  stages: SearchStages;
  /**
   * What the judge did (YOY-147 AC-12): its outcome and the verdict per
   * result, in result order — null for a result the judge did not answer
   * for. Null on the keyword paths. The storefront wire carries none of it.
   */
  judge: PlaygroundJudgeDetails | null;
  /**
   * Whether the wish extraction answered in time to compose the page
   * (YOY-149 AC-4); null on a response the find path did not serve. The
   * latency probe reports the share of searches composed without it.
   */
  extractionInTime: boolean | null;
  /** Whether the extraction cache answered (YOY-149 AC-18); null where `extractionInTime` is. */
  extractionCached: boolean | null;
}

/** The judge's part of the playground details (YOY-147 AC-12). */
export interface PlaygroundJudgeDetails {
  outcome: V2RouteReason;
  /** `standIn` marks a verdict that stands in for a call that never answered (YOY-159). */
  verdicts: Array<{ productId: string; verdict: JudgeVerdictCode | null; standIn?: true }>;
  /**
   * The judge call's single provider calls as the page was served (YOY-159
   * AC-1): the slowest and the median, lower bounds when `open`. Null when
   * no call started — a cached answer, find-only, capped.
   */
  calls: JudgeCallTimes | null;
}

/** The playground response: the proxy contract plus `details`, nothing else. */
export interface PlaygroundSearchResponse extends ProxySearchResponse {
  details: PlaygroundSearchDetails;
}

/**
 * Map an orchestrator response onto the playground wire contract. Delegates
 * the card/chip mapping to the proxy's own serializer — the two APIs
 * must never drift — and adds exactly the four detail fields the route hands
 * over, plus the judge's details read from the response (YOY-147 AC-12). Explicit
 * re-mapping is what keeps a later orchestrator field from leaking out
 * (AC-2, the same guarantee `serializeProxySearchResponse` gives); `stages`
 * is copied key by key in pipeline order so the wire order is the
 * pipeline's, whatever order the ledger ran in.
 */
export function serializePlaygroundSearchResponse(
  response: SearchResponse,
  details: Omit<PlaygroundSearchDetails, "judge" | "extractionInTime" | "extractionCached">,
): PlaygroundSearchResponse {
  return {
    ...serializeProxySearchResponse(response),
    details: {
      routeReason: details.routeReason,
      latencyMs: details.latencyMs,
      limited: details.limited,
      stages: serializeStages(details.stages),
      judge: judgeDetails(response),
      extractionInTime: response.extractionInTime ?? null,
      extractionCached: response.extractionCached ?? null,
    },
  };
}

const V2_ROUTE_REASONS: ReadonlySet<string> = new Set<V2RouteReason>([
  "judged",
  "judge-timeout",
  "judge-error",
  "judge-cached",
  "capped",
  "find-only",
]);

/**
 * The judge's outcome and per-result verdicts on a response the find path
 * served; null on the keyword paths (preview, classic rescue).
 */
function judgeDetails(response: SearchResponse): PlaygroundJudgeDetails | null {
  if (!V2_ROUTE_REASONS.has(response.routeReason)) {
    return null;
  }
  return {
    outcome: response.routeReason as V2RouteReason,
    verdicts: response.hits.map((hit) => ({
      productId: hit.productId,
      verdict: hit.verdict ?? null,
      ...(hit.standIn === true ? { standIn: true as const } : {}),
    })),
    calls: response.judgeCalls ?? null,
  };
}

function serializeStages(stages: SearchStages): SearchStages {
  const ordered: SearchStages = {};
  for (const stage of SEARCH_STAGES) {
    const ms = stages[stage];
    if (ms !== undefined) {
      ordered[stage] = ms;
    }
  }
  return ordered;
}

/** The playground's env-configured limits; invalid values fall back. */
export interface PlaygroundLimits {
  ipPerMinute: number;
  dailyGlobal: number;
  dailyCatalog: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function playgroundLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PlaygroundLimits {
  return {
    ipPerMinute: positiveInt(
      env.PLAYGROUND_AI_THROTTLE_PER_MINUTE,
      DEFAULT_IP_THROTTLE_PER_MINUTE,
    ),
    dailyGlobal: positiveInt(env.PLAYGROUND_DAILY_AI_CAP, DEFAULT_DAILY_AI_CAP),
    dailyCatalog: positiveInt(
      env.PLAYGROUND_CATALOG_DAILY_AI_CAP,
      DEFAULT_CATALOG_DAILY_AI_CAP,
    ),
  };
}

/**
 * Env var: how many trailing `X-Forwarded-For` entries the deployment's own
 * edge guarantees. Default 1 — one reverse proxy (Render) appending the peer
 * it saw. Put a second trusted proxy (a CDN) in front and set 2.
 */
export const TRUSTED_PROXY_HOPS_ENV = "PLAYGROUND_TRUSTED_PROXY_HOPS";
const DEFAULT_TRUSTED_PROXY_HOPS = 1;

export function trustedProxyHopsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveInt(env[TRUSTED_PROXY_HOPS_ENV], DEFAULT_TRUSTED_PROXY_HOPS);
}

/**
 * The visitor's IP for rate-keying (YOY-90 AC-4 as amended by YOY-96 AC-11):
 * the LAST TRUSTED `X-Forwarded-For` hop — the entry `trustedProxyHops`
 * positions from the end of the header — then the connection address the
 * runtime hands us, then a shared `"unknown"` bucket so a request with
 * neither is still rate-limited rather than exempt.
 *
 * Why the end and not the start: every reverse proxy (Render included)
 * APPENDS the peer address it saw to whatever header arrived, so the first
 * entry is whatever the client chose to send. Keyed by the first entry, a
 * visitor minting a fresh random `X-Forwarded-For` per request got a fresh
 * throttle bucket every time and the per-IP guard never bound; only the
 * daily caps did. The entry our own edge appended is the one the client
 * cannot forge. With fewer entries than trusted hops, the request did not
 * come through the configured edge, so the header is not trusted at all and
 * the fallbacks apply.
 *
 * `react-router-serve` exposes no connection address to a loader, so in this
 * deployment the middle arm is only reachable by a caller that supplies one
 * (a custom server's `getLoadContext`, read by `remoteAddressFromContext`);
 * behind a proxy (the playground's own deployment) the header is always
 * present. The parameter keeps the contract honest and testable rather than
 * pretending the address is unavailable everywhere.
 */
export function clientIp(
  request: Request,
  remoteAddress?: string | null,
  trustedProxyHops: number = trustedProxyHopsFromEnv(),
): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const hops = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const trusted = hops[hops.length - trustedProxyHops];
    if (trusted !== undefined) {
      return trusted;
    }
  }
  const address = remoteAddress?.trim();
  return address !== undefined && address !== "" ? address : "unknown";
}

/**
 * The connection address when the runtime's load context carries one — a
 * custom server's `getLoadContext` would set `remoteAddress`; the default
 * `react-router-serve` context has none, so this yields null there.
 */
export function remoteAddressFromContext(context: unknown): string | null {
  if (context === null || typeof context !== "object") {
    return null;
  }
  const value = (context as { remoteAddress?: unknown }).remoteAddress;
  return typeof value === "string" ? value : null;
}

/** A resolved catalog: which tenant key the search runs against. */
export interface ResolvedCatalog {
  /** The `shopDomain` column value every row of this catalog carries. */
  storeKey: string;
  /** Registry slug, or null for the seed catalog. */
  slug: string | null;
}

/**
 * Which tenant a request searches (AC-1). No `catalog` parameter means the
 * seed catalog, whose tenant key is env-configured — an unset seed is a
 * deployment gap, not a visitor error, so it answers 503. A named slug must
 * exist in the registry; an unknown one answers 404 rather than silently
 * falling back to the seed, which would search the wrong catalog.
 */
export async function resolveCatalog(
  db: PrismaClient,
  slug: string | null,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedCatalog | { status: 404 | 503 }> {
  if (slug === null || slug === "") {
    const seed = env[SEED_STORE_KEY_ENV]?.trim();
    if (seed === undefined || seed === "") {
      return { status: 503 };
    }
    return { storeKey: seed, slug: null };
  }
  const catalog = await db.playgroundCatalog.findUnique({
    where: { slug },
    select: { storeKey: true },
  });
  if (catalog === null) {
    return { status: 404 };
  }
  return { storeKey: catalog.storeKey, slug };
}

/** Every tenant key the playground serves: the seed plus the registry. */
export async function playgroundStoreKeys(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const rows = await db.playgroundCatalog.findMany({
    select: { storeKey: true },
  });
  const keys = new Set(rows.map((row) => row.storeKey));
  const seed = env[SEED_STORE_KEY_ENV]?.trim();
  if (seed !== undefined && seed !== "") {
    keys.add(seed);
  }
  return [...keys];
}

/** Midnight UTC of the day containing `now` — the daily counters' epoch. */
export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Count today's AI-routed playground searches (AC-5), from the log rather
 * than from memory: the ceilings are a spend guard, and a guard that resets
 * when the process restarts is not one. Only `route = "ai"` rows count — a
 * search served classic (throttled, capped, or simply keyword-routed) spent
 * no judge budget, so it must not consume the AI ceiling it was denied. Only
 * page-1 rows count (YOY-157 AC-29): every page request writes its own row
 * (YOY-145 AC-10), but a later page is the same search scrolled.
 */
export async function countAiSearchesToday(
  db: PrismaClient,
  storeKeys: string[],
  now: Date,
): Promise<number> {
  if (storeKeys.length === 0) {
    return 0;
  }
  return db.searchEvent.count({
    where: {
      shopDomain: { in: storeKeys },
      route: "ai",
      page: 1,
      createdAt: { gte: startOfUtcDay(now) },
    },
  });
}

export interface LimitCheck {
  db: PrismaClient;
  /** The catalog this search runs against. */
  catalog: ResolvedCatalog;
  /** Whether this IP has already spent its per-minute AI budget. */
  ipThrottled: boolean;
  limits: PlaygroundLimits;
  now?: Date;
  env?: Record<string, string | undefined>;
}

/**
 * Which guard, if any, forces this search onto the classic path.
 *
 * Precedence is broadest-first — global ceiling, then this catalog's, then
 * this IP — because the broadest binding constraint is the one that explains
 * the degradation. Reporting `"ip"` to a visitor who happens to be over
 * their per-minute rate while the whole playground is capped would send them
 * chasing their own behavior for a condition they cannot affect.
 */
export async function resolveLimit({
  db,
  catalog,
  ipThrottled,
  limits,
  now = new Date(),
  env = process.env,
}: LimitCheck): Promise<PlaygroundLimit | null> {
  const globalCount = await countAiSearchesToday(
    db,
    await playgroundStoreKeys(db, env),
    now,
  );
  if (globalCount >= limits.dailyGlobal) {
    return "daily-global";
  }
  const catalogCount = await countAiSearchesToday(
    db,
    [catalog.storeKey],
    now,
  );
  if (catalogCount >= limits.dailyCatalog) {
    return "daily-catalog";
  }
  return ipThrottled ? "ip" : null;
}

/**
 * Headers every playground response carries — every status, both routes.
 * `no-store` because the bodies are per-visitor and must never land in a
 * shared cache; no CORS header appears anywhere (NG-2), so a third party
 * cannot spend our AI budget from their site.
 */
export const PLAYGROUND_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

let ipThrottle: SessionThrottle | undefined;

/**
 * The one process-wide per-IP AI throttle the playground search route
 * consults, mirroring `getSessionThrottle` in `search/throttle.server.ts`.
 * A separate instance from the proxy's session throttle: the two count
 * different things — a shopper session there, a visitor IP here — and must
 * not share a budget. Lazily constructed so the env-configured limit is read
 * at first use, not at import.
 */
export function getPlaygroundIpThrottle(): SessionThrottle {
  ipThrottle ??= createSessionThrottle({
    limit: playgroundLimitsFromEnv().ipPerMinute,
  });
  return ipThrottle;
}

/** Drop the memoized throttle so tests can install their own clock/limit. */
export function resetPlaygroundIpThrottle(): void {
  ipThrottle = undefined;
}

/** True when the tenant key names a registry catalog rather than the seed. */
export function isRegistryStoreKey(storeKey: string): boolean {
  return storeKey.startsWith(PLAYGROUND_STORE_KEY_PREFIX);
}
