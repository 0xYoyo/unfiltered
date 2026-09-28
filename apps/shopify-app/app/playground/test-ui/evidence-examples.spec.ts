import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the curated example set after the YOY-136 swap: the
 * six rendered suggestions under each chrome, and one submitted. Tagged
 * @evidence: captured on demand into docs/evidence/YOY-136, never asserted.
 */
const OUT = "docs/evidence/YOY-136";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png` });
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
      test(`examples ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(path);
        await page.getByTestId("playground-example").nth(5).waitFor();
        await shot(page, `${device}-${locale}-1-examples`);

        await page.getByTestId("playground-example").nth(0).click();
        await page.getByTestId("playground-card").first().waitFor();
        await shot(page, `${device}-${locale}-2-example-submitted`);
      });
    }
  }
});
