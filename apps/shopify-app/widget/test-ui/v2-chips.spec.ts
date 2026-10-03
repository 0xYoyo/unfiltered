import { expect, test, type Locator, type Page } from "@playwright/test";

import { STRING_CATALOG } from "../src/strings";

/**
 * Engine v2 chips on both widget paths (YOY-149 AC-15 client half, AC-16).
 *
 * A v2 response echoes `intent: null` and carries chips of the v2 fields:
 * a price cap with the shopper's own number and its ISO currency, the size
 * as typed, availability, and one `exclude` field for any excluded term.
 * The widget labels them from its string catalog in EN and HE, marks an
 * `exclude` chip with the existing achromatic exclusion treatment (W-3),
 * renders them in the EXISTING owned chip row only on the theme-native
 * path (NG-6), and removes one by re-asking the same query with
 * `removedChips` — every chip removed in the chain, the new one included —
 * instead of `previousIntent`/`removeChip`.
 *
 * Harness fixtures: `?fixture=budget|exclude|size` (widget/index.html and
 * widget/theme-native.html).
 */

interface LoggedRequest {
  query: string;
  previousIntent?: unknown;
  removeChip?: unknown;
  removedChips?: Array<{ field: string; value: string }>;
  mode?: string;
  page?: number;
}

const themeInput = (page: Page) =>
  page.locator('input[type="search"]').first();
const overlayChips = (page: Page) => page.getByTestId("unfiltered-widget-chip");
const overlayCards = (page: Page) => page.getByTestId("unfiltered-widget-card");
const nativeChips = (page: Page) => page.getByTestId("unfiltered-native-chip");
const nativeItems = (page: Page) => page.getByTestId("unfiltered-native-item");
const nativePanel = (page: Page) =>
  page.getByTestId("unfiltered-native-results");

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

/** The submitted search requests the harness logged (previews excluded). */
async function submitted(page: Page): Promise<LoggedRequest[]> {
  const all = await page.evaluate(
    () =>
      (window as unknown as { __searchRequests: LoggedRequest[] })
        .__searchRequests,
  );
  return all.filter((request) => request.mode !== "preview");
}

const money = (locale: "en" | "he", amount: number) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: 0,
  }).format(amount);

async function borderWidth(locator: Locator): Promise<number> {
  return locator.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).borderTopWidth),
  );
}

async function decoration(locator: Locator): Promise<string> {
  return locator.evaluate(
    (element) => getComputedStyle(element).textDecorationLine,
  );
}

