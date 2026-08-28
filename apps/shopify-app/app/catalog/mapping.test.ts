import { describe, expect, it } from "vitest";

import type { ShopifyProductNode } from "./mapping.server";
import {
  computeContentHash,
  computeFamilyKey,
  mapProductNode,
  isPlaceholderImageUrl,
  normalizeFamilyTitle,
  resolveProductUrl,
  snapshotImageUrls,
  usableImageUrls,
} from "./mapping.server";

export function productNode(
  overrides: Partial<ShopifyProductNode> & { id: string },
): ShopifyProductNode {
  return {
    title: "Linen summer dress",
    handle: "linen-summer-dress",
    description: "Lightweight linen dress for warm days.",
    tags: ["dress", "summer"],
    vendor: "Test Vendor",
    productType: "Dress",
    updatedAt: "2026-08-01T10:00:00Z",
    priceRangeV2: {
      minVariantPrice: { amount: "199.90", currencyCode: "ILS" },
      maxVariantPrice: { amount: "249.90", currencyCode: "ILS" },
    },
    variants: { nodes: [{ availableForSale: true }] },
    images: { nodes: [{ altText: "Model wearing linen dress" }] },
    featuredImage: { url: "https://cdn.example.com/linen-dress.jpg" },
    ...overrides,
  };
}

