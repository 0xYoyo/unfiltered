import type { LoaderFunctionArgs } from "react-router";

import { awaitPendingLabels } from "../search/judge-step.server";
import { parseLabelsParams, serializeLabels } from "../search/proxy.server";
import { authenticate } from "../shopify.server";

/**
 * Late labels (YOY-148 AC-8, AC-9): `GET /apps/unfiltered/labels?searchId=…
 * &page=…` under the same app proxy as the search endpoint. When a search
 * was served on a judge deadline miss (`labelsPending: true`), this holds
 * until the judge answers or gives up, then answers one label per product
 * id — or an empty set. It never answers an order: positions served earlier
 * stand. No client calls it yet (NG-2). Also served at the remainder path
 * /labels (see routes/labels.tsx).
 *
 * Auth mirrors the search route: proxy signature or 401, shop identity from
 * the LAST `shop` parameter (the signature-verified value). Labels are held
 * per shop, so a searchId from another shop answers an empty set.
 */

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let shop: string | null;
  try {
    await authenticate.public.appProxy(request);
    shop = new URL(request.url).searchParams.getAll("shop").at(-1) ?? null;
  } catch {
    return emptyResponse(401);
  }
  if (shop === null || shop === "") {
    return emptyResponse(401);
  }
  const params = parseLabelsParams(new URL(request.url).searchParams);
  if (params === null) {
    return emptyResponse(400);
  }
  const labels = await awaitPendingLabels(shop, params.searchId, params.page);
  return Response.json(serializeLabels(labels), {
    headers: { "Cache-Control": "no-store" },
  });
};
