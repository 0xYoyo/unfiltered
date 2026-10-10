import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { writeSearchEvent } from "../search/events.server";
import {
  getProxySearchOrchestrator,
  parseProxySearchBody,
  parseProxySearchParams,
  serializeProxySearchResponse,
  type ProxySearchBody,
} from "../search/proxy.server";
import { getSessionThrottle } from "../search/throttle.server";
import { authenticate } from "../shopify.server";

/**
 * The storefront search endpoint (YOY-46), reached only through the Shopify
 * app proxy: the widget requests /apps/unfiltered/search on the shop domain
 * and Shopify forwards it here with the proxy signature.
 *
 * The widget's transport is GET with query parameters (YOY-60 AC-1) — the
 * proxy edge rejects browser POSTs, which always carry `Origin` — served by
 * the loader. The action keeps the original JSON-POST contract for signed
 * server-side callers. Shopify forwards to `{app_proxy.url}/{remainder}`,
 * and the dev CLI pushes the bare tunnel root as the proxy URL, so the same
 * handlers are also served at the remainder path /search (YOY-60 AC-2, see
 * routes/search.tsx).
 *
 * Auth is the proxy signature alone: a missing or invalid signature is
 * answered 401 with an empty body before any search code runs. The shop
 * identity comes exclusively from the signature-verified query params —
 * never from the request body or client-set params, which a shopper
 * controls.
 *
 * Duplicate `shop` params (YOY-52 AC-10): Shopify's proxy edge strips a
 * client-set reserved `shop` param before forwarding — probed live on
 * 2026-08-09 with `shop=attacker-probe.myshopify.com` appended to a proxy
 * GET; the route received only the signed shop and every SearchEvent
 * recorded the real shop domain. Defense in depth beneath that guarantee:
 * the signature validator resolves duplicate params last-wins, so the shop
 * read below takes the LAST occurrence — the value the signature was
 * actually verified against — never a client duplicate smuggled in front
 * of the signed set.
 *
 * Every response — every status — carries `Cache-Control: no-store` (YOY-52
 * AC-9): the widget transport is GET, and per-shopper search responses must
 * never land in a shared or browser cache.
 */

/** Response headers common to every proxy response, whatever the status. */
export const PROXY_RESPONSE_HEADERS = { "Cache-Control": "no-store" } as const;

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: PROXY_RESPONSE_HEADERS });
}

