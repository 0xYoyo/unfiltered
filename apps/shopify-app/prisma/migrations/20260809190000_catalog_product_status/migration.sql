-- Product status on the catalog snapshot (YOY-61 AC-3): ingestion and
-- webhook sync only write ACTIVE products, so the default backfills every
-- existing row correctly. Both search stores filter on the column as defense
-- in depth so a non-active row can never be served even if one exists.
-- No semicolon anywhere but the statement end, for the PGlite test-DB loader.
ALTER TABLE "CatalogProduct" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
