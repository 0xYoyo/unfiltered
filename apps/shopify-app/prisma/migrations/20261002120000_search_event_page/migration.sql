-- One SearchEvent row per page request, with its page (YOY-145 AC-10).
-- Rows before the column were single-page responses, so they backfill as 1.
ALTER TABLE "SearchEvent" ADD COLUMN "page" INTEGER NOT NULL DEFAULT 1;
