import type { FetchLike } from "../playground/polite-fetch.server";

/**
 * In-memory fake storefront for the public-catalog tests (YOY-88): routes
 * are matched by exact `pathname + search` (with `*` for a catch-all), every
 * request is logged, and a route can be a Response, a body, or a function of
 * the request count for stateful scripts (429 then 200). Offline by
 * construction — anything unrouted answers 404, never the network.
 */
export type FakeRoute =
  | string
  | Record<string, unknown>
  | unknown[]
  | Response
  | ((call: number, url: URL) => Response | string | Record<string, unknown> | unknown[]);

export interface FakeStore {
  fetch: FetchLike;
  requests: Array<{ url: string; headers: Record<string, string> }>;
  routes: Map<string, FakeRoute>;
}

export function createFakeStore(routes: Record<string, FakeRoute> = {}): FakeStore {
  const routeMap = new Map(Object.entries(routes));
  const requests: FakeStore["requests"] = [];
  const counts = new Map<string, number>();
  const toResponse = (value: Exclude<FakeRoute, (...args: never[]) => unknown>): Response => {
    if (value instanceof Response) {
      return value.clone();
    }
    if (typeof value === "string") {
      return new Response(value, { headers: { "Content-Type": "text/plain" } });
    }
    return new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    requests.push({ url: input, headers: init?.headers ?? {} });
    const key = `${url.pathname}${url.search}`;
    const route = routeMap.get(key) ?? routeMap.get(url.pathname) ?? routeMap.get("*");
    if (route === undefined) {
      return new Response("Not found", { status: 404 });
    }
    if (typeof route === "function") {
      const call = (counts.get(key) ?? 0) + 1;
      counts.set(key, call);
      return toResponse(route(call, url));
    }
    return toResponse(route);
  };
  return { fetch, requests, routes: routeMap };
}