describe("Shopify→snapshot mapping", () => {
  it("maps every snapshot field from a full product node", () => {
    const snapshot = mapProductNode(productNode({ id: "gid://shopify/Product/1" }));

    expect(snapshot).toMatchObject({
      productId: "gid://shopify/Product/1",
      title: "Linen summer dress",
      description: "Lightweight linen dress for warm days.",
      tags: ["dress", "summer"],
      vendor: "Test Vendor",
      productType: "Dress",
      priceMin: 199.9,
      priceMax: 249.9,
      currencyCode: "ILS",
      available: true,
      imageAltTexts: ["Model wearing linen dress"],
      sourceUpdatedAt: new Date("2026-08-01T10:00:00Z"),
    });
    expect(snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps Hebrew text and an empty description deterministically", () => {
    const hebrew = mapProductNode(
      productNode({
        id: "gid://shopify/Product/2",
        title: "שמלת ערב שחורה",
        description: null,
        tags: ["שמלה", "ערב"],
      }),
    );

    expect(hebrew.title).toBe("שמלת ערב שחורה");
    expect(hebrew.description).toBe("");
    expect(hebrew.tags).toEqual(["שמלה", "ערב"]);
  });

  it("flags availability when any variant is available, none otherwise", () => {
    const someAvailable = mapProductNode(
      productNode({
        id: "p",
        variants: {
          nodes: [{ availableForSale: false }, { availableForSale: true }],
        },
      }),
    );
    const noneAvailable = mapProductNode(
      productNode({
        id: "p",
        variants: { nodes: [{ availableForSale: false }] },
      }),
    );

    expect(someAvailable.available).toBe(true);
    expect(noneAvailable.available).toBe(false);
  });

  it("drops null and empty image alt texts", () => {
    const snapshot = mapProductNode(
      productNode({
        id: "p",
        images: {
          nodes: [{ altText: "Front view" }, { altText: null }, { altText: "" }],
        },
      }),
    );
    expect(snapshot.imageAltTexts).toEqual(["Front view"]);
  });

  it("maps Online Store publication: timestamp, explicit null, and legacy-absent (YOY-67 AC-4)", () => {
    const published = mapProductNode(
      productNode({ id: "p", publishedAt: "2026-07-01T08:00:00Z" }),
    );
    const unpublished = mapProductNode(productNode({ id: "p", publishedAt: null }));
    // Absent means a legacy fixture: treated as published as of updatedAt,
    // the same compatibility rule `status` follows.
    const legacy = mapProductNode(productNode({ id: "p" }));

    expect(published.publishedAt).toEqual(new Date("2026-07-01T08:00:00Z"));
    expect(unpublished.publishedAt).toBeNull();
    expect(legacy.publishedAt).toEqual(new Date("2026-08-01T10:00:00Z"));
    // Publication sits outside the searchable content: re-publishing or
    // unpublishing must not dirty the hash or trigger re-enrichment.
    expect(published.contentHash).toBe(unpublished.contentHash);
    expect(published.contentHash).toBe(legacy.contentHash);
  });

  it("keeps the content hash stable across tag order and timestamp churn", () => {
    const a = mapProductNode(
      productNode({ id: "p", tags: ["a", "b"], updatedAt: "2026-08-01T10:00:00Z" }),
    );
    const b = mapProductNode(
      productNode({ id: "p", tags: ["b", "a"], updatedAt: "2026-08-02T12:34:56Z" }),
    );
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("changes the content hash when a searchable field changes", () => {
    const base = mapProductNode(productNode({ id: "p" }));
    const retitled = mapProductNode(productNode({ id: "p", title: "New title" }));
    expect(base.contentHash).not.toBe(retitled.contentHash);
  });

  describe("server-resolved product url (YOY-87 AC-1/AC-2)", () => {
    it("takes onlineStoreUrl verbatim when the node carries one", () => {
      const snapshot = mapProductNode(
        productNode({
          id: "p",
          onlineStoreUrl: "https://shop.example/products/linen-summer-dress",
        }),
        { shopDomain: "test-shop.myshopify.com" },
      );
      expect(snapshot.url).toBe(
        "https://shop.example/products/linen-summer-dress",
      );
    });

    it("composes the storefront form from the shop domain and handle when onlineStoreUrl is absent (legacy fixture)", () => {
      const snapshot = mapProductNode(productNode({ id: "p" }), {
        shopDomain: "test-shop.myshopify.com",
      });
      expect(snapshot.url).toBe(
        "https://test-shop.myshopify.com/products/linen-summer-dress",
      );
    });

    it("composes the storefront form when onlineStoreUrl is null", () => {
      expect(
        resolveProductUrl(
          { handle: "linen-summer-dress", onlineStoreUrl: null },
          "test-shop.myshopify.com",
        ),
      ).toBe("https://test-shop.myshopify.com/products/linen-summer-dress");
    });

    it("resolves null when neither an online store url nor a composable form exists", () => {
      expect(mapProductNode(productNode({ id: "p" })).url).toBeNull();
      expect(
        resolveProductUrl({ handle: "", onlineStoreUrl: null }, "shop.example"),
      ).toBeNull();
    });

    it("keeps url outside the content hash: a url-only change leaves the hash intact", () => {
      const base = mapProductNode(productNode({ id: "p" }), {
        shopDomain: "test-shop.myshopify.com",
      });
      const moved = mapProductNode(
        productNode({ id: "p", onlineStoreUrl: "https://shop.example/x" }),
        { shopDomain: "test-shop.myshopify.com" },
      );
      expect(moved.url).not.toBe(base.url);
      expect(moved.contentHash).toBe(base.contentHash);
    });
  });

  describe("image URLs (YOY-120 AC-1, AC-2)", () => {
    it("keeps every usable image node url in order — no cap here — and none when nodes carry no url", () => {
      const node = productNode({
        id: "gid://shopify/Product/1",
        images: {
          nodes: [
            { url: "https://cdn.example.com/1.jpg", altText: "a" },
            { url: "https://cdn.example.com/2.jpg", altText: null },
            { url: null, altText: "no url" },
            { url: "https://cdn.example.com/3.jpg", altText: null },
            { url: "https://cdn.example.com/4.jpg", altText: null },
            { url: "https://cdn.example.com/5.jpg", altText: null },
          ],
        },
      });
      // The four-image cap counts distinct images, so it is applied by
      // image capture after hashing, not at the URL list.
      expect(snapshotImageUrls(node)).toEqual([
        "https://cdn.example.com/1.jpg",
        "https://cdn.example.com/2.jpg",
        "https://cdn.example.com/3.jpg",
        "https://cdn.example.com/4.jpg",
        "https://cdn.example.com/5.jpg",
      ]);
      expect(snapshotImageUrls(productNode({ id: "gid://shopify/Product/2" }))).toEqual([]);
    });

    it("drops the CDN /img404 placeholder, empties, and repeated URLs (binding note, item 2)", () => {
      expect(isPlaceholderImageUrl("https://whitestuff.cdn.example/images/img404")).toBe(true);
      expect(isPlaceholderImageUrl("https://cdn.example/x/IMG404?w=1")).toBe(true);
      expect(isPlaceholderImageUrl("https://cdn.example/img404.jpg")).toBe(false);
      expect(isPlaceholderImageUrl("/relative/img404")).toBe(true);
      expect(
        usableImageUrls([
          "https://whitestuff.cdn.example/images/img404",
          "https://cdn.example.com/a.jpg",
          "",
          null,
          "https://cdn.example.com/a.jpg",
          "https://cdn.example.com/b.jpg",
        ]),
      ).toEqual(["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"]);
    });

    it("keeps image urls outside the snapshot row and its content hash: an image-only change leaves the hash intact", () => {
      const base = mapProductNode(productNode({ id: "gid://shopify/Product/1" }));
      const withImages = productNode({
        id: "gid://shopify/Product/1",
        images: { nodes: [{ url: "https://cdn.example.com/new.jpg", altText: "Model wearing linen dress" }] },
      });
      expect(snapshotImageUrls(withImages)).toEqual(["https://cdn.example.com/new.jpg"]);
      expect(mapProductNode(withImages)).toEqual(base);
      expect(mapProductNode(withImages)).not.toHaveProperty("imageUrls");
    });
  });

  describe("product-family key (YOY-117 AC-1)", () => {
    it("strips one trailing colourway designator in all four shapes", () => {
      expect(normalizeFamilyTitle("Rib Knit Top in Pink")).toBe("rib knit top");
      expect(normalizeFamilyTitle("Rib Knit Top - Navy")).toBe("rib knit top");
      expect(normalizeFamilyTitle("Rib Knit Top – Navy")).toBe("rib knit top");
      expect(normalizeFamilyTitle("Rib Knit Top / Black")).toBe("rib knit top");
      expect(normalizeFamilyTitle("Rib Knit Top (Black)")).toBe("rib knit top");
    });

    it("accepts a two-word colourway whose last word is a colour, and Hebrew colours", () => {
      expect(normalizeFamilyTitle("Trail Jacket in Meteorite Black")).toBe("trail jacket");
      expect(normalizeFamilyTitle("Wrap Dress - Dusty Rose")).toBe("wrap dress");
      expect(normalizeFamilyTitle("שמלת מקסי - שחורה")).toBe("שמלת מקסי");
      // Only ONE designator is stripped, and only a trailing one.
      expect(normalizeFamilyTitle("Top in Pink / Navy")).toBe("top in pink");
    });

    it("a bare modifier is not a designator; it still qualifies a colour (YOY-125 AC-11)", () => {
      // "Soft", "Natural", "Light" are shade/finish modifiers, never a
      // colourway on their own: collapsing them would hide a different
      // product of the same vendor and type behind a colourway that never
      // existed (the co-manager parity rule).
      expect(normalizeFamilyTitle("Jacket - Soft")).toBe("jacket - soft");
      expect(normalizeFamilyTitle("Sofa (Natural)")).toBe("sofa (natural)");
      expect(normalizeFamilyTitle("Tee / Light")).toBe("tee / light");
      expect(normalizeFamilyTitle("Jacket in Vintage")).toBe("jacket in vintage");
      // The same words still qualify a colour in the two-word form.
      expect(normalizeFamilyTitle("Tee in Dusty Rose")).toBe("tee");
      expect(normalizeFamilyTitle("Tee in Meteorite Black")).toBe("tee");
      expect(normalizeFamilyTitle("Jacket - Soft Pink")).toBe("jacket");
      // A one-word colour is unaffected.
      expect(normalizeFamilyTitle("Tee - Floral")).toBe("tee");
    });

    it("a <pattern> Print designator is a colourway (YOY-125 AC-17)", () => {
      // `print` is a TERMINAL colourway word, not a leading modifier:
      // treating it as one split a single product family into a card per
      // pattern — the duplicate-card side of the parity rule.
      expect(normalizeFamilyTitle("Dress - Leopard Print")).toBe("dress");
      expect(normalizeFamilyTitle("Dress - Floral Print")).toBe("dress");
      expect(normalizeFamilyTitle("Dress in Ditsy Print")).toBe("dress");
      expect(normalizeFamilyTitle("Dress - Print")).toBe("dress");
      expect(
        computeFamilyKey({ vendor: "Acme", title: "Dress - Leopard Print", productType: "Dresses" }),
      ).toBe(
        computeFamilyKey({ vendor: "Acme", title: "Dress - Floral Print", productType: "Dresses" }),
      );
      // The modifier rule is unchanged for the words that really are modifiers.
      expect(normalizeFamilyTitle("Jacket - Soft")).toBe("jacket - soft");
      expect(normalizeFamilyTitle("Sofa (Natural)")).toBe("sofa (natural)");
    });

    it("keeps a title with no designator, or a designator that is not a colour", () => {
      expect(normalizeFamilyTitle("Black Evening Gown")).toBe("black evening gown");
      expect(normalizeFamilyTitle("Shirt Dress in Linen")).toBe("shirt dress in linen");
      expect(normalizeFamilyTitle("Jacket (Limited Edition)")).toBe("jacket (limited edition)");
      expect(normalizeFamilyTitle("Trail Jacket in Very Dark Meteorite Black")).toBe(
        "trail jacket in very dark meteorite black",
      );
      expect(normalizeFamilyTitle("  Wide   Leg  Pants ")).toBe("wide leg pants");
    });

    it("keys on vendor | normalized title | product type, lowercased; no type when absent", () => {
      expect(computeFamilyKey({ vendor: "Tentree", title: "Rib Knit Top in Pink", productType: "Tops" })).toBe(
        "tentree|rib knit top|tops",
      );
      expect(computeFamilyKey({ vendor: "Tentree", title: "Rib Knit Top in Navy", productType: "Tops" })).toBe(
        computeFamilyKey({ vendor: "TENTREE", title: "Rib  Knit Top (Navy)", productType: "tops" }),
      );
      // Same vendor and title but a different type: a different product.
      expect(computeFamilyKey({ vendor: "Acme", title: "Classic in Black", productType: "Belts" })).not.toBe(
        computeFamilyKey({ vendor: "Acme", title: "Classic in Black", productType: "Hats" }),
      );
      expect(computeFamilyKey({ vendor: "Acme", title: "Classic Tee", productType: "" })).toBe("acme|classic tee");
    });

    it("rides the mapped snapshot outside the content hash", () => {
      const pink = mapProductNode(productNode({ id: "gid://shopify/Product/1", title: "Rib Knit Top in Pink" }));
      const navy = mapProductNode(productNode({ id: "gid://shopify/Product/1", title: "Rib Knit Top in Navy" }));
      expect(pink.familyKey).toBe("test vendor|rib knit top|dress");
      expect(navy.familyKey).toBe(pink.familyKey);
      // The title differs, so the content hash does — the family key is
      // display-only metadata over it, never part of it.
      expect(pink.contentHash).not.toBe(navy.contentHash);
    });
  });

  it("exposes computeContentHash as a pure function of the searchable fields", () => {
    const snapshot = mapProductNode(productNode({ id: "p" }));
    // computeContentHash reads only the searchable fields, so passing the
    // full snapshot (sourceUpdatedAt included) must reproduce the hash.
    const { contentHash, ...fields } = snapshot;
    expect(computeContentHash(fields)).toBe(contentHash);
  });
});
