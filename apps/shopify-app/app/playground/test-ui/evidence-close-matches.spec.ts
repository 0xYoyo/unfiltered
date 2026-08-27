import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the relaxed-constraint close-matches heading (YOY-111
 * AC-4): the zero-hit state whose heading names what the server relaxed —
 * "Close matches — over your budget" / "התאמות קרובות — מעל התקציב" —
 * desktop and mobile, EN and HE (RTL). Tagged @evidence — off the default
 * lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g "close matches"`.
 */
const OUT = "docs/evidence/YOY-111";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

test.describe("@evidence", () => {
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix, heading] of [
      ["en", "", "Close matches — over your budget"],
      ["he", "?lang=he", "התאמות קרובות — מעל התקציב"],
    ] as const) {
      test(`close matches heading ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/${suffix}`);
        await input(page).fill("ai zero hit");
        await input(page).press("Enter");
        await expect(page.getByRole("heading", { name: heading })).toBeVisible();
        await page.getByRole("heading", { name: heading }).scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-zero-hit-relaxed-heading`);
      });
    }
  }
});
