import { Prisma, type PrismaClient } from "@prisma/client";
import { parseIntent, type Intent } from "@unfiltered/engine";

/**
 * Search/click event writes (YOY-47). Write-only in this milestone (NG-1):
 * nothing reads these tables yet except the click beacon's searchId
 * validation.
 */

export interface SearchEventInput {
  searchId: string;
  shopDomain: string;
  sessionId: string;
  query: string;
  route: string;
  /**
   * Why the search took its route — the orchestrator's `routeReason`,
   * written for every submitted search (YOY-96 AC-9) so a classic row can
   * be told apart by cause: a heuristic or model decision, a throttled
   * session, or the widget's "client-timeout-rescue" of a search that
   * timed out on its side. Rows from before the column are null.
   */
  routeReason: string;
  degraded: boolean;
  latencyMs: number;
  resultCount: number;
  /**
   * Which page of results this request served (YOY-145 AC-10): one row per
   * page request. Absent means 1 — an unpaged search is its own first page.
   */
  page?: number;
  /**
   * The intent the search was served with, when the AI path produced one
   * and the response was not degraded (YOY-64 AC-4); an identical query
   * within the reuse window is answered from it without any LLM call.
   * Stored together with `normalizedQuery`, the reuse key.
   */
  intent?: Intent | null;
  normalizedQuery?: string | null;
}

/**
 * The exact-query reuse key (YOY-64 AC-4): trimmed, whitespace-collapsed,
 * case-folded. Exact text only — no paraphrase, no stemming (NG-5).
 */
export function normalizeReuseQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Which stored intent a search may reuse, and from which row. */
export interface ReusableIntent {
  intent: Intent;
  searchId: string;
  createdAt: Date;
}

/**
 * The most recent intent this shop was served for the same normalized
 * query within `windowMs` (YOY-64 AC-4), or null. Only rows that stored an
 * intent qualify — classic, degraded, and pre-column rows never do — and a
 * stored intent that no longer parses (a schema drift) is skipped rather
 * than served.
 */
export async function findReusableIntent(
  db: PrismaClient,
  options: {
    shopDomain: string;
    normalizedQuery: string;
    windowMs: number;
    now?: Date;
  },
): Promise<ReusableIntent | null> {
  const now = options.now ?? new Date();
  const rows = await db.searchEvent.findMany({
    where: {
      shopDomain: options.shopDomain,
      normalizedQuery: options.normalizedQuery,
      createdAt: { gte: new Date(now.getTime() - options.windowMs) },
      intent: { not: Prisma.DbNull },
    },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { searchId: true, createdAt: true, intent: true },
  });
  for (const row of rows) {
    const intent = parseIntent(row.intent);
    if (intent !== null) {
      return { intent, searchId: row.searchId, createdAt: row.createdAt };
    }
  }
  return null;
}

/**
 * Record one SearchEvent. Never throws: the log is an observer of the
 * search, and a logging outage must not take shopper search down with it
 * (AC-2). The failure is logged server-side and the row is simply lost.
 */
export async function writeSearchEvent(
  db: PrismaClient,
  event: SearchEventInput,
): Promise<void> {
  try {
    const { intent, normalizedQuery, ...rest } = event;
    await db.searchEvent.create({
      data: {
        ...rest,
        normalizedQuery: normalizedQuery ?? null,
        // Prisma distinguishes a JSON null from an absent column; the
        // column is absent (SQL NULL) when there is nothing to reuse.
        intent:
          intent === undefined || intent === null
            ? Prisma.DbNull
            : (intent as unknown as Prisma.InputJsonValue),
      },
    });
  } catch (error) {
    console.error(
      `search-event write failed for search ${event.searchId}:`,
      error,
    );
  }
}

export interface ClickEventInput {
  searchId: string;
  shopDomain: string;
  sessionId: string;
  productId: string;
  position: number;
}

/**
 * Record one ClickEvent, but only when the referenced searchId names a
 * search this shop actually ran (AC-3) — the beacon body is
 * shopper-controlled, and without this check a shopper could log clicks
 * against another shop's searches. Returns false (writing nothing) when the
 * searchId is unknown or belongs to a different shop.
 */
export async function writeClickEvent(
  db: PrismaClient,
  event: ClickEventInput,
): Promise<boolean> {
  const search = await db.searchEvent.findFirst({
    where: { searchId: event.searchId, shopDomain: event.shopDomain },
    select: { id: true },
  });
  if (search === null) {
    return false;
  }
  await db.clickEvent.create({ data: event });
  return true;
}
