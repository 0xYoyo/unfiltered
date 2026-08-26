import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Single source of truth for the workspace packages in every test run
    // (YOY-52 run-5 directive). Each package's `exports` points at its
    // compiled dist/, which is gitignored and rebuilt only by npm install's
    // root postinstall — so an eval or live-regeneration run on a tree whose
    // dist predates the current source silently scores stale logic while
    // every source-level reading looks correct (run 5's
    // "enforceComparativeBounds not in the scored path" was exactly this).
    // Aliasing tests to the TypeScript source removes the stale copy: the
    // scored path IS the source, always.
    //
    // The app resolves the same way since YOY-104: apps/shopify-app/
    // vite.config.ts carries this exact alias (`workspaceSourceAlias`), so
    // the running app, the tests, and the eval runs execute one code path —
    // a stale dist can no longer split "what was tested" from "what runs"
    // (PR #74's port rename did exactly that through an Aug-9 dist).
    // apps/shopify-app/app/workspace-resolution.test.ts keeps the two
    // aliases equal; vitest.dist-seam.config.ts is the deliberate no-alias
    // twin CI uses to prove the built artifact honours the same contract.
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
      // Operational scripts with testable measurement logic (YOY-114: the
      // latency probe's percentile math and exit semantics).
      "apps/*/scripts/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
    ],
  },
});
