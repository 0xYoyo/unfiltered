-- The product card (YOY-143 AC-1): one plain-text dossier per product,
-- written once at load time — facts, look, read, summary, asks (JSON keyed
-- by language), the whole card text with its hash, the hash of the inputs
-- it was written from, the card version, the model id and the written-at.
-- Keyed by tenant + product like the enrichment rows: no FK cascade, so
-- every product delete removes the card in the same transaction (AC-10).
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
CREATE TABLE "ProductCard" ("id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "productId" TEXT NOT NULL, "status" TEXT NOT NULL, "facts" TEXT NOT NULL DEFAULT '', "look" TEXT NOT NULL DEFAULT '', "read" TEXT NOT NULL DEFAULT '', "summary" TEXT NOT NULL DEFAULT '', "asks" JSONB NOT NULL, "cardText" TEXT NOT NULL DEFAULT '', "cardTextHash" TEXT NOT NULL DEFAULT '', "inputHash" TEXT NOT NULL, "cardVersion" INTEGER NOT NULL, "modelId" TEXT NOT NULL, "writtenAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ProductCard_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ProductCard_shopDomain_productId_key" ON "ProductCard"("shopDomain", "productId");
CREATE INDEX "ProductCard_shopDomain_idx" ON "ProductCard"("shopDomain");
