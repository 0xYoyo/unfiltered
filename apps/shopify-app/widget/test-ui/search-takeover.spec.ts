import { expect, test, type Page } from "@playwright/test";

// Theme search takeover + instant classic results (YOY-48), driven against
// the harness fixtures. Each AC's verify steps live here as assertions.

// The widget owns the input's placeholder while active (YOY-50 AC-1), so
// tests locate the theme input structurally rather than by placeholder.
const themeInput = (page: Page) => page.locator('input[type="search"]');
const overlay = (page: Page) => page.getByTestId("unfiltered-widget-overlay");
const cards = (page: Page) => page.getByTestId("unfiltered-widget-card");
const noResults = (page: Page) =>
  page.getByTestId("unfiltered-widget-no-results");

/**
 * Run one search that the fixture will fail, deterministically: clearing the
 * input first resets the overlay to idle (hiding any earlier no-results
 * message), so the message reappearing proves THIS search's failure was
 * processed before the caller moves on.
 */
async function runFailingSearch(page: Page, query: string): Promise<void> {
  await themeInput(page).fill("");
  await expect(noResults(page)).toBeHidden();
  await themeInput(page).fill(query);
  await expect(noResults(page)).toBeVisible({ timeout: 5000 });
}

test("focus alone renders nothing; the first response opens the overlay and native search stays suppressed (AC-1, YOY-67 AC-6)", async ({
  page,
}) => {
  await page.goto("/");

  // Focusing the input renders no panel (YOY-67 AC-6): before any query
  // there is nothing to show, so the overlay stays hidden.
  await themeInput(page).focus();
  await page.waitForTimeout(100);
  await expect(overlay(page)).toBeHidden();

  await themeInput(page).fill("nike");
  await expect(cards(page).first()).toBeVisible();
  await expect(overlay(page)).toBeVisible();

  // Enter must NOT navigate to the theme's /search while the overlay is open.
  await themeInput(page).press("Enter");
  await page.waitForTimeout(200);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(overlay(page)).toBeVisible();
});

test("a single failed search resolves to a quiet no-results state and the widget stays alive (YOY-61 AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=error");

  await themeInput(page).fill("nike");
  // One failure never removes the widget: the loading state resolves to the
  // quiet no-results message, with no error language anywhere.
  await expect(noResults(page)).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(1);
  await expect(overlay(page)).toBeVisible();
});

test("repeated consecutive failures degrade silently: no error UI, native search restored (AC-2, YOY-61 AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=error");

  // Three consecutive hard failures are structural: the widget removes
  // itself entirely — no overlay, no error message — and hands the theme
  // back its own placeholder (YOY-50).
  await runFailingSearch(page, "nike");
  await runFailingSearch(page, "nike two");
  await themeInput(page).fill("");
  await themeInput(page).fill("nike three");
  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(0);
  await expect(themeInput(page)).toHaveAttribute("placeholder", "Theme search");

  // Native search now behaves exactly as without the app.
  await themeInput(page).press("Enter");
  await page.waitForURL(/\/search\?/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("nike three");
});

test("repeated timed-out searches degrade the same way (AC-2, YOY-61 AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=timeout");

  await runFailingSearch(page, "nike");
  await runFailingSearch(page, "nike two");
  await themeInput(page).fill("");
  await themeInput(page).fill("nike three");
  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(0, {
    timeout: 5000,
  });

  await themeInput(page).press("Enter");
  await page.waitForURL(/\/search\?/);
});

test("an over-timeout search leaves the widget functional for the next query (YOY-61 AC-4)", async ({
  page,
}) => {
  await page.goto("/?fixture=slow-then-fast");

  // First search outlives the timeout override: quiet fallback, no removal.
  await runFailingSearch(page, "nike");
  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(1);

  // The next search runs normally and renders cards.
  await themeInput(page).fill("nike again");
  await expect(cards(page).first()).toBeVisible();
  await expect(noResults(page)).toBeHidden();
});

test("the magnifier fires an immediate search, skipping the debounce, without navigating (YOY-52 AC-14)", async ({
  page,
}) => {
  // A debounce far beyond the test's own timeout: any search that lands
  // before it can only have come from the immediate path.
  await page.goto("/?debounce=30000");

  // The overlay has nothing to show yet (YOY-67 AC-6) — the magnifier must
  // still fire the widget search, not the theme's navigation.
  await themeInput(page).fill("nike");
  await expect(overlay(page)).toBeHidden();
  await page.locator('form[role="search"] button[type="submit"]').click();

  await expect(cards(page).first()).toBeVisible({ timeout: 5000 });
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(overlay(page)).toBeVisible();
});

