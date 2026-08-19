import { expect, test, type Page } from "@playwright/test";

// Theme-native result rendering (YOY-70 spike), driven against the
// Dawn-shaped harness page theme-native.html: Variant A (alternate-template
// fetch), Variant B (harvest-clone), the composite (previews are the
// theme's on the native path — YOY-101), the fallback path, the dev flag,
// and the flag-off invariant. Every submitted search here goes through the
// full pipeline (fill + Enter; the flag-off case stretches the preview
// debounce past the test timeout).
//
// The native view is a full-page mirror (YOY-100): the results section sits
// inside the theme's own search-results page (fetched from the stubbed
// `/search?q=*`), the origin page's main content is hidden, and the URL is
// the theme's search URL — see the "full-page mirror" block below.

// The header's search input — the origin page's; the mirrored search page
// adds the template's own input inside main.
const themeInput = (page: Page) => page.locator('input[type="search"]').first();
const panel = (page: Page) => page.getByTestId("unfiltered-native-results");
const shellNodes = (page: Page) => page.locator("[data-unfiltered-mirror]");
const originHidden = (page: Page) =>
  page.locator("[data-unfiltered-origin-hidden]");
const themeCount = (page: Page) => page.getByTestId("theme-results-count");
const mirrorState = (page: Page) =>
  page.evaluate(() => window.history.state as unknown);
const items = (page: Page) => page.getByTestId("unfiltered-native-item");
const nativeChips = (page: Page) => page.getByTestId("unfiltered-native-chip");
const overlay = (page: Page) => page.getByTestId("unfiltered-widget-overlay");
const overlayCards = (page: Page) => page.getByTestId("unfiltered-widget-card");

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

const altTemplateRequests = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __altTemplateRequests: unknown[] })
        .__altTemplateRequests,
  );

const timing = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __unfilteredNativeTiming: Record<string, unknown> })
        .__unfilteredNativeTiming,
  );

/**
 * Record every moment the shadow overlay's panel is not hidden, from before
 * the widget mounts (YOY-106 AC-2: "never becomes visible at any point").
 * The shadow root is open, so the panel is reachable from the page; a
 * mutation observer on its `hidden` attribute catches a flash too short for
 * a Playwright assertion to land on.
 */
async function watchOverlayVisibility(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorder = window as unknown as { __overlayVisible: number };
    recorder.__overlayVisible = 0;
    const watch = (): void => {
      const root = document.querySelector(
        '[data-testid="unfiltered-widget-root"]',
      );
      const found = root?.shadowRoot?.querySelector(
        '[data-testid="unfiltered-widget-overlay"]',
      );
      if (!(found instanceof HTMLElement)) {
        requestAnimationFrame(watch);
        return;
      }
      const record = (): void => {
        if (!found.hidden) {
          recorder.__overlayVisible += 1;
        }
      };
      record();
      new MutationObserver(record).observe(found, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    };
    requestAnimationFrame(watch);
  });
}

const overlayEverVisible = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __overlayVisible: number }).__overlayVisible,
  );

const clickBeacons = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("harness:clickBeacons") ?? "[]"),
  );

