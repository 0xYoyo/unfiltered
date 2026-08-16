import { expect, test, type Page } from "@playwright/test";

// Theme-native result rendering (YOY-70 spike), driven against the
// Dawn-shaped harness page theme-native.html: Variant A (alternate-template
// fetch), Variant B (harvest-clone), the composite with the preview overlay,
// the fallback path, the dev flag, and the flag-off invariant. Every
// submitted search here goes through the full pipeline (fill + Enter with
// the preview debounce stretched past the test timeout).

const themeInput = (page: Page) => page.locator('input[type="search"]');
const panel = (page: Page) => page.getByTestId("unfiltered-native-results");
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
});

test.describe("Variant A — alternate-template fetch (AC-1)", () => {
  test("submitted results render as the theme's own cards inside main, in the theme grid", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&debounce=30000");

    await submitQuery(page, "runner");
    await expect(items(page)).toHaveCount(3);

    // The panel is light DOM inside the theme's main content, marked A.
    await expect(panel(page)).toHaveAttribute("data-variant", "A");
    await expect(page.locator("main#MainContent > section.unfiltered-native")).toHaveCount(1);
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

    // The harvested list's classes become the panel grid's classes.
    await expect(page.getByTestId("unfiltered-native-list")).toHaveClass(
      /grid--4-col-desktop/,
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

test.describe("composite: previews stay on the overlay, submits go native (NG-3)", () => {
  test("typing previews in the shadow overlay; Enter closes it and renders natively; Escape closes both", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&debounce=20");

    await themeInput(page).fill("run");
    await expect(overlayCards(page)).toHaveCount(3);
    await expect(overlay(page)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);

    await themeInput(page).press("Enter");
    await expect(items(page)).toHaveCount(3);
    await expect(overlay(page)).toBeHidden();

    // Typing again returns to a preview: native panel closes, overlay back.
    await themeInput(page).fill("runn");
    await expect(overlayCards(page)).toHaveCount(3);
    await expect(overlay(page)).toBeVisible();
    await expect(panel(page)).toBeHidden();

    await themeInput(page).press("Enter");
    await expect(items(page)).toHaveCount(3);
    await themeInput(page).press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();
  });

  test("New search clears the native panel; the close control closes it", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai&debounce=30000");

    await submitQuery(page, "blue dress");
    await expect(items(page)).toHaveCount(3);
    await page.getByTestId("unfiltered-native-new-search").click();
    await expect(items(page)).toHaveCount(0);
    await expect(nativeChips(page)).toHaveCount(0);
    await expect(themeInput(page)).toHaveValue("");

    await submitQuery(page, "blue dress");
    await expect(items(page)).toHaveCount(3);
    await page.getByTestId("unfiltered-native-close").click();
    await expect(panel(page)).toBeHidden();
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

// Design-gate evidence (AC-5): the native panel next to the theme's own grid
// — desktop and mobile, LTR and RTL — for both variants. Cloned-card
// fidelity is judged against the theme's rendering (the harness cards
// above the panel), chips and bar against the W-* invariants.
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
