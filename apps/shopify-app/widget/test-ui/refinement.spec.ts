import { expect, test, type Page } from "@playwright/test";

import { STRING_CATALOG } from "../src/strings";

/**
 * Refinement and the two-meanings chip on both widget paths (YOY-150).
 *
 * Every submitted search sends the held `carry` as `previousQuery` (AC-4);
 * the overlay's "New search" clears it (AC-5) and the theme-native path has
 * no such control and gains none (NG-2); `carry` lives in memory only
 * (AC-6). A response's `otherReading` leads the chip row as one chip,
 * "{reading} instead?" (AC-8), and tapping it searches the reading afresh
 * with no `previousQuery` (AC-9), with no dialog of its own (AC-10).
 *
 * Harness fixtures: `?fixture=refine|two-meanings` (widget/index.html and
 * widget/theme-native.html), which answer `carry` the way the server
 * builds it: the request's `previousQuery` and the query, one per line.
 */

interface LoggedRequest {
  query: string;
  previousQuery?: string;
  removedChips?: Array<{ field: string; value: string }>;
  mode?: string;
}

const themeInput = (page: Page) => page.locator('input[type="search"]').first();

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

async function submitted(page: Page): Promise<LoggedRequest[]> {
  const all = await page.evaluate(
    () => (window as unknown as { __searchRequests: LoggedRequest[] }).__searchRequests,
  );
  return all.filter((request) => request.mode !== "preview");
}

async function submittedCount(page: Page): Promise<number> {
  return (await submitted(page)).length;
}

/**
 * Wait until the widget has read and applied every search response so far
 * (YOY-157 AC-30). The carry a submit sends is the last response's, so the
 * next submit must not go out before that response is applied — waiting on
 * the request count alone raced it.
 */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const harness = window as unknown as {
          __searchRequests: unknown[];
          __searchResponsesRead: number;
        };
        return harness.__searchResponsesRead === harness.__searchRequests.length;
      }),
    )
    .toBe(true);
}

/** Submit, then wait for that search's response to be applied. */
async function submitAndSettle(page: Page, query: string, expectedSubmitted: number): Promise<void> {
  await submitQuery(page, query);
  await expect.poll(() => submittedCount(page)).toBe(expectedSubmitted);
  await settled(page);
}

const PATHS = [
  {
    name: "overlay",
    url: (fixture: string, locale = "en") =>
      `/?fixture=${fixture}&debounce=30000${locale === "he" ? "&locale=he" : ""}`,
    chips: "unfiltered-widget-chips",
    reading: "unfiltered-widget-other-reading",
  },
  {
    name: "theme-native",
    url: (fixture: string, locale = "en") =>
      `/theme-native.html?native=A&fixture=${fixture}&debounce=30000${locale === "he" ? "&locale=he" : ""}`,
    chips: "unfiltered-native-chips",
    reading: "unfiltered-native-other-reading",
  },
] as const;

