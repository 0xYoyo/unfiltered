import { expect, test, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG } from "../strings";

/**
 * `/try?engine=v1|v2` (YOY-165): the page view asks every submitted
 * search, chip removal and page request for that engine, keystroke
 * previews never name one, and a muted badge near the search field says
 * which engine the page asked for. Fixture mode answers whatever engine is
 * asked, so these prove what the page SENDS and SHOWS; the server's engine
 * switch is the API's own contract.
 */

const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");
const badge = (page: Page) => page.getByTestId("playground-engine-badge");

/** The narrowest card the grid draws (`--card-min-inline-size`). */
const NARROWEST_CARD = 180;

function recordSearchRequests(page: Page): URL[] {
  const urls: URL[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/search")) {
      urls.push(new URL(request.url()));
    }
  });
  return urls;
}

const previews = (urls: URL[]) =>
  urls.filter((url) => url.searchParams.get("mode") === "preview");
const submitted = (urls: URL[]) =>
  urls.filter((url) => url.searchParams.get("mode") !== "preview");

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

for (const locale of ["en", "he"] as const) {
  test(`verify 1: the badge names the engine in the page's language at the narrowest card width (${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(
      locale === "en" ? "/try?engine=v1" : "/try?lang=he&engine=v1",
    );
    await page.addStyleTag({
      content: `.grid { grid-template-columns: repeat(auto-fill, ${NARROWEST_CARD}px) !important; }`,
    });
    await submit(page, "red dress");
    await expect(cards(page).first()).toBeVisible();

    const expected = PLAYGROUND_STRING_CATALOG[locale].engineBadge.replace(
      "{engine}",
      "v1",
    );
    await expect(badge(page)).toHaveText(expected);
    expect(expected).toBe(locale === "en" ? "Engine v1" : "מנוע v1");

    // It sits inside the search card, on one line, without overflowing it.
    const card = await page.getByTestId("playground-search-card").boundingBox();
    const box = await badge(page).boundingBox();
    expect(card).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(card!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width);
    expect(
      await badge(page).evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);

    // No colour of its own: the status line's muted ink and size (AC-2).
    const style = (selector: string) =>
      page.locator(selector).first().evaluate((element) => {
        const computed = getComputedStyle(element);
        return { color: computed.color, fontSize: computed.fontSize };
      });
    expect(await style("[data-testid='playground-engine-badge']")).toEqual(
      await style(".statusLine"),
    );
  });
}

test("verify 3: no engine in the URL shows no badge and sends no engine", async ({
  page,
}) => {
  const urls = recordSearchRequests(page);
  await page.goto("/try?engine=v3");
  await submit(page, "red dress");
  await expect(cards(page).first()).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  expect(submitted(urls).length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url.searchParams.has("engine")).toBe(false);
  }
});

test("a v1 page view sends engine=v1 on every submit and page request, and never on a preview (AC-1, AC-3)", async ({
  page,
}) => {
  const urls = recordSearchRequests(page);
  await page.goto("/try?engine=v1");
  await input(page).pressSequentially("paged dress", { delay: 30 });
  await expect.poll(() => previews(urls).length).toBeGreaterThan(0);
  await input(page).press("Enter");
  await expect(cards(page)).toHaveCount(24);

  await cards(page).last().scrollIntoViewIfNeeded();
  await expect(cards(page)).toHaveCount(30);

  const pages = submitted(urls).map((url) => [
    url.searchParams.get("page"),
    url.searchParams.get("engine"),
  ]);
  expect(pages).toEqual([
    ["1", "v1"],
    ["2", "v1"],
  ]);
  for (const url of previews(urls)) {
    expect(url.searchParams.has("engine")).toBe(false);
  }
});

test("verify 2: a v2 page view keeps engine=v2 through a chip removal, and the details panel names the engine that answered (AC-2, AC-3)", async ({
  page,
}) => {
  const urls = recordSearchRequests(page);
  await page.goto("/try?engine=v2&details=1");
  await expect(badge(page)).toHaveText("Engine v2");
  await submit(page, "budget dress under 400 size m in stock not black");
  await expect(page.getByTestId("playground-chip")).toHaveCount(4);

  const panel = page.getByTestId("playground-details-panel");
  await expect(
    panel.locator(".detailsRow").filter({ hasText: "Engine" }),
  ).toContainText("v2");

  await page.locator("[data-field='priceMax']").click();
  await expect(page.getByTestId("playground-chip")).toHaveCount(3);
  const removal = submitted(urls).at(-1)!;
  expect(removal.searchParams.has("removedChips")).toBe(true);
  expect(removal.searchParams.get("engine")).toBe("v2");
  for (const url of submitted(urls)) {
    expect(url.searchParams.get("engine")).toBe("v2");
  }
});

test("the engine survives a language switch and the details toggle's link", async ({
  page,
}) => {
  await page.goto("/try?engine=v1");
  const toggle = page.getByTestId("playground-language-toggle");
  expect(
    new URL((await toggle.getAttribute("href"))!, "http://x").searchParams.get(
      "engine",
    ),
  ).toBe("v1");
  await submit(page, "red dress");
  const details = page.getByTestId("playground-details-toggle");
  expect(
    new URL((await details.getAttribute("href"))!, "http://x").searchParams.get(
      "engine",
    ),
  ).toBe("v1");
});
