import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the widget's relaxed-constraint close-matches heading
 * (YOY-111 AC-4): the overlay's zero-hit state and the native view's, each
 * with the heading naming what the server relaxed, desktop + mobile, EN +
 * HE (RTL). Skipped on the default lane — the widget project has no
 * @evidence filter — and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget -g "close matches"`.
 */
const OUT = "docs/evidence/YOY-111";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const themeInput = (page: Page) => page.locator('input[type="search"]').first();

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
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
    for (const [locale, suffix, heading] of [
      ["en", "", "Close matches — over your budget"],
      ["he", "&locale=he", "התאמות קרובות — מעל התקציב"],
    ] as const) {
      test(`widget overlay close matches ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?fixture=ai-zero-hit&debounce=30000${suffix}`);
        await themeInput(page).fill("elegant dress under 400");
        await themeInput(page).press("Enter");
        await expect(
          page.getByTestId("unfiltered-widget-close-matches").locator("h2"),
        ).toHaveText(heading);
        await shot(page, `widget-overlay-${device}-${locale}-zero-hit-relaxed-heading`);
      });

      test(`widget native close matches ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          `/theme-native.html?native=A&fixture=ai-zero-hit&debounce=30000${suffix}`,
        );
        await themeInput(page).fill("elegant dress under 400");
        await themeInput(page).press("Enter");
        await expect(
          page.getByTestId("unfiltered-native-close-matches").locator("h2"),
        ).toHaveText(heading);
        await shot(page, `widget-native-${device}-${locale}-zero-hit-relaxed-heading`);
      });
    }
  }
});
