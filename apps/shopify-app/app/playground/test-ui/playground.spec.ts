import { expect, test, type Page } from "@playwright/test";

import {
  PLAYGROUND_STRING_CATALOG,
  type PlaygroundLocale,
} from "../strings";

/**
 * The playground shell (YOY-92 AC-1, AC-3…AC-7), driven against the built
 * app in fixture mode. Every assertion below is one of the issue's "How to
 * verify" steps; the fixture is chosen by the query text.
 */

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };

const input = (page: Page) => page.getByTestId("playground-input");
const submit = (page: Page) => page.getByTestId("playground-submit");
const status = (page: Page) => page.getByTestId("playground-status");
const cards = (page: Page) => page.getByTestId("playground-card");
const strings = (locale: PlaygroundLocale) =>
  PLAYGROUND_STRING_CATALOG[locale];

/** Record every playground API request the page issues. */
async function recordSearchRequests(page: Page): Promise<string[]> {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/search")) {
      urls.push(request.url());
    }
  });
  return urls;
}

/** Submit through the full pipeline: type, then explicit Enter. */
async function submitQuery(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

test.describe("chrome language and direction (AC-3, verify 1)", () => {
  test("defaults to English, honours ?lang=he, and falls back to Accept-Language", async ({
    page,
    browser,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.goto("/?lang=he");
    await expect(page.locator("html")).toHaveAttribute("lang", "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const hebrew = await browser.newContext({ locale: "he-IL" });
    const hebrewPage = await hebrew.newPage();
    await hebrewPage.goto("/");
    await expect(hebrewPage.locator("html")).toHaveAttribute("lang", "he");
    await expect(hebrewPage.locator("html")).toHaveAttribute("dir", "rtl");
    await hebrew.close();
  });

  test("the toggle switches language and keeps the typed query (AC-3)", async ({
    page,
  }) => {
    await page.goto("/");
    await input(page).fill("linen");

    await page.getByTestId("playground-language-toggle").click();

    await expect(page.locator("html")).toHaveAttribute("lang", "he");
    await expect(input(page)).toHaveValue("linen");
    await expect(page.getByTestId("playground-language-toggle")).toHaveText(
      strings("he").languageToggleTarget,
    );
  });

  test("the page title and description come from the catalog (AC-1)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(strings("en").pageTitle);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      strings("en").metaDescription,
    );

    await page.goto("/?lang=he");
    await expect(page).toHaveTitle(strings("he").pageTitle);
  });

  test("the template marketing copy and login form are gone (AC-1)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator('form[action="/auth/login"]')).toHaveCount(0);
    await expect(page.locator('input[name="shop"]')).toHaveCount(0);
    await expect(page.getByText("[your app]")).toHaveCount(0);
  });
});

