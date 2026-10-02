import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  fixtureOutcome,
  playgroundFixturesEnabled,
  selectFixture,
  selectFixtureForRemoval,
  sleep,
} from "../playground/fixture-mode.server";
import {
  clientIp,
  getPlaygroundIpThrottle,
  playgroundLimitsFromEnv,
  PLAYGROUND_RESPONSE_HEADERS,
  remoteAddressFromContext,
  resolveCatalog,
  resolveLimit,
  serializePlaygroundSearchResponse,
} from "../playground/api.server";
import { normalizeReuseQuery, writeSearchEvent } from "../search/events.server";
import { runPlaygroundSearch } from "../search/playground-search.server";
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
  context,
}: LoaderFunctionArgs): Promise<Response> => {
  const url = new URL(request.url);
  const body = parseProxySearchParams(url.searchParams);
  if (body === null) {
    return emptyResponse(400);
  }
  // The engine for this request (YOY-145 AC-6), overriding ENGINE_V2; only
  // this API reads it — the storefront proxy ignores the parameter. An
  // unknown value is a malformed request, like any other parse failure.
  const engineParam = url.searchParams.get("engine");
  if (engineParam !== null && engineParam !== "v1" && engineParam !== "v2") {
    return emptyResponse(400);
  }

  // Fixture mode (YOY-92 AC-8): the UI lane answers from committed JSON, so
  // the page under test needs no database, no Gemini key, and no network.
  // The branch sits after parsing so a malformed request still answers 400
  // in the lane exactly as it does in production.
  if (playgroundFixturesEnabled()) {
    // A chip removal is answered by its own echo rather than by the query
    // text, because the query has not changed — only the constraint set has.
    const outcome = fixtureOutcome(
      body.removeChip !== undefined
        ? selectFixtureForRemoval(body.removeChip)
        : selectFixture(body.query, body.mode !== undefined),
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
  // The classic rescue (YOY-96 AC-9): a submitted search re-asked down the
  // classic path after timing out client-side — logged, unlike a preview.
  const classic = body.mode === "classic";

  // Guards apply only where AI spend is possible. A preview and a classic
  // rescue are classic-only by contract and chip removal makes no LLM call
  // at all, so none can burn budget and none is counted or limited (AC-3).
  const guarded = !preview && !classic && resolvedIntent === undefined;
  const throttle = getPlaygroundIpThrottle();
  // Keyed by the last trusted X-Forwarded-For hop; the connection address is
  // only available to a custom server's load context (YOY-96 AC-11).
  const ip = clientIp(request, remoteAddressFromContext(context));
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
    // The shared search call (YOY-140 AC-6): the score runner searches
    // through this same function.
    const { response, latencyMs } = await runPlaygroundSearch(orchestrator, {
      query: body.query,
      storeKey: catalog.storeKey,
      preview,
      classic,
      limited: limited !== null,
      resolvedIntent,
      previousIntent: body.previousIntent,
      ...(engineParam !== null ? { engine: engineParam } : {}),
      ...(body.paging !== undefined ? { paging: body.paging } : {}),
    });

    // Budget is consumed whenever the classifier actually took the AI route,
    // mirroring the proxy's accounting: a degraded response that still spent
    // its intent call counts, a heuristic classic route does not.
    // An exact-query reuse (YOY-64 AC-4) made no LLM call: no budget spent.
    const aiDecided =
      (response.route === "ai" && response.routeReason !== "intent-reuse") ||
      (response.degraded &&
        (response.routeReason === "model" ||
          // A purpose phrase settles AI deterministically (YOY-133); its
          // degraded fallback still spent the intent call, like "model".
          response.routeReason === "purpose-phrase" ||
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
        routeReason: response.routeReason,
        degraded: response.degraded,
        latencyMs,
        resultCount: response.hits.length,
        // One row per page request, with its page (YOY-145 AC-10).
        page: response.page ?? 1,
        // Only a freshly EXTRACTED intent is stored (YOY-125 AC-3): a
        // response served under "intent-reuse" must not re-anchor the reuse
        // window on itself.
        ...(response.route === "ai" &&
        response.routeReason !== "intent-reuse" &&
        !response.degraded &&
        response.intent !== null
          ? { intent: response.intent, normalizedQuery: normalizeReuseQuery(body.query) }
          : {}),
      });
    }

    return Response.json(
      serializePlaygroundSearchResponse(response, {
        routeReason: response.routeReason,
        latencyMs,
        limited,
        stages: response.stages,
        intentTier: response.intentTier,
        engine: response.engine,
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
