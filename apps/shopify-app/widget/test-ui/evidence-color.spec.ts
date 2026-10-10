import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the colour wish (YOY-171 AC-5; verify 4): the colour
 * chip, the asked colour first and the others labelled `color-differs`,
 * then the chip removed — find order back, no colour label — on the overlay
 * and the theme-native grid, desktop + mobile, EN + HE (RTL), plus the
 * overlay's loading, empty and error states, which this change leaves as
 * they were. Skipped on the default lane and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget evidence-color`.
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
    for (const [locale, suffix, query] of [
      ["en", "", "red evening gown"],
      ["he", "&locale=he", "שמלת ערב אדומה"],
    ] as const) {
      for (const [path, base, cardId] of [
        ["overlay", "/?fixture=color&debounce=30000", "unfiltered-widget-card"],
        ["native", "/theme-native.html?native=A&fixture=color&debounce=30000", "unfiltered-native-item"],
      ] as const) {
        test(`widget ${path} colour ${device} ${locale}`, async ({ page }) => {
          await page.setViewportSize(viewport);
          await page.goto(`${base}${suffix}`);
          await submit(page, query);
          await expect(page.getByTestId(cardId).first()).toContainText("Lace Dress");
          await shot(page, `widget-${path}-${device}-${locale}-color`, false);
          await page.locator("[data-field='color']").click();
          await expect(page.getByTestId(cardId).last()).toContainText("Lace Dress");
          await shot(page, `widget-${path}-${device}-${locale}-color-removed`, false);
        });
      }

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
