import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { ProductWebhookPayload } from "../catalog/webhook-sync.server";
import { syncProductFromWebhook } from "../catalog/webhook-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const outcome = await syncProductFromWebhook({
    db,
    shopDomain: shop,
    payload: payload as unknown as ProductWebhookPayload,
  });
  console.log(`Received ${topic} webhook for ${shop}: ${outcome}`);

  return new Response();
};
