import { expect, test } from "@playwright/test";

// Mounting behavior (YOY-43 lane, updated by YOY-48): the widget mounts a
// hidden overlay host when — and only when — the page has a recognizable
// theme search input; with none it stays inert entirely.

test("widget mounts a root with the overlay hidden until the input is used", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("unfiltered-widget-root")).toBeAttached();
  await expect(page.getByTestId("unfiltered-widget-overlay")).toBeHidden();
});

test("init receives the storefront locale and shop domain", async ({
  page,
}) => {
  await page.goto("/?locale=he");

  const root = page.getByTestId("unfiltered-widget-root");
  await expect(root).toHaveAttribute("data-locale", "he");
  await expect(root).toHaveAttribute(
    "data-shop-domain",
    "harness.myshopify.com",
  );
});

test("stays inert on a host page with no search input: no root, no errors (AC-2)", async ({
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

  await expect(page.getByTestId("unfiltered-widget-root")).toHaveCount(0);
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
