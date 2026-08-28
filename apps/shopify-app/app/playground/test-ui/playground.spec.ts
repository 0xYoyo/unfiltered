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
  test("is 60px tall and above the fold on desktop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");

    const box = await page.locator(".searchField").boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBe(60);
    expect(box!.y + box!.height).toBeLessThan(DESKTOP.height);
  });

  test("is 52px tall and above the fold on mobile", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/");

    const box = await page.locator(".searchField").boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBe(52);
    expect(box!.y + box!.height).toBeLessThan(MOBILE.height);
  });

  test("takes the accent border and the focus ring when focused (P-2)", async ({
    page,
  }) => {
    await page.goto("/");
    const field = page.locator(".searchField");

    const rest = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.borderTopWidth,
        color: style.borderTopColor,
        shadow: style.boxShadow,
      };
    });
    expect(rest.width).toBe("1px");
    expect(rest.shadow).toBe("none");

    await input(page).focus();
    // Both the border colour and the ring transition over --dur-fast, so
    // poll rather than sampling mid-interpolation.
    await expect
      .poll(async () =>
        field.evaluate((element) => getComputedStyle(element).borderTopColor),
      )
      .not.toBe(rest.color);
    await expect
      .poll(async () =>
        field.evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .not.toBe("none");
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

  // Runs at BOTH viewports: the hero heading and the bar are the page's two
  // display-scale elements, in that order, and nothing below the search
  // card may reach display scale (P-3).
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
  test(`the heading and the bar are the only display-scale elements — ${device} (P-3)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    // The heading is the largest thing on the page; the bar's input is the
    // largest interactive one, and it never drops to body size.
    const heading = await page
      .locator(".heroHeading")
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    const field = await input(page).evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    expect(heading).toBeGreaterThan(field);
    expect(field).toBeGreaterThan(16);

    // Nothing else comes close: display scale starts at --size-h2 (25px).
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
    expect(oversized).toEqual(["H1.heroHeading"]);
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

test.describe("preview cards are not attributable (YOY-96 AC-14)", () => {
  test("a click on a preview card sends no beacon; the same click after Enter sends exactly one with the submitted searchId", async ({
    page,
  }) => {
    // Count the real requests on the wire, and read each beacon's body
    // through a recording wrapper: Playwright exposes no postData for a
    // sendBeacon Blob, so the wrapper keeps the payload (and still sends).
    const beacons: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/playground/click")) {
        beacons.push(request.url());
      }
    });
    await page.addInitScript(() => {
      const recorded: string[] = [];
      (window as unknown as { __beaconBodies: string[] }).__beaconBodies =
        recorded;
      const original = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        if (data instanceof Blob) {
          void data.text().then((text) => recorded.push(text));
        } else if (typeof data === "string") {
          recorded.push(data);
        }
        return original(url, data);
      };
    });
    await page.goto("/");

    // Typing with NO Enter: the debounced preview answers with its own
    // fixture, whose searchId has no SearchEvent behind it.
    await input(page).fill("dress");
    await expect(cards(page)).toHaveCount(2);
    await cards(page).nth(0).locator("a").click({ modifiers: ["Shift"] });
    // Give a beacon that would have fired time to show up, then insist it
    // did not: the link opened, nothing was sent.
    await page.waitForTimeout(400);
    expect(beacons).toHaveLength(0);

    // The SAME click after an explicit submit beacons once, carrying the
    // submitted response's searchId — never the preview's.
    await input(page).press("Enter");
    await expect(cards(page)).toHaveCount(4);
    await cards(page).nth(0).locator("a").click({ modifiers: ["Shift"] });
    await expect.poll(() => beacons.length).toBe(1);
    const bodies = await page.evaluate(
      () => (window as unknown as { __beaconBodies: string[] }).__beaconBodies,
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ searchId: "fixture-results" });
    expect(bodies[0]).not.toContain("fixture-preview");
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
  test("tab order runs input → magnifier → examples → details → cards", async ({
    page,
  }) => {
    await page.goto("/");
    await submitQuery(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    await input(page).focus();

    // Walk the sequence rather than asserting three fixed stops: the page
    // gained controls in YOY-93, and what F-4 requires is that every one of
    // them is reachable in the order it is read, not that the list is short.
    const order: string[] = [];
    for (let step = 0; step < 9; step += 1) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return (
            active?.getAttribute("data-testid") ??
            active?.className.split(" ")[0] ??
            "none"
          );
        }),
      );
    }

    expect(order).toEqual([
      "playground-submit",
      ...Array.from({ length: 6 }, () => "playground-example"),
      "playground-details-toggle",
      "cardLink",
    ]);
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

  test("every interactive control meets the 44px hit target floor (F-3)", async ({
    page,
  }) => {
    // Measured on EVERY control, not a sample: the example links shipped at
    // ~20px tall because the original spec only checked the magnifier and
    // the language toggle. The one carve-out F-3 allows is a chip-remove
    // affordance at 24×24, and here the whole chip is the control.
    await page.goto("/");
    await submitQuery(page, "ai elegant dress");
    await expect(page.getByTestId("playground-chip")).toHaveCount(3);

    const boxes = await page
      .locator(
        [
          '[data-testid="playground-submit"]',
          '[data-testid="playground-language-toggle"]',
          '[data-testid="playground-example"]',
          '[data-testid="playground-chip"]',
          '[data-testid="playground-new-search"]',
          '[data-testid="playground-details-toggle"]',
        ].join(", "),
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            id: node.getAttribute("data-testid") ?? "?",
            width: rect.width,
            height: rect.height,
          };
        }),
      );

    // Guard against the selector silently matching nothing.
    expect(boxes.length).toBeGreaterThanOrEqual(11);
    for (const box of boxes) {
      expect(box.height, `${box.id} is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${box.id} is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
    }
  });
});

