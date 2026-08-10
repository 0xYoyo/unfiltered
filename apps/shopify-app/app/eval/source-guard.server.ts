import * as engine from "@unfiltered/engine";

// Source-execution guard (YOY-52 run-6 root cause): vitest invoked with its
// working directory inside apps/shopify-app picks up the app's vite.config.ts
// — which carries no engine alias — instead of the root vitest.config.ts, so
// @unfiltered/engine silently resolves to the gitignored compiled dist/ and
// the run scores stale logic. The engine exports ENGINE_SOURCE_URL, the URL
// it was actually loaded from; anything outside packages/engine/src means the
// alias was bypassed. Path-based, so every future dist-skew layer trips it,
// not just one missing symbol.

const SOURCE_PATH = "/packages/engine/src/";

/**
 * Null when the engine module URL points into packages/engine/src; otherwise
 * the failure message naming the fix. `undefined` (a dist build so stale it
 * predates the sentinel export) also trips.
 */
export function engineSourceResolutionFailure(
  moduleUrl: unknown,
): string | null {
  if (typeof moduleUrl === "string" && moduleUrl.includes(SOURCE_PATH)) {
    return null;
  }
  const loadedFrom =
    typeof moduleUrl === "string"
      ? moduleUrl
      : "a compiled build so stale it predates the ENGINE_SOURCE_URL sentinel";
  return (
    `@unfiltered/engine did not resolve to packages/engine/src — it loaded from ${loadedFrom}. ` +
    "This run would score stale compiled dist/ output while every source-level reading looks correct, " +
    "so it stops here, before any paid call. " +
    "Fix: run from the repository root so the root vitest.config.ts alias applies — " +
    "`LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm run regen:live`."
  );
}

/** Throw loudly unless @unfiltered/engine is executing from source. */
export function assertEngineSourceExecution(): void {
  const failure = engineSourceResolutionFailure(
    (engine as { ENGINE_SOURCE_URL?: unknown }).ENGINE_SOURCE_URL,
  );
  if (failure !== null) {
    throw new Error(failure);
  }
}
