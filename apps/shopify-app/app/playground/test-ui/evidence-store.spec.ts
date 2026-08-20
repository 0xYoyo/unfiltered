import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/** Design evidence for the store-preload page (YOY-94). Tagged @evidence. */
const OUT = "docs/evidence/YOY-94";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");

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
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "?lang=he"],
    ] as const) {
      test(`store ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);

        await page.goto(`/s/demo-store${suffix}`);
        await shot(page, `${device}-${locale}-1-store-initial`);

        await input(page).fill("ai elegant dress");
        await input(page).press("Enter");
        await page.getByTestId("playground-chip").first().waitFor();
        await shot(page, `${device}-${locale}-2-store-results`);

        await page.goto(`/s/nope${suffix}`);
        await shot(page, `${device}-${locale}-3-unknown-slug`);
      });
    }
  }
});
