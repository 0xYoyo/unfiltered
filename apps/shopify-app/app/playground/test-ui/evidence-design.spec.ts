import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the re-authored playground (YOY-123 AC-3). Tagged
 * @evidence: captured on demand into docs/evidence/M5-design, never
 * asserted — the assertions are the committed baselines in
 * snapshots.spec.ts and the invariant tests in design-invariants.spec.ts.
 *
 *   PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-design
 *
 * Every state the issue's "How to verify" names, in EN and HE, at 1280 and
 * at 360: the initial page, classic results, the AI state, the zero-hit
 * rescue with its close matches, the negation chips, the engine panel, and
 * the store-preload page. Full-page frames, so what a reviewer judges is
 * the whole page and not a viewport crop.
 */
const OUT = "docs/evidence/M5-design";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };

const input = (page: Page) => page.getByTestId("playground-input");

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
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
    for (const [locale, base] of [
      ["en", "/try"],
      ["he", "/try?lang=he"],
    ] as const) {
      test(`playground ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);

        await page.goto(base);
        await shot(page, `${device}-${locale}-1-initial`);

        await submit(page, "dress");
        await page.getByTestId("playground-card").nth(3).waitFor();
        await shot(page, `${device}-${locale}-2-classic-results`);

        await submit(page, "ai elegant dress");
        await page.getByTestId("playground-chip").nth(2).waitFor();
        await shot(page, `${device}-${locale}-3-ai-chips`);

        await submit(page, "ai negation");
        await page.locator("[data-chip-negated='true']").first().waitFor();
        await shot(page, `${device}-${locale}-4-negation-chip`);

        await submit(page, "ai zero hit");
        await page.locator(".closeMatches").waitFor();
        await shot(page, `${device}-${locale}-5-zero-hit-close-matches`);

        await page.goto(
          locale === "en" ? "/s/demo-store" : "/s/demo-store?lang=he",
        );
        await shot(page, `${device}-${locale}-6-store-preload`);
      });

      test(`engine panel ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          locale === "en" ? "/try?details=1" : "/try?lang=he&details=1",
        );
        await submit(page, "ai elegant dress");
        await page.getByTestId("playground-details-panel").waitFor();
        await shot(page, `${device}-${locale}-7-engine-panel`);
      });
    }
  }
});
