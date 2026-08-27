-- Vision enrichment (YOY-121 AC-1, PRD capability 14). Five vision-only
-- coverage attributes (vocabularies in packages/engine/src/taxonomy.ts),
-- the image-hash key the vision pass re-analyses on, its status, and both
-- passes' own parsed answers so either side re-merges against the other.
-- Existing rows backfill to "never analysed" (hashes [], status none), and
-- the ENRICHMENT_VERSION bump re-enriches every row on the next
-- `npm run ingest`, which runs the vision pass for every product with images.
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
ALTER TABLE "ProductEnrichment" ADD COLUMN "sleeveLength" TEXT;
ALTER TABLE "ProductEnrichment" ADD COLUMN "neckline" TEXT;
ALTER TABLE "ProductEnrichment" ADD COLUMN "garmentLength" TEXT;
ALTER TABLE "ProductEnrichment" ADD COLUMN "pattern" TEXT;
ALTER TABLE "ProductEnrichment" ADD COLUMN "materialAppearance" TEXT;
ALTER TABLE "ProductEnrichment" ADD COLUMN "visionImageHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ProductEnrichment" ADD COLUMN "visionStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "ProductEnrichment" ADD COLUMN "textAttributes" JSONB;
ALTER TABLE "ProductEnrichment" ADD COLUMN "visionAttributes" JSONB;
