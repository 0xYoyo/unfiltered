import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for sized card images (YOY-169 AC-4; verify 1): the
 * results grid with one Shopify-CDN card (sized `src`/`srcset`) beside a
 * crawl-sourced card, and the plain results grid — desktop and mobile, EN
 * and HE (RTL) — plus loading, empty and error. The look is unchanged; the
 * images are only fetched smaller. Tagged @evidence — off the default
 * lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-card-images`.
 */
const OUT = "docs/evidence/YOY-169";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
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
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "?lang=he"],
    ] as const) {
      test(`card images ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.route(/cdn\.shopify\.com|images\.example\.test/, (route) =>
          route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
        );
        await page.goto(`/try${suffix}`);
        await submit(page, "images dress");
        await expect(page.getByTestId("playground-card")).toHaveCount(2);
        await shot(page, `playground-${device}-${locale}-sized-images`);
        await submit(page, "dress");
        await expect(page.getByTestId("playground-card").first()).toBeVisible();
        await shot(page, `playground-${device}-${locale}-results`);
      });

      test(`card images states ${device} ${locale}`, async ({ page }) => {
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
