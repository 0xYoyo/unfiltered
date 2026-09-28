import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for an exact-query intent reuse (YOY-64 AC-4): the
 * engine-details panel on a reused answer — reason `intent-reuse`, no
 * classify/intent stage rows, no intent tier — desktop and mobile, EN and
 * HE. Tagged @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g @evidence`.
 */
const OUT = "docs/evidence/YOY-64";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");
const panel = (page: Page) => page.getByTestId("playground-details-panel");

test.describe("@evidence", () => {
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "&lang=he"],
    ] as const) {
      test(`intent reuse ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try?details=1${suffix}`);
        await input(page).fill("ai reuse elegant dress");
        await input(page).press("Enter");
        await panel(page).waitFor();
        mkdirSync(OUT, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await panel(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${OUT}/${device}-${locale}-intent-reuse.png`, fullPage: true });
      });
    }
  }
});
