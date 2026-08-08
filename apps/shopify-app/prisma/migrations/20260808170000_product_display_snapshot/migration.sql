-- Product display snapshot (YOY-44): storefront handle and featured-image
-- URL on CatalogProduct, for result cards without per-request Shopify calls.
-- Both columns are display-only and deliberately outside contentHash, and
-- existing rows stay valid (defaulted / nullable). Every statement is
-- single-semicolon for the PGlite test-DB loader.
ALTER TABLE "CatalogProduct" ADD COLUMN "handle" TEXT NOT NULL DEFAULT '';

ALTER TABLE "CatalogProduct" ADD COLUMN "featuredImageUrl" TEXT;
