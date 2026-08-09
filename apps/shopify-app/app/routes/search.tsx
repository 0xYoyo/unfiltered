/**
 * Remainder-path alias for the storefront search endpoint (YOY-60 AC-2).
 *
 * Shopify's app proxy forwards /apps/unfiltered/search on the shop domain
 * to `{app_proxy.url}` + the path REMAINDER after the prefix/subpath — so
 * with the proxy URL at the app root (what the dev CLI pushes for the
 * tunnel, and what a root production `app_proxy.url` gives), the request
 * lands here at /search. The canonical module keeps the full-subpath route
 * for proxy URLs that carry /apps/unfiltered themselves; both serve the
 * identical signed handlers.
 */
export { action, loader } from "./apps.unfiltered.search";
