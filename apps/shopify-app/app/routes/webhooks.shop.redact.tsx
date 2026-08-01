import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory GDPR compliance topic. Shop data beyond the session is not stored
// yet; sessions are already deleted by the app/uninstalled handler, which
// Shopify sends before shop/redact.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