test.describe("overlay path", () => {
  test("verify 4: an exclude chip has the exclusion treatment (EN)", async ({
    page,
  }) => {
    await page.goto("/?fixture=exclude&debounce=30000");
    await submitQuery(page, "dress under 400 not black");
    await expect(overlayChips(page)).toHaveCount(2);

    const price = page.locator("[data-field='priceMax']");
    const excluded = page.locator("[data-field='exclude']");
    await expect(price).toContainText(`Under ${money("en", 400)}`);
    await expect(excluded).toHaveAttribute("data-chip-negated", "true");
    await expect(excluded.locator(".chip-negator")).toHaveText("Not");
    await expect(excluded.locator(".chip-value")).toHaveText("black");
    await expect(excluded).toHaveAttribute(
      "aria-label",
      STRING_CATALOG.en.removeFilter.replace("{label}", "Not black"),
    );

    // Heavier border than a plain chip, the value struck, the negator not.
    expect(await borderWidth(excluded)).toBeGreaterThan(
      await borderWidth(price),
    );
    expect(await decoration(excluded.locator(".chip-value"))).toContain(
      "line-through",
    );
    expect(await decoration(excluded.locator(".chip-negator"))).not.toContain(
      "line-through",
    );
  });

  test("verify 6: Hebrew chrome labels the v2 chips from the HE catalog, mirrored", async ({
    page,
  }) => {
    await page.goto("/?fixture=exclude&locale=he&debounce=30000");
    await submitQuery(page, "שמלה עד 400 לא שחור");
    await expect(overlayChips(page)).toHaveCount(2);

    await expect(page.getByTestId("unfiltered-widget-root")).toHaveAttribute(
      "dir",
      "rtl",
    );
    const price = page.locator("[data-field='priceMax']");
    const excluded = page.locator("[data-field='exclude']");
    await expect(price).toContainText(`עד ${money("he", 400)}`);
    await expect(excluded.locator(".chip-negator")).toHaveText(
      STRING_CATALOG.he.chipNegator,
    );
    // The excluded term as the Hebrew shopper typed it.
    await expect(excluded.locator(".chip-value")).toHaveText("שחור");
    await expect(excluded).toHaveAttribute(
      "aria-label",
      STRING_CATALOG.he.removeFilter.replace("{label}", "לא שחור"),
    );
    // Mirrored: the first chip sits to the right of the second.
    const first = await price.boundingBox();
    const second = await excluded.boundingBox();
    expect(first!.x).toBeGreaterThan(second!.x);
  });

  test("size and availability chips render in EN and HE", async ({ page }) => {
    await page.goto("/?fixture=size&debounce=30000");
    await submitQuery(page, "dress size m in stock");
    await expect(page.locator("[data-field='size']")).toContainText("Size M");
    await expect(page.locator("[data-field='availability']")).toContainText(
      "In stock",
    );

    await page.goto("/?fixture=size&locale=he&debounce=30000");
    await submitQuery(page, "שמלה מידה M במלאי");
    await expect(page.locator("[data-field='size']")).toContainText("מידה M");
    await expect(page.locator("[data-field='availability']")).toContainText(
      "במלאי",
    );
  });

  test("AC-15: removing v2 chips re-asks the same query with every removed chip", async ({
    page,
  }) => {
    await page.goto("/?fixture=exclude&debounce=30000");
    await submitQuery(page, "dress under 400 not black");
    await expect(overlayChips(page)).toHaveCount(2);
    await expect(overlayCards(page)).toHaveCount(2);

    await page.locator("[data-field='exclude']").click();
    await expect(page.locator("[data-field='exclude']")).toHaveCount(0);
    await expect(overlayChips(page)).toHaveCount(1);
    let requests = await submitted(page);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.query).toBe("dress under 400 not black");
    expect(requests[1]!.removedChips).toEqual([
      { field: "exclude", value: "black" },
    ]);
    expect(requests[1]!.previousIntent).toBeUndefined();
    expect(requests[1]!.removeChip).toBeUndefined();
    expect(requests[1]!.page).toBe(1);

    // The chain accumulates: the next removal carries both.
    await page.locator("[data-field='priceMax']").click();
    await expect(overlayChips(page)).toHaveCount(0);
    // The cap is gone, so the dearer product is back.
    await expect(overlayCards(page)).toHaveCount(3);
    requests = await submitted(page);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.removedChips).toEqual([
      { field: "exclude", value: "black" },
      { field: "priceMax", value: "400" },
    ]);

    // A search the shopper submits starts a new chain.
    await submitQuery(page, "dress under 400 not black");
    await expect(overlayChips(page)).toHaveCount(2);
    requests = await submitted(page);
    expect(requests).toHaveLength(4);
    expect(requests[3]!.removedChips).toBeUndefined();
  });

  test("v1 removal still sends removeChip with previousIntent", async ({
    page,
  }) => {
    await page.goto("/?fixture=ai&debounce=30000");
    await submitQuery(page, "elegant dress");
    await expect(overlayChips(page)).toHaveCount(3);
    await page.locator("[data-field='colorsExclude']").click();
    await expect(overlayChips(page)).toHaveCount(2);
    const requests = await submitted(page);
    expect(requests[1]!.removeChip).toEqual({
      field: "colorsExclude",
      value: "black",
    });
    expect(requests[1]!.previousIntent).toBeDefined();
    expect(requests[1]!.removedChips).toBeUndefined();
  });
});

