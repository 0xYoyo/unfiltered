import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the late judged page (YOY-171 AC-1): a search served
 * on a judge deadline miss shows the find-order cards with every label line
 * reserved, then the late page replaces them — judged order, the
 * not-relevant card gone, the close products under "Close matches" — on the
 * overlay and the theme-native grid, desktop + mobile, EN + HE (RTL), plus
 * the overlay's loading, empty and error states, which this change leaves
 * as they were. Skipped on the default lane and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget evidence-late-page`.
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
      test(`widget overlay late page ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?fixture=labels-pending&debounce=30000${suffix}`);
        await submit(page, "dress under 400 size m");
        const cards = page.getByTestId("unfiltered-widget-card");
        await expect(cards).toHaveCount(6);
        await shot(page, `widget-overlay-${device}-${locale}-pending-find-order`, false);
        await expect(cards).toHaveCount(5);
        await expect(page.getByTestId("unfiltered-widget-close-matches-divider")).toHaveCount(1);
        await shot(page, `widget-overlay-${device}-${locale}-late-page`, false);
      });

      test(`widget native late page ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/theme-native.html?native=A&fixture=labels-pending&debounce=30000${suffix}`);
        await submit(page, "dress under 400 size m");
        const items = page.getByTestId("unfiltered-native-item");
        await expect(items).toHaveCount(6);
        await shot(page, `widget-native-${device}-${locale}-pending-find-order`);
        await expect(items).toHaveCount(5);
        await expect(page.getByTestId("unfiltered-native-close-matches-divider")).toHaveCount(1);
        await shot(page, `widget-native-${device}-${locale}-late-page`);
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
