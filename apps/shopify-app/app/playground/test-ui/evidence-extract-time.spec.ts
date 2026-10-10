import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the extraction's time (YOY-171 AC-6; verify 5): the
 * details panel lists `extract` first — in time on the budget page, marked
 * late on the late-labels page — desktop and mobile, EN and HE (RTL), plus
 * the loading, empty and error states, which this change leaves as they
 * were. Tagged @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-extract-time`.
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
      test(`extract time ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix === "" ? "?details=1" : `${suffix}&details=1`}`);
        const stages = page.getByTestId("playground-details-stages");
        await submit(page, "budget dress under 400 size m in stock not black");
        await expect(stages.locator("li").first()).toContainText("extract");
        await stages.scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-extract-in-time`, false);
        await submit(page, "labels pending");
        await expect(stages.locator("li").first()).toContainText("930");
        await stages.scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-extract-late`, false);
      });

      test(`extract time states ${device} ${locale}`, async ({ page }) => {
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
