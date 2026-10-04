import { expect, test, type Locator, type Page } from "@playwright/test";

import { STRING_CATALOG } from "../src/strings";

/**
 * The label line on both widget paths (YOY-151 AC-2, AC-4 – AC-9): one
 * quiet line under the overlay card's price, appended after the theme's
 * own card markup on the theme-native path, never truncated or wrapped,
 * absent on a storefront language with no templates, and — when the
 * response has `labelsPending` — filled late into lines every card already
 * reserved, so nothing moves and nothing re-orders.
 *
 * Harness fixtures (widget/index.html, widget/theme-native.html):
 * `?fixture=labels|label-too-long|label-overflow|labels-pending`; the
 * harness logs every labels request in `window.__labelsRequests`.
 */

const themeInput = (page: Page) =>
  page.locator('input[type="search"]').first();
const overlayCards = (page: Page) => page.getByTestId("unfiltered-widget-card");
const overlayLabels = (page: Page) =>
  page.getByTestId("unfiltered-widget-label");
const nativeItems = (page: Page) => page.getByTestId("unfiltered-native-item");

const NARROWEST_CARD = 180;

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

/**
 * Pin the overlay's grid tracks at 180 px, its narrowest card (the grid's
 * own `minmax(180px, 1fr)` floor), inside the shadow root where the
 * overlay's stylesheet lives.
 */
async function pinNarrowestCards(page: Page): Promise<void> {
  await page.evaluate((width) => {
    const root = document.querySelector(
      '[data-testid="unfiltered-widget-root"]',
    )?.shadowRoot;
    const style = document.createElement("style");
    style.textContent = `.grid { grid-template-columns: repeat(auto-fill, ${width}px) !important; }`;
    root?.appendChild(style);
  }, NARROWEST_CARD);
}

async function openOverlay(
  page: Page,
  fixture: string,
  locale: string,
): Promise<void> {
  await page.goto(`/?fixture=${fixture}&locale=${locale}&debounce=30000`);
  await pinNarrowestCards(page);
  await submitQuery(page, "dress under 400 size m");
}

const overlayCard = (page: Page, index: number): Locator =>
  page.locator(
    `[data-testid="unfiltered-widget-card"][data-product-id="gid://shopify/Product/label-${index}"]`,
  );

const nativeItem = (page: Page, index: number): Locator =>
  page.locator(
    `[data-testid="unfiltered-native-item"][data-product-id="gid://shopify/Product/label-${index}"]`,
  );

const EXPECTED = {
  en: [
    "420 ILS, slightly over 400 ILS",
    "640 ILS, over your 400 ILS",
    "no M — S, L in stock",
    "in linen, not silk",
    "close match",
  ],
  he: [
    "420 ILS, מעט מעל 400 ILS",
    "640 ILS, מעל ה-400 ILS שביקשת",
    "אין M — יש S, L במלאי",
    "בlinen, לא silk",
    STRING_CATALOG.he.labelCloseMatch,
  ],
} as const;

/** Every card's box and the product order, for the no-move assertions. */
async function layout(cards: Locator): Promise<unknown> {
  return cards.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        productId: element.getAttribute("data-product-id"),
        box: [box.x, box.y, box.width, box.height],
      };
    }),
  );
}

async function labelsRequests(page: Page): Promise<unknown[]> {
  return page.evaluate(
    () => (window as unknown as { __labelsRequests: unknown[] }).__labelsRequests,
  );
}