test("flag off: the shadow overlay renders exactly as before and no native panel exists (NG-1/NG-2)", async ({
  page,
}) => {
  await page.goto("/theme-native.html?debounce=30000");

  await submitQuery(page, "runner");
  await expect(overlayCards(page)).toHaveCount(3);
  await expect(panel(page)).toHaveCount(0);
  expect(await altTemplateRequests(page)).toEqual([]);
  // No mirror either (YOY-100 AC-5): no shell fetch, origin content shown,
  // URL and history untouched.
  expect(await page.evaluate(() => (window as unknown as { __shellRequests: unknown[] }).__shellRequests)).toEqual([]);
  await expect(shellNodes(page)).toHaveCount(0);
  await expect(originHidden(page)).toHaveCount(0);
  await expect(page.getByTestId("theme-grid")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/theme-native.html");
  expect(await mirrorState(page)).toBeNull();
});

test.describe("Variant A — alternate-template fetch (AC-1)", () => {
  test("submitted results render as the theme's own cards inside main, in the theme grid", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&debounce=30000");

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);

    // The panel is light DOM inside the theme's main content — inside the
    // mirrored search page's results container (YOY-100) — marked A.
    await expect(panel(page)).toHaveAttribute("data-variant", "A");
    await expect(
      page.locator(
        "main#MainContent [data-unfiltered-mirror] #product-grid > section.unfiltered-native",
      ),
    ).toHaveCount(1);
    await expect(page.getByTestId("unfiltered-native-list")).toHaveClass(
      /product-grid/,
    );
    await expect(items(page).first()).toHaveClass(/grid__item/);

    // Each item holds the markup the alternate template returned — the
    // theme's card snippet, not widget markup — linking to the product.
    for (const index of [0, 1, 2]) {
      await expect(
        items(page).nth(index).locator(".card-wrapper[data-alt-template]"),
      ).toHaveCount(1);
    }
    await expect(items(page).nth(0).locator(".card__heading a")).toHaveText(
      "Nike Air 90",
    );
    await expect(items(page).nth(0).locator(".card__heading a")).toHaveAttribute(
      "href",
      "/products/nike-air-90",
    );
    await expect(items(page).nth(2).locator(".card__badge .badge")).toHaveText(
      "Sold out",
    );
    await expect(panel(page)).toHaveAttribute("data-native-count", "3");
    await expect(panel(page)).toHaveAttribute("data-fallback-count", "0");

    // One alternate-template fetch per result, against the configured view.
    expect(await altTemplateRequests(page)).toEqual([
      { handle: "nike-air-90", view: "unfiltered-card" },
      { handle: "runner-range", view: "unfiltered-card" },
      { handle: "sold-out-boot", view: "unfiltered-card" },
    ]);

    // The shadow overlay is closed: the two surfaces never show together.
    await expect(overlay(page)).toBeHidden();
  });

  test("the fetched card's stylesheet is hoisted into <head> once and its scripts never run", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&debounce=30000");

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);

    // theme-card.css is already the page's stylesheet: the three fetched
    // copies dedupe against it — one link total, none inside the cards.
    await expect(
      page.locator('head link[rel="stylesheet"][href*="theme-card.css"]'),
    ).toHaveCount(1);
    await expect(items(page).locator("link")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __altTemplateScriptRan?: boolean }).__altTemplateScriptRan,
      ),
    ).toBeUndefined();
  });

  test("host CSS styles the injected cards (theme-native by construction)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&debounce=30000");

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);

    // The harness theme CSS gives .card a rounded grey background; the
    // injected card picks it up because it lives in the host document.
    const themeCard = page.getByTestId("theme-grid").locator(".card").first();
    const injectedCard = items(page).first().locator(".card");
    const style = (locator: typeof themeCard) =>
      locator.evaluate((element) => {
        const computed = getComputedStyle(element);
        return [computed.backgroundColor, computed.borderRadius];
      });
    expect(await style(injectedCard)).toEqual(await style(themeCard));
  });

  test("template missing on the theme: every result falls back to a plain card, still functional", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&template=missing&debounce=30000",
    );

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);
    await expect(items(page).nth(0)).toHaveAttribute("data-fallback", "true");
    await expect(
      items(page).nth(0).locator(".unfiltered-native__fallback"),
    ).toHaveAttribute("href", "/products/nike-air-90");
    await expect(items(page).nth(0)).toContainText("Nike Air 90");
    await expect(panel(page)).toHaveAttribute("data-fallback-count", "3");
  });

  test("clicking a native card fires the attribution beacon and navigates (YOY-48 AC-5)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&debounce=30000");

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);

    await items(page).nth(1).locator("a").first().click();
    await page.waitForURL("**/products/runner-range");
    expect(await clickBeacons(page)).toEqual([
      {
        searchId: "harness-search-1",
        sessionId: expect.any(String),
        productId: "gid://shopify/Product/2",
        position: 1,
      },
    ]);
  });

  test("AI response: chips render in the panel, chip removal re-renders and reuses cached cards (AC-4c)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");

    await submitQuery(page, "blue dress under 400");
    await expect(items(page)).toHaveCount(3);
    await expect(nativeChips(page)).toHaveCount(3);
    await expect(nativeChips(page).nth(1)).toContainText("Under 400");
    // Color truthfulness carries onto native cards (YOY-67 AC-5).
    await expect(items(page).nth(2)).toHaveClass(/color-unknown/);
    await expect(items(page).nth(2)).toContainText("Color not confirmed");
    expect(await altTemplateRequests(page)).toHaveLength(3);

    await nativeChips(page).filter({ hasText: "Under 400" }).click();
    await expect(items(page)).toHaveCount(4);
    await expect(nativeChips(page)).toHaveCount(2);
    await expect(items(page).nth(3)).toContainText("Unfiltered By Removal");

    // Three of the four cards came from the per-handle cache: only the new
    // product cost a fetch.
    expect(await altTemplateRequests(page)).toHaveLength(4);
    expect(await timing(page)).toMatchObject({
      variant: "A",
      native: 4,
      fallback: 0,
      cached: 3,
    });
  });

  test("AI zero hit: the zero-hit state and close matches render natively", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&fixture=ai-zero-hit&debounce=30000",
    );

    await submitQuery(page, "blue dress under 400");
    await expect(page.getByTestId("unfiltered-native-zero-hit")).toBeVisible();
    await expect(
      page.getByTestId("unfiltered-native-close-matches"),
    ).toBeVisible();
    await expect(
      page.getByTestId("unfiltered-native-close-matches").locator(".card-wrapper"),
    ).toHaveCount(1);
  });
});

