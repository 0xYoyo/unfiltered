import { expect, test, type Page } from "@playwright/test";

// The preview/submit interaction model (YOY-68 AC-5): typing produces live,
// classic-only preview results with zero AI involvement; the full pipeline
// (chips, zero-hit rescue, refinement) fires only on explicit submit; and the
// preview→submitted transition is clean — panels swap, never stack.

const themeInput = (page: Page) => page.locator('input[type="search"]');
const overlay = (page: Page) => page.getByTestId("unfiltered-widget-overlay");
const cards = (page: Page) => page.getByTestId("unfiltered-widget-card");
const chips = (page: Page) => page.getByTestId("unfiltered-widget-chip");
const previewEmpty = (page: Page) =>
  page.getByTestId("unfiltered-widget-preview-empty");
const noResults = (page: Page) =>
  page.getByTestId("unfiltered-widget-no-results");
const zeroHit = (page: Page) => page.getByTestId("unfiltered-widget-zero-hit");

interface CapturedRequest {
  query: string;
  mode?: string;
  previousIntent?: unknown;
}

const searchRequests = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __searchRequests: CapturedRequest[] })
        .__searchRequests,
  );

test("typing produces live-updating classic previews: every request is mode=preview, none carries refinement context (AC-1)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai");

  // Two debounced keystroke batches, each landing a preview render.
  await themeInput(page).fill("ni");
  await expect(cards(page).first()).toBeVisible();
  await themeInput(page).fill("nike");
  await expect.poll(async () => (await searchRequests(page)).length).toBe(2);
  await expect(cards(page)).toHaveCount(3);

  // Previews render the plain grid only: no chips even on an AI fixture,
  // because the preview request never reaches the AI pipeline.
  await expect(chips(page)).toHaveCount(0);

  const requests = await searchRequests(page);
  for (const request of requests) {
    expect(request.mode).toBe("preview");
    expect("previousIntent" in request).toBe(false);
    expect("removeChip" in request).toBe(false);
  }
});

test("submit runs the full pipeline; the preview→submitted transition swaps panels without stacking (AC-2, AC-4, AC-5)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai");

  // Preview first: plain classic grid, no chips.
  await themeInput(page).fill("elegant dress");
  await expect(cards(page)).toHaveCount(3);
  await expect(chips(page)).toHaveCount(0);

  // Explicit submit: the same query through the full pipeline.
  await themeInput(page).press("Enter");
  await expect(chips(page)).toHaveCount(3);
  await expect(cards(page)).toHaveCount(2);

  // The submit request is the only one WITHOUT mode=preview.
  const requests = await searchRequests(page);
  const submitted = requests.filter((request) => request.mode === undefined);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.query).toBe("elegant dress");
  expect(requests.length).toBeGreaterThan(1);

  // Clean transition: exactly one results grid, no leftover preview or
  // empty-state panels alongside the submitted response.
  await expect(page.getByTestId("unfiltered-widget-results")).toHaveCount(1);
  await expect(previewEmpty(page)).toBeHidden();
  await expect(noResults(page)).toBeHidden();
  await expect(zeroHit(page)).toBeHidden();
});

test("preview zero hits show the quiet empty state; the flat no-results panel waits for submit (AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=empty");

  await themeInput(page).fill("nothing matches this");
  await expect(previewEmpty(page)).toBeVisible();
  await expect(noResults(page)).toBeHidden();
  await expect(zeroHit(page)).toBeHidden();
  await expect(cards(page)).toHaveCount(0);

  // Submit the same query: the submitted classic empty set renders the flat
  // panel, and the quiet preview state leaves with it (no stacking).
  await themeInput(page).press("Enter");
  await expect(noResults(page)).toBeVisible();
  await expect(previewEmpty(page)).toBeHidden();
});

test("typing after a submitted AI response drops to a plain preview but keeps the refinement memory for the next submit (AC-2)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai");

  await themeInput(page).fill("elegant dress");
  await expect(cards(page)).toHaveCount(3);
  await themeInput(page).press("Enter");
  await expect(chips(page)).toHaveCount(3);

  // Typing again previews without chips — refinement is submit-gated.
  await themeInput(page).fill("same but cheaper");
  await expect(chips(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);

  // The follow-up submit still carries the held intent from the last
  // submitted response; the preview in between never did.
  await themeInput(page).press("Enter");
  await expect(chips(page)).toHaveCount(3);
  const requests = await searchRequests(page);
  const submitted = requests.filter((request) => request.mode === undefined);
  expect(submitted).toHaveLength(2);
  expect("previousIntent" in submitted[0]!).toBe(false);
  expect(submitted[1]!.previousIntent).toBeDefined();
  const previews = requests.filter((request) => request.mode === "preview");
  expect(previews.length).toBeGreaterThan(0);
  for (const preview of previews) {
    expect("previousIntent" in preview).toBe(false);
  }
});

test("clicking a preview card navigates without firing the click beacon (AC-3)", async ({
  page,
}) => {
  await page.goto("/");

  await themeInput(page).fill("nike");
  await expect(cards(page).first()).toBeVisible();
  await cards(page).first().click();

  await page.waitForURL(/\/products\/nike-air-90/);

  // No SearchEvent exists for a preview, so nothing may be attributed to it.
  const beacons = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("harness:clickBeacons") ?? "[]"),
  );
  expect(beacons).toEqual([]);
});

test("a preview refresh keeps the current results on screen instead of flashing the loading state", async ({
  page,
}) => {
  await page.goto("/?fixture=delayed");

  // First preview: nothing rendered yet, so the loading state opens the
  // overlay (YOY-67 AC-6 unchanged).
  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeVisible();
  await expect(cards(page)).toHaveCount(3);

  // Follow-up keystrokes refresh in place: the previous cards stay while
  // the next preview is in flight — no loading flicker per keystroke.
  await themeInput(page).fill("nike air");
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeHidden();
  await expect(cards(page)).toHaveCount(3);
  await expect(overlay(page)).toBeVisible();
});
