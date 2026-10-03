import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the engine v2 chips in the playground (YOY-149
 * AC-16). Tagged @evidence: captured on demand, never asserted —
 * `v2-chips.spec.ts` holds the assertions. Written to `EVIDENCE_OUT` when
 * set, else docs/evidence/YOY-149:
 *
 *   PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g "v2 chips"
 */
const OUT = process.env.EVIDENCE_OUT ?? "docs/evidence/YOY-149";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const QUERY = "budget dress under 400 size m in stock not black";

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
    for (const [locale, path] of [
      ["en", "/try"],
      ["he", "/try?lang=he"],
    ] as const) {
      test(`v2 chips playground ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(path);
        await page.getByTestId("playground-input").fill(QUERY);
        await page.getByTestId("playground-input").press("Enter");
        await page.locator("[data-field='priceMax']").waitFor();
        await shot(page, `playground-${device}-${locale}-1-budget-chips`);

        await page.locator("[data-field='priceMax']").click();
        await page.getByTestId("playground-card").nth(3).waitFor();
        await shot(page, `playground-${device}-${locale}-2-cap-removed`);
      });
    }
  }
});
