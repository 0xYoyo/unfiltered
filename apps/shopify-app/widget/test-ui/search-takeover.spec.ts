import { expect, test, type Page } from "@playwright/test";

// Theme search takeover + instant classic results (YOY-48), driven against
// the harness fixtures. Each AC's verify steps live here as assertions.

const themeInput = (page: Page) => page.getByPlaceholder("Theme search");
const overlay = (page: Page) => page.getByTestId("unfiltered-widget-overlay");
const cards = (page: Page) => page.getByTestId("unfiltered-widget-card");

test("focusing or typing opens the overlay and suppresses native search while open (AC-1)", async ({
  page,
}) => {
  await page.goto("/");

  await themeInput(page).focus();
  await expect(overlay(page)).toBeVisible();

  await themeInput(page).fill("nike");
  await expect(cards(page).first()).toBeVisible();

  // Enter must NOT navigate to the theme's /search while the overlay is open.
  await themeInput(page).press("Enter");
  await page.waitForTimeout(200);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(overlay(page)).toBeVisible();
});

test("a failing search endpoint degrades silently: no error UI, native search restored (AC-2)", async ({
  page,
}) => {
  await page.goto("/?fixture=error");

  await themeInput(page).fill("nike");
  // The widget removes itself entirely — no overlay, no error message.
  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(0);

  // Native search now behaves exactly as without the app.
  await themeInput(page).press("Enter");
  await page.waitForURL(/\/search\?/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("nike");
});

test("a timed-out search endpoint degrades the same way (AC-2)", async ({
  page,
}) => {
  await page.goto("/?fixture=timeout");

  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(0, {
    timeout: 5000,
  });

  await themeInput(page).press("Enter");
  await page.waitForURL(/\/search\?/);
});

test("typing renders cards: image, placeholder, title, price range, sold-out (AC-3)", async ({
  page,
}) => {
  await page.goto("/");

  await themeInput(page).fill("nike");
  await expect(cards(page)).toHaveCount(3);

  // The request carried the query and a per-session sessionId.
  const requests = await page.evaluate(
    () =>
      (window as unknown as { __searchRequests: unknown[] }).__searchRequests,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ query: "nike" });
  const sessionId = (requests[0] as { sessionId: string }).sessionId;
  expect(sessionId.length).toBeGreaterThan(0);

  const first = cards(page).nth(0);
  await expect(first.locator("img")).toBeVisible();
  await expect(first).toContainText("Nike Air 90");
  await expect(first).toContainText("100 ILS");

  // imageUrl null → placeholder element, and a price range for min ≠ max.
  const second = cards(page).nth(1);
  await expect(second.locator(".card-image-placeholder")).toBeVisible();
  await expect(second).toContainText("100–150 ILS");

  const third = cards(page).nth(2);
  await expect(third).toContainText("Sold out");

  // The same session reuses one sessionId per browser session (NG-4).
  await themeInput(page).fill("nike again");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { __searchRequests: { sessionId: string }[] })
            .__searchRequests.length,
      ),
    )
    .toBe(2);
  const secondRequest = await page.evaluate(
    () =>
      (window as unknown as { __searchRequests: { sessionId: string }[] })
        .__searchRequests[1],
  );
  expect(secondRequest.sessionId).toBe(sessionId);
});

test("a loading indicator shows while in flight and is gone when cards render (AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=delayed");

  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeHidden();
});

test("instant classic responses replace the indicator with cards (AC-4)", async ({
  page,
}) => {
  await page.goto("/");

  await themeInput(page).fill("nike");
  await expect(cards(page).first()).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeHidden();
});

test("clicking a card fires the beacon and navigates to the product (AC-5)", async ({
  page,
}) => {
  await page.goto("/");

  await themeInput(page).fill("nike");
  await cards(page).first().click();

  await page.waitForURL(/\/products\/nike-air-90/);

  // The beacon log survives navigation in sessionStorage.
  const beacons = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("harness:clickBeacons") ?? "[]"),
  );
  expect(beacons).toHaveLength(1);
  expect(beacons[0]).toMatchObject({
    searchId: "harness-search-1",
    productId: "gid://shopify/Product/1",
    position: 0,
  });
  expect(beacons[0].sessionId.length).toBeGreaterThan(0);
});

test("navigation proceeds even when the beacon endpoint is absent (AC-5)", async ({
  page,
}) => {
  await page.goto("/?fixture=beacon-missing");

  await themeInput(page).fill("nike");
  await cards(page).first().click();

  await page.waitForURL(/\/products\/nike-air-90/);
});

test("close control and Escape both dismiss; reopening retains the query (AC-6)", async ({
  page,
}) => {
  await page.goto("/");

  await themeInput(page).fill("nike");
  await expect(cards(page).first()).toBeVisible();

  await page.getByTestId("unfiltered-widget-close").click();
  await expect(overlay(page)).toBeHidden();

  // Refocus reopens with the query text still in the input.
  await themeInput(page).focus();
  await expect(overlay(page)).toBeVisible();
  await expect(themeInput(page)).toHaveValue("nike");
  await expect(cards(page).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();
  await expect(themeInput(page)).toHaveValue("nike");
});

test("hostile host CSS cannot break the overlay, and widget CSS does not leak out (AC-7)", async ({
  page,
}) => {
  await page.goto("/hostile-css.html");

  await themeInput(page).fill("nike");
  await expect(overlay(page)).toBeVisible();
  await expect(cards(page).first()).toBeVisible();

  // Typography inherits from the host page through the shadow boundary.
  const cardFont = await cards(page)
    .first()
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(cardFont).toContain("Georgia");
  const cardColor = await cards(page)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  expect(cardColor).toBe("rgb(20, 30, 40)");

  // The host element sharing the widget's "card" class name keeps its own
  // styling: the widget's border rule must not reach it.
  const hostCardBorder = await page
    .locator("#host-card")
    .evaluate((element) => getComputedStyle(element).borderTopWidth);
  expect(hostCardBorder).toBe("0px");
});

test("an empty classic result set renders a no-results message (AC-8)", async ({
  page,
}) => {
  await page.goto("/?fixture=empty");

  await themeInput(page).fill("nothing matches this");
  await expect(page.getByTestId("unfiltered-widget-no-results")).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-no-results")).toContainText(
    "No results",
  );
  await expect(cards(page)).toHaveCount(0);
});
