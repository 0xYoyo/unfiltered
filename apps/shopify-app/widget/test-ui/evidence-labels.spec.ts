import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the label line on both widget paths (YOY-151), EN
 * and HE, desktop and mobile: one card per template, a pending page's
 * reserved lines and the same page once its labels land, and the overlay's
 * loading, empty and error states beside them. Tagged @evidence and
 * skipped on the default lane like every widget evidence spec;
 * `labels.spec.ts` holds the assertions. Written to `EVIDENCE_OUT` when
 * set, else docs/evidence/YOY-151:
 *
 *   WIDGET_EVIDENCE=1 npx playwright test --project=widget -g "labels evidence"
 */
const OUT = process.env.EVIDENCE_OUT ?? "docs/evidence/YOY-151";
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
      ["en", "", "dress under 400 size m"],
      ["he", "&locale=he", "שמלה עד 400 מידה M"],
    ] as const) {
      test(`labels evidence overlay ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const prefix = `widget-overlay-${device}-${locale}`;
        await page.goto(`/?fixture=labels&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-label").nth(4).waitFor();
        await shot(page, `${prefix}-1-labels`);

        await page.goto(`/?fixture=labels-pending&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-card").nth(5).waitFor();
        await shot(page, `${prefix}-2-labels-pending`);
        await page.getByTestId("unfiltered-widget-label").nth(4).waitFor();
        await shot(page, `${prefix}-3-labels-arrived`);

        await page.goto(`/?fixture=delayed&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-loading").waitFor();
        await shot(page, `${prefix}-4-loading`);

        await page.goto(`/?fixture=empty&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-no-results").waitFor();
        await shot(page, `${prefix}-5-empty`);

        await page.goto(`/?fixture=error&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-widget-no-results").waitFor();
        await shot(page, `${prefix}-6-error`);
      });

      test(`labels evidence native ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const prefix = `widget-native-${device}-${locale}`;
        // A phone-width theme card is narrower than some labels, which are
        // then left off (AC-6) — so wait on the cards, not a label count.
        await page.goto(`/theme-native.html?native=A&fixture=labels&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-native-item").nth(5).waitFor();
        await page.getByTestId("unfiltered-widget-label").first().waitFor();
        await shot(page, `${prefix}-1-labels`);

        await page.goto(`/theme-native.html?native=A&fixture=labels-pending&debounce=30000${suffix}`);
        await submit(page, query);
        await page.getByTestId("unfiltered-native-item").nth(5).waitFor();
        await shot(page, `${prefix}-2-labels-pending`);
        await page.getByTestId("unfiltered-widget-label").first().waitFor();
        await shot(page, `${prefix}-3-labels-arrived`);
      });
    }
  }
});
