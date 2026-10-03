import { expect, test, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG } from "../strings";

/**
 * Refinement and the two-meanings chip in the playground (YOY-150), against
 * the `v2-refine` and `v2-two-meanings` fixtures. The fixture answers a
 * `carry` the way the server builds one — the request's `previousQuery` and
 * the query, one per line — so the chain is observable on the wire.
 */

const input = (page: Page) => page.getByTestId("playground-input");
const chips = (page: Page) => page.getByTestId("playground-chip");
const reading = (page: Page) => page.getByTestId("playground-other-reading");
const newSearch = (page: Page) => page.getByTestId("playground-new-search");

function recordSubmitted(page: Page): URL[] {
  const urls: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/playground/search" && url.searchParams.get("mode") !== "preview") {
      urls.push(url);
    }
  });
  return urls;
}

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

test("verify 2: a second search carries previousQuery equal to the first response's carry (AC-1, AC-3)", async ({
  page,
}) => {
  const urls = recordSubmitted(page);
  await page.goto("/try");
  const first = page.waitForResponse((response) => response.url().includes("/api/playground/search?") && !response.url().includes("mode=preview"));
  await submit(page, "refine black dress");
  const carry = ((await (await first).json()) as { carry: string }).carry;
  expect(carry).toBe("refine black dress");
  await expect(chips(page)).toHaveCount(1);

  await submit(page, "refine same but cheaper");
  await expect.poll(() => urls.length).toBe(2);
  expect(urls[0]!.searchParams.has("previousQuery")).toBe(false);
  expect(urls[1]!.searchParams.get("previousQuery")).toBe(carry);

  // The chain grows: the third search carries both sentences.
  await submit(page, "refine in navy");
  await expect.poll(() => urls.length).toBe(3);
  expect(urls[2]!.searchParams.get("previousQuery")).toBe(
    "refine black dress\nrefine same but cheaper",
  );
});

test("verify 3: New search clears the held carry — the next search has no previousQuery (AC-5)", async ({
  page,
}) => {
  const urls = recordSubmitted(page);
  await page.goto("/try");
  await submit(page, "refine black dress");
  await expect(newSearch(page)).toBeVisible();
  await newSearch(page).click();
  await submit(page, "refine same but cheaper");
  await expect.poll(() => urls.length).toBe(2);
  expect(urls[1]!.searchParams.has("previousQuery")).toBe(false);
});

test("a removed chip stays removed across a refinement in the same chain (AC-11)", async ({ page }) => {
  const urls = recordSubmitted(page);
  await page.goto("/try");
  await submit(page, "refine dress size m");
  await expect(chips(page)).toHaveCount(1);
  await page.locator("[data-field='size']").click();
  await expect(chips(page)).toHaveCount(0);
  await expect.poll(() => urls.length).toBe(2);
  // The removal re-asks the same search, with no previous chain of its own.
  expect(urls[1]!.searchParams.has("previousQuery")).toBe(false);

  await submit(page, "refine same but cheaper");
  await expect.poll(() => urls.length).toBe(3);
  expect(urls[2]!.searchParams.get("previousQuery")).toBe("refine dress size m");
  expect(JSON.parse(urls[2]!.searchParams.get("removedChips") ?? "null")).toEqual([
    { field: "size", value: "M" },
  ]);
  await expect(page.locator("[data-field='size']")).toHaveCount(0);
});

for (const locale of ["en", "he"] as const) {
  const strings = PLAYGROUND_STRING_CATALOG[locale];
  const path = locale === "he" ? "/try?lang=he" : "/try";

  test(`verify 5–7 (${locale}): the second reading leads the chip row; tapping it searches afresh, with no dialog (AC-8 – AC-10)`, async ({
    page,
  }) => {
    const urls = recordSubmitted(page);
    await page.goto(path);
    await submit(page, "two meanings wedding dress");
    await expect(reading(page)).toHaveText(strings.otherReading.replace("{reading}", "Bridal gowns"));
    // First in the row.
    await expect(page.locator("[data-testid='playground-chips'] > li").first()).toContainText(
      strings.otherReading.replace("{reading}", "Bridal gowns"),
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    await reading(page).click();
    await expect.poll(() => urls.length).toBe(2);
    expect(urls[1]!.searchParams.get("query")).toBe("Bridal gowns");
    expect(urls[1]!.searchParams.has("previousQuery")).toBe(false);
    await expect(input(page)).toHaveValue("Bridal gowns");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
}

test("no reading chip when the response carries no second reading", async ({ page }) => {
  await page.goto("/try");
  await submit(page, "refine black dress");
  await expect(chips(page)).toHaveCount(1);
  await expect(reading(page)).toHaveCount(0);
});
