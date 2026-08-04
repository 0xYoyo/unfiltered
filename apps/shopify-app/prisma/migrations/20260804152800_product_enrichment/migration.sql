-- CreateTable
CREATE TABLE "ProductEnrichment" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "category" TEXT,
    "colors" TEXT[],
    "occasions" TEXT[],
    "fit" TEXT,
    "styleTags" TEXT[],
    "seasons" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductEnrichment_shopDomain_idx" ON "ProductEnrichment"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEnrichment_shopDomain_productId_key" ON "ProductEnrichment"("shopDomain", "productId");
