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
