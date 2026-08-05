-- CreateTable
-- The embedding column is dimensionless "vector" on purpose: the vector
-- dimension is owned by the embedding-model configuration
-- (GEMINI_EMBEDDING_DIMENSION), not by the schema. The pipeline creates a
-- dimension-typed expression index at run time and every read casts through
-- that dimension, so a configuration/stored-vector mismatch fails loudly
-- instead of silently comparing incompatible vectors.
CREATE TABLE "ProductEmbedding" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductEmbedding_shopDomain_idx" ON "ProductEmbedding"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEmbedding_shopDomain_productId_key" ON "ProductEmbedding"("shopDomain", "productId");
