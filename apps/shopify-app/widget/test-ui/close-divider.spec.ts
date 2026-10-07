import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Close products under the divider (YOY-166 AC-2 to AC-4): a judged page
 * with matches shows its close products after its results under the
 * "Close matches" heading with no label line — the heading is the label
 * (YOY-168 AC-3) — while a labelled match above it keeps its line. On the
 * overlay every appended page repeats the heading under its own results;
 * on the theme-native path the divider sits inside the page's grid, on
 * every page the theme's pagination shows. The `close-divider` harness
 * fixture is a 30-product order whose every page serves its last two
 * products as close. Run at a phone width.
 */

const themeInput = (page: Page) => page.locator('input[type="search"]').first();
const overlayGrid = (page: Page) => page.getByTestId("unfiltered-widget-results");
const overlayCards = (page: Page) => page.getByTestId("unfiltered-widget-card");
const overlayDividers = (page: Page) =>
  page.getByTestId("unfiltered-widget-close-matches-divider");
const nativeList = (page: Page) => page.getByTestId("unfiltered-native-list");
const nativeItems = (page: Page) => page.getByTestId("unfiltered-native-item");
const nativeDividers = (page: Page) =>
  page.getByTestId("unfiltered-native-close-matches-divider");
const themePages = (page: Page) => page.locator('[data-testid="theme-pagination"] a');

const HEADINGS = { en: "Close matches", he: "התאמות קרובות" } as const;
const PRICE_NEAR = { en: "slightly over budget", he: "מעט מעל התקציב" } as const;

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

/** The test ids of a grid's direct children, in order. */
const childIds = (grid: Locator) =>
  grid.evaluate((element) =>
    [...element.children].map((child) => child.getAttribute("data-testid")),
  );

test.use({ viewport: { width: 390, height: 844 } });

for (const locale of ["en", "he"] as const) {
  const suffix = locale === "he" ? "&locale=he" : "";

  test(`overlay: the close products sit under the divider, and the appended page repeats it (${locale})`, async ({
    page,
  }) => {
    await page.goto(`/?fixture=close-divider&results=30&debounce=30000${suffix}`);
    await submitQuery(page, "red evening gown");
    await expect(overlayCards(page)).toHaveCount(24);

    await expect(overlayDividers(page)).toHaveCount(1);
    await expect(overlayDividers(page)).toHaveText(HEADINGS[locale]);
    const card = "unfiltered-widget-card";
    const divider = "unfiltered-widget-close-matches-divider";
    expect(await childIds(overlayGrid(page))).toEqual([
      ...Array(22).fill(card),
      divider,
      card,
      card,
    ]);
    await expect(
      overlayCards(page).first().getByTestId("unfiltered-widget-label"),
    ).toHaveText(PRICE_NEAR[locale]);
    for (const index of [22, 23]) {
      await expect(overlayCards(page).nth(index).locator(".card-label")).toHaveCount(0);
    }
    // The zero-hit section stays hidden on a page with matches.
    await expect(page.getByTestId("unfiltered-widget-close-matches")).toBeHidden();
    // The divider spans the grid's full width.
    const [dividerBox, gridBox] = await Promise.all([
      overlayDividers(page).boundingBox(),
      overlayGrid(page).boundingBox(),
    ]);
    expect(Math.round(dividerBox!.width)).toBe(Math.round(gridBox!.width));

    await overlayCards(page).last().scrollIntoViewIfNeeded();
    await expect(overlayCards(page)).toHaveCount(30);
    await expect(overlayDividers(page)).toHaveCount(2);
    expect(await childIds(overlayGrid(page))).toEqual([
      ...Array(22).fill(card),
      divider,
      card,
      card,
      ...Array(4).fill(card),
      divider,
      card,
      card,
    ]);
  });

  test(`theme-native: the divider sits inside each page's grid (${locale})`, async ({
    page,
  }) => {
    await page.goto(
      `/theme-native.html?native=A&fixture=close-divider&results=30&pageSize=12&debounce=30000${suffix}`,
    );
    await submitQuery(page, "red evening gown");
    await expect(nativeItems(page)).toHaveCount(12);

    const item = "unfiltered-native-item";
    const divider = "unfiltered-native-close-matches-divider";
    const pageShape = [...Array(10).fill(item), divider, item, item];
    expect(await childIds(nativeList(page))).toEqual(pageShape);
    await expect(nativeDividers(page)).toHaveText(HEADINGS[locale]);
    await expect(
      nativeItems(page).first().getByTestId("unfiltered-widget-label"),
    ).toHaveText(PRICE_NEAR[locale]);
    for (const index of [10, 11]) {
      await expect(
        nativeItems(page).nth(index).locator(".unfiltered-native__label"),
      ).toHaveCount(0);
    }
    await expect(page.getByTestId("unfiltered-native-close-matches")).toBeHidden();
    const [dividerBox, listBox] = await Promise.all([
      nativeDividers(page).boundingBox(),
      nativeList(page).boundingBox(),
    ]);
    expect(Math.round(dividerBox!.width)).toBe(Math.round(listBox!.width));

    // Page 2 through the theme's own pagination: its own divider, in its grid.
    await themePages(page).nth(1).click();
    await expect(nativeItems(page).first()).toHaveAttribute("data-position", "12");
    expect(await childIds(nativeList(page))).toEqual(pageShape);
    await expect(nativeItems(page).nth(10)).toHaveAttribute("data-position", "22");
  });
}

for (const locale of ["en", "he"] as const) {
  const suffix = locale === "he" ? "&locale=he" : "";

  test(`overlay: a Jev-judged page puts its other-variant products under the divider with the close one, none labelled (YOY-157 AC-27, ${locale})`, async ({
    page,
  }) => {
    await page.goto(`/?fixture=close-divider-jev&results=5&debounce=30000${suffix}`);
    await submitQuery(page, "red evening gown");
    await expect(overlayCards(page)).toHaveCount(5);

    // Only the exact product sits above the heading; the four below carry no label.
    const card = "unfiltered-widget-card";
    expect(await childIds(overlayGrid(page))).toEqual([
      card,
      "unfiltered-widget-close-matches-divider",
      ...Array(4).fill(card),
    ]);
    await expect(overlayDividers(page)).toHaveText(HEADINGS[locale]);
    for (let index = 0; index < 5; index += 1) {
      await expect(overlayCards(page).nth(index).locator(".card-label")).toHaveCount(0);
    }
  });
}
