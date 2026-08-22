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

  // Focus renders nothing (YOY-67 AC-6) — and the theme's own focus
  // listener must still be suppressed while the widget owns the input.
  await themeInput(page).focus();
  await page.waitForTimeout(100);
  await expect(overlay(page)).toBeHidden();

  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-card")).toBeVisible();
  await expect(overlay(page)).toBeVisible();

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

  // Three consecutive failed searches drive the widget inert and it removes
  // itself (YOY-61 AC-4: a single failure only shows a quiet fallback).
  // Clearing between searches resets the overlay to idle, so the no-results
  // message reappearing proves each failure was processed in turn.
  const failed = page.getByTestId("unfiltered-widget-no-results");
  await themeInput(page).fill("nike");
  await expect(failed).toBeVisible();
  await themeInput(page).fill("");
  await expect(failed).toBeHidden();
  await themeInput(page).fill("nike two");
  await expect(failed).toBeVisible();
  await themeInput(page).fill("");
  await expect(failed).toBeHidden();
  await themeInput(page).fill("nike three");
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

// Native mode (YOY-101): the SAME fixture, opposite contract — keystroke
// previews ride the theme's own predictive search. Typing and focus reach
// the theme's listeners untouched (the SUGGESTIONS dropdown renders, its
// event log fills), the owned preview box never mounts, no preview request
// leaves for the proxy, and only Enter / the form submit are taken over.
test.describe("native mode: keystroke previews ride the theme's predictive search (YOY-101)", () => {
  const themeEvents = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { __themeEvents: string[] }).__themeEvents,
    );
  const searchRequests = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __searchRequests: unknown[] }).__searchRequests,
    );
  const nativeItems = (page: Page) => page.getByTestId("unfiltered-native-item");

  test("typing renders the theme's SUGGESTIONS dropdown, never the owned preview box, and sends no preview request (AC-1, AC-3, AC-5)", async ({
    page,
  }) => {
    await page.goto("/native-predictive.html?native=A");

    // Focus reaches the theme (its focus listener runs, nothing to render
    // for an empty input yet) and the widget still renders nothing.
    await themeInput(page).focus();
    await themeInput(page).pressSequentially("nike");
    await expect(nativeResults(page)).toBeVisible();
    await expect(nativeResults(page)).toContainText("SUGGESTIONS: nike");

    // Well past the widget's debounce (50 ms): still no owned overlay, no
    // owned card, and no request of any kind to the proxy.
    await page.waitForTimeout(300);
    await expect(overlay(page)).toBeHidden();
    await expect(page.getByTestId("unfiltered-widget-card")).toHaveCount(0);
    expect(await searchRequests(page)).toEqual([]);

    // The theme's listeners received every keystroke un-suppressed: focus,
    // one keydown + one input per typed character.
    const events = await themeEvents(page);
    expect(events).toContain("focus:");
    expect(events.filter((e) => e === "input:")).toHaveLength(4);
    expect(events).toEqual(
      expect.arrayContaining(["keydown:n", "keydown:i", "keydown:k", "keydown:e"]),
    );
  });

  test("Enter runs our pipeline and renders the native view; the theme's scripted /search navigation and form submit stay prevented (AC-2)", async ({
    page,
  }) => {
    await page.goto("/native-predictive.html?native=A");
    // A marker on the live document: any real navigation (the theme's
    // `location.assign` or the form's GET) would produce a fresh document
    // without it.
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });

    await themeInput(page).pressSequentially("nike");
    await expect(nativeResults(page)).toContainText("SUGGESTIONS: nike");
    await themeInput(page).press("Enter");

    await expect(nativeItems(page)).toHaveCount(1);
    await expect(overlay(page)).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as unknown as { __sameDocument?: boolean }).__sameDocument,
      ),
    ).toBe(true);
    // Exactly one request, the submitted search — never a preview.
    expect(await searchRequests(page)).toEqual([{ query: "nike", mode: null }]);
    // Enter is the one keystroke the theme's listeners never see.
    expect(await themeEvents(page)).not.toContain("keydown:Enter");
  });

  test("our submit closes the theme's inline predictive dropdown; typing again re-shows it (YOY-96 AC-6)", async ({
    page,
  }) => {
    await page.goto("/native-predictive.html?native=A");
    const dropdown = page.locator("#PredictiveResults");

    await themeInput(page).pressSequentially("nike");
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText("SUGGESTIONS: nike");

    // The fixture's predictive panel is inline — no modal wraps it — so a
    // takeover submit must hide it explicitly, or it overlaps the mirrored
    // results view until focus leaves the input.
    await themeInput(page).press("Enter");
    await expect(nativeItems(page)).toHaveCount(1);
    await expect(dropdown).toBeHidden();
    await expect(dropdown).toHaveAttribute("hidden", "");

    // Typing still reaches the theme untouched (YOY-101 AC-1): the theme's
    // own input listener re-renders and re-shows its dropdown.
    await themeInput(page).pressSequentially("s");
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText("SUGGESTIONS: nikes");
  });

  test("the magnifier submit button runs our pipeline instead of navigating (AC-2)", async ({
    page,
  }) => {
    await page.goto("/native-predictive.html?native=A");
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });

    await themeInput(page).pressSequentially("nike");
    await page.locator('predictive-search button[type="submit"]').click();

    await expect(nativeItems(page)).toHaveCount(1);
    expect(
      await page.evaluate(
        () => (window as unknown as { __sameDocument?: boolean }).__sameDocument,
      ),
    ).toBe(true);
    expect(await searchRequests(page)).toEqual([{ query: "nike", mode: null }]);
  });
});
