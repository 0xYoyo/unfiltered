import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  fixtureOutcome,
  playgroundFixturesEnabled,
  selectFixture,
  sleep,
} from "../playground/fixture-mode.server";
import {
  clientIp,
  getPlaygroundIpThrottle,
  playgroundLimitsFromEnv,
  PLAYGROUND_RESPONSE_HEADERS,
  PLAYGROUND_RESULT_LIMIT,
  resolveCatalog,
  resolveLimit,
  serializePlaygroundSearchResponse,
} from "../playground/api.server";
import { writeSearchEvent } from "../search/events.server";
import {
  getProxySearchOrchestrator,
  parseProxySearchParams,
  removeChipFromIntent,
} from "../search/proxy.server";

/**
 * The playground's search endpoint (YOY-90): `GET /api/playground/search` on
 * our own origin, unauthenticated and same-origin only, running the SAME
 * orchestrator the Shopify proxy runs over a catalog named by `catalog` (a
 * registry slug) or the env-configured seed.
 *
 * It speaks the proxy's own parameters — parsed by the proxy's own
 * `parseProxySearchParams`, so preview, refinement, and chip removal cannot
 * drift between the two APIs — and answers the proxy contract plus a
 * `details` object the playground renders as "what the engine did".
 *
 * Being unauthenticated, its real exposure is the AI bill, so three guards
 * sit in front of the AI path (see playground/api.server.ts). Every one of
 * them degrades to classic results rather than to an error: a visitor who
 * trips a ceiling still gets a working search, told honestly through
 * `degraded` and `details.limited`.
 *
 * No CORS headers are set anywhere (NG-2): the playground's own pages are
 * same-origin, and a third party must not be able to spend our AI budget
 * from their site. Every response carries `Cache-Control: no-store` — the
 * bodies are per-visitor and must never land in a shared cache.
 */

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: PLAYGROUND_RESPONSE_HEADERS,
  });
}

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<Response> => {
  const url = new URL(request.url);
  const body = parseProxySearchParams(url.searchParams);
  if (body === null) {
    return emptyResponse(400);
  }

  // Fixture mode (YOY-92 AC-8): the UI lane answers from committed JSON, so
  // the page under test needs no database, no Gemini key, and no network.
  // The branch sits after parsing so a malformed request still answers 400
  // in the lane exactly as it does in production.
  if (playgroundFixturesEnabled()) {
    const outcome = fixtureOutcome(
      selectFixture(body.query, body.mode === "preview"),
    );
    await sleep(outcome.delayMs);
    return outcome.body === null
      ? emptyResponse(outcome.status)
      : Response.json(outcome.body, { headers: PLAYGROUND_RESPONSE_HEADERS });
  }

  const catalog = await resolveCatalog(db, url.searchParams.get("catalog"));
  if ("status" in catalog) {
    return emptyResponse(catalog.status);
  }

  // Chip removal: pure intent surgery, then straight to retrieval — no
  // classification and no extraction, exactly as the proxy route does it.
  const resolvedIntent =
    body.removeChip !== undefined && body.previousIntent !== undefined
      ? removeChipFromIntent(body.previousIntent, body.removeChip)
      : undefined;
  const preview = body.mode === "preview";

  // Guards apply only where AI spend is possible. A preview is classic-only
  // by contract and chip removal makes no LLM call at all, so neither can
  // burn budget and neither is counted or limited (AC-3).
  const guarded = !preview && resolvedIntent === undefined;
  const throttle = getPlaygroundIpThrottle();
  const ip = clientIp(request);
  const limited = guarded
    ? await resolveLimit({
        db,
        catalog,
        ipThrottled: throttle.shouldThrottle(ip),
        limits: playgroundLimitsFromEnv(),
      })
    : null;

  try {
    const orchestrator = getProxySearchOrchestrator(db);
    const startedAt = Date.now();
    const response = await orchestrator.runSearch({
      query: body.query,
      shopDomain: catalog.storeKey,
      limit: PLAYGROUND_RESULT_LIMIT,
      ...(preview
        ? { preview: true }
        : limited !== null
          ? { forceClassic: true }
          : resolvedIntent !== undefined
            ? { resolvedIntent }
            : body.previousIntent !== undefined
              ? { previousIntent: body.previousIntent }
              : {}),
    });
    const latencyMs = Date.now() - startedAt;

    // Budget is consumed whenever the classifier actually took the AI route,
    // mirroring the proxy's accounting: a degraded response that still spent
    // its intent call counts, a heuristic classic route does not.
    const aiDecided =
      response.route === "ai" ||
      (response.degraded &&
        (response.routeReason === "model" ||
          response.routeReason === "classic-zero-hit"));
    if (guarded && limited === null && aiDecided) {
      throttle.recordAiSearch(ip);
    }

    // One SearchEvent per SUBMITTED search — limited ones included, because
    // the daily ceilings are counted from this table and a search that was
    // denied still happened (AC-6). Previews are never logged (AC-3).
    if (!preview) {
      await writeSearchEvent(db, {
        searchId: response.searchId,
        shopDomain: catalog.storeKey,
        sessionId: body.sessionId,
        query: body.query,
        route: response.route,
        degraded: response.degraded,
        latencyMs,
        resultCount: response.hits.length,
      });
    }

    return Response.json(
      serializePlaygroundSearchResponse(response, {
        routeReason: response.routeReason,
        latencyMs,
        limited,
      }),
      { headers: PLAYGROUND_RESPONSE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    // Containment, as on the proxy route: nothing below the orchestrator's
    // own fallback ladder may surface framework error detail to a visitor.
    return emptyResponse(500);
  }
};
