import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the two-meanings chip and refinement on both widget
 * paths (YOY-150), EN and HE, desktop and mobile, with the overlay's
 * loading, empty and error states beside them. Tagged @evidence and
 * skipped on the default lane like every widget evidence spec;
 * `refinement.spec.ts` holds the assertions. Written to `EVIDENCE_OUT` when
 * set, else docs/evidence/YOY-150:
 *
 *   WIDGET_EVIDENCE=1 npx playwright test --project=widget -g "refinement evidence"
 */
const OUT = process.env.EVIDENCE_OUT ?? "docs/evidence/YOY-150";
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

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
  test.skip(process.env.WIDGET_EVIDENCE !== "1", "evidence capture only (WIDGET_EVIDENCE=1)");

  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix, query] of [
      ["en", "", "wedding dress"],
      ["he", "&locale=he", "שמלת כלה"],
    ] as const) {
      test(`refinement evidence overlay ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const prefix = `widget-overlay-${device}-${locale}`;
        await page.goto(`/?fixture=two-meanings&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-other-reading").waitFor();
        await shot(page, `${prefix}-1-other-reading`);

        await page.goto(`/?fixture=refine&debounce=30000${suffix}`);
        await submit(page, query);
        await page.locator("[data-field='size']").waitFor();
        await submit(page, locale === "he" ? "זול יותר" : "same but cheaper");
        await page.getByTestId("unfiltered-widget-card").first().waitFor();
        await shot(page, `${prefix}-2-refined-chain`);

        await page.goto(`/?fixture=delayed&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-loading").waitFor();
        await shot(page, `${prefix}-3-loading`);

        await page.goto(`/?fixture=empty&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-no-results").waitFor();
        await shot(page, `${prefix}-4-empty`);

        await page.goto(`/?fixture=error&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-no-results").waitFor();
        await shot(page, `${prefix}-5-error`);
      });

      test(`refinement evidence native ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/theme-native.html?native=A&fixture=two-meanings&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-native-other-reading").waitFor();
        await page.getByTestId("unfiltered-native-item").nth(2).waitFor();
        await shot(page, `widget-native-${device}-${locale}-other-reading`);
      });
    }
  }
});
