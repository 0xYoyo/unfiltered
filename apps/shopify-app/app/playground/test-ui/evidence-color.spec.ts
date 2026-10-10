import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the colour wish (YOY-171 AC-5; verify 4): "red evening
 * gown" with its colour chip, the cards of another colour labelled
 * `color-differs`, then the chip removed — the same order, no colour
 * label — desktop and mobile, EN and HE (RTL), plus the loading, empty and
 * error states, which this change leaves as they were. Tagged
 * @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-color`.
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
      test(`colour ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "red evening gown colour");
        await expect(cards(page).last()).toContainText("Lace Dress");
        await expect(page.getByTestId("playground-card-label")).toHaveCount(2);
        await shot(page, `playground-${device}-${locale}-color`);
        await page.locator("[data-field='color']").click();
        await expect(cards(page).last()).toContainText("Lace Dress");
        await expect(page.getByTestId("playground-card-label")).toHaveCount(0);
        await shot(page, `playground-${device}-${locale}-color-removed`);
      });

      test(`colour states ${device} ${locale}`, async ({ page }) => {
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