test.describe("Variant B — harvest-clone (AC-2)", () => {
  test("results render as clones of the theme's harvested card, refilled with our data", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=B&debounce=30000");

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);
    await expect(panel(page)).toHaveAttribute("data-variant", "B");
    // No alternate-template traffic at all — pure DOM.
    expect(await altTemplateRequests(page)).toEqual([]);

    // The clone is the harvested card's structure with our data filled in.
    const first = items(page).nth(0);
    await expect(first.locator(".card-wrapper.product-card-wrapper")).toHaveCount(1);
    await expect(first.locator(".card__heading a")).toHaveText("Nike Air 90");
    await expect(first.locator(".card__heading a")).toHaveAttribute(
      "href",
      "/products/nike-air-90",
    );
    await expect(first.locator(".card__media img")).toHaveAttribute(
      "alt",
      "Nike Air 90",
    );
    await expect(first.locator(".card__media img")).not.toHaveAttribute(
      "srcset",
      /.+/,
    );
    await expect(
      first.locator(".price__regular .price-item--regular"),
    ).toHaveText("100 ILS");
    // The harvested compare-at price is blanked, never leaked onto our card.
    await expect(first.locator("s.price-item")).toHaveText("");

    // Second result: no image → the media image is dropped; price range.
    const second = items(page).nth(1);
    await expect(second.locator(".card__media img")).toHaveCount(0);
    await expect(second.locator(".card__heading a")).toHaveText("Runner Range");
    await expect(
      second.locator(".price__regular .price-item--regular"),
    ).toHaveText("100–150 ILS");

    // Third: sold out badge from the widget's own strings.
    await expect(items(page).nth(2).locator(".card__badge .badge")).toHaveText(
      "Sold out",
    );

    // The grid classes are the theme's SEARCH page list's (3-col in the
    // harness shell), not the harvest page's 4-col collection grid: the
    // mirror's list wins over the harvest (YOY-100).
    await expect(page.getByTestId("unfiltered-native-list")).toHaveClass(
      /grid--3-col-desktop/,
    );
    await expect(panel(page)).toHaveAttribute("data-native-count", "3");
  });

  test("harvested ids are made unique across clones and the harvested page (no duplicate ids)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=B&debounce=30000");

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);

    const duplicates = await page.evaluate(() => {
      const seen = new Map<string, number>();
      document.querySelectorAll("[id]").forEach((element) => {
        seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
      });
      return [...seen.entries()].filter(([, count]) => count > 1);
    });
    expect(duplicates).toEqual([]);
    // aria references follow the rewritten ids.
    const link = items(page).nth(0).locator(".card__heading a");
    const id = await link.getAttribute("id");
    expect(id).toMatch(/^CardLink--1001--unf\d+$/);
    await expect(link).toHaveAttribute("aria-labelledby", new RegExp(`^${id} `));
  });

  test("harvest page without a recognizable card: every result falls back to a plain card", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=B&harvest=missing&debounce=30000",
    );

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);
    await expect(items(page).nth(0)).toHaveAttribute("data-fallback", "true");
    await expect(panel(page)).toHaveAttribute("data-fallback-count", "3");
  });
});

