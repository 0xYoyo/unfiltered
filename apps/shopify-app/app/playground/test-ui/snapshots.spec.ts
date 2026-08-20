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

/**
 * AI-state baselines (YOY-93 AC-7, verify 7). The chip row, the zero-hit
 * rescue, and the opened details panel are where a mirrored layout or a
 * stray accent would show first, so they get their own baselines.
 */
test.describe("AI-state baselines", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  for (const locale of ["en", "he"] as const) {
    const base = locale === "en" ? "/" : "/?lang=he";

    test(`ai state — ${locale}`, async ({ page }) => {
      await page.goto(base);
      await input(page).fill("ai elegant dress");
      await input(page).press("Enter");
      await expect(page.getByTestId("playground-chip")).toHaveCount(3);
      await settle(page);
      await expect(page).toHaveScreenshot(`playground-ai-${locale}.png`);
    });

    test(`zero hit — ${locale}`, async ({ page }) => {
      await page.goto(base);
      await input(page).fill("ai zero hit");
      await input(page).press("Enter");
      await expect(page.getByTestId("playground-chip")).toHaveCount(3);
      await settle(page);
      await expect(page).toHaveScreenshot(`playground-zero-hit-${locale}.png`);
    });
  }

  test("details open — en", async ({ page }) => {
    await page.goto("/?details=1");
    await input(page).fill("ai elegant dress");
    await input(page).press("Enter");
    await page.getByTestId("playground-details-panel").waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot("playground-details-en.png");
  });
});