async function handleSearch(
  request: Request,
  parse: (request: Request) => Promise<ProxySearchBody | null>,
): Promise<Response> {
  let shop: string | null;
  try {
    // Validates the signature over the proxy query params; throws a
    // Response for missing/invalid signatures.
    await authenticate.public.appProxy(request);
    // Last occurrence: the value the signature validation verified (see the
    // duplicate-shop note above).
    shop = new URL(request.url).searchParams.getAll("shop").at(-1) ?? null;
  } catch {
    return emptyResponse(401);
  }
  if (shop === null || shop === "") {
    return emptyResponse(401);
  }

  let body: ProxySearchBody | null;
  try {
    body = await parse(request);
  } catch {
    body = null;
  }
  if (body === null) {
    return emptyResponse(400);
  }

  // Keystroke preview (YOY-68): classic-only, zero LLM calls, outside the
  // throttle and outside the SearchEvent log — the submitted search is the
  // shopper's actual query; previews are typing noise.
  const preview = body.mode === "preview";
  // The classic rescue (YOY-96 AC-9): the widget's SUBMITTED search timed
  // out on its side and it re-asks the same query down the classic path —
  // the same zero-LLM keyword results as a preview, but a real search the
  // shopper made, so it is logged and attributable like any other submit.
  const classic = body.mode === "classic";

  // Per-session AI throttle (YOY-47): a session past its sliding-window
  // budget is served find order with no judge call (YOY-147 AC-7).
  // Previews and classic rescues make no model call, so the throttle
  // ignores them.
  const throttle = getSessionThrottle();
  const throttled = !preview && !classic && throttle.shouldThrottle(body.sessionId);

  // Containment (YOY-52 AC-4): a failure below the orchestrator's own
  // fallback ladder — construction included — must never surface framework
  // error details to a shopper. Same empty-body style as the 401/400 above.
  try {
    // Module singleton (YOY-67 AC-7). Construction failures are not
    // memoized, so this stays inside the containment try.
    const orchestrator = getProxySearchOrchestrator(db);
    const startedAt = Date.now();
    // Page parameters ride every submitted shape (YOY-145 AC-4); the
    // orchestrator ignores them on a preview (AC-9).
    const paging = body.paging !== undefined ? { paging: body.paging } : {};
    // Chips removed from a previous response (YOY-149 AC-15).
    const removed =
      body.removedChips !== undefined ? { removedChips: body.removedChips } : {};
    // The refinement chain (YOY-150 AC-1).
    const chain =
      body.previousQuery !== undefined ? { previousQuery: body.previousQuery } : {};
    const response = await orchestrator.runSearch(
      preview
        ? { query: body.query, shopDomain: shop, preview: true }
        : classic
          ? {
              query: body.query,
              shopDomain: shop,
              forceClassic: true,
              forceClassicReason: "client-timeout-rescue",
              ...paging,
            }
          : throttled
            ? { query: body.query, shopDomain: shop, forceClassic: true, ...paging, ...removed, ...chain }
            : { query: body.query, shopDomain: shop, ...paging, ...removed, ...chain },
    );
    const latencyMs = Date.now() - startedAt;

    // One structured line per SUBMITTED search (YOY-114 AC-2): the proxy
    // contract never carries `stages` (NG-3) — the widget has no use for it
    // and the storefront wire stays pinned — so the per-stage split reaches
    // the server log instead, where the latency probe's method reads it.
    if (!preview) {
      console.log(
        "[search] stages",
        JSON.stringify({
          searchId: response.searchId,
          route: response.route,
          routeReason: response.routeReason,
          latencyMs,
          stages: response.stages,
        }),
      );
    }

    // Budget is consumed by every search the find step served (route
    // "ai"); previews, classic rescues and throttled searches consume
    // nothing (YOY-47 AC-4). Only page 1 spends budget (YOY-157 AC-29): a
    // later page is the same search scrolled, and it answers `route: "ai"`
    // (AC-23) even when it made no model call.
    const firstPage = (response.page ?? 1) === 1;
    if (!preview && !throttled && response.route === "ai" && firstPage) {
      throttle.recordAiSearch(body.sessionId);
    }

    // Exactly one SearchEvent per SUBMITTED search — degraded, zero-hit,
    // throttled, and classic-rescued included; a write failure never fails
    // the response (YOY-47 AC-2/AC-5). Keystroke previews are never logged
    // (YOY-68 AC-3): they would flood analytics with per-keystroke noise,
    // and the click beacon has nothing to attribute to a search the shopper
    // never submitted. The row keeps the orchestrator's routeReason (YOY-96
    // AC-9) so a rescue is distinguishable from a throttled search in the
    // ledger.
    if (!preview) {
      await writeSearchEvent(db, {
        searchId: response.searchId,
        shopDomain: shop,
        sessionId: body.sessionId,
        query: body.query,
        route: response.route,
        routeReason: response.routeReason,
        degraded: response.degraded,
        latencyMs,
        resultCount: response.hits.length,
        // One row per page request, with its page (YOY-145 AC-10); an
        // unpaged response is the first and only page.
        page: response.page ?? 1,
      });
    }

    return Response.json(serializeProxySearchResponse(response), {
      headers: PROXY_RESPONSE_HEADERS,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    return emptyResponse(500);
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleSearch(request, (req) =>
    Promise.resolve(parseProxySearchParams(new URL(req.url).searchParams)),
  );

export const action = async ({ request }: ActionFunctionArgs) =>
  handleSearch(request, async (req) => parseProxySearchBody(await req.json()));
