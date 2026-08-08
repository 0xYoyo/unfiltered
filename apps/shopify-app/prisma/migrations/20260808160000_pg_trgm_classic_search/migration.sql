-- Classic keyword search (YOY-41): pg_trgm trigram index over the catalog's
-- searchable text. The PGlite test-DB loader splits this file on the
-- semicolon character, so every statement — comments included — must contain
-- exactly one, at its end. The function below uses the PG14+ RETURN-clause
-- SQL body for that reason (no body semicolons, unlike quoted bodies).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The searchable text of one catalog row: the keyword fields (title, tags,
-- vendor, productType, imageAltTexts) joined and lowercased. A function
-- (rather than an inline index expression) because array_to_string is not
-- IMMUTABLE-declared, and both the index and every classic query must build
-- the text identically or the index goes unused. array_to_string over text[]
-- is immutable in practice, so the declaration is safe for these columns.
CREATE FUNCTION catalog_search_text(title text, tags text[], vendor text, product_type text, image_alt_texts text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN lower(title || ' ' || array_to_string(tags, ' ') || ' ' || vendor || ' ' || product_type || ' ' || array_to_string(image_alt_texts, ' '));

-- Trigram GIN index the classic query plan matches via the same
-- catalog_search_text(...) call in its WHERE clause.
CREATE INDEX "CatalogProduct_search_text_trgm_idx" ON "CatalogProduct" USING gin (catalog_search_text("title", "tags", "vendor", "productType", "imageAltTexts") gin_trgm_ops);
