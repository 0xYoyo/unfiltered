import { expect, test, type Locator, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG } from "../strings";

/**
 * The label line on the playground card (YOY-151 AC-2, AC-3, AC-6, AC-8,
 * AC-9), against the fixtures `labels` (one card per template, plus one
 * that misses nothing), `label-too-long`, `label-overflow` and
 * `labels-pending` (fixture-mode.server.ts).
 *
 * Every test pins the grid's tracks at 180 px — the narrowest card the
 * grid draws (`--card-min-inline-size`) — so "fits the card" is proved at
 * the width where it is hardest.
 */

const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");
const labels = (page: Page) => page.getByTestId("playground-card-label");

const NARROWEST_CARD = 180;

async function pinNarrowestCards(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `.grid { grid-template-columns: repeat(auto-fill, ${NARROWEST_CARD}px) !important; }`,
  });
}

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

async function open(page: Page, locale: "en" | "he"): Promise<void> {
  await page.goto(locale === "en" ? "/try" : "/try?lang=he");
  await pinNarrowestCards(page);
}

const card = (page: Page, title: string): Locator =>
  cards(page).filter({ hasText: title });

const EXPECTED = {
  en: [
    ["Satin Slip Dress", "slightly over budget"],
    ["Silk Evening Dress", "over budget"],
    ["Jersey Midi Dress", "size M not in stock"],
    ["Linen Wrap Dress", "in linen, not silk"],
    ["Cotton Shirt Dress", "close match"],
  ],
  he: [
    ["Satin Slip Dress", "מעט מעל התקציב"],
    ["Silk Evening Dress", "מעל התקציב"],
    ["Jersey Midi Dress", "מידה M לא במלאי"],
    ["Linen Wrap Dress", "בlinen, לא silk"],
    ["Cotton Shirt Dress", PLAYGROUND_STRING_CATALOG.he.labelCloseMatch],
  ],
} as const;

for (const locale of ["en", "he"] as const) {
  test(`verify 2: every template shows under the price on a 180 px card (${locale})`, async ({
    page,
  }) => {
    await open(page, locale);
    await submit(page, "labels");
    await expect(cards(page)).toHaveCount(6);
    await expect(labels(page)).toHaveCount(5);

    for (const [title, text] of EXPECTED[locale]) {
      const target = card(page, title);
      expect((await target.boundingBox())!.width).toBeCloseTo(NARROWEST_CARD, 0);
      const label = target.getByTestId("playground-card-label");
      await expect(label).toBeVisible();
      await expect(label).toHaveText(text);
      // Directly under the price: the label is the price's next sibling,
      // and it starts below where the price ends.
      const previous = await label.evaluate(
        (element) => element.previousElementSibling?.className,
      );
      expect(previous).toBe("cardPrice");
      const priceBox = (await target.locator(".cardPrice").boundingBox())!;
      const labelBox = (await label.boundingBox())!;
      expect(labelBox.y).toBeGreaterThanOrEqual(priceBox.y + priceBox.height - 0.5);
      // One line, inside the card: never wrapped, never clipped.
      const { scroll, client } = await label.evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(client);
    }
    // A product that misses nothing has no label line at all.
    await expect(
      card(page, "Crepe Shift Dress").locator(".cardLabel"),
    ).toHaveCount(0);
  });
}

test("AC-3: the label is --text-muted at --size-caption, one line, with no fill or border", async ({
  page,
}) => {
  await open(page, "en");
  await submit(page, "labels");
  await expect(labels(page)).toHaveCount(5);
  const style = await labels(page)
    .first()
    .evaluate((element) => {
      const computed = getComputedStyle(element);
      const probe = document.createElement("span");
      probe.style.color = "var(--text-muted)";
      probe.style.fontSize = "var(--size-caption)";
      document.body.append(probe);
      const tokens = getComputedStyle(probe);
      const expected = { color: tokens.color, fontSize: tokens.fontSize };
      probe.remove();
      return {
        color: computed.color,
        fontSize: computed.fontSize,
        whiteSpace: computed.whiteSpace,
        background: computed.backgroundColor,
        border: computed.borderTopWidth,
        expected,
      };
    });
  expect(style.color).toBe(style.expected.color);
  expect(style.fontSize).toBe(style.expected.fontSize);
  expect(style.whiteSpace).toBe("nowrap");
  expect(style.background).toBe("rgba(0, 0, 0, 0)");
  expect(style.border).toBe("0px");
});

test("verify 5: a label over its template's maximum is not shown", async ({
  page,
}) => {
  await open(page, "en");
  await submit(page, "label too long");
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, "Linen Wrap Dress").locator(".cardLabel")).toHaveCount(0);
  await expect(card(page, "Satin Slip Dress").getByTestId("playground-card-label")).toBeVisible();
});

test("AC-6: a label wider than its card is not shown — never truncated or wrapped", async ({
  page,
}) => {
  await open(page, "en");
  await submit(page, "label overflow");
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, "Satin Slip Dress").getByTestId("playground-card-label")).toBeVisible();
  await expect(card(page, "Wide Weave Dress").locator(".cardLabel")).toHaveCount(0);
});

