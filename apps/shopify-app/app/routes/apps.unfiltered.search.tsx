import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import {
  createProxySearchOrchestrator,
  parseProxySearchBody,
  removeChipFromIntent,
  serializeProxySearchResponse,
} from "../search/proxy.server";
import { authenticate } from "../shopify.server";

/**
 * The storefront search endpoint (YOY-46), reached only through the Shopify
 * app proxy configured in shopify.app.toml: the widget POSTs to
 * /apps/unfiltered/search on the shop domain and Shopify forwards it here
 * with the proxy signature.
 *
 * Auth is the proxy signature alone: a missing or invalid signature is
 * answered 401 with an empty body before any search code runs. The shop
 * identity comes exclusively from the signature-verified query params —
 * never from the request body, which a shopper controls.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
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

  let body;
  try {
    body = parseProxySearchBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return new Response(null, { status: 400 });
  }

  const orchestrator = createProxySearchOrchestrator(db);
  const response = await orchestrator.runSearch(
    body.removeChip !== undefined && body.previousIntent !== undefined
      ? {
          // Chip removal: pure intent surgery, then straight to retrieval —
          // no classification and no extraction (AC-4).
          query: body.query,
          shopDomain: shop,
          resolvedIntent: removeChipFromIntent(
            body.previousIntent,
            body.removeChip,
          ),
        }
      : {
          query: body.query,
          shopDomain: shop,
          ...(body.previousIntent !== undefined
            ? { previousIntent: body.previousIntent }
            : {}),
        },
  );

  return Response.json(serializeProxySearchResponse(response));
};