test.describe("overlay path", () => {
  for (const locale of ["en", "he"] as const) {
    test(`every template shows directly under the price on a 180 px card (${locale})`, async ({
      page,
    }) => {
      await openOverlay(page, "labels", locale);
      await expect(overlayCards(page)).toHaveCount(6);
      await expect(overlayLabels(page)).toHaveCount(5);
      for (const [index, text] of EXPECTED[locale].entries()) {
        const target = overlayCard(page, index + 1);
        expect((await target.boundingBox())!.width).toBeCloseTo(NARROWEST_CARD, 0);
        const label = target.getByTestId("unfiltered-widget-label");
        await expect(label).toBeVisible();
        await expect(label).toHaveText(text);
        expect(
          await label.evaluate((element) => element.previousElementSibling?.className),
        ).toBe("card-price");
        const fits = await label.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        );
        expect(fits).toBe(true);
      }
      // A product that misses nothing has no label line.
      await expect(overlayCard(page, 6).locator(".card-label")).toHaveCount(0);
    });
  }

  test("verify 3: the label is in the card's inherited colour, smaller and quieter than the price, with no border or fill", async ({
    page,
  }) => {
    await openOverlay(page, "labels", "en");
    await expect(overlayLabels(page)).toHaveCount(5);
    const styles = await overlayCard(page, 1).evaluate((card) => {
      const label = card.querySelector(".card-label")!;
      const price = card.querySelector(".card-price")!;
      const of = (element: Element) => getComputedStyle(element);
      return {
        cardColor: of(card).color,
        labelColor: of(label).color,
        border: of(label).borderTopWidth,
        background: of(label).backgroundColor,
        whiteSpace: of(label).whiteSpace,
        labelSize: Number.parseFloat(of(label).fontSize),
        priceSize: Number.parseFloat(of(price).fontSize),
        labelOpacity: Number(of(label).opacity),
        priceOpacity: Number(of(price).opacity),
        icons: label.querySelectorAll("svg, img").length,
      };
    });
    expect(styles.labelColor).toBe(styles.cardColor);
    expect(styles.border).toBe("0px");
    expect(styles.background).toBe("rgba(0, 0, 0, 0)");
    expect(styles.whiteSpace).toBe("nowrap");
    expect(styles.labelSize).toBeLessThan(styles.priceSize);
    expect(styles.labelOpacity).toBeLessThan(styles.priceOpacity);
    expect(styles.icons).toBe(0);
  });

  test("verify 5: a label over its template's maximum is not shown", async ({
    page,
  }) => {
    await openOverlay(page, "label-too-long", "en");
    await expect(overlayCards(page)).toHaveCount(2);
    await expect(overlayCard(page, 7).locator(".card-label")).toHaveCount(0);
    await expect(overlayLabels(page)).toHaveCount(1);
  });

  test("AC-6: a label wider than its card is not shown — never truncated or wrapped", async ({
    page,
  }) => {
    await openOverlay(page, "label-overflow", "en");
    await expect(overlayCards(page)).toHaveCount(2);
    await expect(overlayCard(page, 8).locator(".card-label")).toHaveCount(0);
    await expect(overlayLabels(page)).toHaveCount(1);
  });

  test("verify 6: late labels — one request, every card reserves its line, no card moves, order unchanged", async ({
    page,
  }) => {
    await openOverlay(page, "labels-pending", "en");
    await expect(overlayCards(page)).toHaveCount(6);
    await expect(page.locator("[data-testid='unfiltered-widget-root']").locator("[data-label-slot]")).toHaveCount(6);
    await expect(overlayLabels(page)).toHaveCount(0);
    const before = await layout(overlayCards(page));

    await expect(overlayLabels(page)).toHaveCount(5);
    expect(await layout(overlayCards(page))).toEqual(before);
    expect(await labelsRequests(page)).toEqual([
      { searchId: "harness-labels-pending-1", page: 1 },
    ]);
    await expect(overlayCard(page, 2).getByTestId("unfiltered-widget-label")).toHaveText(
      "640 ILS, over your 400 ILS",
    );
  });

  test("verify 7: a storefront locale with no templates shows no label", async ({
    page,
  }) => {
    await openOverlay(page, "labels", "fr");
    await expect(overlayCards(page)).toHaveCount(6);
    await expect(page.locator("[data-testid='unfiltered-widget-root']").locator(".card-label")).toHaveCount(0);
  });

  test("NG-2: keystroke previews carry no label", async ({ page }) => {
    await page.goto("/?fixture=labels&debounce=30");
    await themeInput(page).pressSequentially("dre");
    await expect(overlayCards(page)).not.toHaveCount(0);
    await expect(page.locator("[data-testid='unfiltered-widget-root']").locator(".card-label")).toHaveCount(0);
  });

  for (const locale of ["en", "he"] as const) {
    test(`visual baseline: the labelled overlay grid (${locale})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openOverlay(page, "labels", locale);
      await expect(overlayLabels(page)).toHaveCount(5);
      await expect(page.getByTestId("unfiltered-widget-results")).toHaveScreenshot(
        `labels-overlay-${locale}.png`,
      );
    });
  }
});

test.describe("theme-native path", () => {
  async function openNative(
    page: Page,
    fixture: string,
    locale = "en",
  ): Promise<void> {
    await page.goto(
      `/theme-native.html?native=A&fixture=${fixture}&locale=${locale}&debounce=30000`,
    );
    await submitQuery(page, "dress under 400 size m");
  }

  test("verify 4: each labelled item has exactly one added element, after the theme card", async ({
    page,
  }) => {
    await openNative(page, "labels");
    await expect(nativeItems(page)).toHaveCount(6);
    for (const [index, text] of EXPECTED.en.entries()) {
      const item = nativeItem(page, index + 1);
      const shape = await item.evaluate((element) => ({
        count: element.children.length,
        first: element.children[0]?.getAttribute("data-testid") ?? element.children[0]?.className,
        last: element.lastElementChild?.getAttribute("data-testid"),
        fallback: element.getAttribute("data-fallback"),
      }));
      // The theme's own card, then the label — nothing else of ours.
      expect(shape.fallback).toBeNull();
      expect(shape.count).toBe(2);
      expect(shape.last).toBe("unfiltered-widget-label");
      await expect(item.getByTestId("unfiltered-widget-label")).toHaveText(text);
    }
    // A product that misses nothing gets nothing added.
    expect(await nativeItem(page, 6).evaluate((element) => element.children.length)).toBe(1);
  });

  test("AC-5: the label is styled as on the overlay — inherited colour, quieter, no border or fill", async ({
    page,
  }) => {
    await openNative(page, "labels");
    await expect(nativeItems(page)).toHaveCount(6);
    const styles = await nativeItem(page, 1).evaluate((item) => {
      const label = item.querySelector(".unfiltered-native__label")!;
      const of = (element: Element) => getComputedStyle(element);
      return {
        itemColor: of(item).color,
        labelColor: of(label).color,
        border: of(label).borderTopWidth,
        background: of(label).backgroundColor,
        whiteSpace: of(label).whiteSpace,
        opacity: Number(of(label).opacity),
        labelSize: Number.parseFloat(of(label).fontSize),
        itemSize: Number.parseFloat(of(item).fontSize),
      };
    });
    expect(styles.labelColor).toBe(styles.itemColor);
    expect(styles.border).toBe("0px");
    expect(styles.background).toBe("rgba(0, 0, 0, 0)");
    expect(styles.whiteSpace).toBe("nowrap");
    expect(styles.opacity).toBeLessThan(1);
    expect(styles.labelSize).toBeLessThan(styles.itemSize);
  });

  test("Hebrew storefront: every template in Hebrew", async ({ page }) => {
    await openNative(page, "labels", "he");
    await expect(nativeItems(page)).toHaveCount(6);
    for (const [index, text] of EXPECTED.he.entries()) {
      await expect(
        nativeItem(page, index + 1).getByTestId("unfiltered-widget-label"),
      ).toHaveText(text);
    }
  });

  test("an over-length and an overflowing label are absent", async ({ page }) => {
    await openNative(page, "label-too-long");
    await expect(nativeItems(page)).toHaveCount(2);
    await expect(
      page.locator('[data-product-id="gid://shopify/Product/label-7"] .unfiltered-native__label'),
    ).toHaveCount(0);

    // A phone-width theme grid, where a theme card is narrowest.
    await page.setViewportSize({ width: 390, height: 844 });
    await openNative(page, "label-overflow");
    await expect(nativeItems(page)).toHaveCount(2);
    await expect(
      page.locator('[data-product-id="gid://shopify/Product/label-8"] .unfiltered-native__label'),
    ).toHaveCount(0);
    await expect(nativeItem(page, 5).getByTestId("unfiltered-widget-label")).toBeVisible();
  });

  test("late labels — one request, no item moves, order unchanged", async ({
    page,
  }) => {
    await openNative(page, "labels-pending");
    await expect(nativeItems(page)).toHaveCount(6);
    await expect(page.locator(".unfiltered-native__label[data-label-slot]")).toHaveCount(6);
    await expect(page.getByTestId("unfiltered-widget-label")).toHaveCount(0);
    const before = await layout(nativeItems(page));

    await expect(page.getByTestId("unfiltered-widget-label")).toHaveCount(5);
    expect(await layout(nativeItems(page))).toEqual(before);
    expect(await labelsRequests(page)).toEqual([
      { searchId: "harness-labels-pending-1", page: 1 },
    ]);
  });

  test("a storefront locale with no templates shows no label", async ({
    page,
  }) => {
    await openNative(page, "labels", "fr");
    await expect(nativeItems(page)).toHaveCount(6);
    await expect(page.locator(".unfiltered-native__label")).toHaveCount(0);
  });

  for (const locale of ["en", "he"] as const) {
    test(`visual baseline: the labelled theme grid (${locale})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openNative(page, "labels", locale);
      await expect(page.getByTestId("unfiltered-widget-label")).toHaveCount(5);
      await expect(page.getByTestId("unfiltered-native-list")).toHaveScreenshot(
        `labels-native-${locale}.png`,
      );
    });
  }
});
