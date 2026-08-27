-- Primary colour + enrichment versioning (YOY-110 AC-1, AC-2). A colour
-- exclusion applies to the product's primary/displayed colour, not to any
-- colourway it also comes in, so enrichment records the primary colour
-- beside the full `colors` list. The enrichment cache is keyed on content
-- only, so a schema change would never re-run: every row now carries the
-- ENRICHMENT_VERSION it was written at, and existing rows backfill to 0 so
-- the next `npm run ingest` re-enriches the whole catalog at version 1.
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
ALTER TABLE "ProductEnrichment" ADD COLUMN "primaryColor" TEXT;
ALTER TABLE "ProductEnrichment" ADD COLUMN "enrichmentVersion" INTEGER NOT NULL DEFAULT 0;
