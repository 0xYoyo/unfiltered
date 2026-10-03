-- The judge answer cache (YOY-148 AC-1): one stored answer per tenant and
-- cache key (the hash of the normalized search text, the candidate ids in
-- order, each candidate's card text hash, the judge provider and model, and
-- the prompt version). Never evicted (NG-1).
-- The verdict log (YOY-148 AC-4, AC-5): one row per product on every judged
-- or cache-served page, with the clicked-at time a click beacon sets.
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
CREATE TABLE "JudgeAnswer" ("id" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "cacheKey" TEXT NOT NULL, "verdicts" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "JudgeAnswer_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "JudgeAnswer_shopDomain_cacheKey_key" ON "JudgeAnswer"("shopDomain", "cacheKey");
CREATE TABLE "JudgeVerdict" ("id" TEXT NOT NULL, "searchId" TEXT NOT NULL, "shopDomain" TEXT NOT NULL, "productId" TEXT NOT NULL, "page" INTEGER NOT NULL, "position" INTEGER NOT NULL, "verdict" TEXT NOT NULL, "missed" TEXT[], "labelTemplate" TEXT, "cached" BOOLEAN NOT NULL, "clickedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "JudgeVerdict_pkey" PRIMARY KEY ("id"));
CREATE INDEX "JudgeVerdict_searchId_productId_idx" ON "JudgeVerdict"("searchId", "productId");
