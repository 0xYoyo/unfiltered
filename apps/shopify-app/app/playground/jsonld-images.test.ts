import { describe, expect, it } from "vitest";

import { mapProductNode } from "./jsonld.server";

// JSON-LD image capture (YOY-120 AC-1): up to four `image` entries — URL
// strings, ImageObjects, arrays of either — the product's own first, then
// the variants', resolved against the page like `imageUrl`.

const PAGE = "https://shop.example/item/dress-1";
const withOffer = (node: Record<string, unknown>) => ({
  "@type": "Product",
  name: "Dress",
  sku: "D-1",
  offers: { "@type": "Offer", price: "100", priceCurrency: "ILS", availability: "https://schema.org/InStock" },
  ...node,
});

describe("JSON-LD imageUrls (YOY-120 AC-1)", () => {
  it("keeps up to four image entries in order, mixing strings and ImageObjects", () => {
    const product = mapProductNode(
      withOffer({
        image: [
          "/img/a.jpg",
          { "@type": "ImageObject", url: "https://cdn.example/b.jpg" },
          { "@type": "ImageObject", contentUrl: "/img/c.jpg" },
          "/img/d.jpg",
          "/img/e.jpg",
        ],
      }),
      { pageUrl: PAGE, canonicalUrl: null },
    );
    expect(product?.imageUrl).toBe("https://shop.example/img/a.jpg");
    expect(product?.imageUrls).toEqual([
      "https://shop.example/img/a.jpg",
      "https://cdn.example/b.jpg",
      "https://shop.example/img/c.jpg",
      "https://shop.example/img/d.jpg",
    ]);
  });

  it("takes a single string image, falls through to variant images, and yields none when there are none", () => {
    expect(
      mapProductNode(withOffer({ image: "/img/only.jpg" }), { pageUrl: PAGE, canonicalUrl: null })?.imageUrls,
    ).toEqual(["https://shop.example/img/only.jpg"]);
    const group = mapProductNode(
      {
        "@type": "ProductGroup",
        name: "Sneaker",
        sku: "G-1",
        hasVariant: [
          withOffer({ image: "/img/v38.jpg" }),
          withOffer({ image: ["/img/v39.jpg", "/img/v39-b.jpg"] }),
        ],
      },
      { pageUrl: PAGE, canonicalUrl: null },
    );
    expect(group?.imageUrls).toEqual([
      "https://shop.example/img/v38.jpg",
      "https://shop.example/img/v39.jpg",
      "https://shop.example/img/v39-b.jpg",
    ]);
    expect(mapProductNode(withOffer({}), { pageUrl: PAGE, canonicalUrl: null })?.imageUrls).toEqual([]);
  });
});
