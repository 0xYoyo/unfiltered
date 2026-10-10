import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  fixtureLabels,
  playgroundFixturesEnabled,
  sleep,
} from "../playground/fixture-mode.server";
import {
  PLAYGROUND_RESPONSE_HEADERS,
  resolveCatalog,
  serializePlaygroundSearchResponse,
  type PlaygroundSearchResponse,
} from "../playground/api.server";
import { awaitLatePage, latePageLabels } from "../search/judge-step.server";
import {
  parseLabelsParams,
  serializeLabels,
  type ProxyLabelsResponse,
} from "../search/proxy.server";

/**
 * The playground's late page (YOY-148 AC-8, AC-9; YOY-171 AC-1): `GET
 * /api/playground/labels?searchId=…&page=…` against the catalog named by
 * `catalog` (or the seed). Holds until the judge answers or gives up, then
 * answers the judged page under `page` — the playground search response's
 * shape, its details timed from the search's start — with `labels`, the
 * page flattened, beside it; an empty set when it gave up. A searchId from
 * another catalog answers an empty set: pages are held per tenant. The
 * playground asks it once per page answered with `labelsPending` (YOY-151
 * AC-8). Fixture mode answers with no database: the `labels-pending`
 * fixture's late page, or an empty set.
 */

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: PLAYGROUND_RESPONSE_HEADERS,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<Response> => {
  const url = new URL(request.url);
  const params = parseLabelsParams(url.searchParams);
  if (params === null) {
    return emptyResponse(400);
  }
  if (playgroundFixturesEnabled()) {
    const fixture = fixtureLabels(params.searchId);
    await sleep(fixture.delayMs);
    const body: ProxyLabelsResponse<PlaygroundSearchResponse> = {
      ...serializeLabels(fixture.labels),
      ...(fixture.page !== null ? { page: fixture.page } : {}),
    };
    return Response.json(body, { headers: PLAYGROUND_RESPONSE_HEADERS });
  }
  const catalog = await resolveCatalog(db, url.searchParams.get("catalog"));
  if ("status" in catalog) {
    return emptyResponse(catalog.status);
  }
  const late = await awaitLatePage(catalog.storeKey, params.searchId, params.page);
  const body: ProxyLabelsResponse<PlaygroundSearchResponse> = {
    ...serializeLabels(latePageLabels(late)),
    ...(late !== null
      ? {
          page: serializePlaygroundSearchResponse(late.response, {
            routeReason: late.response.routeReason,
            latencyMs: late.latencyMs,
            limited: null,
            stages: late.response.stages,
          }),
        }
      : {}),
  };
  return Response.json(body, { headers: PLAYGROUND_RESPONSE_HEADERS });
};
