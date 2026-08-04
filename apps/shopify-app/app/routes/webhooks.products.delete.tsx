import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { ProductDeleteWebhookPayload } from "../catalog/webhook-sync.server";
import { deleteProductFromWebhook } from "../catalog/webhook-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const outcome = await deleteProductFromWebhook({
    db,
    shopDomain: shop,
    payload: payload as unknown as ProductDeleteWebhookPayload,
  });
  console.log(`Received ${topic} webhook for ${shop}: ${outcome}`);

  return new Response();
};
