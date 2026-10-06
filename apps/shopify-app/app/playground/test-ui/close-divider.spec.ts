import { expect, test, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG } from "../strings";

/**
 * Close products under the divider (YOY-166 AC-2 to AC-4; verify 1, 2): a
 * judged page with matches shows its close products after its results,
 * under the "Close matches" heading, each still labelled; every appended
 * page repeats the heading under its own results. The `v2-close` fixture
 * ("divider …") is a 30-product order: page 1 holds 20 matches and 4 close
 * products, page 2 holds 4 matches and 2 close products. Run at a phone
 * width, where the divider must still span the whole two-column grid.
 */

const grid = (page: Page) => page.getByTestId("playground-grid");
const cards = (page: Page) => grid(page).getByTestId("playground-card");
const dividers = (page: Page) => grid(page).getByTestId("playground-close-matches-divider");

test.use({ viewport: { width: 390, height: 844 } });

for (const locale of ["en", "he"] as const) {
  const strings = PLAYGROUND_STRING_CATALOG[locale];
  const path = locale === "he" ? "/try?lang=he" : "/try";

  test(`a mixed page puts its close products under the divider, and the next page repeats it (${locale})`, async ({
    page,
  }) => {
    await page.goto(path);
    await page.getByTestId("playground-input").fill("divider red gown");
    await page.getByTestId("playground-input").press("Enter");
    await expect(cards(page)).toHaveCount(24);

    // One divider, between the 20 matches and the 4 close products.
    await expect(dividers(page)).toHaveCount(1);
    await expect(dividers(page)).toHaveText(strings.closeMatchesHeading);
    const items = grid(page).locator(":scope > *");
    await expect(items.nth(20)).toHaveAttribute(
      "data-testid",
      "playground-close-matches-divider",
    );
    for (let index = 0; index < 20; index += 1) {
      await expect(cards(page).nth(index)).toContainText("Red gown");
    }
    for (let index = 20; index < 24; index += 1) {
      const card = cards(page).nth(index);
      await expect(card).toContainText("Close dress");
      await expect(card.getByTestId("playground-card-label")).toHaveText(
        strings.labelCloseMatch,
      );
    }

    // The divider spans the grid: as wide as the grid itself, on its own row.
    const [dividerBox, gridBox, firstClose] = await Promise.all([
      dividers(page).boundingBox(),
      grid(page).boundingBox(),
      cards(page).nth(20).boundingBox(),
    ]);
    expect(Math.round(dividerBox!.width)).toBe(Math.round(gridBox!.width));
    expect(firstClose!.y).toBeGreaterThan(dividerBox!.y + dividerBox!.height - 1);

    // Page 2 appends its own matches, then its own divider and close products.
    await cards(page).last().scrollIntoViewIfNeeded();
    await expect(cards(page)).toHaveCount(30);
    await expect(dividers(page)).toHaveCount(2);
    await expect(items.nth(24 + 1 + 4)).toHaveAttribute(
      "data-testid",
      "playground-close-matches-divider",
    );
    await expect(cards(page).nth(27)).toContainText("Red gown 27");
    for (const index of [28, 29]) {
      await expect(cards(page).nth(index).getByTestId("playground-card-label")).toHaveText(
        strings.labelCloseMatch,
      );
    }

    // The zero-hit section below the grid is not used for a page with matches.
    await expect(page.locator(".closeMatches")).toHaveCount(0);
  });
}