test.describe("composite: previews are the theme's, submits go native (YOY-101)", () => {
  test("typing renders nothing of ours and sends no preview request; Enter renders natively; Escape closes the view", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&debounce=20");
    const searchRequests = () =>
      page.evaluate(
        () =>
          (window as unknown as { __searchRequests: { mode?: string }[] })
            .__searchRequests,
      );

    // Native mode: keystroke previews ride the theme's own predictive
    // search (YOY-101 AC-1/AC-3) — the owned preview box never appears and
    // no debounced request leaves for the proxy.
    await themeInput(page).fill("run");
    await page.waitForTimeout(200);
    await expect(overlay(page)).toBeHidden();
    await expect(overlayCards(page)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    expect(await searchRequests()).toEqual([]);

    await themeInput(page).press("Enter");
    await expect(items(page)).toHaveCount(3);
    await expect(overlay(page)).toBeHidden();
    expect(await searchRequests()).toHaveLength(1);
    expect((await searchRequests())[0].mode).toBeUndefined();

    // Typing on the results view — the native view is a page (YOY-100), it
    // stays until the shopper leaves it — still previews nothing of ours.
    await themeInput(page).fill("runn");
    await page.waitForTimeout(200);
    await expect(overlay(page)).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await expect(items(page)).toHaveCount(3);
    expect(await searchRequests()).toHaveLength(1);

    await themeInput(page).press("Enter");
    await expect(items(page)).toHaveCount(3);
    expect(await searchRequests()).toHaveLength(2);
    await themeInput(page).press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();
  });

  test("no owned buttons above the results: a new query from the theme's input replaces the view, Escape closes it (YOY-82 AC-1)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");

    await submitQuery(page, "blue dress");
    await expect(items(page)).toHaveCount(3);
    await expect(nativeChips(page)).toHaveCount(3);
    // The Mirror Bar leaves only chips and status text as owned chrome:
    // no New search, no × — and no owned <button> at all outside the chips.
    await expect(page.getByTestId("unfiltered-native-new-search")).toHaveCount(0);
    await expect(page.getByTestId("unfiltered-native-close")).toHaveCount(0);
    await expect(
      panel(page).locator("button:not([data-testid='unfiltered-native-chip'])"),
    ).toHaveCount(0);

    // "New search" rides the theme's own input: editing it and submitting
    // replaces the view's results in place.
    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);
    await expect(themeCount(page)).toHaveText("3 results found for “runner”");
    // Chips are still removable filters (W-7): removing one re-renders.
    await nativeChips(page).first().click();
    await expect(nativeChips(page)).toHaveCount(2);
    await expect(items(page)).toHaveCount(4);

    // "Close" rides Escape (and Back, covered by the mirror block below).
    await themeInput(page).press("Escape");
    await expect(panel(page)).toBeHidden();
  });

  test("chips wear the host's button geometry through the configured custom properties, with neutral fallbacks (YOY-82 AC-2)", async ({
    page,
  }) => {
    // The Dawn-shaped harness exposes --buttons-radius / --buttons-border-width.
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");
    await submitQuery(page, "blue dress");
    await expect(nativeChips(page)).toHaveCount(3);
    const chipStyle = () =>
      nativeChips(page)
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            radius: style.borderTopLeftRadius,
            borderWidth: style.borderTopWidth,
            fontFamily: style.fontFamily,
            color: style.color,
            background: style.backgroundColor,
            borderColor: style.borderTopColor,
          };
        });
    const host = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return { fontFamily: style.fontFamily, color: style.color };
    });
    const themed = await chipStyle();
    expect(themed.radius).toBe("4px");
    expect(themed.borderWidth).toBe("2px");
    // Typography and color inherited from the host, no fill, border in the
    // host's text color (currentColor) — no palette of our own (W-3/W-4).
    expect(themed.fontFamily).toBe(host.fontFamily);
    expect(themed.color).toBe(host.color);
    expect(themed.borderColor).toBe(host.color);
    expect(themed.background).toBe("rgba(0, 0, 0, 0)");

    // A theme exposing neither property: the neutral fallbacks apply.
    await page.addStyleTag({
      content: ":root { --buttons-radius: initial; --buttons-border-width: initial; }",
    });
    const neutral = await chipStyle();
    expect(neutral.radius).toBe("999px");
    expect(neutral.borderWidth).toBe("1px");
  });

  test("a failed submitted search resolves to a quiet no-results state on the surface that showed loading", async ({
    page,
  }) => {
    // Before the panel ever opened, loading and the failure both live on
    // the overlay (YOY-61 AC-4 unchanged); no native panel is mounted.
    await page.goto("/theme-native.html?native=A&fixture=error&debounce=30000");
    await submitQuery(page, "runner");
    await expect(page.getByTestId("unfiltered-widget-no-results")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);

    // With the panel open, a failed refinement resolves inside the panel.
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");
    await submitQuery(page, "blue dress");
    await expect(items(page)).toHaveCount(3);
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = (input, init) =>
        String(typeof input === "string" ? input : (input as Request).url).startsWith(
          "/apps/unfiltered/search",
        )
          ? Promise.resolve(new Response(null, { status: 500 }))
          : original(input, init);
    });
    await nativeChips(page).first().click();
    await expect(page.getByTestId("unfiltered-native-no-results")).toBeVisible();
    await expect(items(page)).toHaveCount(0);
    await expect(overlay(page)).toBeHidden();
  });
});

