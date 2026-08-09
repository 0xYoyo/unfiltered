import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { writeSearchEvent } from "../search/events.server";
import {
  createProxySearchOrchestrator,
  parseProxySearchBody,
  parseProxySearchParams,
  removeChipFromIntent,
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
    shop = new URL(request.url).searchParams.get("shop");
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

  // Chip removal: pure intent surgery, then straight to retrieval — no
  // classification and no extraction (YOY-46 AC-4).
  const resolvedIntent =
    body.removeChip !== undefined && body.previousIntent !== undefined
      ? removeChipFromIntent(body.previousIntent, body.removeChip)
      : undefined;

  // Per-session AI throttle (YOY-47): a session past its sliding-window
  // budget is forced onto the classic path with zero LLM calls. Chip
  // removal is exempt — it makes no classification or intent call anyway.
  const throttle = getSessionThrottle();
  const throttled =
    resolvedIntent === undefined && throttle.shouldThrottle(body.sessionId);

  // Containment (YOY-52 AC-4): a failure below the orchestrator's own
  // fallback ladder — construction included — must never surface framework
  // error details to a shopper. Same empty-body style as the 401/400 above.
  try {
    const orchestrator = createProxySearchOrchestrator(db);
    const startedAt = Date.now();
    const response = await orchestrator.runSearch(
      throttled
        ? { query: body.query, shopDomain: shop, forceClassic: true }
        : resolvedIntent !== undefined
          ? { query: body.query, shopDomain: shop, resolvedIntent }
          : {
              query: body.query,
              shopDomain: shop,
              ...(body.previousIntent !== undefined
                ? { previousIntent: body.previousIntent }
                : {}),
            },
    );
    const latencyMs = Date.now() - startedAt;

    // Budget is consumed whenever the classifier decided the AI route (YOY-52
    // AC-5) — an AI-classified search that degraded to classic after intent
    // extraction or retrieval failed (route "classic", degraded, routeReason
    // "model") spent real LLM calls and counts. Heuristic and model-decided
    // classic searches ("short-query", "sku-pattern", non-degraded "model",
    // "model-error") consume nothing; chip removal and throttled responses
    // stay exempt (YOY-47 AC-4).
    const aiDecided =
      response.route === "ai" ||
      (response.degraded && response.routeReason === "model");
    if (resolvedIntent === undefined && !throttled && aiDecided) {
      throttle.recordAiSearch(body.sessionId);
    }

    // Exactly one SearchEvent per search — degraded, zero-hit, and throttled
    // included; a write failure never fails the response (YOY-47 AC-2/AC-5).
    await writeSearchEvent(db, {
      searchId: response.searchId,
      shopDomain: shop,
      sessionId: body.sessionId,
      query: body.query,
      route: response.route,
      degraded: response.degraded,
      latencyMs,
      resultCount: response.hits.length,
    });

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
