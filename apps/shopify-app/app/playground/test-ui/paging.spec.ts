import { expect, test, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG } from "../strings";

/**
 * The playground requests pages from the server (YOY-146 AC-1, AC-6 to
 * AC-10; verify 6): a submitted search asks for page 1 of 24, and when the
 * last card comes into view the next page is requested and its cards are
 * appended below — the cards already shown never move, appending stops at
 * `totalCount`, and a failed page changes nothing on screen. The `paged`
 * fixture is a 30-product order served one page per request; `paged fail`
 * fails every page after the first.
 */

const input = (page: Page) => page.getByTestId("playground-input");
const grid = (page: Page) => page.getByTestId("playground-grid");
const cards = (page: Page) => grid(page).getByTestId("playground-card");
const loadingMore = (page: Page) => page.getByTestId("playground-loading-more");

/** Every search request the page issues, as parsed query parameters. */
function recordSearchRequests(page: Page): URLSearchParams[] {
  const requests: URLSearchParams[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/search")) {
      requests.push(new URL(request.url()).searchParams);
    }
  });
  return requests;
}

/** A card's box in page coordinates — independent of how far the page scrolled. */
const pageBox = (page: Page, index: number) =>
  cards(page)
    .nth(index)
    .evaluate((card) => {
      const box = card.getBoundingClientRect();
      return { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width };
    });

async function submitQuery(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

for (const [locale, path] of [
  ["en", "/try"],
  ["he", "/try?lang=he"],
] as const) {
  test(`a submitted search appends the next page as the last card comes into view, up to totalCount (verify 6, ${locale})`, async ({
    page,
  }) => {
    const requests = recordSearchRequests(page);
    await page.goto(path);
    await submitQuery(page, "paged dress");
    await expect(cards(page)).toHaveCount(24);

    const submitted = requests.filter((params) => !params.has("mode"));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.get("page")).toBe("1");
    expect(submitted[0]!.get("pageSize")).toBe("24");
    const firstBox = await pageBox(page, 0);
    const lastBox = await pageBox(page, 23);

    await cards(page).last().scrollIntoViewIfNeeded();
    await expect(cards(page)).toHaveCount(30);
    // The first cards did not move (AC-6).
    expect(await pageBox(page, 0)).toEqual(firstBox);
    expect(await pageBox(page, 23)).toEqual(lastBox);
    await expect(cards(page).nth(24)).toContainText("Paged dress 24");
    await expect(loadingMore(page)).toBeHidden();

    // Appending stops at totalCount (AC-8): no page 3 request.
    await cards(page).last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const pages = requests
      .filter((params) => !params.has("mode"))
      .map((params) => params.get("page"));
    expect(pages).toEqual(["1", "2"]);
  });
}

test("a failed page leaves the shown cards in place and shows no error text (AC-9)", async ({
  page,
}) => {
  const requests = recordSearchRequests(page);
  await page.goto("/try");
  await submitQuery(page, "paged fail");
  await expect(cards(page)).toHaveCount(24);

  await cards(page).last().scrollIntoViewIfNeeded();
  await expect
    .poll(() => requests.filter((params) => params.get("page") === "2").length)
    .toBe(1);
  await expect(loadingMore(page)).toBeHidden();
  await expect(cards(page)).toHaveCount(24);
  // The status line stays quiet: no failure sentence for a later page.
  await expect(page.getByTestId("playground-status")).not.toHaveAttribute(
    "data-failed",
    "true",
  );
  await expect(page.getByTestId("playground-status")).not.toHaveText(
    PLAYGROUND_STRING_CATALOG.en.requestFailed,
  );
});

test("a card's click position counts through the whole order (AC-10)", async ({
  page,
}) => {
  const beacons: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/click")) {
      beacons.push(request.postData() ?? "");
    }
  });
  await page.goto("/try");
  await submitQuery(page, "paged dress");
  await expect(cards(page)).toHaveCount(24);
  await cards(page).last().scrollIntoViewIfNeeded();
  await expect(cards(page)).toHaveCount(30);

  // Cards open in a new tab; the beacon is what this test reads.
  await page.context().route("https://example.test/**", (route) =>
    route.fulfill({ status: 204 }),
  );
  await cards(page).nth(26).locator("a").first().click();
  await expect.poll(() => beacons.length).toBeGreaterThan(0);
  expect(JSON.parse(beacons.at(-1)!)).toMatchObject({
    productId: "paged-26",
    position: 26,
  });
});
