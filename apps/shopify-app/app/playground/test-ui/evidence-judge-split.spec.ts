import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the judge stage split (YOY-159 AC-1): the engine
 * details panel on an Engine v2 page now lists `judgeRows` before `judge`,
 * and the empty, loading and error states beside it are unchanged —
 * desktop and mobile, EN and HE (RTL). Tagged @evidence.
 */
const OUT = "docs/evidence/YOY-159";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");

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
      ["en", "/try?details=1"],
      ["he", "/try?lang=he&details=1"],
    ] as const) {
      test(`playground judge split ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(path);
        await submit(page, "budget dress under 400 size m in stock not black");
        const stages = page.getByTestId("playground-details-stages");
        await expect(stages).toContainText("judgeRows");
        await stages.scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-1-details-judge-split`);

        await page.goto(path);
        await submit(page, "delayed dress");
        // The `delayed` fixture answers after 700 ms: this is the loading state.
        await page.waitForTimeout(150);
        await shot(page, `playground-${device}-${locale}-2-loading`);

        await page.goto(path);
        await submit(page, "empty dress");
        await page.waitForTimeout(300);
        await shot(page, `playground-${device}-${locale}-3-empty`);

        await page.goto(path);
        await submit(page, "error dress");
        await page.waitForTimeout(300);
        await shot(page, `playground-${device}-${locale}-4-error`);
      });
    }
  }
});