for (const path of PATHS) {
  test.describe(`${path.name} path`, () => {
    test("every submitted search sends the held carry as previousQuery (AC-4)", async ({ page }) => {
      await page.goto(path.url("refine"));
      await submitAndSettle(page, "black dress", 1);
      await expect(page.getByTestId(path.chips)).toBeVisible();
      await submitAndSettle(page, "same but cheaper", 2);
      await submitAndSettle(page, "in navy", 3);
      const requests = await submitted(page);
      expect(requests[0]!.previousQuery).toBeUndefined();
      expect(requests[1]!.previousQuery).toBe("black dress");
      expect(requests[2]!.previousQuery).toBe("black dress\nsame but cheaper");
    });

    test("a removed chip stays removed across a refinement in the same chain (AC-11)", async ({ page }) => {
      await page.goto(path.url("refine"));
      await submitQuery(page, "dress size m");
      await expect(page.locator("[data-field='size']")).toHaveCount(1);
      await page.locator("[data-field='size']").click();
      await expect(page.locator("[data-field='size']")).toHaveCount(0);
      await expect.poll(() => submittedCount(page)).toBe(2);
      await settled(page);

      await submitAndSettle(page, "same but cheaper", 3);
      const requests = await submitted(page);
      // The removal re-asked the search on screen, with no chain of its own.
      expect(requests[1]!.previousQuery).toBeUndefined();
      expect(requests[2]!.previousQuery).toBe("dress size m");
      expect(requests[2]!.removedChips).toEqual([{ field: "size", value: "M" }]);
      await expect(page.locator("[data-field='size']")).toHaveCount(0);
    });

    for (const locale of ["en", "he"] as const) {
      test(`the second reading leads the chip row and searches afresh (${locale}; AC-8 – AC-10)`, async ({
        page,
      }) => {
        await page.goto(path.url("two-meanings", locale));
        const dialogsBefore = await page.getByRole("dialog", { includeHidden: true }).count();
        await submitQuery(page, "wedding dress");
        const reading = page.getByTestId(path.reading);
        // The harness answers the reading in the shopper's language.
        const phrase = locale === "he" ? "שמלות כלה" : "Bridal gowns";
        const label = STRING_CATALOG[locale].otherReading.replace("{reading}", phrase);
        await expect(reading).toHaveText(label);
        // First in the chip row.
        await expect(page.getByTestId(path.chips).locator(":scope > *").first()).toHaveText(label);
        // No dialog of its own: only the overlay's own panel, if any.
        expect(await page.getByRole("dialog", { includeHidden: true }).count()).toBe(dialogsBefore);
        await expect(page.getByRole("alertdialog")).toHaveCount(0);

        await reading.click();
        await expect.poll(() => submittedCount(page)).toBe(2);
        await settled(page);
        const requests = await submitted(page);
        expect(requests[0]!.previousQuery).toBeUndefined();
        expect(requests[1]!.query).toBe(phrase);
        expect(requests[1]!.previousQuery).toBeUndefined();
        expect(await page.getByRole("dialog", { includeHidden: true }).count()).toBe(dialogsBefore);
        await expect(page.getByRole("alertdialog")).toHaveCount(0);

        // The reading started a new chain: the next search refines IT.
        await submitAndSettle(page, "in ivory", 3);
        expect((await submitted(page))[2]!.previousQuery).toBe(phrase);
      });
    }

    test("carry is held in memory only: a reload forgets it (AC-6)", async ({ page }) => {
      await page.goto(path.url("refine"));
      await submitQuery(page, "black dress");
      await expect.poll(() => submittedCount(page)).toBe(1);
      const stored = await page.evaluate(() =>
        JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }, document.cookie]),
      );
      expect(stored).not.toContain("black dress");
      await page.goto(path.url("refine"));
      await submitQuery(page, "same but cheaper");
      await expect.poll(() => submittedCount(page)).toBe(1);
      expect((await submitted(page))[0]!.previousQuery).toBeUndefined();
    });
  });
}

test("overlay: New search clears the held carry (AC-5)", async ({ page }) => {
  await page.goto(PATHS[0].url("refine"));
  // The response is applied before New search, so New search is what clears the carry.
  await submitAndSettle(page, "black dress", 1);
  await page.getByTestId("unfiltered-widget-new-search").click();
  await submitQuery(page, "same but cheaper");
  await expect.poll(() => submittedCount(page)).toBe(2);
  expect((await submitted(page))[1]!.previousQuery).toBeUndefined();
});

test("theme-native: no New search control exists, and none is added (AC-4, NG-2)", async ({ page }) => {
  await page.goto(PATHS[1].url("refine"));
  await submitAndSettle(page, "black dress", 1);
  await submitAndSettle(page, "same but cheaper", 2);
  expect((await submitted(page))[1]!.previousQuery).toBe("black dress");
  await expect(page.getByTestId("unfiltered-native-results")).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-new-search")).not.toBeVisible();
  await expect(page.getByTestId("unfiltered-native-results").getByTestId(/new-search/)).toHaveCount(0);
});