test.describe("the hero search bar (AC-4, verify 2)", () => {
  // The measured box is the field — the bar itself, borders included — not
  // the input inside it, which is shorter by the field's border.
  test("is 56px tall and above the fold on desktop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");

    const box = await page.locator(".searchField").boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBe(56);
    expect(box!.y + box!.height).toBeLessThan(DESKTOP.height);
  });

  test("is 48px tall and above the fold on mobile", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/");

    const box = await page.locator(".searchField").boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBe(48);
    expect(box!.y + box!.height).toBeLessThan(MOBILE.height);
  });

  test("borders 1px at rest and 2px accent when focused", async ({ page }) => {
    await page.goto("/");
    const field = page.locator(".searchField");

    const rest = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.borderTopWidth,
        color: style.borderTopColor,
      };
    });
    expect(rest.width).toBe("1px");

    await input(page).focus();
    await expect(field).toHaveCSS("border-top-width", "2px");
    // The border colour transitions over --motion-hover, so poll rather than
    // sampling mid-interpolation.
    await expect
      .poll(async () =>
        field.evaluate((element) => getComputedStyle(element).borderTopColor),
      )
      .not.toBe(rest.color);
  });

  test("the magnifier sits inside the field at the inline-end, mirrored under RTL", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");
    const field = await page.locator(".searchField").boundingBox();
    const ltr = await submit(page).boundingBox();
    expect(ltr!.x).toBeGreaterThan(field!.x + field!.width / 2);
    expect(ltr!.x + ltr!.width).toBeLessThanOrEqual(field!.x + field!.width + 1);

    await page.goto("/?lang=he");
    const rtlField = await page.locator(".searchField").boundingBox();
    const rtl = await submit(page).boundingBox();
    expect(rtl!.x).toBeLessThan(rtlField!.x + rtlField!.width / 2);
  });

  // Runs at BOTH viewports: the bar gets shorter on mobile but its type must
  // not drop below the display size (AC-4), and nothing else may reach it.
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
  test(`the input is the only display-size type on the page — ${device} (P-3, AC-4)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    await expect
      .poll(async () =>
        input(page).evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        ),
      )
      .toBeGreaterThanOrEqual(25);

    const oversized = await page.evaluate(() => {
      const found: string[] = [];
      document.querySelectorAll<HTMLElement>(".playground *").forEach((node) => {
        if (node.childElementCount > 0 && node.tagName !== "INPUT") {
          return;
        }
        const size = Number.parseFloat(getComputedStyle(node).fontSize);
        if (size >= 25) {
          found.push(`${node.tagName}.${node.className}`);
        }
      });
      return found;
    });
    expect(oversized).toEqual(["INPUT.searchInput"]);
  });
  }
});

test.describe("preview and submit (AC-5, verify 3)", () => {
  test("typing previews, Enter submits, and the input never moves", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const requests = await recordSearchRequests(page);
    await page.goto("/");

    // Focus first, then measure: focusing widens the field's border from 1px
    // to 2px by design (DESIGN §2), and F-8 is about state changes moving the
    // bar, not about the focus ring. Every measurement below is taken with
    // the input focused, exactly as a typing shopper sees it.
    await input(page).focus();
    const before = await input(page).boundingBox();

    await input(page).fill("dre");
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests[0]).toContain("mode=preview");
    await expect(cards(page)).toHaveCount(2);
    const during = await input(page).boundingBox();

    const previewCount = requests.length;
    await input(page).press("Enter");
    await expect.poll(() => requests.length).toBeGreaterThan(previewCount);
    expect(requests[requests.length - 1]).not.toContain("mode=preview");
    await expect(cards(page)).toHaveCount(4);

    const after = await input(page).boundingBox();
    expect(during).toEqual(before);
    expect(after).toEqual(before);
  });

  test("every request carries a per-tab sessionId (AC-5)", async ({ page }) => {
    const requests = await recordSearchRequests(page);
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    const sessionIds = requests.map((url) =>
      new URL(url).searchParams.get("sessionId"),
    );
    expect(sessionIds.every((id) => id !== null && id !== "")).toBe(true);
    expect(new Set(sessionIds).size).toBe(1);
  });

  test("results replace rather than stack (F-8, AC-5)", async ({ page }) => {
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);
    await submitQuery(page, "another dress");
    await expect(cards(page)).toHaveCount(4);
  });
});

test.describe("result cards (AC-6, verify 4)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);
  });

  test("render image, title, price, and a sold-out pill", async ({ page }) => {
    const first = cards(page).nth(0);
    await expect(first.locator("img")).toHaveCount(1);
    await expect(first).toContainText("Silk slip dress");
    await expect(first).toContainText("320 ILS");

    // Range price when the variants span prices.
    await expect(cards(page).nth(1)).toContainText("280–320 ILS");

    // Sold out pill only on the unavailable card.
    await expect(
      cards(page).nth(2).getByTestId("playground-card-soldout"),
    ).toBeVisible();
    await expect(
      cards(page).nth(0).getByTestId("playground-card-soldout"),
    ).toHaveCount(0);
  });

  test("a null imageUrl renders a neutral placeholder, not a broken image", async ({
    page,
  }) => {
    const last = cards(page).nth(3);
    await expect(last.locator("img")).toHaveCount(0);
    await expect(
      last.getByTestId("playground-card-placeholder"),
    ).toHaveCount(1);
  });

  test("cards link out in a new tab and fire one click beacon", async ({
    page,
  }) => {
    const beacons: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/playground/click")) {
        beacons.push(request.url());
      }
    });

    const link = cards(page).nth(0).locator("a");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute(
      "href",
      "https://example.test/products/silk-slip-dress",
    );

    // Open in this tab's context without navigating away from the page.
    await link.click({ modifiers: ["Shift"] });
    await expect.poll(() => beacons.length).toBe(1);
  });

  test("a clamped Latin title keeps its beginning under Hebrew chrome (X-7)", async ({
    page,
  }) => {
    // -webkit-line-clamp puts the ellipsis at the line's LOGICAL end, so
    // without a per-title direction a Latin title inside RTL chrome clamped
    // on its left: the visible text began "…eliberately long title so",
    // overwriting the title's start and hiding where it was actually cut.
    //
    // Asserted on the computed style rather than the text, because clamping
    // is purely visual — `textContent` holds the whole title either way, so
    // a text assertion would pass with the bug present. The HE results
    // baseline is the second half of this guard: it shows where the ellipsis
    // actually lands.
    await page.setViewportSize(DESKTOP);
    await page.goto("/?lang=he");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    const clamped = cards(page).nth(1).locator(".cardTitle");
    await expect(clamped).toHaveCSS("unicode-bidi", "plaintext");
  });

  test("a null-url card has no anchor at all", async ({ page }) => {
    await expect(cards(page).nth(3).locator("a")).toHaveCount(0);
  });

  test("the grid is two columns minimum on mobile", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const columns = await page
      .getByTestId("playground-grid")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      );
    expect(columns).toBeGreaterThanOrEqual(2);
  });
});

test.describe("states (AC-7, verify 5 and 6)", () => {
  test("initial shows a quiet hint and no cards", async ({ page }) => {
    await page.goto("/");
    await expect(status(page)).toHaveText(strings("en").initialHint);
    await expect(cards(page)).toHaveCount(0);
  });

  test("an empty result is one muted sentence and no cards", async ({
    page,
  }) => {
    await page.goto("/");
    await submitQuery(page, "empty");
    await expect(status(page)).toHaveText(strings("en").emptyResults);
    await expect(cards(page)).toHaveCount(0);
  });

  test("a failure keeps the previous results and says try again", async ({
    page,
  }) => {
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    await submitQuery(page, "error");
    await expect(status(page)).toHaveText(strings("en").requestFailed);
    // The previous results are still on screen (F-6, AC-7).
    await expect(cards(page)).toHaveCount(4);
  });

  test("loading is one status line and never a spinner (X-4)", async ({
    page,
  }) => {
    await page.goto("/");
    await input(page).fill("delayed");
    await input(page).press("Enter");

    await expect(status(page)).toHaveText(strings("en").loading);
    await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
    await expect(page.locator('[class*="spinner"]')).toHaveCount(0);

    await expect(cards(page)).toHaveCount(4);
  });

  test("the status line reserves its space so nothing moves (F-8)", async ({
    page,
  }) => {
    await page.goto("/");
    // Measured focused throughout, for the reason given in the preview spec.
    await input(page).focus();
    const before = await input(page).boundingBox();
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);
    expect(await input(page).boundingBox()).toEqual(before);
  });
});

test.describe("layout holds at every viewport (AC-4, F-5)", () => {
  // Regression: the app ships no global reset, so `.shell`'s inline padding
  // added to its 100% width and pushed 32px of the page off a 360px screen —
  // visible as a clipped header and a horizontally scrolling page, worst in
  // RTL. Nothing else on the page moved, which is exactly why it needs a
  // test rather than an eye.
  for (const [locale, path] of [
    ["en", "/"],
    ["he", "/?lang=he"],
  ] as const) {
    test(`never scrolls horizontally on a 360px screen — ${locale}`, async ({
      page,
    }) => {
      await page.setViewportSize(MOBILE);
      await page.goto(path);
      await submitQuery(page, "dress");
      await expect(cards(page)).toHaveCount(4);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }
});

test.describe("keyboard and focus (AC-7, verify 7)", () => {
  test("tab order reaches the input, magnifier, then a card link", async ({
    page,
  }) => {
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await input(page).focus();
    await page.keyboard.press("Tab");
    await expect(submit(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cards(page).nth(0).locator("a")).toBeFocused();
  });

  test("focused elements draw a visible ring", async ({ page }) => {
    await page.goto("/");
    await submit(page).focus();
    const outline = await submit(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.outlineWidth,
        style: style.outlineStyle,
      };
    });
    expect(outline.style).not.toBe("none");
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  });

  test("interactive controls meet the 44px hit target floor (F-3)", async ({
    page,
  }) => {
    await page.goto("/");
    for (const target of [
      submit(page),
      page.getByTestId("playground-language-toggle"),
    ]) {
      const box = await target.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
