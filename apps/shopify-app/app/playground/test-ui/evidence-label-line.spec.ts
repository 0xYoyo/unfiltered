import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the one short label line (YOY-168; verify 1 – 3):
 * every template at the narrowest card (180 px) with no numbers in the
 * price labels, and a mixed page whose cards under "Close matches" carry no
 * label — desktop and mobile, EN and HE (RTL) — plus the loading, empty and
 * error states, which this change leaves as they were. Tagged @evidence —
 * off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-label-line`.
 */
const OUT = "docs/evidence/YOY-168";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const input = (page: Page) => page.getByTestId("playground-input");

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
      test(`label line ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        // The narrowest card the grid allows (180 px).
        await page.addStyleTag({
          content: ".grid { grid-template-columns: repeat(auto-fill, 180px) !important; }",
        });
        await submit(page, "labels");
        await expect(page.getByTestId("playground-card-label")).toHaveCount(5);
        await shot(page, `playground-${device}-${locale}-labels-narrowest`);
      });

      test(`label line under the divider ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "divider red gown");
        const divider = page.getByTestId("playground-close-matches-divider");
        await expect(divider).toHaveCount(1);
        await divider.scrollIntoViewIfNeeded();
        await shot(page, `playground-${device}-${locale}-no-label-under-divider`, false);
      });

      test(`label line states ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await submit(page, "delayed dress");
        await expect(page.getByTestId("playground-skeleton")).toBeVisible();
        await shot(page, `playground-${device}-${locale}-loading`);
        await expect(page.getByTestId("playground-card").first()).toBeVisible();
        await submit(page, "empty rail");
        await expect(page.getByTestId("playground-card")).toHaveCount(0);
        await shot(page, `playground-${device}-${locale}-empty`);
        await submit(page, "error dress");
        await expect(page.locator(".statusLine")).not.toBeEmpty();
        await shot(page, `playground-${device}-${locale}-error`);
      });
    }
  }
});
