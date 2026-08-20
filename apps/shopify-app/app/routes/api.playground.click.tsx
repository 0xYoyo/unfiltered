import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import { playgroundFixturesEnabled } from "../playground/fixture-mode.server";
import {
  PLAYGROUND_RESPONSE_HEADERS,
  resolveCatalog,
} from "../playground/api.server";
import { writeClickEvent } from "../search/events.server";
import { parseClickBeaconBody } from "../search/proxy.server";

/**
 * The playground's click beacon (YOY-90 AC-6): `POST /api/playground/click`
 * with the proxy beacon's own JSON body, against the catalog named by
 * `catalog` (or the seed). POST rather than the proxy's GET because there is
 * no Shopify proxy edge here to work around — this is our own origin, and a
 * write belongs on a write verb.
 *
 * The searchId must name a search THIS catalog actually ran. The body is
 * visitor-controlled, so without that check a visitor could attribute clicks
 * to another catalog's searches; `writeClickEvent` enforces it and answers
 * false, which becomes a 404 with no row written.
 */

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: PLAYGROUND_RESPONSE_HEADERS,
  });
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<Response> => {
  // Fixture mode (YOY-92 AC-8): the beacon is observed by the UI lane
  // through the network, not through a row, so it acknowledges without a
  // database. The body is still parsed below, so a malformed beacon fails
  // in the lane exactly as it would in production.
  const fixtures = playgroundFixturesEnabled();

  const catalog = fixtures
    ? null
    : await resolveCatalog(
        db,
        new URL(request.url).searchParams.get("catalog"),
      );
  if (catalog !== null && "status" in catalog) {
    return emptyResponse(catalog.status);
  }

  let body;
  try {
    body = parseClickBeaconBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return emptyResponse(400);
  }

  if (catalog === null) {
    return emptyResponse(204);
  }

  const recorded = await writeClickEvent(db, {
    searchId: body.searchId,
    shopDomain: catalog.storeKey,
    sessionId: body.sessionId,
    productId: body.productId,
    position: body.position,
  });
  return emptyResponse(recorded ? 204 : 404);
};
