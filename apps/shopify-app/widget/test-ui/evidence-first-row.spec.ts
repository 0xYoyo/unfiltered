import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for first-row images (YOY-171 AC-8): the overlay and the
 * theme-native grid with their first four images loaded eagerly at high
 * priority — desktop + mobile, EN + HE (RTL) — plus the overlay's loading,
 * empty and error states, which this change leaves as they were. Skipped
 * on the default lane and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget evidence-first-row`.
 */
const OUT = "docs/evidence/YOY-171";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const themeInput = (page: Page) => page.locator('input[type="search"]').first();

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
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
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "&locale=he"],
    ] as const) {
      test(`widget overlay first row ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?fixture=labels&debounce=30000${suffix}`);
        await submit(page, "dress");
        await expect(page.getByTestId("unfiltered-widget-card")).toHaveCount(6);
        await shot(page, `widget-overlay-${device}-${locale}-first-row`, false);
      });

      test(`widget native first row ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/theme-native.html?native=A&fixture=labels&debounce=30000${suffix}`);
        await submit(page, "dress");
        await expect(page.getByTestId("unfiltered-native-item")).toHaveCount(6);
        await shot(page, `widget-native-${device}-${locale}-first-row`, false);
      });

      test(`widget overlay states ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        for (const [fixture, state, testId] of [
          ["delayed", "loading", "unfiltered-widget-loading"],
          ["empty", "empty", "unfiltered-widget-no-results"],
          ["error", "error", "unfiltered-widget-no-results"],
        ] as const) {
          await page.goto(`/?fixture=${fixture}&debounce=30000${suffix}`);
          await submit(page, "dress under 400");
          await expect(page.getByTestId(testId)).toBeVisible();
          await shot(page, `widget-overlay-${device}-${locale}-${state}`, false);
        }
      });
    }
  }
});
