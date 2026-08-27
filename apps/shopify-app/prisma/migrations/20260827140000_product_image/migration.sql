-- Product images (YOY-120 AC-1): up to four image URLs per product, each
-- with the SHA-256 of its bytes, so vision enrichment (capability 14) can be
-- keyed on image content and re-run only when an image actually changed.
-- Bytes are hashed and discarded, never stored. Keyed by tenant + product +
-- position like the enrichment and embedding rows: no FK cascade, so every
-- product delete removes these rows in the same transaction.
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
-- duplicateUrls: other source URLs whose bytes hashed identical to this row's
-- (a CDN serving one asset under several suffixes), so a re-run over an
-- unchanged image list makes zero fetches even for the de-duplicated URLs.
CREATE TABLE "ProductImage" ("id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "productId" TEXT NOT NULL, "position" INTEGER NOT NULL, "url" TEXT NOT NULL, "duplicateUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "contentHash" TEXT NOT NULL, "fetchedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ProductImage_shopDomain_productId_position_key" ON "ProductImage"("shopDomain", "productId", "position");
CREATE INDEX "ProductImage_shopDomain_productId_idx" ON "ProductImage"("shopDomain", "productId");
