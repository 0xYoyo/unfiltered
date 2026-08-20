import { expect, test, type Page } from "@playwright/test";

/**
 * Visual baselines for the playground (YOY-92 AC-8), EN and HE, initial and
 * results. Per-OS like the widget's, so a font-rendering difference between
 * a laptop and CI is a missing baseline rather than a false failure.
 *
 * These are the durable form of the design evidence: a mirrored RTL layout,
 * a stranded magnifier, or a card that grew a shadow fails here.
 */

const DESKTOP = { width: 1280, height: 800 };

const input = (page: Page) => page.getByTestId("playground-input");

async function settle(page: Page): Promise<void> {
  // Fonts and the data-URI card images must be painted before a baseline.
  await page.evaluate(() => document.fonts.ready);
}

test.describe("visual baselines", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  for (const locale of ["en", "he"] as const) {
    test(`initial state — ${locale}`, async ({ page }) => {
      await page.goto(locale === "en" ? "/" : "/?lang=he");
      await settle(page);
      await expect(page).toHaveScreenshot(`playground-initial-${locale}.png`);
    });

    test(`results state — ${locale}`, async ({ page }) => {
      await page.goto(locale === "en" ? "/" : "/?lang=he");
      await input(page).fill("dress");
      await input(page).press("Enter");
      await expect(page.getByTestId("playground-card")).toHaveCount(4);
      await settle(page);
      await expect(page).toHaveScreenshot(`playground-results-${locale}.png`);
    });
  }
});