test("Enter fires an immediate search the same way (YOY-52 AC-14)", async ({
  page,
}) => {
  await page.goto("/?debounce=30000");

  await themeInput(page).fill("nike");
  await themeInput(page).press("Enter");

  await expect(cards(page).first()).toBeVisible({ timeout: 5000 });
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(overlay(page)).toBeVisible();
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
  // Attribution belongs to submitted searches (YOY-68 AC-3): the beacon
  // test submits explicitly; the preview-click case is pinned in
  // preview-submit.spec.ts.
  await page.goto("/?debounce=30000");

  await themeInput(page).fill("nike");
  await themeInput(page).press("Enter");
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
  await page.goto("/?fixture=beacon-missing&debounce=30000");

  await themeInput(page).fill("nike");
  await themeInput(page).press("Enter");
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

  // Refocus alone no longer reopens (superseded by YOY-67 AC-6: nothing
  // renders until a query produces a response); the query text is retained
  // and continuing to type reopens from the new search's response.
  await themeInput(page).focus();
  await page.waitForTimeout(100);
  await expect(overlay(page)).toBeHidden();
  await expect(themeInput(page)).toHaveValue("nike");
  await themeInput(page).press("s");
  await expect(overlay(page)).toBeVisible();
  await expect(themeInput(page)).toHaveValue("nikes");
  await expect(cards(page).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();
  await expect(themeInput(page)).toHaveValue("nikes");
});

test("Escape before the debounce fires cancels the pending preview: no request, overlay stays hidden (YOY-69 AC-2)", async ({
  page,
}) => {
  // A debounce long enough to press Escape inside it, short enough that the
  // test can wait it out and prove the timer was cancelled, not just slow.
  await page.goto("/?fixture=delayed&debounce=500");

  await themeInput(page).fill("nike");
  await themeInput(page).press("Escape");

  // Past the debounce interval AND the fixture's response delay: had the
  // timer survived, a request would have fired and the overlay opened.
  await page.waitForTimeout(1200);
  await expect(overlay(page)).toBeHidden();
  const requests = await page.evaluate(
    () =>
      (window as unknown as { __searchRequests: unknown[] }).__searchRequests,
  );
  expect(requests).toHaveLength(0);
});

test("Escape while a request is in flight closes for good: the late response renders nothing (YOY-69 AC-2)", async ({
  page,
}) => {
  await page.goto("/?fixture=delayed");

  // The loading state proves the request is in flight and the overlay open.
  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeVisible();

  await themeInput(page).press("Escape");
  await expect(overlay(page)).toBeHidden();

  // The delayed response lands after ~500ms — it must not reopen anything.
  await page.waitForTimeout(900);
  await expect(overlay(page)).toBeHidden();
  await expect(cards(page)).toHaveCount(0);
});

test("the close control mid-flight cancels the same way (YOY-69 AC-2)", async ({
  page,
}) => {
  await page.goto("/?fixture=delayed");

  await themeInput(page).fill("nike");
  await expect(page.getByTestId("unfiltered-widget-loading")).toBeVisible();

  await page.getByTestId("unfiltered-widget-close").click();
  await expect(overlay(page)).toBeHidden();

  await page.waitForTimeout(900);
  await expect(overlay(page)).toBeHidden();
  await expect(cards(page)).toHaveCount(0);
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

test("an empty classic result set renders a no-results message on submit (AC-8)", async ({
  page,
}) => {
  // The flat no-results panel belongs to SUBMITTED searches (YOY-68 AC-4);
  // typing previews show the quiet empty state, pinned in
  // preview-submit.spec.ts.
  await page.goto("/?fixture=empty&debounce=30000");

  await themeInput(page).fill("nothing matches this");
  await themeInput(page).press("Enter");
  await expect(page.getByTestId("unfiltered-widget-no-results")).toBeVisible();
  await expect(page.getByTestId("unfiltered-widget-no-results")).toContainText(
    "No results",
  );
  await expect(cards(page)).toHaveCount(0);
});
