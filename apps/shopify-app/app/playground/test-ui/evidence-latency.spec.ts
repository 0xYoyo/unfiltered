import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the per-stage latency rows in the engine-details panel
 * (YOY-114 AC-2): the panel open on an AI response (five stage rows), on a
 * classic response (three rows — the missing LLM rows are the point), and on
 * a zero-hit response (the closeMatches row), desktop and mobile, EN and HE.
 * Tagged @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g @evidence`.
 */
const OUT = "docs/evidence/YOY-114";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");
const stages = (page: Page) => page.getByTestId("playground-details-stages");

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await stages(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
  await stages(page).locator("li").first().waitFor();
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
      test(`stage rows ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/?details=1${suffix}`);

        await submit(page, "ai elegant dress");
        await shot(page, `${device}-${locale}-1-ai-stages`);

        await submit(page, "dress");
        await shot(page, `${device}-${locale}-2-classic-stages`);

        await submit(page, "ai zero hit dress");
        await shot(page, `${device}-${locale}-3-zero-hit-stages`);
      });
    }
  }
});
