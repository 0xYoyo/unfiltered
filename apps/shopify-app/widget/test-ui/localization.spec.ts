import { expect, test, type Page } from "@playwright/test";

import {
  STRING_CATALOG,
  WIDGET_LOCALES,
  type WidgetLocale,
} from "../src/strings";

// EN+HE localization and RTL mirroring (YOY-50), driven against the harness
// fixtures with ?locale= switching chrome language.

const themeInput = (page: Page) => page.locator('input[type="search"]');
const root = (page: Page) => page.getByTestId("unfiltered-widget-root");
const overlay = (page: Page) => page.getByTestId("unfiltered-widget-overlay");
const chips = (page: Page) => page.getByTestId("unfiltered-widget-chip");
const cards = (page: Page) => page.getByTestId("unfiltered-widget-card");

test("the string catalog has complete, non-empty EN and HE sets (AC-1)", () => {
  const [reference, ...rest] = WIDGET_LOCALES.map((locale) => ({
    locale,
    keys: Object.keys(STRING_CATALOG[locale]).sort(),
  }));
  for (const other of rest) {
    expect(other.keys, `${other.locale} keys must match ${reference!.locale}`)
      .toEqual(reference!.keys);
  }
  for (const locale of WIDGET_LOCALES) {
    for (const [key, value] of Object.entries(STRING_CATALOG[locale])) {
      expect(value.trim(), `${locale}.${key} must not be empty`).not.toBe("");
    }
  }
});

test("Hebrew locale renders Hebrew chrome and dir=rtl; query text passes through untouched (AC-2, AC-3)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai&locale=he");

  await expect(root(page)).toHaveAttribute("dir", "rtl");
  await expect(themeInput(page)).toHaveAttribute(
    "placeholder",
    STRING_CATALOG.he.inputPlaceholder,
  );

  // Chrome language never touches query language: an English query in
  // Hebrew chrome reaches the endpoint verbatim.
  await themeInput(page).fill("elegant dress");
  await expect(cards(page)).toHaveCount(2);
  const requests = await page.evaluate(
    () =>
      (window as unknown as { __searchRequests: { query: string }[] })
        .__searchRequests,
  );
  expect(requests[0]!.query).toBe("elegant dress");

  await expect(
    page.getByTestId("unfiltered-widget-new-search"),
  ).toHaveText(STRING_CATALOG.he.newSearch);
  await expect(page.getByTestId("unfiltered-widget-close")).toHaveAttribute(
    "aria-label",
    STRING_CATALOG.he.closeSearch,
  );
});

test("any non-Hebrew locale falls back to English chrome and dir=ltr (AC-2)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai&locale=fr");

  await expect(root(page)).toHaveAttribute("dir", "ltr");
  await expect(themeInput(page)).toHaveAttribute(
    "placeholder",
    STRING_CATALOG.en.inputPlaceholder,
  );

  await themeInput(page).fill("elegant dress");
  await expect(cards(page)).toHaveCount(2);
  await expect(
    page.getByTestId("unfiltered-widget-new-search"),
  ).toHaveText(STRING_CATALOG.en.newSearch);
});

test("Hebrew chrome mirrors the layout and isolates Latin card text (AC-3)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai&locale=he");

  await themeInput(page).fill("elegant dress");
  await expect(cards(page)).toHaveCount(2);

  // dir on the root flips the resolved direction of everything inside the
  // shadow root — the logical properties in widget.css do the mirroring.
  const overlayDirection = await overlay(page).evaluate(
    (element) => getComputedStyle(element).direction,
  );
  expect(overlayDirection).toBe("rtl");

  // Latin titles and prices are bidi-isolated so they stay readable inside
  // the RTL layout.
  const firstCard = cards(page).first();
  await expect(firstCard.locator(".card-title")).toHaveAttribute(
    "dir",
    "auto",
  );
  await expect(firstCard.locator(".card-price")).toHaveAttribute(
    "dir",
    "auto",
  );
  await expect(firstCard.locator(".card-title")).toContainText("Silk Gown");
});

test("Hebrew chrome localizes chip values; unknown values render as extracted (AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-localized&locale=he");

  await themeInput(page).fill("elegant dress");
  await expect(chips(page)).toHaveCount(6);

  // Canonical values display in Hebrew; the price chip carries the intent's
  // currency; "chartreuse" is outside the fixed color list and renders raw.
  await expect(chips(page).nth(0)).toContainText("שמלה");
  await expect(chips(page).nth(1)).toContainText("עד 400 ILS");
  await expect(chips(page).nth(2)).toContainText("לא שחור");
  await expect(chips(page).nth(3)).toContainText("chartreuse");
  await expect(chips(page).nth(4)).toContainText("ערב");
  await expect(chips(page).nth(5)).toContainText("במלאי");
  await expect(chips(page).nth(1)).toHaveAttribute(
    "aria-label",
    "הסרת סינון: עד 400 ILS",
  );
});

test("English chrome keeps the YOY-49 chip labels on the same fixture (AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-localized&locale=en");

  await themeInput(page).fill("elegant dress");
  await expect(chips(page)).toHaveCount(6);

  await expect(chips(page).nth(0)).toContainText("dress");
  await expect(chips(page).nth(1)).toContainText("Under 400");
  await expect(chips(page).nth(2)).toContainText("Not black");
  await expect(chips(page).nth(3)).toContainText("chartreuse");
  await expect(chips(page).nth(4)).toContainText("evening");
  await expect(chips(page).nth(5)).toContainText("In stock");
});

// Mirroring regressions are caught in both directions (AC-5): RTL and LTR
// baselines of the overlay's main states.
for (const locale of ["en", "he"] as WidgetLocale[]) {
  test(`results grid with chips matches the ${locale} baseline (AC-5)`, async ({
    page,
  }) => {
    await page.goto(`/?fixture=ai&locale=${locale}`);

    await themeInput(page).fill("elegant dress");
    await expect(cards(page)).toHaveCount(2);
    await expect(chips(page)).toHaveCount(3);

    await expect(overlay(page)).toHaveScreenshot(`ai-results-${locale}.png`);
  });

  test(`zero-hit state matches the ${locale} baseline (AC-5)`, async ({
    page,
  }) => {
    await page.goto(`/?fixture=ai-zero-hit&locale=${locale}`);

    await themeInput(page).fill("elegant dress under 400");
    await expect(page.getByTestId("unfiltered-widget-zero-hit")).toBeVisible();
    await expect(
      page.getByTestId("unfiltered-widget-close-matches"),
    ).toBeVisible();

    await expect(overlay(page)).toHaveScreenshot(`zero-hit-${locale}.png`);
  });
}
