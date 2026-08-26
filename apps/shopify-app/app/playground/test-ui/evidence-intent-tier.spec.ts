import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the intent-tier row in the engine-details panel
 * (YOY-116 AC-3): an AI response naming the tier that answered ("lite" on
 * the AI fixture, "accuracy" on the zero-hit fixture) and a classic
 * response showing none, desktop and mobile, EN and HE. Tagged @evidence —
 * off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g @evidence`.
 */
const OUT = "docs/evidence/YOY-116";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");
const panel = (page: Page) => page.getByTestId("playground-details-panel");

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
  await panel(page).waitFor();
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await panel(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

test.describe("@evidence", () => {
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "&lang=he"],
    ] as const) {
      test(`intent tier ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?details=1${suffix}`);
        await submit(page, "ai elegant dress");
        await shot(page, `${device}-${locale}-1-lite-tier`);
        await submit(page, "ai zero hit dress");
        await shot(page, `${device}-${locale}-2-accuracy-tier`);
        await submit(page, "dress");
        await shot(page, `${device}-${locale}-3-no-tier`);
      });
    }
  }
});
