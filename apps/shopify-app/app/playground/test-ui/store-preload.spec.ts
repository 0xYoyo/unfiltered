import { expect, test, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG, type PlaygroundLocale } from "../strings";

/**
 * The store-preload page (YOY-94). Every assertion is one of the issue's
 * "How to verify" steps, driven against the built app in fixture mode where
 * `demo-store` is the one known slug.
 */

const DESKTOP = { width: 1280, height: 800 };

const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");
const storeLine = (page: Page) => page.getByTestId("playground-store-line");
const strings = (locale: PlaygroundLocale) =>
  PLAYGROUND_STRING_CATALOG[locale];

function recordSearchRequests(page: Page): URL[] {
  const urls: URL[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/search")) {
      urls.push(new URL(request.url()));
    }
  });
  return urls;
}

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

test.describe("the store's page (AC-1, AC-2, verify 1)", () => {
  test("names the store, counts its products, and is noindex", async ({
    page,
  }) => {
    await page.goto("/s/demo-store");

    await expect(storeLine(page)).toContainText("Demo Store");
    await expect(storeLine(page)).toContainText(
      strings("en").storeProducts.replace("{count}", "120"),
    );
    // One phrase to assistive tech, the literal separator included — not
    // "Demo Store120 products" with the gap coming from CSS alone (YOY-96
    // AC-16). Exact, whitespace-normalised.
    await expect(storeLine(page)).toHaveText("Demo Store · 120 products");
    await expect(page).toHaveTitle("Demo Store — Unfiltered");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex",
    );
  });

  test("the seed playground stays indexable and has no store line", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await expect(storeLine(page)).toHaveCount(0);
  });

  test("the store name takes the hero's place and nothing else changes (P-7)", async ({
    page,
  }) => {
    // Same chrome, same controls: the page is the store's because it says
    // so, not because it dressed up as the store. The demo hero is the one
    // block the store line replaces (P-7, re-authored 2026-08-28).
    await page.setViewportSize(DESKTOP);

    const inventory = async (path: string, drop: string) => {
      await page.goto(path);
      return page.evaluate(
        (prefix) =>
          Array.from(document.querySelectorAll(".playground *"))
            // getAttribute, not `className`: on an SVG element that property
            // is an SVGAnimatedString, and the magnifier is an SVG.
            .map((node) => (node.getAttribute("class") ?? "").split(" ")[0])
            .filter((name) => name !== "" && !name.startsWith(prefix)),
        drop,
      );
    };

    expect(await inventory("/s/demo-store", "store")).toEqual(
      await inventory("/", "hero"),
    );
  });
});

test.describe("every request carries the catalog (AC-1, verify 2)", () => {
  test("a submitted search names the slug", async ({ page }) => {
    const urls = recordSearchRequests(page);
    await page.goto("/s/demo-store");
    await submit(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.searchParams.get("catalog")).toBe("demo-store");
    }
  });

  test("so does a keystroke preview", async ({ page }) => {
    const urls = recordSearchRequests(page);
    await page.goto("/s/demo-store");
    await input(page).pressSequentially("dre", { delay: 120 });
    await expect
      .poll(() =>
        urls.filter((url) => url.searchParams.get("mode") === "preview").length,
      )
      .toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.searchParams.get("catalog")).toBe("demo-store");
    }
  });

  test("and the click beacon", async ({ page }) => {
    const beacons: URL[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/playground/click")) {
        beacons.push(new URL(request.url()));
      }
    });
    await page.goto("/s/demo-store");
    await submit(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    await cards(page).nth(0).locator("a").click({ modifiers: ["Shift"] });
    await expect.poll(() => beacons.length).toBe(1);
    expect(beacons[0].searchParams.get("catalog")).toBe("demo-store");
  });
});

test.describe("an unknown slug (AC-1, verify 3)", () => {
  test("answers 404 with a designed page, not a raw error", async ({
    page,
  }) => {
    const response = await page.goto("/s/nope");
    expect(response?.status()).toBe(404);

    await expect(page.getByText(strings("en").catalogNotFound)).toBeVisible();
    await expect(page.locator('a[href="/"]')).toBeVisible();
    // The playground's own shell, not a framework error screen.
    await expect(page.locator(".playground")).toBeVisible();
    await expect(page.getByText(/stack|Unexpected Server Error/i)).toHaveCount(
      0,
    );
  });

  test("renders its language server-side, with no hydration flip (AC-3)", async ({
    page,
  }) => {
    // Regression: the boundary read the language from `document`, so the
    // server rendered English inside <html lang="he"> and the client
    // hydrated to Hebrew — a text mismatch and a visible flip, which is the
    // exact first-frame flicker resolving the language server-side prevents.
    const ssr = await (await page.request.get("/s/nope?lang=he")).text();
    expect(ssr).toContain(strings("he").catalogNotFound);
    expect(ssr).not.toContain(strings("en").catalogNotFound);

    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    await page.goto("/s/nope?lang=he");
    await expect(
      page.getByText(strings("he").catalogNotFound),
    ).toBeVisible();
    expect(errors.filter((text) => /hydrat/i.test(text))).toEqual([]);
  });

  test("honours Accept-Language, not just ?lang= (AC-3)", async ({
    browser,
  }) => {
    // The boundary ignored the header entirely, so a Hebrew reader whose
    // only signal is Accept-Language never saw Hebrew on this page.
    const context = await browser.newContext({ locale: "he-IL" });
    const hebrew = await context.newPage();
    await hebrew.goto("/s/nope");

    await expect(hebrew.locator("html")).toHaveAttribute("lang", "he");
    await expect(
      hebrew.getByText(strings("he").catalogNotFound),
    ).toBeVisible();
    await context.close();
  });

  test("keeps the same shell, language toggle included (AC-1)", async ({
    page,
  }) => {
    await page.goto("/s/nope?lang=he");

    const toggle = page.getByTestId("playground-language-toggle");
    await expect(toggle).toBeVisible();
    const href = await toggle.getAttribute("href");
    expect(href).toContain("/s/nope");
    expect(href).toContain("lang=en");
  });

  test("the link goes back to the seed playground", async ({ page }) => {
    await page.goto("/s/nope");
    await page.locator('a[href="/"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(input(page)).toBeVisible();
  });
});

test.describe("lang and details work as on / (AC-3, verify 4)", () => {
  test("?lang=he mirrors the page and keeps the path", async ({ page }) => {
    await page.goto("/s/demo-store?lang=he");

    await expect(page.locator("html")).toHaveAttribute("lang", "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(storeLine(page)).toContainText(
      strings("he").storeProducts.replace("{count}", "120"),
    );
    // The mirrored equivalent of the EN phrase, separator included (AC-16).
    await expect(storeLine(page)).toHaveText(
      `Demo Store · ${strings("he").storeProducts.replace("{count}", "120")}`,
    );

    const href = await page
      .getByTestId("playground-language-toggle")
      .getAttribute("href");
    expect(href).toContain("/s/demo-store");
    expect(href).toContain("lang=en");
  });

  test("?details=1 opens the panel on this page too", async ({ page }) => {
    await page.goto("/s/demo-store?details=1");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-details-panel")).toBeVisible();
  });

  test("the sessionId is shared with / in the same tab", async ({ page }) => {
    const urls = recordSearchRequests(page);

    await page.goto("/");
    await submit(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    await page.goto("/s/demo-store");
    await submit(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    const sessionIds = new Set(
      urls.map((url) => url.searchParams.get("sessionId")),
    );
    expect(sessionIds.size).toBe(1);
  });
});
