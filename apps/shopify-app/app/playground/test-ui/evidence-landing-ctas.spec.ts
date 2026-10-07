import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the landing page's call-to-action pairs (YOY-157
 * AC-26): the hero ("Try it on a real catalog" + "See how it works") and the
 * closer ("Try it on a real catalog" + "See pricing"), desktop and mobile.
 * The site is English-only LTR, and the page has no loading, empty or error
 * state. Tagged @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground evidence-landing-ctas`.
 */
const OUT = "docs/evidence/YOY-157/AC-26";

test.describe("@evidence", () => {
  for (const [device, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    test(`landing call-to-action pairs ${device}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expect(page.locator(".site-hero__actions a")).toHaveCount(2);
      mkdirSync(OUT, { recursive: true });
      await page.evaluate(() => document.fonts.ready);
      await page.locator(".site-hero").screenshot({ path: `${OUT}/landing-${device}-hero.png` });
      await page.locator(".site-closer").screenshot({ path: `${OUT}/landing-${device}-closer.png` });
      await page.screenshot({ path: `${OUT}/landing-${device}-full.png`, fullPage: true });
    });
  }
});
