-- Product-family key (YOY-117 AC-1): colourways of one product — "Rib Knit
-- Top in Pink" / "in Navy" / "in Black" — share lower(vendor) + "|" + the
-- title with its trailing colourway designator stripped (+ "|" +
-- lower(productType) when present), and both search stores return one card
-- per family. Display-only like `handle` (outside contentHash, refreshed on
-- every sync). Pre-migration rows backfill to '' = "own family" -- the next
-- ingest of each tenant writes the real key.
-- One statement per line, no inner semicolons, for the PGlite test-DB loader.
ALTER TABLE "CatalogProduct" ADD COLUMN "familyKey" TEXT NOT NULL DEFAULT '';
CREATE INDEX "CatalogProduct_shopDomain_familyKey_idx" ON "CatalogProduct"("shopDomain", "familyKey");
