import { describe, expect, it } from "vitest";

import type { ShopifyProductNode } from "./mapping.server";
import { mapProductNode } from "./mapping.server";
import type { ProductWebhookPayload } from "./webhook-sync.server";
import { mapWebhookProduct } from "./webhook-sync.server";

/** GraphQL product node matching the webhook payload `webhookPayload` builds. */
function productNode(overrides: Partial<ShopifyProductNode> = {}): ShopifyProductNode {
  return {
    id: "gid://shopify/Product/1",
    title: "Linen summer dress",
    description: "Lightweight linen dress for warm days.",
    tags: ["dress", "summer"],
    vendor: "Test Vendor",
    productType: "Dress",
    updatedAt: "2026-08-01T10:00:00Z",
    priceRangeV2: {
      minVariantPrice: { amount: "199.90", currencyCode: "ILS" },
      maxVariantPrice: { amount: "199.90", currencyCode: "ILS" },
    },
    variants: { nodes: [{ availableForSale: true }] },
    images: { nodes: [{ altText: "Model wearing linen dress" }] },
    ...overrides,
  };
}

/** REST-style webhook payload matching the GraphQL node `productNode` builds. */
function webhookPayload(
  overrides: Partial<ProductWebhookPayload> = {},
): ProductWebhookPayload {
  return {
    id: 1,
    admin_graphql_api_id: "gid://shopify/Product/1",
    title: "Linen summer dress",
    body_html: "<p>Lightweight linen dress for warm days.</p>",
    vendor: "Test Vendor",
    product_type: "Dress",
    tags: "dress, summer",
    updated_at: "2026-08-01T10:00:00Z",
    variants: [
      {
        price: "199.90",
        inventory_quantity: 3,
        inventory_policy: "deny",
        inventory_management: "shopify",
      },
    ],
    images: [{ alt: "Model wearing linen dress" }],
    ...overrides,
  };
}

describe("webhook→snapshot mapping convergence with ingestion", () => {
  it("hashes a plain body_html identically to the ingested description", () => {
    const viaWebhook = mapWebhookProduct(webhookPayload(), "ILS");
    const viaIngestion = mapProductNode(productNode());

    expect(viaWebhook.description).toBe(viaIngestion.description);
    expect(viaWebhook.contentHash).toBe(viaIngestion.contentHash);
  });

  it("hashes numeric and hex entity body_html identically to the ingested description", () => {
    const viaWebhook = mapWebhookProduct(
      webhookPayload({
        body_html:
          "<p>Sun &#38; sand &#8212; the kids&#x2019; favourite &#x201C;linen&#x201D;</p>",
      }),
      "ILS",
    );
    const viaIngestion = mapProductNode(
      productNode({ description: "Sun & sand — the kids’ favourite “linen”" }),
    );

    expect(viaWebhook.description).toBe("Sun & sand — the kids’ favourite “linen”");
    expect(viaWebhook.contentHash).toBe(viaIngestion.contentHash);
  });

  it("decodes named entities once, leaving double-encoded text encoded once", () => {
    const snapshot = mapWebhookProduct(
      webhookPayload({
        body_html:
          "<p>Caf&eacute;-style &ldquo;wrap&rdquo; &ndash; 30&deg; wash &amp;amp; dry</p>",
      }),
      "ILS",
    );

    expect(snapshot.description).toBe("Café-style “wrap” – 30° wash &amp; dry");
  });

  it("passes unrecognized entities through unchanged", () => {
    const snapshot = mapWebhookProduct(
      webhookPayload({ body_html: "<p>Uses &unknownentity; markers</p>" }),
      "ILS",
    );

    expect(snapshot.description).toBe("Uses &unknownentity; markers");
  });
});
