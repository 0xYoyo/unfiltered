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
} from "../playground/api.server";
import { awaitPendingLabels } from "../search/judge-step.server";
import { parseLabelsParams, serializeLabels } from "../search/proxy.server";

/**
 * The playground's late labels (YOY-148 AC-8, AC-9): `GET
 * /api/playground/labels?searchId=…&page=…` against the catalog named by
 * `catalog` (or the seed). Holds until the judge answers or gives up, then
 * answers one label per product id, or an empty set — never an order. A
 * searchId from another catalog answers an empty set: labels are held per
 * tenant. The playground asks it once per page answered with
 * `labelsPending` (YOY-151 AC-8). Fixture mode answers with no database:
 * the `labels-pending` fixture's late labels, or an empty set.
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
    return Response.json(serializeLabels(fixture.labels), {
      headers: PLAYGROUND_RESPONSE_HEADERS,
    });
  }
  const catalog = await resolveCatalog(db, url.searchParams.get("catalog"));
  if ("status" in catalog) {
    return emptyResponse(catalog.status);
  }
  const labels = await awaitPendingLabels(catalog.storeKey, params.searchId, params.page);
  return Response.json(serializeLabels(labels), { headers: PLAYGROUND_RESPONSE_HEADERS });
};
