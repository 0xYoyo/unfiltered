-- Server-resolved product link on the catalog snapshot (YOY-87, LEAK-2):
-- result cards link to `url`, resolved once by the ingestion adapter that
-- knows the storefront, so no renderer ever composes a product URL. Nullable
-- and display-only (outside contentHash, like handle/featuredImageUrl).
-- Existing rows are backfilled with the Shopify storefront form where a
-- handle is known -- the next full ingest replaces it with the Admin API's
-- onlineStoreUrl when present.
-- No semicolon anywhere but the statement ends, for the PGlite test-DB loader.
ALTER TABLE "CatalogProduct" ADD COLUMN "url" TEXT;

UPDATE "CatalogProduct" SET "url" = 'https://' || "shopDomain" || '/products/' || "handle" WHERE "handle" <> '' AND "url" IS NULL;
