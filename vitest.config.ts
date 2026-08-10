import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Single source of truth for the workspace packages in every test run
    // (YOY-52 run-5 directive). The app resolves @unfiltered/* through each
    // package's compiled dist/, which is gitignored and rebuilt only by npm
    // install's prepare hook — so an eval or live-regeneration run on a tree
    // whose dist predates the current source silently scores stale logic
    // while every source-level reading looks correct (run 5's
    // "enforceComparativeBounds not in the scored path" was exactly this).
    // Aliasing tests to the TypeScript source removes the stale copy: the
    // scored path IS the source, always.
    alias: {
      "@unfiltered/engine": fileURLToPath(
        new URL("./packages/engine/src/index.ts", import.meta.url),
      ),
      "@unfiltered/provider-gemini": fileURLToPath(
        new URL("./packages/provider-gemini/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "apps/*/app/**/*.test.{ts,tsx}",
      "packages/*/test/**/*.test.ts",
    ],
  },
});
