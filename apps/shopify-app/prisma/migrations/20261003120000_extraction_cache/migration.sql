-- The wish extraction cache (YOY-149 AC-18): one validated extraction per
-- cache key (the hash of the normalized sentence, its language, the
-- extraction prompt version and the model id). Additive, never evicted.
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
CREATE TABLE "ExtractionAnswer" ("id" TEXT NOT NULL, "cacheKey" TEXT NOT NULL, "wishes" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ExtractionAnswer_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ExtractionAnswer_cacheKey_key" ON "ExtractionAnswer"("cacheKey");
