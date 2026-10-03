import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for refinement and the two-meanings chip in the
 * playground (YOY-150): the reading chip leading the row, the fresh search
 * it starts, a refined chain with "New search" held, and the empty,
 * loading and error states beside them. Tagged @evidence: captured on
 * demand, never asserted — `refinement.spec.ts` holds the assertions.
 * Written to `EVIDENCE_OUT` when set, else docs/evidence/YOY-150:
 *
 *   PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g "refinement evidence"
 */
const OUT = process.env.EVIDENCE_OUT ?? "docs/evidence/YOY-150";
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
      test(`refinement evidence playground ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const prefix = `playground-${device}-${locale}`;

        await page.goto(path);
        await submit(page, "two meanings wedding dress");
        await page.getByTestId("playground-other-reading").waitFor();
        await shot(page, `${prefix}-1-other-reading`);

        await page.getByTestId("playground-other-reading").click();
        await page.getByTestId("playground-other-reading").waitFor({ state: "detached" });
        await page.getByTestId("playground-card").first().waitFor();
        await shot(page, `${prefix}-2-reading-searched`);

        await page.goto(path);
        await submit(page, "refine black dress");
        await page.getByTestId("playground-chip").waitFor();
        await submit(page, "refine same but cheaper");
        await page.getByTestId("playground-new-search").waitFor();
        await shot(page, `${prefix}-3-refined-chain`);

        await page.goto(path);
        await page.route("**/api/playground/search?**", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          await route.continue();
        });
        await submit(page, "two meanings wedding dress");
        await page.waitForTimeout(300);
        await shot(page, `${prefix}-4-loading`);
        await page.unroute("**/api/playground/search?**");

        await page.goto(path);
        await submit(page, "empty");
        await page.waitForTimeout(400);
        await shot(page, `${prefix}-5-empty`);

        await page.goto(path);
        await submit(page, "error");
        await page.waitForTimeout(400);
        await shot(page, `${prefix}-6-error`);
      });
    }
  }
});
