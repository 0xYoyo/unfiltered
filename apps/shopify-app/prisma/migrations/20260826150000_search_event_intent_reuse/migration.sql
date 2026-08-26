-- Exact-query intent reuse (YOY-64 AC-4): a submitted search stores the
-- intent it was served with and the normalized query it answered, so an
-- identical query within the reuse window skips classification and intent
-- extraction. Nullable, no backfill: rows from before this column carry no
-- intent and are never reused. Single-statement lines for the PGlite
-- test-DB loader.
ALTER TABLE "SearchEvent" ADD COLUMN "normalizedQuery" TEXT;
ALTER TABLE "SearchEvent" ADD COLUMN "intent" JSONB;
CREATE INDEX "SearchEvent_shopDomain_normalizedQuery_createdAt_idx" ON "SearchEvent"("shopDomain", "normalizedQuery", "createdAt");
