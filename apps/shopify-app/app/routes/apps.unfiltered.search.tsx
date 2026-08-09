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
 */
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
    return new Response(null, { status: 401 });
  }
  if (shop === null || shop === "") {
    return new Response(null, { status: 401 });
  }

  let body: ProxySearchBody | null;
  try {
    body = await parse(request);
  } catch {
    body = null;
  }
  if (body === null) {
    return new Response(null, { status: 400 });
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

  // Only genuinely AI-routed searches consume throttle budget: classic
  // routes, chip removal, and throttled responses do not (YOY-47 AC-4).
  if (resolvedIntent === undefined && !throttled && response.route === "ai") {
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

  return Response.json(serializeProxySearchResponse(response));
}

export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleSearch(request, (req) =>
    Promise.resolve(parseProxySearchParams(new URL(req.url).searchParams)),
  );

export const action = async ({ request }: ActionFunctionArgs) =>
  handleSearch(request, async (req) => parseProxySearchBody(await req.json()));
