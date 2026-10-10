import type { PrismaClient } from "@prisma/client";

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
   * written for every submitted search (YOY-96 AC-9) so a row can be told
   * apart by cause: the judge's outcome, a capped session, or the widget's
   * "client-timeout-rescue" of a search that timed out on its side. Rows
   * from before the column are null.
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
}

/**
 * The exact-query key the judge answer cache and the extraction cache are
 * keyed by (YOY-148, YOY-149 AC-18): trimmed, whitespace-collapsed,
 * case-folded. Exact text only — no paraphrase, no stemming.
 */
export function normalizeReuseQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
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
    await db.searchEvent.create({ data: event });
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
  // The verdict log's clicked-at time (YOY-148 AC-5): the first click on a
  // product of a judged or cache-served page marks its row. Never fails the
  // beacon: the log is an observer.
  try {
    await db.judgeVerdict.updateMany({
      where: {
        searchId: event.searchId,
        shopDomain: event.shopDomain,
        productId: event.productId,
        clickedAt: null,
      },
      data: { clickedAt: new Date() },
    });
  } catch (error) {
    console.error(`judge-verdict click mark failed for search ${event.searchId}:`, error);
  }
  return true;
}