test.describe("the loading surface is the theme's, not ours (YOY-106)", () => {
  test("the first search loads inside the native surface and the overlay never becomes visible across the lifecycle (AC-1, AC-2)", async ({
    page,
  }) => {
    await watchOverlayVisibility(page);
    await page.goto(
      "/theme-native.html?native=A&fixture=ai&searchDelay=700&debounce=30000",
    );
    await expect(page.getByTestId("theme-grid")).toBeVisible();

    // First search of the session, from a page whose results view is not
    // open: before YOY-106 this rendered the loading state in the owned
    // white overlay panel — a Mirror Bar violation for the whole wait.
    await submitQuery(page, "blue dress under 400");
    await expect(page.getByTestId("unfiltered-native-loading")).toBeVisible();
    // The theme's own results page IS the loading surface: the origin
    // content is already gone and the URL already names this query.
    await expect(page.getByTestId("theme-grid")).toBeHidden();
    await expect(overlay(page)).toBeHidden();
    await expect(page.getByTestId("unfiltered-widget-loading")).toBeHidden();
    expect(new URL(page.url()).searchParams.get("q")).toBe(
      "blue dress under 400",
    );

    await expect(items(page)).toHaveCount(3);
    await expect(page.getByTestId("unfiltered-native-loading")).toBeHidden();

    // A chip edit reloads inside the same native view.
    await nativeChips(page).filter({ hasText: "Under 400" }).click();
    await expect(page.getByTestId("unfiltered-native-loading")).toBeVisible();
    await expect(items(page)).toHaveCount(4);

    // As does a second submitted query from the theme's input.
    await submitQuery(page, "runner");
    await expect(page.getByTestId("unfiltered-native-loading")).toBeVisible();
    await expect(items(page)).toHaveCount(3);

    expect(await overlayEverVisible(page)).toBe(0);
  });

  test("a first search that fails still resolves quietly on the overlay, and the view it entered is withdrawn (NG-2)", async ({
    page,
  }) => {
    // Failure routing is untouched by YOY-106: the native view entered for
    // the loading state leaves again, exactly as if it had never been.
    await page.goto(
      "/theme-native.html?native=A&fixture=error&searchDelay=300&debounce=30000",
    );
    await submitQuery(page, "runner");
    await expect(page.getByTestId("unfiltered-native-loading")).toBeVisible();

    await expect(page.getByTestId("unfiltered-widget-no-results")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByTestId("theme-grid")).toBeVisible();
  });

  test("Back during a search cancels it: the late response never pulls the shopper into the view they left", async ({
    page,
  }) => {
    // The view is entered from the loading state now, so Back is available
    // mid-search — and must mean what it means everywhere else.
    await page.goto(
      "/theme-native.html?native=A&fixture=ai&searchDelay=1500&debounce=30000",
    );
    await submitQuery(page, "blue dress under 400");
    await expect(page.getByTestId("unfiltered-native-loading")).toBeVisible();

    await page.goBack();
    await expect(page.getByTestId("theme-grid")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);

    // Long enough for the abandoned response to land: it renders nothing,
    // takes no history entry, and leaves the origin page alone.
    await page.waitForTimeout(2000);
    await expect(panel(page)).toHaveCount(0);
    await expect(overlay(page)).toBeHidden();
    await expect(originHidden(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/theme-native.html");
  });

  test("native off: the overlay is the loading surface exactly as before (AC-3)", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&unfiltered_native=off&fixture=ai&searchDelay=700&debounce=30000",
    );

    await submitQuery(page, "blue dress under 400");
    await expect(page.getByTestId("unfiltered-widget-loading")).toBeVisible();
    await expect(overlay(page)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);

    await expect(overlayCards(page)).toHaveCount(3);
    await expect(page.getByTestId("unfiltered-widget-loading")).toBeHidden();
    await expect(page.getByTestId("theme-grid")).toBeVisible();
  });
});

