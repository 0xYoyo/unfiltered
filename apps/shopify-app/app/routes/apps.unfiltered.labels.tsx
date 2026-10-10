import type { LoaderFunctionArgs } from "react-router";

import { awaitLatePage, latePageLabels } from "../search/judge-step.server";
import {
  parseLabelsParams,
  serializeLabels,
  serializeProxySearchResponse,
  type ProxyLabelsResponse,
} from "../search/proxy.server";
import { authenticate } from "../shopify.server";

/**
 * The late page (YOY-148 AC-8, AC-9; YOY-171 AC-1): `GET
 * /apps/unfiltered/labels?searchId=…&page=…` under the same app proxy as
 * the search endpoint. When a search was served on a judge deadline miss
 * (`labelsPending: true`), this holds until the judge answers or gives up,
 * then answers the judged page under `page`, in the search response's
 * shape, with `labels` — the page flattened to one label per product id —
 * beside it; an empty `labels` and no `page` when it gave up. Also served
 * at the remainder path /labels (see routes/labels.tsx).
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
  const late = await awaitLatePage(shop, params.searchId, params.page);
  const body: ProxyLabelsResponse = {
    ...serializeLabels(latePageLabels(late)),
    ...(late !== null ? { page: serializeProxySearchResponse(late.response) } : {}),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
};
