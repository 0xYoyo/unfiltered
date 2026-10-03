import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the engine v2 chips on both widget paths (YOY-149
 * AC-16): the overlay's `exclude` chip and the Dawn-mirror `size` chip, EN
 * and HE. Tagged @evidence and skipped on the default lane like every widget
 * evidence spec; `v2-chips.spec.ts` holds the assertions. Written to
 * `EVIDENCE_OUT` when set, else docs/evidence/YOY-149:
 *
 *   WIDGET_EVIDENCE=1 npx playwright test --project=widget -g "v2 chips"
 */
const OUT = process.env.EVIDENCE_OUT ?? "docs/evidence/YOY-149";
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

const themeInput = (page: Page) =>
  page.locator('input[type="search"]').first();

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png` });
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
    for (const [locale, suffix, excludeQuery, sizeQuery] of [
      ["en", "", "dress under 400 not black", "dress size m in stock"],
      ["he", "&locale=he", "שמלה עד 400 לא שחור", "שמלה מידה M במלאי"],
    ] as const) {
      test(`v2 chips overlay exclude ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?fixture=exclude&debounce=30000${suffix}`);
        await themeInput(page).fill(excludeQuery);
        await themeInput(page).press("Enter");
        await page.locator("[data-field='exclude']").waitFor();
        await shot(page, `widget-overlay-${device}-${locale}-exclude-chip`);
      });

      test(`v2 chips native size ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          `/theme-native.html?native=A&fixture=size&debounce=30000${suffix}`,
        );
        await themeInput(page).fill(sizeQuery);
        await themeInput(page).press("Enter");
        await page.locator("[data-field='size']").waitFor();
        await page.getByTestId("unfiltered-native-item").nth(2).waitFor();
        await shot(page, `widget-native-${device}-${locale}-size-chip`);
      });
    }
  }
});
