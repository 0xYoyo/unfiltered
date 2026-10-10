import { defineConfig } from "vitest/config";

// Dist-seam config (YOY-104 AC-3): the SAME suites as vitest.config.ts but
// WITHOUT the @unfiltered/* → src alias, so @unfiltered/engine and
// @unfiltered/provider-gemini resolve the way any consumer of the published
// packages would — through each package's `exports` → compiled dist/.
//
// Nothing in this repository executes dist any more (the app and every test
// run the source; see apps/shopify-app/vite.config.ts), but the port contract
// between app and engine must hold for the built artifact too: PR #74's
// shopDomain → storeId rename went green on src-aliased tests while a stale
// dist returned zero rows for every AI-routed search. CI's `dist-seam` job
// builds the workspaces and runs the search-path suites through this
// config; a src/dist contract divergence fails there and nowhere else.
//
//   npm run build
//   npx vitest run --config vitest.dist-seam.config.ts \
//     apps/shopify-app/app/search/orchestrator.test.ts \
//     apps/shopify-app/app/search/engine-v2.test.ts
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "apps/*/app/**/*.test.{ts,tsx}",
      "packages/*/test/**/*.test.ts",
    ],
  },
});
