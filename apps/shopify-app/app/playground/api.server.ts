import type { PrismaClient } from "@prisma/client";

import { PLAYGROUND_STORE_KEY_PREFIX } from "./ingest-public.server";
import type { SearchResponse } from "../search/orchestrator.server";
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
 * - per-IP rate, in-process, reusing the proxy's sliding-window throttle;
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
}

/** The playground response: the proxy contract plus `details`, nothing else. */
export interface PlaygroundSearchResponse extends ProxySearchResponse {
  details: PlaygroundSearchDetails;
}

/**
 * Map an orchestrator response onto the playground wire contract. Delegates
 * the card/chip/intent mapping to the proxy's own serializer — the two APIs
 * must never drift — and adds exactly the three detail fields. Explicit
 * re-mapping is what keeps a later orchestrator field from leaking out
 * (AC-2, the same guarantee `serializeProxySearchResponse` gives).
 */
export function serializePlaygroundSearchResponse(
  response: SearchResponse,
  details: PlaygroundSearchDetails,
): PlaygroundSearchResponse {
  return {
    ...serializeProxySearchResponse(response),
    details: {
      routeReason: details.routeReason,
      latencyMs: details.latencyMs,
      limited: details.limited,
    },
  };
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
 * The visitor's IP for rate-keying (AC-4): the first `X-Forwarded-For` entry
 * — the client as the outermost proxy saw it — then the connection address
 * the runtime hands us, then a shared `"unknown"` bucket so a request with
 * neither is still rate-limited rather than exempt.
 *
 * `react-router-serve` exposes no connection address to a loader, so in this
 * deployment the middle arm is only reachable by a caller that supplies one;
 * behind a proxy (the playground's own deployment) the header is always
 * present. The parameter keeps the contract honest and testable rather than
 * pretending the address is unavailable everywhere.
 */
export function clientIp(
  request: Request,
  remoteAddress?: string | null,
): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") {
    return first;
  }
  const address = remoteAddress?.trim();
  return address !== undefined && address !== "" ? address : "unknown";
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
 * no LLM budget, so it must not consume the AI ceiling it was denied.
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
