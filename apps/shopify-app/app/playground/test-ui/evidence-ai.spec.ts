import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/** Design evidence for the AI states (YOY-93). Tagged @evidence. */
const OUT = "docs/evidence/YOY-93";
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
      ["en", "/try"],
      ["he", "/try?lang=he"],
    ] as const) {
      test(`ai ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);

        await page.goto(path);
        await shot(page, `${device}-${locale}-1-initial-examples`);

        await submit(page, "ai elegant dress");
        await page.getByTestId("playground-chip").first().waitFor();
        await shot(page, `${device}-${locale}-2-ai-chips`);

        await submit(page, "ai zero hit");
        await page.getByTestId("playground-chips").waitFor();
        await shot(page, `${device}-${locale}-3-zero-hit`);

        await submit(page, "degraded");
        await page.getByTestId("playground-card").first().waitFor();
        await shot(page, `${device}-${locale}-4-degraded`);

        await submit(page, "ai color beige");
        await page.getByTestId("playground-card-color-unknown").first().waitFor();
        await shot(page, `${device}-${locale}-5-color-unknown`);
      });
    }
  }

  test("details panel desktop en", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/try?details=1");
    await submit(page, "ai elegant dress");
    await page.getByTestId("playground-details-panel").waitFor();
    await shot(page, "desktop-en-6-details-open");
  });
});
