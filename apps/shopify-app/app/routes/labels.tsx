/**
 * Remainder-path alias for the labels endpoint (YOY-148 AC-8) — same mapping
 * rationale as routes/search.tsx: Shopify forwards the path remainder onto
 * `app_proxy.url`, which is the app/tunnel root in dev and production.
 */
export { loader } from "./apps.unfiltered.labels";
