import { expect, test, type Page } from "@playwright/test";

// Native predictive-search suppression (YOY-60 AC-3/AC-4), driven against
// the real-theme fixture: a predictive-search custom element bound directly
// to the input, rendering a SUGGESTIONS dropdown on input/focus and
// navigating to /search on Enter by script as well as by form submit —
// exactly the behavior the M3 live run showed over the widget.

const themeInput = (page: Page) => page.locator('input[type="search"]');
const overlay = (page: Page) => page.getByTestId("unfiltered-widget-overlay");
const nativeResults = (page: Page) =>
  page.getByTestId("native-predictive-results");

test("typing renders the widget overlay and never the native SUGGESTIONS dropdown (AC-3)", async ({
  page,
}) => {
  await page.goto("/native-predictive.html");

  await themeInput(page).focus();
  await expect(overlay(page)).toBeVisible();

  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-card")).toBeVisible();

  // The theme's dropdown must not have rendered at any point: suppressed
  // listeners never populate it, so it is still empty as well as hidden.
  await expect(nativeResults(page)).toBeHidden();
  await expect(nativeResults(page)).toBeEmpty();
});

test("Enter submits neither the form nor the theme's scripted /search navigation (AC-3)", async ({
  page,
}) => {
  await page.goto("/native-predictive.html");

  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-card")).toBeVisible();

  await themeInput(page).press("Enter");
  await page.waitForTimeout(200);
  expect(new URL(page.url()).pathname).toBe("/native-predictive.html");
  await expect(overlay(page)).toBeVisible();
});

test("the magnifier submit button does not navigate while the overlay is open (AC-3)", async ({
  page,
}) => {
  await page.goto("/native-predictive.html");

  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-card")).toBeVisible();

  await page.locator('predictive-search button[type="submit"]').click();
  await page.waitForTimeout(200);
  expect(new URL(page.url()).pathname).toBe("/native-predictive.html");
  await expect(overlay(page)).toBeVisible();
});

test("an inert widget hands the input back: native predictive search and Enter navigation work (AC-3 bound by YOY-48 AC-2)", async ({
  page,
}) => {
  await page.goto("/native-predictive.html?fixture=error");

  // The failing endpoint drives the widget inert and it removes itself.
  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(0);

  // The theme's own predictive dropdown now renders — proving the fixture
  // really carries native predictive behavior (the suppression assertions
  // above are not vacuous) and that inert means fully restored.
  await themeInput(page).fill("nike again");
  await expect(nativeResults(page)).toBeVisible();
  await expect(nativeResults(page)).toContainText("SUGGESTIONS");

  await themeInput(page).press("Enter");
  await page.waitForURL(/\/search\?/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("nike again");
});
