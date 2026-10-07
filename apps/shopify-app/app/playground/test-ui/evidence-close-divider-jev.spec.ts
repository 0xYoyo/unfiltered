import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the Jev-judged page under the divider (YOY-157
 * AC-27): only the exact product above "Close matches", the other-variant
 * products and the close one under it with no label line — desktop and
 * mobile, EN and HE (RTL) — plus the loading, empty and error states, which
 * this change leaves as they were. Tagged @evidence — off the default lane,
 * captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-close-divider-jev`.
 */
const OUT = "docs/evidence/YOY-157/AC-27";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");
const dividers = (page: Page) => page.getByTestId("playground-close-matches-divider");

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
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
      test(`jev close divider ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "divider jev red evening gown");
        await expect(dividers(page)).toHaveCount(1);
        await expect(cards(page)).toHaveCount(5);
        await shot(page, `playground-${device}-${locale}-jev-page-divider`);
      });

      test(`jev close divider states ${device} ${locale}`, async ({ page }) => {
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
