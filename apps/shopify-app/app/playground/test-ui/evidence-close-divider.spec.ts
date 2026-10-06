import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for close products under the divider (YOY-166 AC-2,
 * AC-3; verify 1, 2): a judged page with matches, its close products under
 * "Close matches" inside the grid, and the appended page repeating it —
 * desktop and mobile, EN and HE (RTL) — plus the loading, empty and error
 * states around it, which this change leaves as they were. Tagged
 * @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-close-divider`.
 */
const OUT = "docs/evidence/YOY-166";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");
const dividers = (page: Page) => page.getByTestId("playground-close-matches-divider");

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
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
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "?lang=he"],
    ] as const) {
      test(`close divider ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "divider red gown");
        await expect(dividers(page)).toHaveCount(1);
        await dividers(page).first().scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-mixed-page-divider`, false);
        await cards(page).last().scrollIntoViewIfNeeded();
        await expect(dividers(page)).toHaveCount(2);
        await shot(page, `playground-${device}-${locale}-mixed-page-two-pages`);
      });

      test(`close divider states ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "delayed dress");
        await expect(page.getByTestId("playground-skeleton")).toBeVisible();
        await shot(page, `playground-${device}-${locale}-loading`);
        await expect(cards(page).first()).toBeVisible();
        await submit(page, "empty rail");
        await expect(cards(page)).toHaveCount(0);
        await shot(page, `playground-${device}-${locale}-empty`);
        await submit(page, "error dress");
        await expect(page.locator(".statusLine")).not.toBeEmpty();
        await shot(page, `playground-${device}-${locale}-error`);
      });
    }
  }
});
