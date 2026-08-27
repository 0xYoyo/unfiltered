import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the negated-attribute chip (YOY-133 AC-5). Tagged
 * @evidence: captured on demand into docs/evidence/YOY-133, never asserted.
 */
const OUT = "docs/evidence/YOY-133";
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
      ["en", "/"],
      ["he", "/?lang=he"],
    ] as const) {
      test(`negation ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(path);

        await submit(page, "ai winter coat not wool");
        await page.getByTestId("playground-chip").nth(1).waitFor();
        await shot(page, `${device}-${locale}-1-not-wool-chip`);

        await page.getByTestId("playground-chip").nth(1).click();
        await page.getByTestId("playground-card").nth(2).waitFor();
        await shot(page, `${device}-${locale}-2-chip-removed`);
      });
    }
  }

  test("details panel desktop en", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/?details=1");
    await submit(page, "ai winter coat not wool");
    await page.getByTestId("playground-details-panel").waitFor();
    await shot(page, "desktop-en-3-details-open");
  });
});
