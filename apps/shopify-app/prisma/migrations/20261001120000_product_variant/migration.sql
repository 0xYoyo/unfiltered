-- Product variants (YOY-142 AC-1): every variant as the merchant defined it,
-- option name/value pairs verbatim in the merchant's order, per-variant
-- price, availability and (when the source exposes it) stock quantity.
-- Keyed by tenant + product + variant like the image, enrichment and
-- embedding rows: no FK cascade, so every product delete removes these rows
-- in the same transaction (AC-7).
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
CREATE TABLE "ProductVariant" ("id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "productId" TEXT NOT NULL, "variantId" TEXT NOT NULL, "position" INTEGER NOT NULL, "options" JSONB NOT NULL, "price" DOUBLE PRECISION NOT NULL, "available" BOOLEAN NOT NULL, "quantity" INTEGER, "sourceUpdatedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ProductVariant_shopDomain_productId_variantId_key" ON "ProductVariant"("shopDomain", "productId", "variantId");
CREATE INDEX "ProductVariant_shopDomain_productId_idx" ON "ProductVariant"("shopDomain", "productId");
