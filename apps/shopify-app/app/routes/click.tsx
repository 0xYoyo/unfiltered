/**
 * Remainder-path alias for the click beacon (YOY-60 AC-2) — same mapping
 * rationale as routes/search.tsx: Shopify forwards the path remainder onto
 * `app_proxy.url`, which is the app/tunnel root in dev and production.
 */
export { action, loader } from "./apps.unfiltered.click";
