-- Search and click event logs (YOY-47): SearchEvent gets one row per proxy
-- search request (including degraded, zero-hit, and throttled searches);
-- ClickEvent gets one row per verified click beacon. Both are write-only in
-- this milestone. Every statement is single-semicolon for the PGlite
-- test-DB loader.
CREATE TABLE "SearchEvent" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "degraded" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SearchEvent_shopDomain_createdAt_idx" ON "SearchEvent"("shopDomain", "createdAt");

CREATE INDEX "SearchEvent_searchId_idx" ON "SearchEvent"("searchId");

CREATE TABLE "ClickEvent" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClickEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClickEvent_shopDomain_createdAt_idx" ON "ClickEvent"("shopDomain", "createdAt");
