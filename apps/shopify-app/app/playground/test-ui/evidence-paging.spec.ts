import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for server pages on the playground (YOY-146): the first
 * page, the quiet loading line while the next page loads, the appended
 * page, and a failed page that changes nothing — desktop and mobile, EN and
 * HE. Tagged @evidence.
 */
const OUT = "docs/evidence/YOY-146";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) =>
  page.getByTestId("playground-grid").getByTestId("playground-card");

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png` });
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
    for (const [locale, path] of [
      ["en", "/try"],
      ["he", "/try?lang=he"],
    ] as const) {
      test(`playground paging ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(path);

        await submit(page, "paged slow dress");
        await expect(cards(page)).toHaveCount(24);
        await shot(page, `playground-${device}-${locale}-1-first-page`);

        await cards(page).last().scrollIntoViewIfNeeded();
        await page.getByTestId("playground-loading-more").waitFor();
        await page.getByTestId("playground-loading-more").scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-2-loading-more`);

        await expect(cards(page)).toHaveCount(30);
        await cards(page).last().scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-3-appended`);

        await page.goto(path);
        await submit(page, "paged fail dress");
        await expect(cards(page)).toHaveCount(24);
        await cards(page).last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await shot(page, `playground-${device}-${locale}-4-failed-page`);
      });
    }
  }
});
