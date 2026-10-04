import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the label line on the playground card (YOY-151): one
 * card per template, the reserved lines of a page whose labels are pending
 * and the same page once they land, an over-length and an overflowing
 * label left off, and the loading, empty and error states beside them.
 * Tagged @evidence: captured on demand, never asserted — `labels.spec.ts`
 * holds the assertions. Written to `EVIDENCE_OUT` when set, else
 * docs/evidence/YOY-151:
 *
 *   PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g "labels evidence"
 */
const OUT = process.env.EVIDENCE_OUT ?? "docs/evidence/YOY-151";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function submit(page: Page, query: string): Promise<void> {
  await page.getByTestId("playground-input").fill(query);
  await page.getByTestId("playground-input").press("Enter");
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
      test(`labels evidence playground ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const prefix = `playground-${device}-${locale}`;

        await page.goto(path);
        await submit(page, "labels");
        await page.getByTestId("playground-card-label").nth(4).waitFor();
        await shot(page, `${prefix}-1-labels`);

        await page.goto(path);
        await submit(page, "labels pending");
        await page.getByTestId("playground-card").nth(5).waitFor();
        await shot(page, `${prefix}-2-labels-pending`);
        await page.getByTestId("playground-card-label").nth(4).waitFor();
        await shot(page, `${prefix}-3-labels-arrived`);

        await page.goto(path);
        await submit(page, "label too long");
        await page.getByTestId("playground-card").nth(1).waitFor();
        await shot(page, `${prefix}-4-label-too-long`);

        await page.goto(path);
        await submit(page, "label overflow");
        await page.getByTestId("playground-card").nth(1).waitFor();
        await shot(page, `${prefix}-5-label-overflow`);

        await page.goto(path);
        await page.route("**/api/playground/search?**", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          await route.continue();
        });
        await submit(page, "labels");
        await page.waitForTimeout(300);
        await shot(page, `${prefix}-6-loading`);
        await page.unroute("**/api/playground/search?**");

        await page.goto(path);
        await submit(page, "empty");
        await page.waitForTimeout(400);
        await shot(page, `${prefix}-7-empty`);

        await page.goto(path);
        await submit(page, "error");
        await page.waitForTimeout(400);
        await shot(page, `${prefix}-8-error`);
      });
    }
  }
});
