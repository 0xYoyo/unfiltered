import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the one-statement classic search (YOY-115 AC-3): the
 * engine-details panel on a keystroke preview shows a `classic` row and no
 * `hydrate` row, desktop and mobile, EN and HE. Tagged
 * @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g @evidence`.
 */
const OUT = "docs/evidence/YOY-115";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");
const stages = (page: Page) => page.getByTestId("playground-details-stages");

test.describe("@evidence", () => {
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "&lang=he"],
    ] as const) {
      test(`classic stages ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try?details=1${suffix}`);
        // A preview — the classic keyword path: typed, not submitted.
        await input(page).fill("dress");
        await stages(page).getByText(/^classic · /).waitFor();
        mkdirSync(OUT, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await stages(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${OUT}/${device}-${locale}-classic-stages.png`, fullPage: true });
      });
    }
  }
});
