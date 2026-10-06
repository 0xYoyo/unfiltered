import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the site copy pass (YOY-156; verify 1 – 4): the text
 * wordmark and the "Try it on a real catalog" links in the nav, the hero,
 * the closer and the pricing cards, on `/` and `/pricing`, and the site
 * chrome around `/try` in EN and HE (the chrome stays LTR English) —
 * desktop and mobile — plus the playground's loading, empty and error
 * states inside that chrome. Tagged @evidence — off the default lane,
 * captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-site-copy`.
 */
const OUT = "docs/evidence/YOY-156";
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
    ["desktop", { width: 1280, height: 800 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    test(`site copy pages ${device}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const [path, name] of [
        ["/", "landing"],
        ["/pricing", "pricing"],
      ] as const) {
        await page.goto(path);
        await expect(page.locator(".site-nav .site-wordmark__name")).toHaveText("Unfiltered");
        await shot(page, `site-${device}-${name}`);
      }
    });

    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "?lang=he"],
    ] as const) {
      test(`site copy /try ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/try${suffix}`);
        await expect(input(page)).toBeVisible();
        await shot(page, `try-${device}-${locale}-initial`);
        await submit(page, "delayed dress");
        await expect(page.getByTestId("playground-skeleton")).toBeVisible();
        await shot(page, `try-${device}-${locale}-loading`);
        await expect(page.getByTestId("playground-card").first()).toBeVisible();
        await shot(page, `try-${device}-${locale}-results`);
        await submit(page, "empty rail");
        await expect(page.getByTestId("playground-card")).toHaveCount(0);
        await shot(page, `try-${device}-${locale}-empty`);
        await submit(page, "error dress");
        await expect(page.locator(".statusLine")).not.toBeEmpty();
        await shot(page, `try-${device}-${locale}-error`);
      });
    }
  }
});
