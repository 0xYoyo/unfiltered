import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Design evidence for the M4 hardening tail's widget items (YOY-96): the
 * native results view with the sanitized alternate-template cards (AC-1),
 * the sanitized harvested clones (AC-1), and the sanitized full-page shell
 * (AC-4), desktop + mobile, EN + HE (RTL). Skipped on the default lane —
 * the widget project has no @evidence filter — and captured with
 * `WIDGET_EVIDENCE=1 npx playwright test --project=widget -g hardening`.
 */
const OUT = "docs/evidence/YOY-96";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };
const themeInput = (page: Page) => page.locator('input[type="search"]').first();
const items = (page: Page) => page.getByTestId("unfiltered-native-item");

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

test.describe("@evidence", () => {
  test.skip(
    process.env.WIDGET_EVIDENCE !== "1",
    "evidence capture only (WIDGET_EVIDENCE=1)",
  );

  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix] of [
      ["en", ""],
      ["he", "&locale=he"],
    ] as const) {
      for (const variant of ["A", "B"] as const) {
        test(`widget hardening ${variant} ${device} ${locale}`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          await page.goto(
            `/theme-native.html?native=${variant}&debounce=30000${suffix}`,
          );
          await themeInput(page).fill("runner");
          await themeInput(page).press("Enter");
          await items(page).nth(2).waitFor();
          await shot(
            page,
            `widget-${device}-${locale}-variant-${variant}-sanitized-results`,
          );
        });
      }
    }
  }
});
