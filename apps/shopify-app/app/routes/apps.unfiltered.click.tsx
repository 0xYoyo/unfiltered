import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import { writeClickEvent } from "../search/events.server";
import { parseClickBeaconBody } from "../search/proxy.server";
import { authenticate } from "../shopify.server";

/**
 * The click beacon (YOY-47), under the same app proxy as the search
 * endpoint: the widget POSTs a clicked result's searchId/productId/position
 * to /apps/unfiltered/click, fire-and-forget.
 *
 * Auth mirrors the search route: proxy signature or 401, shop identity from
 * the verified query params only. The body's searchId must name a search
 * this shop actually ran, else 404 and no row — the body is
 * shopper-controlled and must not write into another shop's log.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  let shop: string | null;
  try {
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
    body = parseClickBeaconBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return new Response(null, { status: 400 });
  }

  const recorded = await writeClickEvent(db, {
    searchId: body.searchId,
    shopDomain: shop,
    sessionId: body.sessionId,
    productId: body.productId,
    position: body.position,
  });
  if (!recorded) {
    return new Response(null, { status: 404 });
  }
  return new Response(null, { status: 204 });
};
