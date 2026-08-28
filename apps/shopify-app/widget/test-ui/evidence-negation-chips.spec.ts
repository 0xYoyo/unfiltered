import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Dawn-mirror design evidence for the widget's negated chips (YOY-123
 * AC-4). Tagged @evidence: captured on demand into docs/evidence/M5-design,
 * never asserted — `negation-chips.spec.ts` holds the assertions and the
 * committed baselines. Skipped on the default lane the way every widget
 * evidence spec is (the widget project has no @evidence filter), and
 * captured with:
 *
 *   WIDGET_EVIDENCE=1 npx playwright test --project=widget -g "dawn negation"
 *
 * What a reviewer is judging here is a NEGATIVE: that an exclusion is
 * legible inside a merchant's own theme without the widget introducing any
 * hue that theme does not have (W-3). Desktop and mobile, EN and HE.
 */
const OUT = "docs/evidence/M5-design";
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

const themeInput = (page: Page) =>
  page.locator('input[type="search"]').first();
const nativeChips = (page: Page) =>
  page.getByTestId("unfiltered-native-chip");

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
    for (const [locale, suffix, query] of [
      ["en", "", "dress not black not wool"],
      ["he", "&locale=he&lang=he", "שמלה לא שחורה"],
    ] as const) {
      test(`dawn negation chips ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          `/theme-native.html?native=A&fixture=ai-negation${suffix}`,
        );
        await themeInput(page).fill(query);
        await themeInput(page).press("Enter");
        await nativeChips(page).nth(2).waitFor();
        await page.getByTestId("unfiltered-native-item").nth(2).waitFor();
        await shot(page, `widget-dawn-${device}-${locale}-8-negation-chips`);

        // The same row after one exclusion is removed: still the theme's
        // page, one chip fewer, nothing of ours left behind (W-7, W-10).
        await nativeChips(page).nth(1).click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              '[data-testid="unfiltered-native-chip"]',
            ).length === 2,
        );
        await shot(
          page,
          `widget-dawn-${device}-${locale}-9-exclusion-removed`,
        );
      });
    }
  }
});