test.describe("full-page mirror — the theme's own search page (YOY-100)", () => {
  test("after a submit the view is the theme's search page holding our results; origin content is absent (AC-1, AC-2, AC-7)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");
    await expect(page.getByTestId("theme-grid")).toBeVisible();

    await submitQuery(page, "blue dress under 400");
    await expect(items(page)).toHaveCount(3);

    // The theme's search page furniture is on the page: its heading, its
    // own template search input carrying the query, its count line — the
    // theme's wording and markup, OUR count and the shopper's query.
    await expect(page.getByTestId("theme-search-heading")).toBeVisible();
    await expect(page.getByTestId("theme-search-heading")).toHaveText(
      "Search results",
    );
    await expect(page.locator("#Search-In-Template")).toHaveValue(
      "blue dress under 400",
    );
    await expect(themeCount(page)).toBeVisible();
    await expect(themeCount(page)).toHaveText(
      "3 results found for “blue dress under 400”",
    );
    // Chips above the grid, inside the theme's results container.
    await expect(nativeChips(page)).toHaveCount(3);
    await expect(
      page.locator(
        "#product-grid > section.unfiltered-native [data-testid='unfiltered-native-chips'] ~ [data-testid='unfiltered-native-list']",
      ),
    ).toHaveCount(1);
    // The theme's grid classes come from the search page's list.
    await expect(page.getByTestId("unfiltered-native-list")).toHaveClass(
      /grid--3-col-desktop/,
    );

    // Nothing of the origin page is visible: every main-content child of
    // the origin is hidden in place (never removed), the theme's own
    // featured grid included.
    await expect(page.getByTestId("theme-grid")).toBeHidden();
    await expect(page.getByTestId("theme-grid")).toHaveCount(1);
    await expect(originHidden(page)).toHaveCount(
      await page.evaluate(
        () =>
          [...document.querySelector("main#MainContent")!.children].filter(
            (child) => !child.hasAttribute("data-unfiltered-mirror"),
          ).length,
      ),
    );
    await expect(page.locator("main#MainContent h1:visible")).toHaveText([
      "Search results",
    ]);

    // The theme's own hits for the shell fetch never survive, and neither
    // do the furniture pieces that only make sense against them; the
    // fetched page's scripts never ran.
    await expect(page.getByTestId("theme-search-grid")).toHaveCount(0);
    await expect(page.getByText("Theme Own Hit")).toHaveCount(0);
    await expect(page.getByTestId("theme-facets")).toHaveCount(0);
    await expect(page.getByTestId("theme-sorting")).toHaveCount(0);
    await expect(page.getByTestId("theme-pagination")).toHaveCount(0);
    await expect(page.getByTestId("theme-loading-overlay")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __shellScriptRan?: boolean }).__shellScriptRan,
      ),
    ).toBeUndefined();

    // One shell fetch — the theme's search page for the every-product term,
    // products only — cached for the page view.
    expect(
      await page.evaluate(
        () => (window as unknown as { __shellRequests: unknown[] }).__shellRequests,
      ),
    ).toEqual([{ q: "*", type: "product" }]);

    // URL state: the theme's own search URL for the query, under the
    // mirror's history entry (AC-4).
    const url = new URL(page.url());
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("blue dress under 400");
    expect(await mirrorState(page)).toEqual({ unfilteredNativeMirror: true });
  });

  test("a refinement and a second query update the same view in place: count line follows, one history entry, one shell fetch (AC-2, AC-3, AC-4)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");
    await submitQuery(page, "blue dress under 400");
    await expect(items(page)).toHaveCount(3);

    // Chip removal: same query, our new count.
    await nativeChips(page).filter({ hasText: "Under 400" }).click();
    await expect(items(page)).toHaveCount(4);
    await expect(themeCount(page)).toHaveText(
      "4 results found for “blue dress under 400”",
    );
    expect(new URL(page.url()).searchParams.get("q")).toBe(
      "blue dress under 400",
    );

    // A second query, submitted from the mirrored page's OWN template
    // input this time (the /search-origin case): identical outcome, URL
    // updated in place, no second shell fetch, no second history entry.
    const templateInput = page.locator("#Search-In-Template");
    await templateInput.fill("runner");
    await templateInput.press("Enter");
    await expect(themeCount(page)).toHaveText("3 results found for “runner”");
    await expect(items(page)).toHaveCount(3);
    await expect(page.locator("#Search-In-Template")).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("q")).toBe("runner");
    expect(
      await page.evaluate(
        () => (window as unknown as { __shellRequests: unknown[] }).__shellRequests,
      ),
    ).toHaveLength(1);

    // One Back leaves the results view straight to the origin page.
    await page.goBack();
    await expect(page.getByTestId("theme-grid")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/theme-native.html");
  });

  test("Back returns to the page the shopper searched from, Forward re-enters the results view; Escape leaves it and pops the entry (AC-4)", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");
    await submitQuery(page, "blue dress under 400");
    await expect(items(page)).toHaveCount(3);
    await expect(page.getByTestId("theme-grid")).toBeHidden();

    await page.goBack();
    // Same document, no reload: the origin's content is back exactly (the
    // hidden markers are gone), the mirror's nodes are out of the page.
    await expect(page.getByTestId("theme-grid")).toBeVisible();
    await expect(shellNodes(page)).toHaveCount(0);
    await expect(originHidden(page)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/theme-native.html");
    expect(await mirrorState(page)).toBeNull();
    // The widget survived: still bound (placeholder), still the same page.
    await expect(themeInput(page)).toHaveAttribute("placeholder", /.+/);

    await page.goForward();
    await expect(items(page)).toHaveCount(3);
    await expect(page.getByTestId("theme-grid")).toBeHidden();
    await expect(themeCount(page)).toHaveText(
      "3 results found for “blue dress under 400”",
    );
    expect(new URL(page.url()).pathname).toBe("/search");

    // Escape leaves the results view: origin back, entry popped.
    await themeInput(page).focus();
    await themeInput(page).press("Escape");
    await expect(page.getByTestId("theme-grid")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/theme-native.html");

    // And again via Back — the close affordance under the Mirror Bar
    // (YOY-82 AC-1: no owned close control on the view).
    await submitQuery(page, "blue dress under 400");
    await expect(items(page)).toHaveCount(3);
    expect(new URL(page.url()).pathname).toBe("/search");
    await page.goBack();
    await expect(page.getByTestId("theme-grid")).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/theme-native.html");
    await expect(originHidden(page)).toHaveCount(0);
  });

  test("the outcome is identical whichever input the search came from — header modal or in-page form (AC-3)", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&fixture=ai&multi=1&debounce=30000",
    );
    // From the header modal.
    await page.getByTestId("header-search-summary").click();
    const modalInput = page.locator("#Search-In-Modal");
    await modalInput.fill("blue dress under 400");
    await modalInput.press("Enter");
    await expect(items(page)).toHaveCount(3);
    const fromModal = {
      heading: await page.getByTestId("theme-search-heading").textContent(),
      count: await themeCount(page).textContent(),
      url: page.url(),
      originVisible: await page.getByTestId("theme-grid").isVisible(),
      listClass: await page.getByTestId("unfiltered-native-list").getAttribute("class"),
    };
    // Modal closed and dim gone (YOY-99) — the results page stands alone.
    await expect(page.locator("details[data-section='header']")).not.toHaveAttribute("open", /.*/);

    // Fresh page, from the in-page form.
    await page.goto(
      "/theme-native.html?native=A&fixture=ai&multi=1&debounce=30000",
    );
    const inPage = page.locator("#Search-In-Page");
    await inPage.fill("blue dress under 400");
    await inPage.press("Enter");
    await expect(items(page)).toHaveCount(3);
    expect({
      heading: await page.getByTestId("theme-search-heading").textContent(),
      count: await themeCount(page).textContent(),
      url: page.url(),
      originVisible: await page.getByTestId("theme-grid").isVisible(),
      listClass: await page.getByTestId("unfiltered-native-list").getAttribute("class"),
    }).toEqual(fromModal);
    expect(fromModal.originVisible).toBe(false);
  });

  test("shell unavailable: the bare section shows in the theme's main content, origin still hidden, functional always", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&fixture=ai&shell=missing&debounce=30000",
    );
    await submitQuery(page, "blue dress under 400");
    await expect(items(page)).toHaveCount(3);
    await expect(nativeChips(page)).toHaveCount(3);
    await expect(shellNodes(page)).toHaveCount(0);
    await expect(page.getByTestId("theme-grid")).toBeHidden();
    await expect(page.locator("main#MainContent > section.unfiltered-native")).toHaveCount(1);
    await expect(panel(page)).toHaveClass(/page-width/);
    expect(new URL(page.url()).pathname).toBe("/search");

    await page.goBack();
    await expect(page.getByTestId("theme-grid")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test("a slow shell never delays the view: it enters bare and the theme's page wraps the results when the shell lands", async ({
    page,
  }) => {
    await page.goto(
      "/theme-native.html?native=A&fixture=ai&shellDelay=1500&debounce=30000",
    );
    await submitQuery(page, "blue dress under 400");
    // Loading shows in the theme's main content while the shell and cards
    // are in flight — the origin content is already gone.
    await expect(page.getByTestId("unfiltered-native-loading")).toBeVisible();
    await expect(page.getByTestId("theme-grid")).toBeHidden();
    await expect(items(page)).toHaveCount(3);
    await expect(shellNodes(page).first()).toBeAttached();
    await expect(themeCount(page)).toHaveText(
      "3 results found for “blue dress under 400”",
    );
  });

  test("a results-view URL loaded fresh (reload, or Back from a product page) re-runs its query (AC-4)", async ({
    page,
  }) => {
    // The mirror's history entry survives a reload of its URL; without the
    // widget's own DOM the query is re-run from the URL. Simulated on the
    // harness URL itself, since the harness has no server route at /search.
    await page.goto("/theme-native.html?native=A&fixture=ai&q=blue+dress+under+400&debounce=30000");
    await expect(panel(page)).toHaveCount(0);
    await page.evaluate(() =>
      window.history.replaceState({ unfilteredNativeMirror: true }, "", window.location.href),
    );
    await page.reload();
    await expect(items(page)).toHaveCount(3);
    await expect(themeCount(page)).toHaveText(
      "3 results found for “blue dress under 400”",
    );
    await expect(themeInput(page)).toHaveValue("blue dress under 400");
    // Re-entered in place: no extra history entry stacked on the reload.
    expect(new URL(page.url()).pathname).toBe("/search");
    expect(await mirrorState(page)).toEqual({ unfilteredNativeMirror: true });

    // The same URL WITHOUT the mirror's state is the theme's own page: the
    // widget does nothing on load.
    await page.goto("/theme-native.html?native=A&fixture=ai&q=runner&debounce=30000");
    await page.waitForTimeout(300);
    await expect(panel(page)).toHaveCount(0);
    await expect(overlay(page)).toBeHidden();
  });
});

