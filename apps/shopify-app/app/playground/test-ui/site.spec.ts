import { expect, test, type Page } from "@playwright/test";

/**
 * The marketing site (ported from the founder's Claude-Design export) and
 * the playground's move to `/try`. Per route: the page renders its heading,
 * every internal nav and footer link answers 200, and nothing is logged to
 * the console as an error — a missing asset or a hydration mismatch both
 * surface there.
 */

const SITE_PAGES = [
  ["/", "Your shoppers don't think in filters."],
  ["/about", "We built the search box we kept wishing for."],
  ["/how-it-works", "Two kinds of search, one search box."],
  ["/pricing", "Priced against the revenue it returns."],
  ["/faq", "Questions merchants actually ask."],
  ["/privacy", "Privacy policy"],
  ["/terms", "Terms of service"],
] as const;

/** Collect console errors and uncaught page errors for the whole visit. */
function recordErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Every same-origin link in the site nav and footer. */
async function chromeLinks(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator(".site-nav a[href], .site-footer a[href]")
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).href),
    );
  const origin = new URL(page.url()).origin;
  return [...new Set(hrefs.filter((href) => href.startsWith(origin)))];
}

async function expectChromeLinksResolve(page: Page): Promise<void> {
  const links = await chromeLinks(page);
  // Home, how it works, pricing, demo, FAQ, about, privacy, terms.
  expect(links.length).toBeGreaterThanOrEqual(8);
  for (const link of links) {
    const response = await page.request.get(link);
    expect(response.status(), link).toBe(200);
  }
}

for (const [path, heading] of SITE_PAGES) {
  test(`${path} renders, its nav links resolve, and it logs no errors`, async ({
    page,
  }) => {
    const errors = recordErrors(page);

    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    await expect(page.locator(".site-nav")).toBeVisible();
    await expect(page.locator(".site-footer")).toBeVisible();

    await expectChromeLinksResolve(page);
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });
}

test("/try renders the playground search bar inside the site chrome", async ({
  page,
}) => {
  const errors = recordErrors(page);

  const response = await page.goto("/try");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("playground-input")).toBeVisible();
  await expect(page.getByTestId("playground-submit")).toBeVisible();
  await expect(page.locator(".site-nav")).toBeVisible();
  await expect(page.locator(".site-footer")).toBeVisible();

  await expectChromeLinksResolve(page);
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});

/**
 * The site copy pass (YOY-156; verify 1 – 4): the wordmark is text in the
 * display face, every former "Start 14-day trial" / "Add to Shopify" button
 * is a link to /try reading "Try it on a real catalog", nothing is
 * disabled, and the pricing cards state PRD §8's tiers.
 */
const TRY_LABEL = "Try it on a real catalog";

/** PRD §8: price, AI searches a month, catalog size, per tier. */
const PRD_TIERS = [
  ["$39", "10,000 AI searches / month", "Catalogs up to 1,000 products"],
  ["$99", "50,000 AI searches / month", "Catalogs up to 5,000 products"],
  ["$249", "200,000 AI searches / month", "Catalogs up to 20,000 products"],
] as const;

for (const path of ["/", "/pricing"]) {
  test(`${path}: a text wordmark, every call to action links to /try, nothing disabled (verify 1, 2, 4)`, async ({
    page,
  }) => {
    await page.goto(path);
    for (const scope of [".site-nav", ".site-footer"]) {
      const wordmark = page.locator(`${scope} .site-wordmark__name`);
      await expect(wordmark).toHaveText("Unfiltered");
      expect(
        await wordmark.evaluate((element) =>
          [...element.childNodes].every((node) => node.nodeType === Node.TEXT_NODE),
        ),
      ).toBe(true);
      expect(
        await wordmark.evaluate((element) => getComputedStyle(element).fontFamily),
      ).toContain("Frank Ruhl Libre");
      await expect(page.locator(`${scope} img`)).toHaveCount(0);
    }
    await expect(page.locator('img[src*="logo-wordmark"]')).toHaveCount(0);

    await expect(page.getByText("Start 14-day trial")).toHaveCount(0);
    await expect(page.getByText("Add to Shopify", { exact: true })).toHaveCount(0);
    const ctas = page.locator(".unf-btn", { hasText: TRY_LABEL });
    expect(await ctas.count()).toBeGreaterThan(0);
    for (const cta of await ctas.all()) {
      expect(await cta.evaluate((element) => element.tagName)).toBe("A");
      await expect(cta).toHaveAttribute("href", "/try");
    }
    await expect(page.locator("[disabled]")).toHaveCount(0);
  });
}

test("/pricing: each card states the PRD §8 price, searches and catalog size (verify 3)", async ({
  page,
}) => {
  await page.goto("/pricing");
  const cards = page.locator(".unf-pricing");
  await expect(cards).toHaveCount(3);
  for (const [index, [price, searches, catalog]] of PRD_TIERS.entries()) {
    const card = cards.nth(index);
    await expect(card.locator(".unf-pricing__amount")).toHaveText(price);
    await expect(card).toContainText(searches);
    await expect(card).toContainText(catalog);
  }
});
