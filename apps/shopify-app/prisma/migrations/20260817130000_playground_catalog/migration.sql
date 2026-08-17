-- Playground catalog registry (YOY-88 AC-1): one row per public catalog
-- ingested through the generic catalog-source port. storeKey is the tenant
-- key value (`playground:<slug>`) the catalog's rows carry in every
-- shopDomain column. Every statement is single-semicolon for the PGlite
-- test-DB loader.
CREATE TABLE "PlaygroundCatalog" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "lastIngestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaygroundCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlaygroundCatalog_slug_key" ON "PlaygroundCatalog"("slug");

CREATE UNIQUE INDEX "PlaygroundCatalog_storeKey_key" ON "PlaygroundCatalog"("storeKey");
