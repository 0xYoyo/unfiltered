import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for sized card images on the overlay (YOY-169 AC-4;
 * verify 2): one Shopify-CDN card beside a crawl-sourced card, and the
 * plain results — desktop + mobile, EN + HE (RTL) — plus loading, empty and
 * error. The look is unchanged; the images are only fetched smaller.
 * Skipped on the default lane and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget evidence-card-images`.
 */
const OUT = "docs/evidence/YOY-169";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const themeInput = (page: Page) => page.locator('input[type="search"]').first();

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function submit(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

test.describe("@evidence", () => {
  test.skip(
    process.env.WIDGET_EVIDENCE !== "1",
    "evidence capture only (WIDGET_EVIDENCE=1)",
  );

  for (const [device, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "&locale=he"],
    ] as const) {
      test(`widget overlay card images ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.route(/cdn\.shopify\.com|images\.example\.test/, (route) =>
          route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
        );
        await page.goto(`/?fixture=images&debounce=30000${suffix}`);
        await submit(page, "dress");
        await expect(page.getByTestId("unfiltered-widget-card")).toHaveCount(2);
        await shot(page, `widget-overlay-${device}-${locale}-sized-images`);
        for (const [fixture, state, testId] of [
          ["results", "results", "unfiltered-widget-card"],
          ["delayed", "loading", "unfiltered-widget-loading"],
          ["empty", "empty", "unfiltered-widget-no-results"],
          ["error", "error", "unfiltered-widget-no-results"],
        ] as const) {
          await page.goto(`/?fixture=${fixture}&debounce=30000${suffix}`);
          await submit(page, "dress");
          await expect(page.getByTestId(testId).first()).toBeVisible();
          await shot(page, `widget-overlay-${device}-${locale}-${state}`);
        }
      });
    }
  }
});
