import { defineConfig } from "@playwright/test";

/**
 * UI test lane. Two projects, one entry point (`npm run test:ui`):
 *
 * - `widget` (YOY-43) drives the storefront widget against its Vite dev
 *   harness — fake theme pages, a stubbed search endpoint, no Shopify.
 * - `playground` (YOY-92 AC-8) drives the real built app with
 *   `PLAYGROUND_FIXTURES=1`, so the page under test is the page that ships
 *   while `/api/playground/*` answers from committed fixtures — no database,
 *   no Gemini key, no network.
 *
 * The playground project runs the built server rather than a dev server on
 * purpose: SSR `lang`/`dir` and the meta tags are what AC-1 and AC-3 are
 * about, and a client-only harness could not prove them.
 */

const PLAYGROUND_PORT = 4174;

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Named projects would otherwise append `-<project>` to every snapshot
  // file name, silently orphaning the widget's committed baselines and
  // re-recording them on the next run. Pinning the template keeps the
  // existing names, so the widget's visual guard still guards.
  snapshotPathTemplate:
    "{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}",
  expect: {
    // Visual baselines (YOY-50 AC-5): absorb sub-perceptual antialiasing
    // jitter between runs; a mirrored or restrung overlay still fails.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  projects: [
    {
      name: "widget",
      testDir: "apps/shopify-app/widget/test-ui",
      use: { baseURL: "http://127.0.0.1:4173" },
    },
    {
      name: "playground",
      testDir: "apps/shopify-app/app/playground/test-ui",
      use: { baseURL: `http://127.0.0.1:${PLAYGROUND_PORT}` },
      // The @evidence specs capture design-review screenshots into
      // docs/evidence/ rather than asserting anything, so they are off the
      // default lane — otherwise every run rewrites committed PNGs. Opting
      // in has to lift the filter itself, because grep and grepInvert both
      // apply and `-g @evidence` alone would still match nothing:
      //   PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground
      ...(process.env.PLAYGROUND_EVIDENCE === "1"
        ? {}
        : { grepInvert: /@evidence/ }),
    },
  ],
  use: {
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm run widget:harness --workspace app",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run start --workspace app",
      url: `http://127.0.0.1:${PLAYGROUND_PORT}/`,
      reuseExistingServer: !process.env.CI,
      env: {
        PLAYGROUND_FIXTURES: "1",
        PORT: String(PLAYGROUND_PORT),
        HOST: "127.0.0.1",
        // Dummy Shopify configuration: the playground page itself never
        // authenticates, but the app's server modules read these at boot.
        SHOPIFY_API_KEY: "playground-fixture-key",
        SHOPIFY_API_SECRET: "playground-fixture-secret",
        SHOPIFY_APP_URL: `http://127.0.0.1:${PLAYGROUND_PORT}`,
        SCOPES: "write_products",
        // Never connected to: fixture mode answers before any query runs,
        // but the Prisma client is constructed when its module loads.
        DATABASE_URL:
          "postgresql://playground:fixtures@127.0.0.1:5432/unused?schema=public",
      },
    },
  ],
});