/**
 * The three self-hosted families (YOY-96 AC-13, re-authored by YOY-123
 * AC-1): `Assistant` for the UI, `Frank Ruhl Libre` for display, and
 * `IBM Plex Mono` for prices and the engine panel. All three are declared
 * by playground/fonts.css from the app's own static assets; the page must
 * actually load the two text families — for Latin on `/` and for Hebrew on
 * `/?lang=he`, both of which they cover — and must fetch no font from a
 * third-party host.
 */
test.describe("the playground fonts (YOY-96 AC-13, YOY-123 AC-1)", () => {
  const FAMILY = "Assistant";
  const DISPLAY_FAMILY = "Frank Ruhl Libre";

  for (const [locale, path, sample] of [
    ["en", "/", "Dress"],
    ["he", "/?lang=he", "שמלה"],
  ] as const) {
    test(`${locale}: the families load and each role renders in its own`, async ({
      page,
    }) => {
      // Anything font-shaped that leaves the app's own host is a CDN leak.
      const thirdPartyFonts: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          url.hostname !== "127.0.0.1" &&
          /font|\.woff2?$|fonts\.g(static|oogleapis)|cdn\.shopify/i.test(
            request.url(),
          )
        ) {
          thirdPartyFonts.push(request.url());
        }
      });

      await page.goto(path);
      await submitQuery(page, "dress");
      await expect(cards(page)).toHaveCount(4);
      await page.evaluate(() => document.fonts.ready);

      for (const family of [FAMILY, DISPLAY_FAMILY]) {
        const loaded = await page.evaluate(
          ({ family: name, text }) => ({
            any: document.fonts.check(`16px "${name}"`),
            sample: document.fonts.check(`16px "${name}"`, text),
            faces: [...document.fonts]
              .filter((face) => face.family.replace(/"/g, "") === name)
              .map((face) => face.status),
          }),
          { family, text: sample },
        );
        expect(loaded.any, family).toBe(true);
        expect(loaded.sample, `${family} covers ${sample}`).toBe(true);
        expect(loaded.faces, family).toContain("loaded");
      }

      // One family per role, and the role decides — not the script.
      for (const [selector, family] of [
        [".searchInput", FAMILY],
        [".cardTitle", FAMILY],
        [".heroHeading", DISPLAY_FAMILY],
        [".productName", DISPLAY_FAMILY],
        [".cardPrice", "IBM Plex Mono"],
      ] as const) {
        const computed = await page
          .locator(selector)
          .first()
          .evaluate((element) => getComputedStyle(element).fontFamily);
        expect(computed.replace(/^"/, ""), selector).toMatch(
          new RegExp(`^${family}\\b`),
        );
      }

      expect(thirdPartyFonts).toEqual([]);
    });
  }
});
