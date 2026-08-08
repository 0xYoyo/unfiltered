import { expect, test } from "@playwright/test";

// UI test lane (YOY-43 AC-5): headless browser tests against the local
// harness — no Shopify, no network. These are the repo's first UI tests and
// the lane every later widget issue extends.

test("widget mounts: root testid present and search input focusable", async ({
  page,
}) => {
  await page.goto("/");

  const root = page.getByTestId("unfiltered-widget-root");
  await expect(root).toBeVisible();

  const input = root.getByRole("searchbox");
  await expect(input).toBeVisible();
  await input.focus();
  await expect(input).toBeFocused();
});

test("init receives the storefront locale and shop domain (AC-1 contract)", async ({
  page,
}) => {
  await page.goto("/?locale=he");

  const root = page.getByTestId("unfiltered-widget-root");
  await expect(root).toHaveAttribute("data-locale", "he");
  await expect(root).toHaveAttribute(
    "data-shop-domain",
    "harness.myshopify.com",
  );
  await expect(root).toHaveAttribute("data-theme-search-form", "found");
});

test("mounts without console errors on a host page with no search form (AC-3)", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });

  await page.goto("/no-search-form.html");

  const root = page.getByTestId("unfiltered-widget-root");
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute("data-theme-search-form", "absent");
  expect(errors).toEqual([]);
});

test("a second init call does not mount a second root", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.UnfilteredWidget?.init({
      locale: "en",
      shopDomain: "harness.myshopify.com",
    });
  });

  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(1);
});
