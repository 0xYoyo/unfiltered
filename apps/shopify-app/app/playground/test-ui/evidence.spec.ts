import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design-review evidence (YOY-92). Not assertions — the assertions live in
 * playground.spec.ts and the baselines in snapshots.spec.ts. This captures
 * the states a `[DESIGN]` reviewer judges against docs/DESIGN.md, at both
 * viewports and in both directions, into docs/evidence/YOY-92/.
 *
 * Tagged @evidence so the normal lane does not spend time on it:
 * `npx playwright test --project=playground -g @evidence`.
 */

const OUT = "docs/evidence/YOY-92";
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
    for (const [locale, path] of [
      ["en", "/"],
      ["he", "/?lang=he"],
    ] as const) {
      test(`${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);

        await page.goto(path);
        await shot(page, `${device}-${locale}-1-initial`);

        await input(page).fill("delayed");
        await input(page).press("Enter");
        await shot(page, `${device}-${locale}-2-loading`);
        await page.getByTestId("playground-card").first().waitFor();
        await shot(page, `${device}-${locale}-3-results`);

        await input(page).fill("empty");
        await input(page).press("Enter");
        await page.waitForTimeout(300);
        await shot(page, `${device}-${locale}-4-empty`);

        await input(page).fill("dress");
        await input(page).press("Enter");
        await page.getByTestId("playground-card").first().waitFor();
        await input(page).fill("error");
        await input(page).press("Enter");
        await page.waitForTimeout(300);
        await shot(page, `${device}-${locale}-5-failure-keeps-results`);
      });
    }
  }

  test("desktop en dark", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.setViewportSize(DESKTOP);
    await page.goto("/");
    await shot(page, "desktop-en-6-dark-initial");
    await input(page).fill("dress");
    await input(page).press("Enter");
    await page.getByTestId("playground-card").first().waitFor();
    await shot(page, "desktop-en-7-dark-results");
    await context.close();
  });
});
