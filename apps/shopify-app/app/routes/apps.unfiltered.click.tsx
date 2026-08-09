import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { writeClickEvent } from "../search/events.server";
import {
  parseClickBeaconBody,
  parseClickBeaconParams,
  type ClickBeaconBody,
} from "../search/proxy.server";
import { authenticate } from "../shopify.server";

/**
 * The click beacon (YOY-47), under the same app proxy as the search
 * endpoint: the widget reports a clicked result's searchId/productId/
 * position to /apps/unfiltered/click, fire-and-forget. The widget rides
 * GET query parameters (YOY-60 AC-1 — browser POSTs cannot pass the proxy
 * edge), served by the loader; the action keeps the JSON-POST contract for
 * signed server-side callers. Also served at the remainder path /click
 * (YOY-60 AC-2, see routes/click.tsx).
 *
 * Auth mirrors the search route: proxy signature or 401, shop identity from
 * the verified query params only. The beacon's searchId must name a search
 * this shop actually ran, else 404 and no row — the beacon fields are
 * shopper-controlled and must not write into another shop's log.
 *
 * Every response — every status — carries `Cache-Control: no-store` (YOY-52
 * AC-9): the beacon rides GET, and its responses must never be cached.
 */

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleClick(
  request: Request,
  parse: (request: Request) => Promise<ClickBeaconBody | null>,
): Promise<Response> {
  let shop: string | null;
  try {
    await authenticate.public.appProxy(request);
    shop = new URL(request.url).searchParams.get("shop");
  } catch {
    return emptyResponse(401);
  }
  if (shop === null || shop === "") {
    return emptyResponse(401);
  }

  let body: ClickBeaconBody | null;
  try {
    body = await parse(request);
  } catch {
    body = null;
  }
  if (body === null) {
    return emptyResponse(400);
  }

  const recorded = await writeClickEvent(db, {
    searchId: body.searchId,
    shopDomain: shop,
    sessionId: body.sessionId,
    productId: body.productId,
    position: body.position,
  });
  if (!recorded) {
    return emptyResponse(404);
  }
  return emptyResponse(204);
}

export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleClick(request, (req) =>
    Promise.resolve(parseClickBeaconParams(new URL(req.url).searchParams)),
  );

export const action = async ({ request }: ActionFunctionArgs) =>
  handleClick(request, async (req) => parseClickBeaconBody(await req.json()));
