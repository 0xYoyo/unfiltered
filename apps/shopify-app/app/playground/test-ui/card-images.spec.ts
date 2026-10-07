import { expect, test, type Page } from "@playwright/test";

/**
 * Sized card images on the playground (YOY-169 AC-2, AC-3; verify 1): a
 * card whose image is on Shopify's CDN asks for it at 360 px with a
 * 360/540/720 `srcset`; a crawl-sourced image on another host keeps its
 * plain `src`. Image requests are answered locally, so the lane never
 * reaches the CDN.
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

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`playground cards size Shopify-CDN images and leave other hosts alone (verify 1, ${viewport.width} px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    // React's development build warns once per misspelled DOM prop (YOY-157 AC-25).
    const consoleMessages: string[] = [];
    page.on("console", (message) => consoleMessages.push(message.text()));
    const requested = await stubImages(page);
    await page.goto("/try");
    await page.getByTestId("playground-input").fill("images dress");
    await page.getByTestId("playground-input").press("Enter");
    const images = page.getByTestId("playground-card").locator("img");
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
    await expect(shopify).toHaveAttribute("sizes", /640px/);
    await expect(shopify).toHaveAttribute("decoding", "async");
    await expect(shopify).toHaveAttribute("loading", "eager");

    const crawl = images.nth(1);
    await expect(crawl).toHaveAttribute(
      "src",
      "https://images.example.test/products/fixture-shirt.jpg",
    );
    await expect(crawl).not.toHaveAttribute("srcset", /.+/);

    await expect.poll(() => requested.length).toBeGreaterThan(0);
    for (const url of requested.filter((entry) => entry.includes("cdn.shopify.com"))) {
      expect(new URL(url).searchParams.get("width")).toMatch(/^(360|540|720)$/);
    }
    expect(consoleMessages.filter((text) => text.includes("Invalid DOM property"))).toEqual([]);
  });
}

test("cards after the first row load lazily", async ({ page }) => {
  await page.goto("/try");
  await page.getByTestId("playground-input").fill("paged dress");
  await page.getByTestId("playground-input").press("Enter");
  const images = page.getByTestId("playground-card").locator("img");
  await expect(images).toHaveCount(24);
  await expect(images.nth(3)).toHaveAttribute("loading", "eager");
  await expect(images.nth(4)).toHaveAttribute("loading", "lazy");
});
