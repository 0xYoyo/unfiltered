import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the Jev-judged page under the divider (YOY-157
 * AC-27): the overlay with only the exact product above "Close matches" and
 * the other-variant and close products under it, unlabelled — desktop +
 * mobile, EN + HE (RTL). Skipped on the default lane and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget evidence-close-divider-jev`.
 */
const OUT = "docs/evidence/YOY-157/AC-27";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const themeInput = (page: Page) => page.locator('input[type="search"]').first();

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
      test(`widget overlay jev close divider ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?fixture=close-divider-jev&results=5&debounce=30000${suffix}`);
        await themeInput(page).fill("red evening gown");
        await themeInput(page).press("Enter");
        await expect(page.getByTestId("unfiltered-widget-close-matches-divider")).toHaveCount(1);
        await expect(page.getByTestId("unfiltered-widget-card")).toHaveCount(5);
        mkdirSync(OUT, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${OUT}/widget-overlay-${device}-${locale}-jev-page-divider.png` });
      });
    }
  }
});
