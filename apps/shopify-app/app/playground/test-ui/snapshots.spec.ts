import { expect, test, type Page } from "@playwright/test";

/**
 * Visual baselines for the playground (YOY-92 AC-8; re-recorded against the
 * 2026-08-28 direction by YOY-123 AC-3). EN and HE, desktop and 360px, over
 * every state the issue's verify steps name: the initial page, classic
 * results, the AI state with its chip row, the zero-hit rescue with its
 * close matches, the opened engine panel, and the store-preload page.
 *
 * Per-OS like the widget's, so a font-rendering difference between a laptop
 * and CI is a missing baseline rather than a false failure.
 *
 * These are the durable form of the design evidence: a mirrored RTL layout,
 * a stranded magnifier, a chip that lost its accent tint, or a card that
 * grew a border fails here.
 */

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };

const VIEWPORTS = [
  ["desktop", DESKTOP],
  ["mobile", MOBILE],
] as const;

const input = (page: Page) => page.getByTestId("playground-input");

async function settle(page: Page): Promise<void> {
  // Fonts and the data-URI card images must be painted before a baseline.
  await page.evaluate(() => document.fonts.ready);
}

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

test.describe("visual baselines", () => {
  for (const [device, viewport] of VIEWPORTS) {
    for (const locale of ["en", "he"] as const) {
      const base = locale === "en" ? "/" : "/?lang=he";

      test(`initial state — ${locale} ${device}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(base);
        await settle(page);
        await expect(page).toHaveScreenshot(
          `playground-initial-${locale}-${device}.png`,
          { fullPage: true },
        );
      });

      test(`results state — ${locale} ${device}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(base);
        await submit(page, "dress");
        await expect(page.getByTestId("playground-card")).toHaveCount(4);
        await settle(page);
        await expect(page).toHaveScreenshot(
          `playground-results-${locale}-${device}.png`,
          { fullPage: true },
        );
      });

      test(`ai state — ${locale} ${device}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(base);
        await submit(page, "ai elegant dress");
        await expect(page.getByTestId("playground-chip")).toHaveCount(3);
        await settle(page);
        await expect(page).toHaveScreenshot(
          `playground-ai-${locale}-${device}.png`,
          { fullPage: true },
        );
      });

      // Zero hit AND close matches in one frame: the fixture answers with no
      // results and two close matches under a relaxed-budget heading.
      test(`zero hit and close matches — ${locale} ${device}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.goto(base);
        await submit(page, "ai zero hit");
        await expect(page.getByTestId("playground-chip")).toHaveCount(3);
        await expect(page.locator(".closeMatches")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(
          `playground-zero-hit-${locale}-${device}.png`,
          { fullPage: true },
        );
      });

      // The negated chip's accent tint is the one place the accent touches a
      // chip (P-9): it gets its own frame in both languages.
      test(`negation chips — ${locale} ${device}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(base);
        await submit(page, "ai negation");
        await expect(
          page.locator("[data-chip-negated='true']"),
        ).not.toHaveCount(0);
        await settle(page);
        await expect(page).toHaveScreenshot(
          `playground-negation-${locale}-${device}.png`,
          { fullPage: true },
        );
      });

      test(`store page — ${locale} ${device}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(locale === "en" ? "/s/demo-store" : "/s/demo-store?lang=he");
        await settle(page);
        await expect(page).toHaveScreenshot(
          `playground-store-${locale}-${device}.png`,
          { fullPage: true },
        );
      });
    }

    test(`details open — en ${device}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/?details=1");
      await submit(page, "ai elegant dress");
      await page.getByTestId("playground-details-panel").waitFor();
      await settle(page);
      await expect(page).toHaveScreenshot(
        `playground-details-en-${device}.png`,
        { fullPage: true },
      );
    });

    test(`unknown slug — en ${device}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/s/nope");
      await settle(page);
      await expect(page).toHaveScreenshot(
        `playground-store-404-en-${device}.png`,
        { fullPage: true },
      );
    });
  }
});
