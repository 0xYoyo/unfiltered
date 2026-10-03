import { expect, test, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG } from "../strings";

/**
 * Engine v2 chips in the playground (YOY-149 AC-15 client half, AC-16),
 * against the `v2-budget` fixture: a response with `intent: null` whose
 * chips are the v2 fields — a price cap carrying the shopper's number and
 * its ISO currency, the size as typed, availability, and an `exclude`.
 * Labels come from the widget's shared `chipLabel`; removal re-asks the same
 * query with `removedChips` (every chip removed in the chain) instead of
 * `previousIntent`/`removeChip`.
 */

const input = (page: Page) => page.getByTestId("playground-input");
const chips = (page: Page) => page.getByTestId("playground-chip");
const cards = (page: Page) => page.getByTestId("playground-card");

const QUERY = "budget dress under 400 size m in stock not black";

function recordSearchRequests(page: Page): URL[] {
  const urls: URL[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/search")) {
      urls.push(new URL(request.url()));
    }
  });
  return urls;
}

const submitted = (urls: URL[]) =>
  urls.filter((url) => url.searchParams.get("mode") !== "preview");

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

const money = (locale: "en" | "he", amount: number) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: 0,
  }).format(amount);

/** The first card's price as a number, whatever the currency formatting. */
async function firstCardPrice(page: Page): Promise<number> {
  const text = (await cards(page).first().innerText()).replace(/,/g, "");
  const numbers = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) =>
    Number(match[0]),
  );
  expect(numbers.length).toBeGreaterThan(0);
  return numbers[numbers.length - 1]!;
}

test("verify 2: the budget chip shows the number with its currency symbol, and the first card is under the cap", async ({
  page,
}) => {
  await page.goto("/try");
  await submit(page, QUERY);
  await expect(chips(page)).toHaveCount(4);

  const cap = page.locator("[data-testid='playground-chip'][data-field='priceMax']");
  await expect(cap).toHaveCount(1);
  await expect(cap).toContainText(`Under ${money("en", 400)}`);
  await expect(cap).toContainText("400");
  await expect(cap).toContainText("₪");
  expect(await firstCardPrice(page)).toBeLessThanOrEqual(400);

  // The other v2 fields, labelled in English.
  await expect(page.locator("[data-field='size']")).toContainText("Size M");
  await expect(page.locator("[data-field='availability']")).toContainText(
    "In stock",
  );
  const excluded = page.locator("[data-field='exclude']");
  await expect(excluded).toContainText("Not black");
  // The exclusion takes the playground's negation tint (P-9).
  await expect(excluded).toHaveAttribute("data-chip-negated", "true");
  await expect(excluded).toHaveClass(/chipNegated/);
  await expect(cap).not.toHaveClass(/chipNegated/);
});

test("verify 3: removing the chip sends one request with removedChips and the chip is gone", async ({
  page,
}) => {
  const urls = recordSearchRequests(page);
  await page.goto("/try");
  await submit(page, QUERY);
  await expect(chips(page)).toHaveCount(4);
  await expect(cards(page)).toHaveCount(3);

  await page.locator("[data-field='priceMax']").click();

  await expect(page.locator("[data-field='priceMax']")).toHaveCount(0);
  await expect(chips(page)).toHaveCount(3);
  // The cap is off, so the dearer product is back.
  await expect(cards(page)).toHaveCount(4);
  await expect.poll(() => submitted(urls).length).toBe(2);
  const removal = submitted(urls)[1]!;
  expect(removal.searchParams.get("query")).toBe(QUERY);
  expect(JSON.parse(removal.searchParams.get("removedChips") ?? "null")).toEqual(
    [{ field: "priceMax", value: "400" }],
  );
  expect(removal.searchParams.has("previousIntent")).toBe(false);
  expect(removal.searchParams.has("removeChip")).toBe(false);
  expect(removal.searchParams.get("page")).toBe("1");

  // The chain accumulates: a second removal carries both chips.
  await page.locator("[data-field='exclude']").click();
  await expect(page.locator("[data-field='exclude']")).toHaveCount(0);
  await expect.poll(() => submitted(urls).length).toBe(3);
  expect(
    JSON.parse(submitted(urls)[2]!.searchParams.get("removedChips") ?? "null"),
  ).toEqual([
    { field: "priceMax", value: "400" },
    { field: "exclude", value: "black" },
  ]);

  // A search the visitor submits starts a new chain.
  await submit(page, QUERY);
  await expect(chips(page)).toHaveCount(4);
  await expect.poll(() => submitted(urls).length).toBe(4);
  expect(submitted(urls)[3]!.searchParams.has("removedChips")).toBe(false);
});

test("verify 6: under ?lang=he the chips come from the HE catalog and the row is mirrored", async ({
  page,
}) => {
  await page.goto("/try?lang=he");
  await submit(page, QUERY);
  await expect(chips(page)).toHaveCount(4);

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const cap = page.locator("[data-field='priceMax']");
  await expect(cap).toContainText(`עד ${money("he", 400)}`);
  await expect(page.locator("[data-field='size']")).toContainText("מידה M");
  await expect(page.locator("[data-field='availability']")).toContainText(
    "במלאי",
  );
  await expect(page.locator("[data-field='exclude']")).toContainText("לא black");
  await expect(page.locator("[data-field='exclude']")).toHaveAttribute(
    "aria-label",
    PLAYGROUND_STRING_CATALOG.he.removeFilter.replace("{label}", "לא black"),
  );
  await expect(page.getByTestId("playground-chips")).toHaveAttribute(
    "aria-label",
    PLAYGROUND_STRING_CATALOG.he.appliedFilters,
  );

  // Mirrored: the first chip sits to the right of the second.
  const first = await chips(page).nth(0).boundingBox();
  const second = await chips(page).nth(1).boundingBox();
  expect(first!.x).toBeGreaterThan(second!.x);

  // Removal works the same in Hebrew chrome.
  await cap.click();
  await expect(page.locator("[data-field='priceMax']")).toHaveCount(0);
  await expect(chips(page)).toHaveCount(3);
});