test("AC-6: a dropped label stays dropped when the page re-renders", async ({
  page,
}) => {
  await open(page, "en");
  await submit(page, "label overflow");
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, "Wide Weave Dress").locator(".cardLabel")).toHaveCount(0);
  // The engine-details toggle re-renders the page and every card on it
  // without a new search: the verdict must survive, never come back clipped.
  for (let toggle = 0; toggle < 2; toggle += 1) {
    await page.getByTestId("playground-details-toggle").click();
    await expect(card(page, "Wide Weave Dress").locator(".cardLabel")).toHaveCount(0);
  }
  await expect(card(page, "Satin Slip Dress").getByTestId("playground-card-label")).toBeVisible();
});

test("verify 6: every card reserves its line while the late answer is pending", async ({
  page,
}) => {
  await open(page, "en");
  await submit(page, "labels pending");
  await expect(cards(page)).toHaveCount(6);
  await expect(labels(page)).toHaveCount(0);
  await expect(page.locator("[data-label-slot]")).toHaveCount(6);
});

test("YOY-171 AC-1: the late judged page replaces the find-order grid after one poll — judged order, not-relevant gone, close under the heading, scroll kept", async ({
  page,
}) => {
  const requests: URL[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/labels")) {
      requests.push(new URL(request.url()));
    }
  });
  // Short enough that the page scrolls, so a kept position is observable.
  await page.setViewportSize({ width: 420, height: 480 });
  await open(page, "en");
  await submit(page, "labels pending");
  const titles = () => cards(page).locator(".cardTitle").allTextContents();
  await expect(cards(page)).toHaveCount(6);
  expect(await titles()).toEqual([
    "Satin Slip Dress",
    "Silk Evening Dress",
    "Jersey Midi Dress",
    "Linen Wrap Dress",
    "Cotton Shirt Dress",
    "Crepe Shift Dress",
  ]);
  await page.evaluate(() => window.scrollTo({ top: 160 }));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);

  // One render: the judged page, the not-relevant card gone.
  await expect(cards(page)).toHaveCount(5);
  expect(await titles()).toEqual([
    "Crepe Shift Dress",
    "Silk Evening Dress",
    "Linen Wrap Dress",
    "Satin Slip Dress",
    "Cotton Shirt Dress",
  ]);
  await expect(card(page, "Jersey Midi Dress")).toHaveCount(0);
  // The close products sit under the heading, the first of them right after it.
  const divider = page.getByTestId("playground-close-matches-divider");
  await expect(divider).toHaveCount(1);
  await expect(
    page.locator("[data-testid='playground-close-matches-divider'] + [data-testid='playground-card']"),
  ).toContainText("Linen Wrap Dress");
  // Labels come with the page; under the heading `close-match` says nothing (YOY-168).
  await expect(card(page, "Silk Evening Dress").getByTestId("playground-card-label")).toHaveText("over budget");
  await expect(card(page, "Linen Wrap Dress").getByTestId("playground-card-label")).toHaveText(
    "in linen, not silk",
  );
  await expect(card(page, "Cotton Shirt Dress").getByTestId("playground-card-label")).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

  expect(requests).toHaveLength(1);
  expect(requests[0]!.searchParams.get("searchId")).toBe("fixture-labels-pending");
  expect(requests[0]!.searchParams.get("page")).toBe("1");
});

for (const locale of ["en", "he"] as const) {
  test(`YOY-171 AC-2: a stand-in sits after the judged cards and before the heading, saying it is not checked yet (${locale})`, async ({
    page,
  }) => {
    await open(page, locale);
    await submit(page, "unchecked dress");
    await expect(cards(page)).toHaveCount(5);
    expect(await cards(page).locator(".cardTitle").allTextContents()).toEqual([
      "Crepe Shift Dress",
      "Silk Evening Dress",
      "Jersey Midi Dress",
      "Linen Wrap Dress",
      "Cotton Shirt Dress",
    ]);
    await expect(card(page, "Jersey Midi Dress").getByTestId("playground-card-label")).toHaveText(
      PLAYGROUND_STRING_CATALOG[locale].labelUnchecked,
    );
    // The stand-in is the last card before the heading.
    await expect(
      page.locator("[data-testid='playground-card']:has(+ [data-testid='playground-close-matches-divider'])"),
    ).toContainText("Jersey Midi Dress");
  });
}

for (const locale of ["en", "he"] as const) {
  test(`YOY-171 AC-3: 24 cards with one label say it once above the grid, no card line; one card without it keeps every line (${locale})`, async ({
    page,
  }) => {
    await open(page, locale);
    const pageLabel = page.getByTestId("playground-page-label");
    await submit(page, "jacket under 30 same");
    await expect(cards(page)).toHaveCount(24);
    await expect(pageLabel).toHaveText(PLAYGROUND_STRING_CATALOG[locale].labelPriceFar);
    await expect(labels(page)).toHaveCount(0);
    // The line sits above the grid, in the page's direction.
    expect(
      await pageLabel.evaluate((element) => {
        const grid = document.querySelector('[data-testid="playground-grid"]')!;
        return {
          above: element.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top,
          direction: getComputedStyle(element).direction,
        };
      }),
    ).toEqual({ above: true, direction: locale === "he" ? "rtl" : "ltr" });

    await submit(page, "jacket under 30 same mixed");
    await expect(cards(page)).toHaveCount(24);
    await expect(pageLabel).toHaveCount(0);
    await expect(labels(page)).toHaveCount(23);
  });
}

test.describe("visual baselines", () => {
  for (const locale of ["en", "he"] as const) {
    test(`the labelled grid (${locale})`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page, locale);
      await submit(page, "labels");
      await expect(labels(page)).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByTestId("playground-grid")).toHaveScreenshot(
        `labels-grid-${locale}.png`,
      );
    });
  }
});
