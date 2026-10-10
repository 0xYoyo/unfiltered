import { expect, test, type Page } from "@playwright/test";

/**
 * Sized card images on the overlay (YOY-169 AC-2, AC-3; verify 2): a card
 * whose image is on Shopify's CDN asks for it at 360 px with a 360/540/720
 * `srcset`; a crawl-sourced image on another host keeps its plain `src`.
 * Image requests are answered locally, so the lane never reaches the CDN.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

async function stubImages(page: Page): Promise<string[]> {
  const requested: string[] = [];
  await page.route(/cdn\.shopify\.com|images\.example\.test/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  return requested;
}

test("overlay cards size Shopify-CDN images and leave other hosts alone (verify 2)", async ({
  page,
}) => {
  const requested = await stubImages(page);
  await page.goto("/?fixture=images&debounce=30000");
  await page.locator('input[type="search"]').first().fill("dress");
  await page.locator('input[type="search"]').first().press("Enter");
  const images = page.getByTestId("unfiltered-widget-card").locator("img");
  await expect(images).toHaveCount(2);

  const shopify = images.nth(0);
  const src = new URL((await shopify.getAttribute("src"))!);
  expect(src.searchParams.get("width")).toBe("360");
  expect(src.searchParams.get("v")).toBe("1712345678");
  const srcset = (await shopify.getAttribute("srcset"))!;
  expect(srcset.split(", ").map((entry) => entry.split(" ")[1])).toEqual([
    "360w",
    "540w",
    "720w",
  ]);
  await expect(shopify).toHaveAttribute("sizes", /220px/);
  await expect(shopify).toHaveAttribute("decoding", "async");
  // The first row loads eagerly.
  await expect(shopify).toHaveAttribute("loading", "eager");

  const crawl = images.nth(1);
  await expect(crawl).toHaveAttribute(
    "src",
    "https://images.example.test/products/fixture-shirt.jpg",
  );
  await expect(crawl).not.toHaveAttribute("srcset", /.+/);

  // Every Shopify request the browser made asked for a sized image.
  await expect.poll(() => requested.length).toBeGreaterThan(0);
  for (const url of requested.filter((entry) => entry.includes("cdn.shopify.com"))) {
    expect(new URL(url).searchParams.get("width")).toMatch(/^(360|540|720)$/);
  }
});

test("overlay: cards 1–4 load eagerly at high priority; card 5 on lazily with no priority (YOY-171 AC-8)", async ({ page }) => {
  await page.goto("/?fixture=labels&debounce=30000");
  await page.locator('input[type="search"]').first().fill("dress");
  await page.locator('input[type="search"]').first().press("Enter");
  const images = page.getByTestId("unfiltered-widget-card").locator("img");
  await expect(images).toHaveCount(6);
  for (const index of [0, 1, 2, 3]) {
    await expect(images.nth(index)).toHaveAttribute("loading", "eager");
    await expect(images.nth(index)).toHaveAttribute("fetchpriority", "high");
  }
  await expect(images.nth(4)).toHaveAttribute("loading", "lazy");
  await expect(images.nth(4)).not.toHaveAttribute("fetchpriority", /.*/);
});

test("theme-native: the page's first four items load their images first, the fifth does not (YOY-171 AC-8)", async ({ page }) => {
  await page.goto("/theme-native.html?native=A&fixture=labels&debounce=30000");
  await page.locator('input[type="search"]').first().fill("dress");
  await page.locator('input[type="search"]').first().press("Enter");
  const items = page.getByTestId("unfiltered-native-item");
  await expect(items).toHaveCount(6);
  for (const index of [0, 1, 2, 3]) {
    const image = items.nth(index).locator("img").first();
    await expect(image).toHaveAttribute("loading", "eager");
    await expect(image).toHaveAttribute("fetchpriority", "high");
  }
  await expect(items.nth(4).locator("img").first()).not.toHaveAttribute("fetchpriority", /.*/);
});
