-- Card vectors (YOY-144 AC-1): several rows per product, one per card
-- section — "prose" (facts + look + read) and "asks:<lang>" (one ask list
-- per configured language) — each with the hash of the text it embeds, so
-- an unchanged section is never re-embedded (AC-2). The vector column is
-- dimensionless like "ProductEmbedding"'s: the dimension belongs to the
-- embedding-model configuration, and the pipeline builds the
-- dimension-typed HNSW cosine index at run time the way it builds
-- today's. Keyed by tenant + product + section with no FK cascade, like
-- every per-product row: each product delete removes them in the same
-- transaction (AC-8).
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
CREATE TABLE "CardEmbedding" ("id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "productId" TEXT NOT NULL, "section" TEXT NOT NULL, "textHash" TEXT NOT NULL, "embedding" vector NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CardEmbedding_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "CardEmbedding_shopDomain_productId_section_key" ON "CardEmbedding"("shopDomain", "productId", "section");
CREATE INDEX "CardEmbedding_shopDomain_idx" ON "CardEmbedding"("shopDomain");
