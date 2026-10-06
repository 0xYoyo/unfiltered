import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the engine badge (YOY-165): `/try?engine=v1` before
 * a search, while one loads, with results and the details panel's engine
 * row, empty, and failed — desktop and mobile, EN and HE (RTL). Tagged
 * @evidence.
 */
const OUT = "docs/evidence/YOY-165";
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
      ["en", "/try?engine=v1&details=1"],
      ["he", "/try?lang=he&engine=v1&details=1"],
    ] as const) {
      test(`playground engine badge ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(path);
        await page.getByTestId("playground-engine-badge").waitFor();
        await shot(page, `playground-${device}-${locale}-1-initial`);

        await submit(page, "delayed dress");
        // The `delayed` fixture answers after 700 ms: this is the loading state.
        await page.waitForTimeout(150);
        await shot(page, `playground-${device}-${locale}-2-loading`);

        await page.goto(path);
        await submit(page, "budget dress under 400 size m in stock not black");
        await expect(cards(page).first()).toBeVisible();
        await page.getByTestId("playground-details-panel").waitFor();
        await shot(page, `playground-${device}-${locale}-3-results`);
        await page.getByTestId("playground-details-panel").scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-4-details-engine-row`);

        await page.goto(path);
        await submit(page, "empty dress");
        await page.waitForTimeout(300);
        await shot(page, `playground-${device}-${locale}-5-empty`);

        await page.goto(path);
        await submit(page, "error dress");
        await page.waitForTimeout(300);
        await shot(page, `playground-${device}-${locale}-6-error`);
      });
    }
  }
});
