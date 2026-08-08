import { describe, expect, it } from "vitest";

import type { ShopifyProductNode } from "./mapping.server";
import { computeContentHash, mapProductNode } from "./mapping.server";

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

  it("exposes computeContentHash as a pure function of the searchable fields", () => {
    const snapshot = mapProductNode(productNode({ id: "p" }));
    // computeContentHash reads only the searchable fields, so passing the
    // full snapshot (sourceUpdatedAt included) must reproduce the hash.
    const { contentHash, ...fields } = snapshot;
    expect(computeContentHash(fields)).toBe(contentHash);
  });
});