test.describe("theme-native path", () => {
  /** Every owned element in the results section, by test id, cards aside. */
  async function ownedTestIds(page: Page): Promise<string[]> {
    return nativePanel(page).evaluate((section) =>
      [...section.querySelectorAll("[data-testid]")]
        .filter(
          (element) =>
            element.closest("[data-testid='unfiltered-native-item']") === null,
        )
        .map((element) => element.getAttribute("data-testid")!)
        .filter((id) => id !== "unfiltered-native-chip")
        .sort(),
    );
  }

  test("verify 5: a size chip renders in the owned chip row and nothing else is added", async ({
    page,
  }) => {
    // The owned chrome a v1 AI response produces, for comparison.
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");
    await submitQuery(page, "blue dress");
    await expect(nativeChips(page)).toHaveCount(3);
    await expect(nativeItems(page)).toHaveCount(3);
    const v1Owned = await ownedTestIds(page);

    await page.goto("/theme-native.html?native=A&fixture=size&debounce=30000");
    await submitQuery(page, "dress size m in stock");
    await expect(nativeChips(page)).toHaveCount(2);
    await expect(nativeItems(page)).toHaveCount(3);

    const size = page.locator(
      "[data-testid='unfiltered-native-chips'] > [data-field='size']",
    );
    await expect(size).toHaveCount(1);
    await expect(size).toContainText("Size M");
    await expect(
      page.locator(
        "[data-testid='unfiltered-native-chips'] > [data-field='availability']",
      ),
    ).toContainText("In stock");

    // No new owned control (NG-6): the same owned chrome as a v1 response,
    // and no owned button outside the chips beyond the theme cards' own.
    expect(await ownedTestIds(page)).toEqual(v1Owned);
    const panelButtons = await nativePanel(page)
      .locator("button:not([data-testid='unfiltered-native-chip'])")
      .count();
    const themeCardButtons = await nativeItems(page).locator("button").count();
    expect(panelButtons - themeCardButtons).toBe(0);
  });

  test("verify 6: Hebrew size chips come from the HE catalog, mirrored", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&fixture=size&locale=he&debounce=30000",
    );
    await submitQuery(page, "שמלה מידה M במלאי");
    await expect(nativeChips(page)).toHaveCount(2);
    const size = page.locator("[data-field='size']");
    const stock = page.locator("[data-field='availability']");
    await expect(size).toContainText(
      STRING_CATALOG.he.chipSize.replace("{value}", "M"),
    );
    await expect(stock).toContainText(STRING_CATALOG.he.chipInStock);
    const direction = await page
      .getByTestId("unfiltered-native-chips")
      .evaluate((element) => getComputedStyle(element).direction);
    expect(direction).toBe("rtl");
    const first = await size.boundingBox();
    const second = await stock.boundingBox();
    expect(first!.x).toBeGreaterThan(second!.x);
  });

  test("an exclude chip keeps the exclusion treatment in the theme", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&fixture=exclude&debounce=30000",
    );
    await submitQuery(page, "dress under 400 not black");
    await expect(nativeChips(page)).toHaveCount(2);
    const excluded = page.locator("[data-field='exclude']");
    await expect(excluded).toHaveAttribute("data-chip-negated", "true");
    await expect(
      excluded.locator(".unfiltered-native__chip-negator"),
    ).toHaveText("Not");
    expect(
      await decoration(excluded.locator(".unfiltered-native__chip-value")),
    ).toContain("line-through");
    expect(await borderWidth(excluded)).toBeGreaterThan(
      await borderWidth(page.locator("[data-field='priceMax']")),
    );
    await expect(page.locator("[data-field='priceMax']")).toContainText(
      `Under ${money("en", 400)}`,
    );
  });

  test("AC-15: removing a v2 chip on the native path re-asks with removedChips", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=size&debounce=30000");
    await submitQuery(page, "dress size m in stock");
    await expect(nativeChips(page)).toHaveCount(2);

    await page.locator("[data-field='size']").click();
    await expect(page.locator("[data-field='size']")).toHaveCount(0);
    await expect(nativeChips(page)).toHaveCount(1);
    const requests = await submitted(page);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.query).toBe("dress size m in stock");
    expect(requests[1]!.removedChips).toEqual([{ field: "size", value: "M" }]);
    expect(requests[1]!.previousIntent).toBeUndefined();
    expect(requests[1]!.removeChip).toBeUndefined();
    expect(requests[1]!.page).toBe(1);
  });
});
