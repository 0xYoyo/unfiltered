import { defineConfig } from "@playwright/test";

/**
 * UI test lane (YOY-43): Playwright drives the widget dev harness — a local
 * Vite server over apps/shopify-app/widget with fake storefront pages and a
 * stubbed search endpoint. No Shopify, no network. Runs via `npm run
 * test:ui` from the repo root, locally and in CI.
 */
export default defineConfig({
  testDir: "apps/shopify-app/widget/test-ui",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    // Visual baselines (YOY-50 AC-5): absorb sub-perceptual antialiasing
    // jitter between runs; a mirrored or restrung overlay still fails.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run widget:harness --workspace app",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
