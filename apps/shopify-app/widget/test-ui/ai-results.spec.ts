import { expect, test, type Page } from "@playwright/test";

// AI results with chips, zero-hit state, and the refinement flow (YOY-49),
// driven against the harness AI fixtures. The full pipeline is submit-gated
// (YOY-68 AC-2), so these tests stretch the preview debounce beyond the test
// timeout and submit with Enter — every request below is a submitted search.

// The widget owns the input's placeholder while active (YOY-50 AC-1), so
// tests locate the theme input structurally rather than by placeholder.
const themeInput = (page: Page) => page.locator('input[type="search"]');

/** Submit a query through the full pipeline: fill, then explicit Enter. */
async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}
const chips = (page: Page) => page.getByTestId("unfiltered-widget-chip");
const cards = (page: Page) => page.getByTestId("unfiltered-widget-card");

const searchRequests = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __searchRequests: Record<string, unknown>[] })
        .__searchRequests,
  );

/** The echoed intent of the harness AI fixture (wire shape). */
const AI_INTENT = {
  category: "dress",
  priceMin: null,
  priceMax: 400,
  currency: "ILS",
  colorsInclude: [],
  colorsExclude: ["black"],
  occasion: null,
  size: null,
  availabilityRequired: false,
  softAttributes: ["elegant"],
};

test("AI responses render a chip row with remove controls and accessible labels (AC-1)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai&debounce=30000");

  await submitQuery(page, "elegant dress");
  await expect(cards(page)).toHaveCount(2);

  await expect(page.getByTestId("unfiltered-widget-chips")).toBeVisible();
  await expect(chips(page)).toHaveCount(3);
  await expect(chips(page).nth(0)).toContainText("dress");
  await expect(chips(page).nth(1)).toContainText("Under 400");
  await expect(chips(page).nth(2)).toContainText("Not black");
  await expect(chips(page).nth(1)).toHaveAttribute(
    "aria-label",
    "Remove filter: Under 400",
  );
});

test("removing a chip sends the echoed intent + removed chip and re-renders (AC-2)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai&debounce=30000");

  await submitQuery(page, "elegant dress");
  await expect(chips(page)).toHaveCount(3);

  await chips(page).filter({ hasText: "Under 400" }).click();

  // Re-rendered from the removal response: chip gone, results recomputed.
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).filter({ hasText: "Under 400" })).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).nth(2)).toContainText("Unfiltered By Removal");

  const requests = await searchRequests(page);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    query: "elegant dress",
    previousIntent: AI_INTENT,
    removeChip: { field: "priceMax", value: "400" },
  });
});

test("AI zero-hits render the message, removable chips, and close matches (AC-3)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-zero-hit&debounce=30000");

  await submitQuery(page, "elegant dress under 400");

  await expect(page.getByTestId("unfiltered-widget-zero-hit")).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-zero-hit")).toContainText(
    "Nothing matches all of these",
  );
  await expect(chips(page)).toHaveCount(3);

  const closeMatches = page.getByTestId("unfiltered-widget-close-matches");
  await expect(closeMatches).toBeVisible();
  await expect(closeMatches.locator("h2")).toContainText("Close matches");
  await expect(
    closeMatches.getByTestId("unfiltered-widget-card"),
  ).toHaveCount(1);
  await expect(closeMatches).toContainText("Black Evening Dress");

  // The chips are still removable in the zero-hit state: removing one
  // issues the removal request and re-renders results.
  await chips(page).filter({ hasText: "Under 400" }).click();
  await expect(chips(page)).toHaveCount(2);
  await expect(cards(page).first()).toBeVisible();
});

test("a follow-up query carries the held intent; the response's echo replaces it (AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai&debounce=30000");

  await submitQuery(page, "elegant dress");
  await expect(cards(page)).toHaveCount(2);

  await submitQuery(page, "same but cheaper");
  await expect.poll(async () => (await searchRequests(page)).length).toBe(2);

  const requests = await searchRequests(page);
  expect("previousIntent" in requests[0]!).toBe(false);
  expect(requests[1]!.previousIntent).toEqual(AI_INTENT);
});

