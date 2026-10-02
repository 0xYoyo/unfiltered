import { expect, test, type Page } from "@playwright/test";

/**
 * Clients request pages from the server (YOY-146): every submitted search
 * asks for one page and the surfaces fetch the rest as the shopper moves —
 * the theme-native view through the theme's own pagination (with the next
 * page prefetched when the last row comes into view), the overlay by
 * appending below as the shopper scrolls. The harness stubs answer exactly
 * as the endpoint does: `page` and `pageSize` in, that page plus `page` and
 * `totalCount` out. Each test names the How-to-verify step it proves.
 */

const themeInput = (page: Page) => page.locator('input[type="search"]').first();
const nativeItems = (page: Page) => page.getByTestId("unfiltered-native-item");
const nativeTitles = (page: Page) => nativeItems(page).locator(".card__heading a");
const themeCount = (page: Page) => page.getByTestId("theme-results-count");
const themePages = (page: Page) =>
  page.locator('[data-testid="theme-pagination"] a');
const currentPage = (page: Page) =>
  page.locator('[data-testid="theme-pagination"] a[aria-current="page"]');
const overlayCards = (page: Page) => page.getByTestId("unfiltered-widget-card");
const loadingMore = (page: Page) => page.getByTestId("unfiltered-widget-loading-more");

interface LoggedRequest {
  query: string;
  mode?: string;
  page?: number;
  pageSize?: number;
}

const searchRequests = (page: Page): Promise<LoggedRequest[]> =>
  page.evaluate(
    () => (window as unknown as { __searchRequests: LoggedRequest[] }).__searchRequests,
  );

const clickBeacons = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("harness:clickBeacons") ?? "[]"),
  ) as Promise<Array<{ productId: string; position: number }>>;

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

const NATIVE = "/theme-native.html?native=A&fixture=many&results=30&pageSize=12&debounce=30000";
const OVERLAY = "/?fixture=many&results=30&debounce=30000";

for (const [locale, suffix] of [
  ["en", ""],
  ["he", "&locale=he"],
] as const) {
  test.describe(`theme-native pages from the server (${locale})`, () => {
    test(`the first request asks for page 1 at the theme's page size; the count line states totalCount and the links span it (verify 1${locale === "he" ? ", 9" : ""})`, async ({
      page,
    }) => {
      await page.goto(`${NATIVE}${suffix}`);
      await submitQuery(page, "dress");
      await expect(nativeItems(page)).toHaveCount(12);

      const requests = await searchRequests(page);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ query: "dress", page: 1, pageSize: 12 });
      await expect(themeCount(page)).toContainText("30");
      await expect(themePages(page)).toHaveCount(3);
      if (locale === "he") {
        await expect(page.getByTestId("unfiltered-native-results")).toHaveAttribute(
          "dir",
          "rtl",
        );
      }
    });

    test(`the last row prefetches page 2 exactly once; selecting it shows it with no further request, and page 1 comes back from memory (verify 2, 3${locale === "he" ? ", 9" : ""})`, async ({
      page,
    }) => {
      await page.goto(`${NATIVE}${suffix}`);
      await submitQuery(page, "dress");
      await expect(nativeItems(page)).toHaveCount(12);

      await nativeItems(page).last().scrollIntoViewIfNeeded();
      await expect
        .poll(async () => (await searchRequests(page)).filter((r) => r.page === 2).length)
        .toBe(1);
      // Held, not shown: the grid still holds page 1.
      await expect(nativeTitles(page).first()).toHaveText("Full Set Dress 00");
      const before = (await searchRequests(page)).length;

      await themePages(page).nth(1).click();
      await expect(nativeTitles(page).first()).toHaveText("Full Set Dress 12");
      await expect(nativeItems(page)).toHaveCount(12);
      await expect(currentPage(page)).toHaveText("2");
      // Positions run through the whole order (AC-10).
      await expect(nativeItems(page).first()).toHaveAttribute("data-position", "12");

      await themePages(page).first().click();
      await expect(nativeTitles(page).first()).toHaveText("Full Set Dress 00");
      expect((await searchRequests(page)).length).toBe(before);
    });
  });
}

