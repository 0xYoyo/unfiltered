-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[],
    "vendor" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "priceMin" DOUBLE PRECISION NOT NULL,
    "priceMax" DOUBLE PRECISION NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "imageAltTexts" TEXT[],
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogProduct_shopDomain_idx" ON "CatalogProduct"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_shopDomain_productId_key" ON "CatalogProduct"("shopDomain", "productId");
