import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for one label line (YOY-171 AC-3; verify 3): 24 cards all
 * over budget say it once above the grid with no card line, and the same
 * page with one card that carries no label keeps every card's line —
 * desktop and mobile, EN and HE (RTL), plus the loading, empty and error
 * states, which this change leaves as they were. Tagged @evidence — off the
 * default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-one-label`.
 */
const OUT = "docs/evidence/YOY-171";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

test.describe("@evidence", () => {
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "?lang=he"],
    ] as const) {
      test(`one label ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "jacket under 30 same");
        await expect(page.getByTestId("playground-page-label")).toBeVisible();
        await shot(page, `playground-${device}-${locale}-one-label`, false);
        await submit(page, "jacket under 30 same mixed");
        await expect(page.getByTestId("playground-page-label")).toHaveCount(0);
        await expect(cards(page)).toHaveCount(24);
        await shot(page, `playground-${device}-${locale}-one-label-mixed`, false);
      });

      test(`one label states ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "delayed dress");
        await expect(page.getByTestId("playground-skeleton")).toBeVisible();
        await shot(page, `playground-${device}-${locale}-loading`);
        await expect(cards(page).first()).toBeVisible();
        await submit(page, "empty rail");
        await expect(cards(page)).toHaveCount(0);
        await shot(page, `playground-${device}-${locale}-empty`);
        await submit(page, "error dress");
        await expect(page.locator(".statusLine")).not.toBeEmpty();
        await shot(page, `playground-${device}-${locale}-error`);
      });
    }
  }
});