test.describe("dev flag (spike-only)", () => {
  test("?unfiltered_native=B turns native rendering on without any config and persists for the session; off clears it", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?unfiltered_native=B&debounce=30000");
    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);
    await expect(panel(page)).toHaveAttribute("data-variant", "B");

    // Same session, no param: still on.
    await page.goto("/theme-native.html?debounce=30000");
    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);

    // The URL flag overrides an init config, and `off` clears everything.
    await page.goto("/theme-native.html?native=A&unfiltered_native=off&debounce=30000");
    await submitQuery(page, "runner");
    await expect(overlayCards(page)).toHaveCount(3);
    await expect(panel(page)).toHaveCount(0);
  });
});

// Design-gate evidence (YOY-70 AC-5, YOY-100 AC-7): the mirrored search
// page holding our results — desktop and mobile, LTR and RTL — for both
// variants. Theme-native page content (shell, cards) is judged against the
// theme's own rendering, chips and status text against the W-* invariants
// (YOY-82: no owned bar above the results).
for (const variant of ["A", "B"] as const) {
  for (const locale of ["en", "he"] as const) {
    test(`Variant ${variant} panel beside the theme grid matches the ${locale} desktop baseline`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(
        `/theme-native.html?native=${variant}&fixture=ai&locale=${locale}&debounce=30000`,
      );
      await submitQuery(page, "blue dress under 400");
      await expect(items(page)).toHaveCount(3);
      await expect(nativeChips(page)).toHaveCount(3);
      await expect(panel(page)).toHaveAttribute(
        "dir",
        locale === "he" ? "rtl" : "ltr",
      );
      // The theme's count line in the theme's own language, our count and
      // the shopper's query rewritten mid-sentence (YOY-100 AC-2).
      await expect(themeCount(page)).toHaveText(
        locale === "he"
          ? "נמצאו 3 תוצאות עבור “blue dress under 400”"
          : "3 results found for “blue dress under 400”",
      );
      await expect(page.locator("main#MainContent")).toHaveScreenshot(
        `native-${variant}-${locale}-desktop.png`,
      );
    });
  }

  test(`Variant ${variant} panel matches the mobile baseline`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/theme-native.html?native=${variant}&fixture=ai&debounce=30000`,
    );
    await submitQuery(page, "blue dress under 400");
    await expect(items(page)).toHaveCount(3);
    await expect(page.locator("main#MainContent")).toHaveScreenshot(
      `native-${variant}-en-mobile.png`,
    );
  });
}