test("a results URL naming page 3 requests page 3 directly (verify 4)", async ({
  page,
}) => {
  await page.goto(`${NATIVE}&q=dress&page=3`);
  await page.evaluate(() =>
    window.history.replaceState(
      { unfilteredNativeMirror: true },
      "",
      window.location.href,
    ),
  );
  await page.reload();

  await expect(nativeItems(page)).toHaveCount(6);
  const [first] = await searchRequests(page);
  expect(first).toMatchObject({ query: "dress", page: 3, pageSize: 12 });
  await expect(currentPage(page)).toHaveText("3");
  await expect(nativeTitles(page).first()).toHaveText("Full Set Dress 24");
});

test("the overlay appends the next page below as the last row comes into view; shown cards keep their place (verify 5)", async ({
  page,
}) => {
  await page.goto(`${OVERLAY}&pageDelay=400`);
  await submitQuery(page, "dress");
  await expect(overlayCards(page)).toHaveCount(24);
  expect((await searchRequests(page))[0]).toMatchObject({ page: 1, pageSize: 24 });
  const firstBox = await overlayCards(page).first().boundingBox();
  const lastBox = await overlayCards(page).nth(23).boundingBox();

  await overlayCards(page).last().scrollIntoViewIfNeeded();
  // One quiet status line while the page loads — no spinner, no skeleton,
  // no control (AC-7).
  await expect(loadingMore(page)).toBeVisible();
  await expect(loadingMore(page)).toHaveText("Loading more…");
  await expect(overlayCards(page)).toHaveCount(30);
  await expect(loadingMore(page)).toBeHidden();

  // The first 24 did not move: same size, same place relative to each other.
  const firstAfter = await overlayCards(page).first().boundingBox();
  const lastAfter = await overlayCards(page).nth(23).boundingBox();
  expect(firstAfter!.width).toBe(firstBox!.width);
  expect(lastAfter!.x).toBe(lastBox!.x);
  expect(lastAfter!.y - firstAfter!.y).toBe(lastBox!.y - firstBox!.y);
  await expect(overlayCards(page).nth(24)).toContainText("Many Dress 24");

  // Appending stops at totalCount (AC-8): no request after the last page.
  await overlayCards(page).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const pages = (await searchRequests(page)).map((request) => request.page);
  expect(pages).toEqual([1, 2]);
});

test("a failed page request leaves the shown cards in place and shows no error text (verify 7)", async ({
  page,
}) => {
  await page.goto(`${OVERLAY}&failPage=2`);
  await submitQuery(page, "dress");
  await expect(overlayCards(page)).toHaveCount(24);

  await overlayCards(page).last().scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await searchRequests(page)).filter((r) => r.page === 2).length)
    .toBe(1);
  await expect(loadingMore(page)).toBeHidden();
  await expect(overlayCards(page)).toHaveCount(24);
  await expect(page.getByTestId("unfiltered-widget-no-results")).toBeHidden();
  const overlayText = await page
    .getByTestId("unfiltered-widget-overlay")
    .evaluate((element) => element.textContent ?? "");
  expect(overlayText).not.toMatch(/error|fail/i);
});

test("the click beacon carries the card's place in the whole order, not in its page (verify 8)", async ({
  page,
}) => {
  await page.goto(OVERLAY);
  await submitQuery(page, "dress");
  await expect(overlayCards(page)).toHaveCount(24);
  await overlayCards(page).last().scrollIntoViewIfNeeded();
  await expect(overlayCards(page)).toHaveCount(30);

  // The 27th card is the third card of page 2.
  await overlayCards(page).nth(26).evaluate((card) =>
    card.addEventListener("click", (event) => event.preventDefault()),
  );
  await overlayCards(page).nth(26).click();
  await expect
    .poll(async () => (await clickBeacons(page)).at(-1))
    .toMatchObject({ productId: "gid://shopify/Product/many-26", position: 26 });
});

test("keystroke previews stay unpaged (NG-4)", async ({ page }) => {
  await page.goto("/?fixture=many&results=30&debounce=20");
  await themeInput(page).fill("dress");
  await expect(overlayCards(page).first()).toBeVisible();
  const [preview] = await searchRequests(page);
  expect(preview).toMatchObject({ mode: "preview" });
  expect(preview).not.toHaveProperty("page");
  expect(preview).not.toHaveProperty("pageSize");
});
