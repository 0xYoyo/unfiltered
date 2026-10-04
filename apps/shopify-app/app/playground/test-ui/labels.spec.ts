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
    ["Satin Slip Dress", "420 ILS, slightly over 400 ILS"],
    ["Silk Evening Dress", "640 ILS, over your 400 ILS"],
    ["Jersey Midi Dress", "no M — S, L in stock"],
    ["Linen Wrap Dress", "in linen, not silk"],
    ["Cotton Shirt Dress", "close match"],
  ],
  he: [
    ["Satin Slip Dress", "420 ILS, מעט מעל 400 ILS"],
    ["Silk Evening Dress", "640 ILS, מעל ה-400 ILS שביקשת"],
    ["Jersey Midi Dress", "אין M — יש S, L במלאי"],
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

test("verify 6: late labels fill reserved lines — one request, no card moves, order unchanged", async ({
  page,
}) => {
  const requests: URL[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/labels")) {
      requests.push(new URL(request.url()));
    }
  });
  await open(page, "en");
  await submit(page, "labels pending");
  await expect(cards(page)).toHaveCount(6);
  await expect(labels(page)).toHaveCount(0);
  // Every card on the page reserves its line while the labels are pending.
  await expect(page.locator("[data-label-slot]")).toHaveCount(6);

  const snapshot = () =>
    cards(page).evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          title: element.querySelector(".cardTitle")?.textContent,
          box: [box.x, box.y, box.width, box.height],
        };
      }),
    );
  const before = await snapshot();

  await expect(labels(page)).toHaveCount(5);
  const after = await snapshot();
  expect(after).toEqual(before);

  expect(requests).toHaveLength(1);
  expect(requests[0]!.searchParams.get("searchId")).toBe("fixture-labels-pending");
  expect(requests[0]!.searchParams.get("page")).toBe("1");
  await expect(card(page, "Satin Slip Dress").getByTestId("playground-card-label")).toHaveText(
    "420 ILS, slightly over 400 ILS",
  );
});

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
