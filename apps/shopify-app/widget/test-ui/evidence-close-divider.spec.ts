import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for close products under the divider (YOY-166 AC-2,
 * AC-3): the overlay's mixed page and its appended page, and the native
 * view's page 1 and page 2, each with "Close matches" inside the grid —
 * desktop + mobile, EN + HE (RTL) — plus the loading, empty and error
 * states, which this change leaves as they were. Skipped on the default
 * lane and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget evidence-close-divider`.
 */
const OUT = "docs/evidence/YOY-166";
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
      test(`widget overlay close divider ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?fixture=close-divider&results=30&debounce=30000${suffix}`);
        await submit(page, "red evening gown");
        const dividers = page.getByTestId("unfiltered-widget-close-matches-divider");
        await expect(dividers).toHaveCount(1);
        await dividers.first().scrollIntoViewIfNeeded();
        await shot(page, `widget-overlay-${device}-${locale}-mixed-page-divider`, false);
        await page.getByTestId("unfiltered-widget-card").last().scrollIntoViewIfNeeded();
        await expect(dividers).toHaveCount(2);
        await dividers.last().scrollIntoViewIfNeeded();
        await shot(page, `widget-overlay-${device}-${locale}-appended-page-divider`, false);
      });

      test(`widget native close divider ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          `/theme-native.html?native=A&fixture=close-divider&results=30&pageSize=12&debounce=30000${suffix}`,
        );
        await submit(page, "red evening gown");
        const divider = page.getByTestId("unfiltered-native-close-matches-divider");
        await expect(divider).toBeVisible();
        await shot(page, `widget-native-${device}-${locale}-page-1-divider`);
        await page.locator('[data-testid="theme-pagination"] a').nth(1).click();
        await expect(
          page.getByTestId("unfiltered-native-item").first(),
        ).toHaveAttribute("data-position", "12");
        await shot(page, `widget-native-${device}-${locale}-page-2-divider`);
      });

      test(`widget overlay states ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        for (const [fixture, state, testId] of [
          ["delayed", "loading", "unfiltered-widget-loading"],
          ["empty", "empty", "unfiltered-widget-no-results"],
          ["error", "error", "unfiltered-widget-no-results"],
        ] as const) {
          await page.goto(`/?fixture=${fixture}&debounce=30000${suffix}`);
          await submit(page, "red evening gown");
          await expect(page.getByTestId(testId)).toBeVisible();
          await shot(page, `widget-overlay-${device}-${locale}-${state}`, false);
        }
      });
    }
  }
});
