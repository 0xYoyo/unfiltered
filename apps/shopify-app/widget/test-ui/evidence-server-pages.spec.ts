import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for server pages in the widget (YOY-146): the theme-native
 * view on page 1 and on a selected page 2, the overlay's quiet loading line
 * and its appended page, and a failed page that changes nothing — desktop
 * and mobile, EN and HE (RTL). Skipped on the default lane and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget -g "server pages"`.
 */
const OUT = "docs/evidence/YOY-146";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const themeInput = (page: Page) => page.locator('input[type="search"]').first();
const nativeItems = (page: Page) => page.getByTestId("unfiltered-native-item");
const overlayCards = (page: Page) => page.getByTestId("unfiltered-widget-card");

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

test.describe("@evidence server pages", () => {
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
      test(`widget native pages ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          `/theme-native.html?native=A&fixture=many&results=30&pageSize=12&debounce=30000${suffix}`,
        );
        await submitQuery(page, "dress");
        await expect(nativeItems(page)).toHaveCount(12);
        await shot(page, `widget-native-${device}-${locale}-1-page-1`);

        await page
          .locator('[data-testid="theme-pagination"] a')
          .nth(1)
          .click();
        await expect(nativeItems(page).first()).toHaveAttribute("data-position", "12");
        await shot(page, `widget-native-${device}-${locale}-2-page-2`);
      });

      test(`widget overlay pages ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          `/?fixture=many&results=30&debounce=30000&pageDelay=1500${suffix}`,
        );
        await submitQuery(page, "dress");
        await expect(overlayCards(page)).toHaveCount(24);
        await shot(page, `widget-overlay-${device}-${locale}-1-first-page`, false);

        await overlayCards(page).last().scrollIntoViewIfNeeded();
        await page.getByTestId("unfiltered-widget-loading-more").waitFor();
        await page.getByTestId("unfiltered-widget-loading-more").scrollIntoViewIfNeeded();
        await shot(page, `widget-overlay-${device}-${locale}-2-loading-more`, false);

        await expect(overlayCards(page)).toHaveCount(30);
        await overlayCards(page).last().scrollIntoViewIfNeeded();
        await shot(page, `widget-overlay-${device}-${locale}-3-appended`, false);

        await page.goto(`/?fixture=many&results=30&debounce=30000&failPage=2${suffix}`);
        await submitQuery(page, "dress");
        await expect(overlayCards(page)).toHaveCount(24);
        await overlayCards(page).last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await shot(page, `widget-overlay-${device}-${locale}-4-failed-page`, false);
      });
    }
  }
});
