import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  fixtureOutcome,
  pageOfFixture,
  parseFixtureRemovedChips,
  playgroundFixturesEnabled,
  selectFixture,
  sleep,
  withFixtureCarry,
  withoutRemovedChips,
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
import { writeSearchEvent } from "../search/events.server";
import { runPlaygroundSearch } from "../search/playground-search.server";
import { getProxySearchOrchestrator, parseProxySearchParams } from "../search/proxy.server";

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
 * sit in front of the judge (see playground/api.server.ts). Every one of
 * them serves find order with no judge call rather than an error: a visitor
 * who trips a ceiling still gets a working search, told honestly through
 * `details.limited`.
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
  // Fixture mode (YOY-92 AC-8): the UI lane answers from committed JSON, so
  // the page under test needs no database, no Gemini key, and no network.
  // The branch sits after parsing so a malformed request still answers 400
  // in the lane exactly as it does in production.
  if (playgroundFixturesEnabled()) {
    // Paged like the real endpoint (YOY-146): page parameters in, that
    // page plus `page` and `totalCount` out. A chip removal (YOY-149)
    // re-asks the same query, so the query still picks the fixture;
    // `removedChips` takes those chips off it.
    const removedChips = parseFixtureRemovedChips(
      url.searchParams.get("removedChips"),
    );
    const selected = fixtureOutcome(
      selectFixture(body.query, body.mode !== undefined),
      body.paging,
    );
    const outcome = withFixtureCarry(
      pageOfFixture(
        removedChips === null
          ? selected
          : withoutRemovedChips(selected, removedChips),
        body.mode === "preview" ? undefined : body.paging,
      ),
      body.query,
      body.previousQuery,
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

  const preview = body.mode === "preview";
  // The classic rescue (YOY-96 AC-9): a submitted search re-asked down the
  // classic path after timing out client-side — logged, unlike a preview.
  const classic = body.mode === "classic";

  // Guards apply only where AI spend is possible. A preview and a classic
  // rescue are classic-only by contract, so neither can burn budget and
  // neither is counted or limited (AC-3). A preview's one spend is the wish
  // extraction it starts for the submit (YOY-171 AC-7), which a capped
  // search makes too.
  const guarded = !preview && !classic;
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
      ...(body.removedChips !== undefined ? { removedChips: body.removedChips } : {}),
      ...(body.previousQuery !== undefined ? { previousQuery: body.previousQuery } : {}),
      ...(body.paging !== undefined ? { paging: body.paging } : {}),
    });

    // Budget is consumed by every search the find step served (route
    // "ai"), mirroring the proxy's accounting.
    // Only page 1 of a submitted search spends budget (YOY-157 AC-29); the
    // daily ceilings count page-1 rows only (`countAiSearchesToday`).
    const firstPage = (response.page ?? 1) === 1;
    if (guarded && limited === null && response.route === "ai" && firstPage) {
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
      });
    }

    return Response.json(
      serializePlaygroundSearchResponse(response, {
        routeReason: response.routeReason,
        latencyMs,
        limited,
        stages: response.stages,
      }),
      { headers: PLAYGROUND_RESPONSE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    // Containment, as on the proxy route: nothing below the orchestrator
    // may surface framework error detail to a visitor.
    return emptyResponse(500);
  }
};
