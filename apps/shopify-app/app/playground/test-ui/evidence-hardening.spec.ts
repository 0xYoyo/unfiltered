import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the M4 hardening tail's playground items (YOY-96):
 * the store line with its literal separator (AC-16) and the preview-cards
 * vs submitted-cards states behind the click-beacon rule (AC-14). Tagged
 * @evidence — off the default lane, captured with
 * `PLAYGROUND_EVIDENCE=1 npx playwright test --project=playground -g @evidence`.
 */
const OUT = "docs/evidence/YOY-96";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");

async function shot(
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, ...options });
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
      test(`hardening ${device} ${locale}`, async ({ page }) => {
        await page.setViewportSize(viewport);

        // AC-16: the store line reads "Demo Store · 120 products".
        await page.goto(`/s/demo-store${suffix}`);
        await shot(page, `${device}-${locale}-1-store-line`);

        // AC-14: preview cards (typed, no Enter) — a click sends no beacon.
        await page.goto(`/${suffix}`);
        await input(page).fill("dress");
        // Full page: on mobile the two states share a fold, and the
        // evidence has to show the 2-card preview set against the 4-card
        // submitted set.
        await cards(page).nth(1).waitFor();
        await shot(page, `${device}-${locale}-2-preview-cards`, {
          fullPage: true,
        });

        // AC-14: submitted cards — a click beacons with this searchId.
        await input(page).press("Enter");
        await cards(page).nth(3).waitFor();
        await shot(page, `${device}-${locale}-3-submitted-cards`, {
          fullPage: true,
        });
      });
    }
  }
});