test("new search clears intent, input, chips, and results; next query has no previousIntent (AC-5)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai&debounce=30000");

  await submitQuery(page, "elegant dress");
  await expect(chips(page)).toHaveCount(3);

  await page.getByTestId("unfiltered-widget-new-search").click();
  await expect(themeInput(page)).toHaveValue("");
  await expect(chips(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(0);

  await submitQuery(page, "fresh query");
  await expect.poll(async () => (await searchRequests(page)).length).toBe(2);
  const requests = await searchRequests(page);
  expect(requests[1]!.query).toBe("fresh query");
  expect("previousIntent" in requests[1]!).toBe(false);
});

test("degraded responses render plain classic cards: no chips, no error text (AC-6)", async ({
  page,
}) => {
  await page.goto("/?fixture=degraded&debounce=30000");

  await submitQuery(page, "elegant dress");
  await expect(cards(page)).toHaveCount(1);

  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("unfiltered-widget-zero-hit")).toBeHidden();
  await expect(page.getByTestId("unfiltered-widget-no-results")).toBeHidden();
  const overlayText = await page
    .getByTestId("unfiltered-widget-overlay")
    .innerText();
  expect(overlayText.toLowerCase()).not.toContain("error");
});

test("the AI loading indicator survives slow responses and the input stays responsive (AC-7)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-delayed&debounce=30000");

  await submitQuery(page, "elegant dress");
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeVisible();

  // The input stays responsive mid-flight.
  await themeInput(page).press("End");
  await themeInput(page).pressSequentially(" for a wedding");
  await expect(themeInput(page)).toHaveValue("elegant dress for a wedding");

  await expect(cards(page).first()).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeHidden();
});

test("unknown-color results rank after known matches and carry the label (YOY-67 AC-5)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-color&debounce=30000");

  await submitQuery(page, "blue snowboard");
  await expect(cards(page)).toHaveCount(3);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText("blue");

  // Known-color matches render first; the unknown-color product is last,
  // visually de-emphasized, and explicitly labeled.
  await expect(cards(page).nth(0)).toContainText("Blue Snowboard");
  await expect(cards(page).nth(1)).toContainText("Ocean Board");
  const unknown = cards(page).nth(2);
  await expect(unknown).toContainText("Mystery Board");
  await expect(unknown).toHaveClass(/card-color-unknown/);
  await expect(
    unknown.getByTestId("unfiltered-widget-color-note"),
  ).toHaveText("Color not confirmed");

  // Known matches carry no label and no de-emphasis.
  await expect(
    cards(page).nth(0).getByTestId("unfiltered-widget-color-note"),
  ).toHaveCount(0);
  const knownOpacity = await cards(page)
    .nth(0)
    .evaluate((element) => getComputedStyle(element).opacity);
  const unknownOpacity = await unknown.evaluate(
    (element) => getComputedStyle(element).opacity,
  );
  expect(Number(unknownOpacity)).toBeLessThan(Number(knownOpacity));
});

test("the unknown-color label is localized in Hebrew chrome (YOY-67 AC-5)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-color&locale=he&debounce=30000");

  await submitQuery(page, "סנובורד כחול");
  await expect(cards(page)).toHaveCount(3);
  await expect(
    cards(page).nth(2).getByTestId("unfiltered-widget-color-note"),
  ).toHaveText("צבע לא מאומת");
});

test("focus renders no panel; loading opens it; results keep it open (YOY-67 AC-6)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-delayed");

  const overlay = page.getByTestId("unfiltered-widget-overlay");
  await themeInput(page).focus();
  await page.waitForTimeout(100);
  await expect(overlay).toBeHidden();

  // The first query opens the overlay at the loading state, then results.
  await themeInput(page).fill("elegant dress");
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeVisible();
  await expect(overlay).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
});

test("the unknown-color label renders under an exclusion-only color chip too (YOY-67 AC-5)", async ({
  page,
}) => {
  await page.goto("/?fixture=ai-color-exclude&debounce=30000");

  await submitQuery(page, "snowboard not black");
  await expect(cards(page)).toHaveCount(2);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText("Not black");

  // The evidence-backed hit is unlabeled; the unknown-color hit is flagged
  // exactly as under an inclusion chip.
  await expect(
    cards(page).nth(0).getByTestId("unfiltered-widget-color-note"),
  ).toHaveCount(0);
  const unknown = cards(page).nth(1);
  await expect(unknown).toHaveClass(/card-color-unknown/);
  await expect(
    unknown.getByTestId("unfiltered-widget-color-note"),
  ).toHaveText("Color not confirmed");
});
