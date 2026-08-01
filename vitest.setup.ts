// Placeholder Shopify credentials so app modules that read env at import time
// (app/shopify.server.ts) can load in tests. No test may reach the network.
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-api-secret";
process.env.SHOPIFY_APP_URL ??= "https://test-app.example.com";
process.env.SCOPES ??= "write_products";
