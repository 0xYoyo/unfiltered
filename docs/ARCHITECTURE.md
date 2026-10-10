# Architecture

> **Maintenance notice:** any change that alters setup commands, workspace
> layout, auth model, data layer, or the engine API must update this file and
> [README.md](../README.md) in the same pull request. Doc accuracy is part of
> review.

Product requirements live in [PRD.md](PRD.md); this document records how the
codebase is structured and the constraints that structure must preserve.

## Monorepo structure

npm-workspaces monorepo (`apps/*`, `packages/*`) with three workspaces:

- **`apps/shopify-app`** — the embedded Shopify app, generated from Shopify's
  official React Router + TypeScript app template. Owns everything
  Shopify-specific: authentication, session persistence, webhooks, admin UI,
  and (in later milestones) catalog ingestion and the storefront snippet. It
  consumes the search engine strictly as a client of `packages/engine`'s
  public API — see the engine-boundary rule below.
- **`packages/engine`** — the search engine as a standalone TypeScript
  package with its own `tsc` build and zero runtime dependencies: the
  classic-search port, the wish extraction, the judge, and the colourway
  and taxonomy vocabularies (`createEngine()` itself is still a stub that
  returns an empty, well-typed result). Also home of the vendor-free AI ports
  (`LlmClient`, `DecisionClient`, `EmbeddingClient`, `CostRecorder`) that
  provider adapters implement.
- **`packages/provider-gemini`** — the Google AI Studio (Gemini) adapter
  implementing the engine's LLM and embedding ports over plain `fetch`, with
  every call metered through the `CostRecorder` port. Model IDs come only
  from configuration/env (`geminiModelsFromEnv()`; defaults
  `gemini-3.5-flash-lite` for text enrichment, the vision enrichment pass
  (YOY-121, `GEMINI_VISION_MODEL`), the card writer (YOY-143,
  `GEMINI_CARD_MODEL`), the wish extraction (`GEMINI_EXTRACT_MODEL`) and the
  Gemini judge (`GEMINI_JUDGE_MODEL`), `gemini-embedding-001` for
  embeddings); the API key comes from `GEMINI_API_KEY`. Fixture tests only
  by default; live round-trips run solely under `LIVE_LLM_TESTS=1` locally,
  never in CI.

### How the app resolves the workspace packages (YOY-104)

The app, the tests, and the eval runs all execute the workspace packages'
**TypeScript source** — never their compiled `dist/`:

- `apps/shopify-app/vite.config.ts` aliases `@unfiltered/engine` and
  `@unfiltered/provider-gemini` to `packages/*/src/index.ts`, so
  `shopify app dev`, `react-router dev`, and `react-router build` all compile
  the engine from source (Vite handles linked-workspace TypeScript natively;
  the production server bundle inlines it).
- The root `vitest.config.ts` carries the identical alias for every test run
  (YOY-52 run-5 directive), and
  `apps/shopify-app/app/workspace-resolution.test.ts` asserts the two stay
  equal and that `ENGINE_SOURCE_URL` — the URL the engine was loaded from —
  lands under `packages/engine/src` when loaded through the app's own Vite
  resolution.

Each package's `package.json` still `exports` `dist/` (gitignored, rebuilt
only by the root `postinstall` — `npm run build:packages`, which compiles
`engine` then `provider-gemini` in that order; YOY-96 AC-12) for future
package publishing, and
`tsc --noEmit` in the app reads types from `dist/index.d.ts` — but `dist/`
is on no execution path in this repository. Why this matters: PR #74 renamed
the engine port key `shopDomain → storeId` in `src` and in the app; a dev
tree whose `dist/` predated it kept executing the stale port, so every
model-served search returned zero rows and every `AiCall` lost its tenant
while every source-aliased test stayed green (YOY-104 M1).

**After pulling engine or provider changes:** nothing — restart the dev
server if it is running and the new source is what executes. `npm install`
is needed only when dependencies or the Prisma schema changed, exactly as
before. If `npm run typecheck` in the app complains about engine types that
clearly exist in source, the stale part is `dist/index.d.ts`: run
`npm run build --workspace @unfiltered/engine --workspace @unfiltered/provider-gemini`.

The seam is still guarded for consumers of the built artifact: CI's
`dist-seam` job runs `npm run build` and then `orchestrator.test.ts`
through `vitest.dist-seam.config.ts` — the same suite **without** the src
alias, resolving `@unfiltered/*` through
`exports` → `dist/`. A src/dist port-contract divergence fails there and
nowhere else.

## Engine-boundary rule (binding constraint)

The search engine is a separate module/service with its own API, and the
Shopify app calls it as a client. Concretely:

1. The engine exposes its own versioned, typed public API; consumers use only
   that surface.
2. No Shopify types or APIs inside the engine's core — no `@shopify/*`
   dependencies, no Shopify imports, no Shopify-specific concepts in its
   input/output types (generic documents, fields, and scores only).
3. Future catalog sources (a feed + JS snippet for non-Shopify stores, or any
   other platform) integrate by feeding the same engine API, not by
   rewriting the engine.

Any change that would move Shopify knowledge into the engine, or have the app
reach past the public API into engine internals, is an architecture change
and needs explicit human sign-off — not an incidental refactor.

## Auth model

Embedded Shopify app using Shopify-managed installation with token-exchange
authentication (`@shopify/shopify-app-react-router`): embedded requests carry
a session token that the app exchanges for an API access token. There are no
classic authorization-code-grant code paths. Sessions are persisted through
`@shopify/shopify-app-session-storage-prisma`.

### Webhooks

Eight topics are registered in `shopify.app.toml` and handled under
`apps/shopify-app/app/routes/webhooks.*`: `app/uninstalled` (deletes the
shop's persisted sessions), `app/scopes_update`, the three mandatory GDPR
compliance topics `customers/data_request`, `customers/redact`, and
`shop/redact` (acknowledge-and-200 — no shopper data is stored yet), and the
three catalog-sync topics `products/create`, `products/update`, and
`products/delete`, which keep the per-shop `CatalogProduct` snapshot current
between full ingestions (`app/catalog/webhook-sync.server.ts`: payloads map
through the same Shopify→snapshot mapping and content hash as ingestion,
upserts are idempotent, and an out-of-order delivery with an older
`updated_at` never overwrites a newer row). Every handler authenticates
through the library's HMAC verification; signature and auth behavior are
covered by offline unit tests with fixture payloads
(`app/routes/webhooks.test.ts`, `app/routes/webhooks.products.test.ts`,
`app/routes/app.auth.test.ts`, `app/session-storage.test.ts`).

## Data layer

Prisma on Postgres 18 with the pgvector extension
(`apps/shopify-app/prisma/schema.prisma`, currently the template's `Session`
model, the `AiCall` cost-metering ledger, the write-only `SearchEvent` and
`ClickEvent` shopper activity logs (YOY-47; one `SearchEvent` per proxy
search — degraded, zero-hit, and throttled included — and one `ClickEvent`
per verified click beacon, both indexed on `(shopDomain, createdAt)`;
nothing reads them yet except the beacon's searchId validation), and the
`CatalogProduct` per-shop catalog snapshot (unique per `shopDomain` + `productId`, content-hashed for
idempotent re-ingestion via `app/catalog/ingest.server.ts`; also carries the
display-only fields `handle`, `featuredImageUrl` (YOY-44) and the
server-resolved product link `url` (YOY-87: Admin API `onlineStoreUrl`, else
`https://<shop>/products/<handle>`; null when unresolvable) for result
cards, and the product-family key `familyKey` (YOY-117 AC-1:
`lower(vendor) + "|" + normalizedTitle` plus `"|" + lower(productType)`
when present, where `normalizedTitle` is the title with ONE trailing
colourway designator — `in <Colour>`, `- <Colour>`, `/ <Colour>`,
`(<Colour>)`, `<Colour>` being one or two words whose last word is in the
engine's committed `COLORWAY_WORDS` list — stripped, whitespace collapsed,
lowercased; `computeFamilyKey` in `mapping.server.ts`, applied identically
by the Admin ingest, webhook sync, and `ingest:public`; indexed on
`(shopDomain, familyKey)`; `""` for pre-migration rows means "own family")
— all deliberately outside `contentHash`, so ingestion and webhook sync
refresh them even when searchable content is unchanged, and a display-only
change never triggers re-enrichment or re-embedding); the `ProductEnrichment`
attribute record per product (`app/catalog/enrich.server.ts`: `category`,
`colors` — every colourway the text states — `occasions`, `fit`,
`styleTags`, `seasons`, plus **`primaryColor`** (YOY-110), the
primary/displayed colour: the colour named by the title's colourway
designator — `in <Colour>`, `- <Colour>`, `/ <Colour>`, `(<Colour>)` — else
the first colour the text states in reading order (title, description,
tags), else null; the model answers it and `parseEnrichment` re-validates it
against the title and the stated colours, never accepting a colour the text
does not state. Rows are cached by `contentHash` **and** versioned: each row
stores the `ENRICHMENT_VERSION` it was written at (`enrichmentVersion`,
0 for rows from before versioning), and a row at an older version
re-enriches on the next run even when its content is unchanged, so a
prompt/schema/rule change re-runs the catalog exactly once — the content
hash alone could never trigger that. Unchanged content at the current
version makes zero LLM calls); the **`ProductImage`** rows per product
(YOY-120 AC-1; PRD capability 14): up to four image URLs in source order —
`position` 0–3, `url`, `contentHash` = SHA-256 of the fetched bytes,
`fetchedAt`; unique on `(shopDomain, productId, position)`. Written by all
three ingestion paths through `app/catalog/images.server.ts`
(`syncProductImages`): the Admin ingest requests
`images(first: 4) { nodes { url altText } }`, webhook sync maps
`images[].src`, `ingest:public` keeps `images[0..3].src` from the Shopify
feed and up to four `image` entries from JSON-LD (`SourceProduct.imageUrls`),
with the public paths fetching through the polite fetcher. Bytes are hashed
and discarded — never stored, never resized. Rows hold **distinct** images:
the sync walks the source's whole ordered list, hashes each URL's bytes,
records a URL whose hash equals an already-kept one as that row's
`duplicateUrls` entry (a CDN serving one asset under several suffixes),
and stops at four distinct images — so the cap counts pictures, not links.
A URL whose path ends in `/img404` (the White Stuff CDN placeholder) is not
an image: `usableImageUrls` drops it before anything is fetched. Idempotent
by URL: every stored `url` and `duplicateUrls` entry maps to its hash, so a
re-run over an unchanged list makes zero fetches; only a URL the product
never carried is fetched; a position past the kept images is deleted; a
fetch failure is counted (`images: fetched N, unchanged M, failed K` in
every ingest report) without failing the product. Deliberately outside the product `contentHash`:
an image change never dirties the searchable content or triggers text
re-enrichment; vision enrichment (YOY-121) keys its own re-analysis on these
hashes. No FK cascade, like enrichment and embedding rows — every product
delete removes them in the same transaction); the baseline migration runs
`CREATE EXTENSION IF NOT EXISTS vector`, and the classic-search migration
`CREATE EXTENSION IF NOT EXISTS pg_trgm`). The app knows only Postgres
connection strings, from a gitignored `.env` (a managed Neon database in
dev), documented in `.env.example`: `DATABASE_URL` serves queries and
`DIRECT_DATABASE_URL` serves migrations (Prisma `directUrl`, YOY-115 AC-5).
On Render the two differ — `DATABASE_URL` is Neon's pooled `-pooler` host
(PgBouncer, transaction mode, `pgbouncer=true`) and `DIRECT_DATABASE_URL`
the direct host, because `prisma migrate deploy` needs session features a
transaction pooler does not offer; locally both may be the same unpooled
URL, and `docker-entrypoint.sh` defaults the direct URL to `DATABASE_URL`
so an unsplit environment still boots. The classic search's in-statement
`set_config(..., is_local = true)` and every `SET LOCAL` stay
transaction-scoped, which is exactly what transaction pooling preserves.
SQLite is gone.

Tests never require a live database: `createTestDb()`
(`apps/shopify-app/app/testing/helpers.server.ts`) spins up an in-process
embedded Postgres (PGlite) with pgvector and pg_trgm loaded, applies the committed
migration SQL, and hands Prisma a driver adapter for it — so `npm test`
passes with no `DATABASE_URL` set and no external Postgres.

### Vision enrichment at ingestion (YOY-121; PRD capability 14)

Text-sparse catalogs cap what text enrichment can say, so `enrichCatalog`
(`app/catalog/enrich.server.ts`) runs a second, image-driven pass and merges
the two. Every ingest path — `npm run ingest`, `ingest:public`, and nothing
else (webhook sync captures images but enrichment is a run, not a hook) —
passes `vision: { llm, fetchImage }`: the vision-model port
(`createVisionLlmClient`: `GEMINI_VISION_MODEL`, default
`gemini-3.5-flash-lite` per `docs/VISION-MODEL.md`, at
`GEMINI_VISION_THINKING_LEVEL`, default `low`, set explicitly and never the
model default — the YOY-109 lesson) and the fetcher that re-reads the image
bytes (`ProductImage` keeps hashes, never bytes; the Admin path uses the
platform fetch, the public paths the polite fetcher).

**The key.** A product is analysed when it has ≥ 1 `ProductImage` row and its
current image hashes, in position order, differ from the enrichment row's
`visionImageHashes`. Equal hashes make zero vision calls; one changed image
re-analyses that product only (one call, all of its images inline, up to
four); a product whose images all vanish has its vision answer cleared
without a call. The key is independent of the text cache (`contentHash` +
`ENRICHMENT_VERSION`): a text change over unchanged images re-runs the text
side only, an image change over unchanged text the vision side only, and a
product whose text is cached and whose images are unchanged is not written
at all.

**The call.** One `completeStructured` per product, operation `vision`,
`temperature 0`, the images first and then the anchored prompt
(`buildVisionPrompt`): title, product type, description, and tags anchor
WHICH item in the photos is for sale, and the model must "describe ONLY the
item being sold; ignore other garments, footwear, and jewelry worn by
models" — the wording `docs/VISION-MODEL.md` measured at 3.4 % contamination
— with "when text and images disagree, trust the images". The response
schema (`VISION_SCHEMA`) is the shared enrichment fields — `category`,
`colors`, `primaryColor`, `occasions`, `fit`, `styleTags` — plus the five
vision-only fields, each pinned to a closed vocabulary in
`packages/engine/src/taxonomy.ts` (`VISION_SLEEVE_LENGTHS`,
`VISION_NECKLINES`, `VISION_GARMENT_LENGTHS`, `VISION_PATTERNS`,
`VISION_MATERIAL_APPEARANCES`; every list carries `not-applicable`, which
parses to null so a bag's neckline reaches neither the embedding text nor a
filter). `seasons` is absent: a text claim, never a visual one. Two attempts
(an adapter error or schema-violating JSON each count as one), then
`visionStatus: failed` with the hashes recorded, so a model failure retries
only when an image changes — the same rule as text failures, which retry
only on a content change. Images that cannot be fetched at all make no call
and leave the key untouched, so the next run tries again. A vision failure
never fails the run or the product's text enrichment.

**The merge** (`mergeAttributes`, "text-derived values win conflicts on
factual fields, vision fills gaps"): on `category`, `colors`,
`primaryColor`, `occasions`, and `fit` the text value wins when present and
vision fills a null/empty one — a text `category` of `other` counts as
absent (it is `parseEnrichment`'s "nothing mapped" token, not a claim), so
a "Gold straps." product takes `shoes` from its images; `primaryColor`
follows `colors` (text states no colour ⇒ both come from vision).
`styleTags` is the union, text first. `seasons` is text only. The five
vision-only fields are vision's. Text failed but images read is a valid,
vision-only enrichment — the text-sparse catalog is the case the capability
exists for. Each side's own parsed answer is kept raw on the row
(`textAttributes`, `visionAttributes`, JSONB) and the columns are their
merge, so re-running either side re-merges against what the other actually
said, never against previously merged columns.

**Re-embedding.** `composeEmbeddingText` folds the vision fields in after
the text attributes as shopper phrases (`visionAttributeTerms`: "long
sleeves", "v-neck neckline", "midi length", "floral pattern", "knit";
"sleeveless" stays bare), so the composed-text freshness hash moves for
exactly the products whose vision answer changed and `embedCatalog` re-embeds
those and no others. Coverage attributes reach search through that
embedding text, the product card's hints and the judge's rows — never as a
filter.

**Versioning and report.** `ENRICHMENT_VERSION` is 2: every row re-enriches
once on the next run, and the vision pass runs for every product with images
(the rows' `visionImageHashes` backfill to `[]`). Both CLIs print
`vision: analysed N, cached M, failed K, cost $X` after the `enrich:` line —
`analysed` = products sent to the model (enriched or failed), `cached` =
products with images whose key matched, `failed` = two failed attempts or
no fetchable image, `cost` = the run's `vision` ledger rows for the store —
and `/internal/costs` shows the `vision` operation like any other.
**Measured** on the live seed catalog (2026-08-27, YOY-121 AC-7: 465
products, 1,787 images, 0 failures): $0.000474 per image, $0.001823 per
product, **$1.90 per 1,000 products at 4 images each**; the text
re-enrichment and re-embedding of the same run cost $0.41 and $0.02 per
1,000, so a full first-time index is ≈ $2.33 per 1,000 products. The
whole 465-product run — images, text, vision, embed — cost $1.047.

### Product cards at ingestion (YOY-143; PRD §3 Engine v2, Refinements 5, 6, 9)

Engine v2 understands the product once, at load time: a model writes a
plain-text **card** per product, which later steps find and judge against.
`app/catalog/card.server.ts` (`writeCatalogCards`) runs after enrichment,
which it reads, and before embedding. `embedCatalogCards`
(`app/catalog/card-embed.server.ts`, YOY-144) then turns each written card
into `CardEmbedding` rows — one vector for the prose (`facts` + `look` +
`read`) and one per ask language (`asks:<lang>`), re-embedding only a
section whose text hash moved — and the find step searches them; a product
with no written card is found by its `ProductEmbedding` row instead.

**The table.** `ProductCard`, one row per `(shopDomain, productId)`:
`facts` (what the item is and the merchant's stated details, material
first; a detail only a photo shows is written "looks like …"), `look`,
`read` (style, occasion, who wears it — the model's read, never shown to a
shopper and never used to reject a product), `summary` (≤ 300 characters),
`asks` (JSON `{ "<lang>": [10–20 ways to ask] }`), `cardText` (the whole card
as one text) with `cardTextHash` (SHA-256 of it, so it moves only when the
text does), `inputHash`, `cardVersion`, `modelId`, `writtenAt`, and
`status` (`written` | `failed`). No FK cascade, like the enrichment rows:
every product delete removes the card in the same transaction.

**The call.** One structured call per product, operation `card`, through
`createCardWriter` (`GEMINI_CARD_MODEL`, default `gemini-3.5-flash-lite`, at
`GEMINI_CARD_THINKING_LEVEL`, default `low`, set explicitly), metered in the
cost ledger. It carries the merchant's text, the enrichment's merged
attributes as hints ("the merchant's text wins") and up to four images,
re-read through the vision pass's own fetch (`loadVisionImages`,
`fetchInlineImages`). Prose is written in the language of the product's own
text; `asks` covers each configured language (`CARD_ASK_LANGUAGES`, a
comma-separated list of codes, default `en,he`). An answer missing a
section or a language, or with fewer than 10 distinct asks in a language,
is invalid; over 20 asks keeps the first 20, and a long summary is cut at a
word boundary.

**The key.** `inputHash` covers the product's `contentHash`, its enrichment,
its image hashes in position order and the ask languages; variants (stock,
price per size) are outside it. A row whose `inputHash` and `cardVersion`
(`CARD_VERSION`) are current — written or failed — makes zero calls. An
invalid answer or a call error is retried once; two failures write a
`failed` row with the input hash, so the product is retried only when its
inputs change. A product with images none of which can be fetched makes no
call and keeps its row, so the next run tries again. Cards are written in
priority order — in stock first, then most recently updated — one row at a
time, so a run that stops part-way never pays twice for cards it finished.

**The spend cap.** `writeCatalogCards` reads `CARD_SPEND_CAP_USD` (default
`3`; a non-positive or non-numeric value fails loudly). After each product
that made a call it sums the run's `card` ledger rows for the store; once
the sum reaches the cap the run stops. Finished cards stay, the rest stay
unwritten for the next run, the report line ends `cap reached at $X`, and
both `ingest` and `ingest:public` exit non-zero.

**Reports.** `npm run ingest` prints `cards: written N, cached M, failed K,
cost $X` after the `vision:` line (cost = the run's `card` ledger rows for
the store); `/internal/costs` shows the `card` operation. `ingest:public`
writes cards only with `--cards`, so the existing playground catalogs get
no paid card calls unless an operator asks; without it the line reads
`cards: written 0, … (off: pass --cards to write cards)`. Estimate ≈ $4 per
1,000 products for the card text plus the images (PRD §3 Refinement 6);
measured on the seed catalog in the slice after merge.

### Multi-tenant vector search on one shared index (YOY-105)

Every tenant's vectors live in one `ProductEmbedding` table and one
`CardEmbedding` table, each under one HNSW cosine index — an expression index
over the dimension-typed cast, built at run time by `ensureEmbeddingIndex()`
(`app/catalog/embed.server.ts`), because the `embedding` columns are
deliberately dimensionless.

pgvector's HNSW is a **post-filtering** index. It yields its `hnsw.ef_search`
best candidates *table-wide* and only then applies the `shopDomain` predicate,
so a small tenant sitting beside a large one silently loses hits it genuinely
owns: the candidate budget is spent on the large tenant's rows before the
filter runs. The failure is invisible while one store dominates the table and
appears the moment `ingest:public` writes a second `playground:<slug>` tenant.
It is a recall failure, not an isolation failure — the predicate still holds,
so no tenant ever sees another's products.

**The fix: iterative index scans.** Every tenant-filtered vector query runs
inside a transaction that sets

```sql
SET LOCAL hnsw.iterative_scan = relaxed_order
```

(`withTenantVectorScan()` in `app/catalog/hnsw.server.ts`, used by
`queryCardIndex()` in `app/search/card-retrieval.server.ts` — the find step's
card-vector scan and its raw-text `ProductEmbedding` fallback alike — and
`similarProducts()` in `app/catalog/embed.server.ts`). The index then keeps
scanning until the *filtered* result set fills, so recall no longer depends on
the tenant-size ratio, at any asymmetry. `SET LOCAL` is transaction-scoped on
purpose: no global Postgres configuration to keep in sync, no leakage into
unrelated pooled sessions, and the behavior stays visible at the query site.

`relaxed_order` (rather than `strict_order`) is chosen for its far lower cost.
It may emit candidates slightly out of distance order, so each of those queries
wraps its candidate scan in a `MATERIALIZED` CTE and re-sorts by the same keys
outside it — the row *set* is unchanged, the row *order* is exact.

The transaction carries an explicit budget rather than Prisma's implicit
interactive-transaction defaults (2 s to acquire a connection, 5 s lifetime):
`TENANT_VECTOR_SCAN_MAX_WAIT_MS` = 5 s and `TENANT_VECTOR_SCAN_TIMEOUT_MS` =
15 s, forwarded to `$transaction` by `withTenantVectorScan()` (YOY-96 AC-17).
The ceiling bounds how long a wedged scan can hold a pooled connection —
about ten times what a whole vector scan measured live — without turning a
slow-but-correct scan into a degraded answer; it is not the search's latency
budget (YOY-64).

Two alternatives were rejected:

- **Per-tenant partial indexes** — unviable. Playground slugs are created
  dynamically, so this means an unbounded number of indexes created at
  ingestion time, and index count grows with the tenant count forever.
- **Scaling `hnsw.ef_search`** — a heuristic, not a fix. Any fixed multiple
  re-breaks at the next tenant-size asymmetry, and it inflates latency for
  every tenant to serve the smallest. Index and search-parameter tuning is
  separately out of scope (YOY-64 / M5).

The regression test is the small-tenant recall suite in
`apps/shopify-app/app/search/card-retrieval.test.ts`: a 400-product tenant
beside a 2,400-product one whose every vector is nearer to the query, three
card vectors per product, run on the hermetic PGlite database (its pgvector
is 0.8.1, which supports iterative scans, so no real-Postgres lane is
needed). It forces the production-shaped plan with **both**
`enable_seqscan = off` and `enable_sort = off` — the first alone leaves the
planner the cheap fixture-scale option of pre-filtering through the
`shopDomain` index and sorting exactly, which is correct but not the plan
under test. Without iterative scans that plan returns the small tenant
**zero** rows.

## Engine public API (current surface)

`packages/engine` (`@unfiltered/engine`) exports, from `src/index.ts`:

- `version: string` — semantic version of the API contract (`"0.4.0"`).
- `interface EngineDocument` — `{ id: string; fields: Record<string, string> }`.
- `interface SearchOptions` — `{ limit?: number; offset?: number }`.
- `interface SearchHit` — `{ documentId: string; score: number }`.
- `interface SearchResult` — `{ hits: SearchHit[]; totalCount: number; query: string }`.
- `interface Engine` — `{ readonly version: string; search(query, options?): Promise<SearchResult> }`.
- `createEngine(): Engine` — returns the stub implementation (every search
  resolves to an empty result; real search runs in the app's orchestrator,
  below, over the engine pieces and ports listed here).

The engine pieces the search path is built from, each described in its own
section below:

- **Wish extraction** (`src/extract.ts`): `createWishExtractor`,
  `parseExtractAnswer`, `EXTRACT_SCHEMA`, `EXTRACT_PROMPT_VERSION` — the
  stated wishes of one sentence ("Engine v2: stated wishes" below).
- **Judge** (`src/judge.ts`): `createJudge`, `judgeProviderFromEnv`,
  `judgeRow`, `orderByVerdict`, `parseJudgeAnswer`, `JUDGE_PROMPT_VERSION`
  ("Engine v2: the judge" below).
- **Vocabularies** (`src/taxonomy.ts`, `src/colors.ts`): the closed
  category, occasion and vision-attribute vocabularies the enrichment and
  vision passes answer in (`CANONICAL_CATEGORIES`, `CANONICAL_OCCASIONS`,
  `CATEGORY_GROUPS`, the `VISION_*` lists, with their normalizers), and the
  colourway words the product-family rule strips from a title
  (`COLORWAY_WORDS`, `isColorwayDesignator`; Data layer above).

Classic keyword search (the zero-LLM result path; YOY-41):

- `interface ClassicSearchStore` — the keyword-search port the consumer
  implements over its own database. One `search({ storeId, query?, limit? })`
  call returns `{ hits: [{ productId, score }] }` — ranked keyword hits,
  score in [0, 1], higher is better. A request with no query text returns
  every product of the store, unranked, each scoring 0; an absent `limit`
  means the full match set (YOY-107). `normalizeQuery` (trimmed,
  whitespace-collapsed, lowercased) is the shared normalizer. A classic
  search never issues an LLM or embedding call, so it writes no `AiCall`
  rows. It serves keystroke previews, the client-timeout rescue, and the
  find step's keyword half.
- The app's implementation (`apps/shopify-app/app/search/classic-store.server.ts`,
  `createPgTrgmClassicStore`) is Postgres/pg_trgm trigram search. The
  `20260808160000_pg_trgm_classic_search` migration enables the `pg_trgm`
  extension, defines `catalog_search_text(...)` — the lowercased join of
  `CatalogProduct`'s keyword fields (title, tags, vendor, productType,
  imageAltTexts) — and creates a trigram GIN index over that expression;
  classic queries filter with `query <% catalog_search_text(...)` (word
  similarity, threshold lowered to 0.30) and rank title-first
  (`0.7 × word_similarity(query, title) + 0.3 × word_similarity(query, …)`,
  YOY-52 AC-13), so the index serves the plan and one- or two-edit typos
  ("nkie air max") still find the intended product, in English and Hebrew
  alike. **One statement per search (YOY-115 AC-1):**
  the threshold is set inside the statement — a one-row
  `SELECT set_config('pg_trgm.word_similarity_threshold', '0.3', true)`
  subquery is the outer side of a `CROSS JOIN LATERAL` whose inner side is
  the search and references that row, so the executor runs `set_config`
  before the `<%` scan reads the GUC (the plan is one Nested Loop with the
  threshold subquery outer; `classic-store.test.ts` pins that order and
  counts exactly one statement per search). `is_local` scopes
  the setting to the statement's transaction, so it never leaks through a
  pooler. The same statement returns the card fields (title, url, image,
  prices, currency, availability) on every hit (`ClassicCardHit`), so the
  orchestrator builds classic result cards without a follow-up hydration
  query — a preview's or a rescue's `stages` reads `classic` with no
  `hydrate` (AC-3), and each is exactly one database round trip. A classic
  store that returns bare hits (a fake, another implementation) still
  hydrates.

**One card per product family (YOY-117 AC-2, founder decision):** public
catalogs and the seed alike expose colourways as separate products ("Mesh
Over Dress in Pink" / "in Navy"; six "Wildfire Retro Treeline T-Shirt"
cards on `/s/tentree`). The classic store and the card index both collapse
each `familyKey` to one representative INSIDE the SQL (`DISTINCT ON
(family)` over the ranked candidates, the limit applied after the collapse,
so any count is of families, never colourways): the classic store keeps the
best-ranked member, the card index the nearest one, and the find step's
merge keeps each family once across the two (the earlier member stands for
it). An empty `familyKey` is its own family, and two products sharing vendor
and title but not product type never collapse, so the rule can never hide a
different product.

The card-index candidate scan keeps a bound of its own (YOY-125 AC-10,
YOY-144): `limit × FAMILY_OVERSCAN × cardSectionsPerProduct(...)` card rows
(`FAMILY_OVERSCAN = 8`; sections per product are one prose vector plus one
per ask language, never fewer than `CARD_SECTION_OVERSCAN = 3`) and
`limit × FAMILY_OVERSCAN` raw-text rows, in `card-retrieval.server.ts`. An
unbounded `ORDER BY distance` inside the scan's CTE cannot use the HNSW
iterative scan `withTenantVectorScan` enables (YOY-105) — Postgres would
compute the distance for every vector of the tenant and sort them, on every
search: invisible on the seed catalog, a latency regression proportional to
catalog size on `/s/tentree`, `/s/whitestuff`, and any real merchant. The
trade-off the constant buys: a window filled by more than eight colourways
of one family can crowd out a further family that would otherwise have made
it. Eight is the headroom that keeps the common colourway depth (three to
six members) fully visible to the collapse.

AI ports (vendor-free; implemented by provider adapter packages):

- `type JsonSchema` — `Record<string, unknown>` JSON Schema document.
- `interface StructuredCompletionRequest` — `{ prompt; schema; operation; temperature?; storeId?; searchId?; signal?; images? }`.
  `images?: InlineImage[]` (YOY-120 AC-3; PRD capability 14) carries raw
  image bytes with their MIME type, vendor-free; the Gemini adapter sends
  each as an `inlineData` part **before** the text part and meters usage
  exactly as `usageMetadata` reports it, image tokens included. Absent or
  empty, the request body is byte-for-byte the text-only call. The vision
  pass (YOY-121) and the card writer (YOY-143) send images.
- `interface InlineImage` — `{ mimeType: string; data: Uint8Array }`.
- `interface LlmClient` — `{ completeStructured(request): Promise<unknown> }`.
- `interface DecisionClient` — `{ decide(request): Promise<Record<string, DecisionAnswer>> }`:
  typed answers (`choice` or `yes-no`) to typed questions, no free text
  (YOY-152); the Jev judge's port, implemented over OpenRouter in
  `app/ai/openrouter.server.ts`.
- `interface EmbeddingRequest` — `{ texts: string[]; operation?; storeId?; searchId? }`.
- `interface EmbeddingClient` — `{ readonly dimension: number; embed(request): Promise<number[][]> }`.
- `interface AiCallUsage` / `interface CostRecorder` — the metering port every
  adapter records through.

The app's `/healthz` route (`apps/shopify-app/app/routes/healthz.tsx`) calls
`createEngine().search(...)` and proves the wiring end to end.

## Search orchestrator (YOY-45)

`apps/shopify-app/app/search/orchestrator.server.ts`
(`createSearchOrchestrator({ db, classicStore, find, judge?, wishExtractor?,
… })`) is the one server-side entry point behind the product's single
search bar — a function; the HTTP surfaces over it are the app-proxy
endpoint (YOY-46) and the playground API (YOY-90) below.
`runSearch({ query, shopDomain, previousQuery?, removedChips?, preview?,
forceClassic?, forceClassicReason?, searchId?, limit?, paging? })` always
resolves to one response shape:
`{ searchId, route, routeReason, hits, chips, degraded, stages }`, plus on a
submitted search `page`, `totalCount`, `extractionInTime`,
`extractionCached` and `carry`, and — when they apply — `labelsPending`,
`otherReading` and `judgeCalls`. `hits` are display-ready product cards
(`productId`, `title`, `url`, `imageUrl`, `priceMin`/`priceMax`,
`currencyCode`, `available`; `handle` never leaves the adapter — YOY-87)
hydrated from the `CatalogProduct` snapshot in rank order, with `label` on
every submitted-search card and the diagnostic `verdict`/`standIn` the
playground shows. One `searchId` is generated per search (unless the caller
threads its own) and forwarded to every AI port call, so all `AiCall` rows
serving one search share it. The orchestrator holds no session state: the
refinement chain (`previousQuery`) and the removed chips arrive with each
request.

There is one search path, and two keyword-only requests beside it. (The
engine that preceded it is preserved at the `engine-v1-last` tag.)

1. **A submitted search** runs the find step (YOY-145) with the wish
   extraction started alongside it (YOY-149), composes the stated wishes
   onto the find order, hydrates one page, and judges the page's part
   inside the find set (YOY-147). The sections below describe each step.
   A throttled session or a playground cap (`forceClassic`, YOY-47) runs
   the same steps but never calls the judge: the page is served in composed
   find order, route `classic`, reason `capped`.
2. **A keystroke preview** (`preview`, YOY-68) and **the widget's
   client-timeout rescue** (`forceClassicReason: "client-timeout-rescue"`,
   YOY-96 AC-9) are classic keyword search on the raw query — zero model
   and zero embedding calls, route `classic`, no chips, no labels. The
   rescue is `degraded: true` and pages by slicing its full result; a
   preview is never paged.

No model failure reaches the caller. A failed embedding or card-index query
serves the keyword order with `degraded: true` and nothing judged; a late or
failed extraction composes the page without stated wishes; a judge that
times out, fails, or answers invalidly twice serves find order. Classic-store
errors are not caught: the keyword store is the floor and shares its
database with everything else, so a failure there is an infrastructure
outage that must surface to the caller's own error handling.

The eval's Constructor suite (`app/eval/constructor-v2.test.ts`, see
`app/eval/README.md`) searches every golden through this orchestrator and
treats a degraded or unjudged answer as a hard error: offline replay must
never let a fallback mask a missing recording.

### Latency work on the search path (YOY-64)

**The ledger leaves the hot path (AC-1).** Production wraps the Prisma
`CostRecorder` in `createQueuedCostRecorder`
(`app/ai/cost-recorder.server.ts`): `record` validates the usage
synchronously (an unpriced model still throws, before anything is queued)
and resolves as soon as the insert is queued; writes chain in order, a
failed insert is logged (`[ai-cost] ledger write failed …`) and never
fails the search, and `flush()` awaits the queue. The synchronous
recorder is what tests and the eval harness use, so ledger assertions
stay exact. The other latency levers of the search path — the extraction
running alongside find, the judge's deadline and the answer and extraction
caches — are described with their steps below.

### Per-stage timing: `stages` (YOY-114)

Every response carries `stages: Partial<Record<SearchStage, number>>` — whole
milliseconds per pipeline stage the search actually ran, keyed in pipeline
order from the fixed set in `app/search/stages.ts`:
`find | compose | classic | hydrate | judgeRows | judge`. A stage that did
not run is absent, so the key set is itself the path's evidence: a preview
or a rescue reads `classic` alone; a submitted search reads `find`,
`compose` when a stated wish applied, `hydrate`, and `judgeRows` and `judge`
when the judge step ran. `find` times the whole find step (the embedding,
the card-index query and the keyword search); `compose` the stated wishes
applied to the find order; `judgeRows` the judge step's database work and
`judge` the rest of it, the call and its wait (YOY-159). Values are floored
and the stages run one after another, so none exceeds the wall time around
`runSearch` (`orchestrator.test.ts` pins the key sets and the bound). `stages` is diagnostic: the
playground shows it, the proxy route logs it, nothing persists it, and the
storefront contract never carries it. The measurement method built on it is
docs/LATENCY.md.

## Engine v2: the find step and server-side pages (YOY-145)

`apps/shopify-app/app/search/find.server.ts` (`createFindStep({ db,
embeddings, classicStore, findSetSize? })`) is the first step of every
submitted search. The orchestrator takes it as `find`; `runSearch` takes
`paging: { page, pageSize }` for one page, and a submitted-search response
carries `page` and `totalCount`.

- **Find.** The raw sentence, trimmed, is embedded as one vector (one
  `embedding` ledger row per new query; the find step caches recent query
  vectors, so a page request re-embeds nothing) and the nearest
  `FIND_SET_SIZE` products (default 150) come from `queryCardIndex` — card
  vectors, else the raw-text `ProductEmbedding` row, collapsed by product and
  family. Alongside, the pg_trgm store returns its full keyword match set with
  no constraints. Nothing but store, `ACTIVE` and published removes a
  product: no category, colour, occasion, price or attribute filter runs.
- **Merge order** (`mergeFindOrder`). Keyword matches whose classic score is
  at least `STRONG_TITLE_SCORE` (0.9 — a title similarity of at least 6/7,
  the title holding the whole query) lead in keyword order; then the find
  set in vector order; then every remaining keyword match in keyword order.
  Each product appears once, and each family once (the earlier member stands
  for it).
- **Failure.** Only the page's products are hydrated. Route and routeReason
  come from the judge (next section). When the embedding call (or the
  card-index query) fails the page is the keyword order, `degraded: true`,
  with no find set to judge; a keyword-store failure propagates.
- **Pages.** Both search APIs take `page` (1-based; anything else is 1) and
  `pageSize` (1–48; anything else is 24). A submitted search always pages,
  the first page of 24 when no page parameter came. The client-timeout
  rescue pages by slicing its full keyword result (the request's `limit` is
  dropped) and, without page parameters, answers unpaged. Keystroke previews
  ignore paging and never reach the find step: zero model and zero embedding
  calls.
- **Logging.** `SearchEvent.page` (default 1) records the page each request
  served: one row per page request.
- **Measured on recall, not order.** A description wish ("long sleeves") is
  the judge's to rank, never the find step's. `find-recall.test.ts` holds the
  find step to recall on the committed seed fixture: every long-sleeve midi
  dress is among the 150 candidates for "long sleeve midi dress", offline,
  from a recorded query vector (`app/search/data/find-recall-query.json`).

## Engine v2: the judge (YOY-147)

`packages/engine/src/judge.ts` holds the one judge interface (`Judge`) and
the one factory (`createJudge({ provider, clients, maxRowChars? })`):
`JUDGE_PROVIDER` (`judgeProviderFromEnv`; default `jev` since YOY-152
AC-9, `gemini` the selectable fallback) picks which provider's client
answers, and only that client is built. The judge model is the provider's
own config (`OPENROUTER_JUDGE_MODEL`, Jev; `GEMINI_JUDGE_MODEL`, Flash-Lite,
thinking level low); no other code names it. The orchestrator takes the
judge as `judge` and its deadline as `judgeDeadlineMs`
(`JUDGE_DEADLINE_MS`, default 1,500); `app/search/judge-step.server.ts`
runs one page.

- **One call per page inside the find set.** `FindResult.findSetCount` is
  how many products from the front of the merged order are the find set (the
  strong title matches and the vector hits). The page's part inside it is
  judged in one call (temperature 0, ledger operation `judge`); a page beyond
  it is served in keyword order with no call (`find-only`), and a page
  straddling the boundary keeps its keyword tail after the judged part.
- **Rows.** One per candidate (`judgeRow`): title, price, the written
  card's `facts` — or, with no card, the description's first 200 characters
  — then the enrichment's vision attributes as `key: value` (sleeve length,
  neckline, garment length, pattern, material appearance) where present,
  then option names with the values the variants offer, cut to
  `JUDGE_ROW_CHARS` (default 480). Facts, not the card summary (AC-17): a
  summary often leaves out the sleeves, and a judge that cannot see them
  marks every candidate close. The prompt makes `E` conditional on every
  stated wish being met by the row; a wish the row contradicts or omits is
  `C` with the `D` flag. The sentence rides a `Query:` line, which keys
  replay recordings.
- **Score runs.** `score.yml` and `npm run score:public` set
  `JUDGE_DEADLINE_MS=4000` (AC-18): the score measures the judge's judgment,
  not its speed. Speed is the latency probe's, on the deployment; production
  keeps 1,500 ms.
- **Answer.** Fixed-schema JSON in short codes, no prose field: `c` holds one
  three-letter code per candidate in page order — verdict (`E` exact, `V` the
  same item in another colour or size, `C` close, `N` not relevant), missed
  wishes (`-`, `F` fact, `D` description, `B` both), label (`F`
  fact-differs, `C` close-match, `X` none) — and `d` holds, per fact-differs
  label, the candidate's number with the product's value `p` and the asked
  value `a`. Codes, not one object per candidate, because output tokens are
  the latency: Flash-Lite pretty-prints structured JSON, and a page of 24 as
  objects ran ~950–1,500 output tokens and 2.5–4 s against the 1,500 ms
  deadline; as codes it is ~140 tokens and about 1 s. An answer that is
  not one known code per candidate, or whose side list names a candidate
  twice or out of range, is asked once more, then fails
  (`JudgeAnswerError`).
- **Jev's fact picks (YOY-158).** The decision judge writes no text, so it
  asks per product, in the same request as the verdict, two pick-one
  questions over closed lists (`decisionFactQuestions`): which of the
  product's option names the asked fact concerns, and which word or
  adjacent word pair of the sentence (`sentencePhrases`, as typed) names the
  asked value — each plus `none`. A product with no option (or only
  Shopify's `Title: Default Title`) is not asked them. When the verdict is
  labelled (`close`, `other-variant`), the `fact` flag is up and both picks
  land, the label is `fact-differs` with the picked option's values from the
  variants (joined, at most three words) and the picked words; otherwise
  `close-match`, as is a pick off its list or an asked value the product
  offers — a value holding the asked words whole ("Charcoal Grey" for
  "grey") or the asked words holding a whole value, never a sub-word
  (YOY-171 AC-10). `JUDGE_PROMPT_VERSION` 4 keys the answer cache past the change.
- **Order and labels.** `orderByVerdict`: verdict rank, ties in find order.
  A "not relevant" product is dropped from a page that has anything better
  (YOY-163), as an excluded one is, so a page can come out short (no
  backfill; `totalCount` still counts the find order). Its verdict-log row
  is still written, at `position: -1`. When every product left is "not
  relevant" the page stays in find order and every card carries
  `close-match`. A stand-in verdict (a call that failed, timed out or
  answered invalidly; YOY-159) is never dropped: the product follows every
  judged product of the page, in find order — so on the wire it sits after
  the matches and before "Close matches" — labelled `unchecked` ("not
  checked yet", YOY-171 AC-2; it wins over a code label, since the judge
  never saw the card), and never counts toward the all-not-relevant case —
  a page of only stand-ins is served in find order, each `unchecked`. A
  late page (AC-1) replaces them. Playground `details.judge.verdicts` mark it `standIn`. A fact-differs value longer than three words, or a missing
  value, drops that label. Every submitted-search result on the wire carries
  `label` (`{ template, values }` or null); a classic result has no `label`
  key.
  The verdict never reaches the storefront.
  On the wire a judged page with a match serves its close products in
  `closeMatches`, under the "Close matches" divider (`splitCloseVerdicts`,
  YOY-166). A match is `exact`, and `other-variant` too only under a judge that writes the
  merchant-fact label (Flash-Lite): under Jev an `other-variant` card carries
  `close-match` — or `fact-differs` when its fact picks land (YOY-158) — and
  goes under the divider with the close ones (YOY-157 AC-27).
- **Fallbacks.** The deadline serves find order (`judge-timeout`) without
  aborting the call (YOY-148, below); a failed call or an answer invalid twice serves find
  order (`judge-error`); a throttled session or a playground cap — the
  requests that force classic — serve find order with no call (`capped`).
  The client-timeout rescue stays the keyword path. No error reaches the
  shopper.
- **Route and caps.** `route` names the path that answered (YOY-157 AC-23):
  `ai` for every page that went through find — judged, served from the
  answer cache, timed out, failed or find-only — and `classic` only for a
  capped or forced-classic page, a preview or the client-timeout rescue.
  The session throttle and the playground's daily caps (both counted from
  `route = "ai"`) therefore count every find-path search, cached ones
  included. `routeReason` is
  one of `judged`, `judge-timeout`, `judge-error`, `judge-cached`, `capped`,
  `find-only`.
- **Per-call limit and pool (YOY-159).** The Jev judge's 24 calls share one
  keep-alive `undici` pool (`createOpenRouterPool`, 32 connections, idle
  connections kept 60 s), warmed with 24 parallel HEAD requests when the
  client is first built. Each product's call is aborted past
  `JUDGE_CALL_TIMEOUT_MS` (default 1,200, under the 1,500 deadline): that
  product gets a stand-in "not relevant" verdict (`standIn: true`) and the
  answer is `partial` — served, never cached — so one straggler no longer
  turns the page into a deadline miss. A stand-in is no judgment: the
  product stays on the page, after the judged ones and `unchecked` (see
  Order and labels).
  The probe that chose this (one slow call per page, median call fast,
  database work under 340 ms at p95) is on the issue.
- **Diagnostics.** The step is split in two stages (YOY-159): `judgeRows`
  is its database work — the page's rows, the card hashes and the cache
  key, the answer-cache read and write, the verdict log — and `judge` is the
  rest, the call and its wait. Playground `details.judge` is `{ outcome,
  verdicts: [{ productId, verdict }], calls }` on a find-path response
  (verdict null where the judge did not answer), null otherwise. `calls` is
  `{ settled, slowestMs, medianMs, open }`: the judge's single provider calls
  (one per product for Jev) as the page was served, each timed by the
  adapter through `JudgeRequest.onCallSettled`; on a deadline miss the calls
  still running count as the time they had run and `open` is true. Null
  when no call started (a cached answer). The probe's `[judge, all sets]`
  line prints the p50/p95 of `judgeRows`, of the slowest call and of the
  median call. None of it reaches the storefront wire.

### Answer cache, verdict log and late labels (YOY-148)

- **Answer cache.** `JudgeAnswer` holds one answer per tenant and cache key:
  the SHA-256 of the normalized search text (trimmed, whitespace-collapsed,
  case-folded), the page's candidate ids in order, each candidate's
  `ProductCard.cardTextHash` ("" with no written card), the judge's
  `identity` (`provider:model`, from `createJudge`'s `modelIds`) and
  `JUDGE_PROMPT_VERSION` — bump that constant with every prompt, row or
  schema change. Price and stock are not in the key, so a price or stock
  change still hits; a card rewrite misses. A hit makes no call and serves
  the stored verdict order with `routeReason: "judge-cached"` and route
  `ai`, so caps and the throttle count it like any other find-path search
  (YOY-157 AC-23). No eviction or expiry; kept at uninstall.
- **Verdict log.** `JudgeVerdict`: one row per product on every judged or
  cache-served page — search id, store, product, page, whole-order position
  as served, verdict, missed-wish flags, label template, `cached`. A click
  beacon (`writeClickEvent`, both APIs) sets `clickedAt` on the clicked
  product's row. Nothing reads the table yet.
- **Late labels.** The deadline no longer aborts the call: it runs on until
  it answers or `JUDGE_GIVE_UP_MS` (default 6,000, counted from the call's
  start) aborts it, and an answer is stored in the cache either way. A
  response served on a deadline miss carries `labelsPending: true` (absent
  otherwise). `GET /apps/unfiltered/labels` (proxy-signed; alias `/labels`)
  and `GET /api/playground/labels` take `searchId` and `page`, hold until
  the judge answers or gives up, and answer the late page (YOY-171 AC-1):
  `{ page, labels }`, where `page` is the judged page in the search
  response's own shape — the proxy's `ProxySearchResponse`, the playground's
  `PlaygroundSearchResponse` with its details timed from the search's start
  — composed exactly as the in-time path composes it: the step's `serve`
  (verdict order, not-relevant dropped, the verdict log written; a partial
  answer's stand-ins included), the keyword tail, code labels over the
  judge's (YOY-149 AC-12, YOY-160), the `closeMatches` split and the second
  reading. `labels` is the same page flattened to `{ productId: label | null
  }`, kept for one release. When the judge gave up or failed, or nothing is
  held for that shop's search and page, the answer is `{ labels: {} }` with
  no `page`. The playground, the overlay and the theme-native grid replace
  the page's cards with `page` in one render, scroll held; a `labels`-only
  answer still fills the reserved lines in place. The pending pages live in
  process memory (`parkLatePage` in `app/search/judge-step.server.ts`, parked
  by the orchestrator), kept 60 s after they settle.
- **Costs.** `/internal/costs` shows judge calls (ledger rows under
  operation `judge`), cache hits (searches served `judge-cached`) and the
  hit rate, hits over hits plus calls.

## Engine v2: stated wishes, chips and code labels (YOY-149)

The three kinds of wishes (docs/PRD.md §3) applied by code. Packages:
`packages/engine/src/extract.ts` (the extraction), `app/search/wishes.server.ts`
(the composer), `config/currency-rates.json` (the rates).

- **Extraction.** `createWishExtractor` makes one Flash-Lite call (operation
  `extract`, `GEMINI_EXTRACT_MODEL`, thinking level low) that starts with
  the search, in parallel with find, under a throttle or cap too. It returns
  only price max/min, currency, size, in stock, excluded terms (as typed and
  in English) and whether price or size was firm. `parseExtractAnswer`
  keeps a price only when its digits appear in the sentence (thousands
  separators ignored) and a size or excluded term only when it appears
  verbatim, ignoring case. When find finishes, the page waits for it at
  most `EXTRACTION_GRACE_MS` (800, by the 2026-10-03 decision, AC-18) and
  composes the moment it lands; a late or failed extraction leaves the page
  composed without it — no chips, no tiers, no code labels, no exclusion
  filter. `extractionInTime` on every find-path response (and in playground
  `details`) records which; the score table's "no extraction" column and the
  latency probe's `no-extraction=` give the share composed without it.
- **Extraction cache** (AC-18, `app/search/extraction-cache.server.ts`).
  `ExtractionAnswer` holds one validated extraction per key: the SHA-256 of
  the normalized sentence, its language by script, `EXTRACT_PROMPT_VERSION`
  and the model id. Not keyed by tenant — the answer depends on the
  sentence alone; never evicted. A hit makes no call. A late call is not
  aborted: it runs on and fills the cache, so the next search is warm.
  `extractionCached` (response and `details`) says the cache answered; the
  score table's "extraction cached" column and the probe's
  `extraction-cached=` give the share. `score-run.mts --passes 2` runs the
  set twice on one scratch database — cold, then warm — each pass with its
  own spend and `extract calls` line.
- **Removed chips.** Both APIs take `removedChips` (a JSON array of
  `{ field, value }`, at most 20). A removed fact is not applied and its
  chip is absent. Removing a chip is a fresh submitted search of the same
  query with the removed list and the held chain — no special path.
- **Composer** (`composeWishes`, the `compose` stage), over every result of
  the find step before pages are cut:
  - Walls remove products from the results and the count: a firm price
    (cheapest variant over the cap); a firm size (no in-stock variant in
    that size — a product that does not offer the size has none); a stated
    "in stock" (sold-out products); an exclusion (every variant carries
    the term as an option value, or the card facts state it — typed or
    English form, a whole word in any script).
  - Number tiers sort the find front only — the first `TIER_FRONT_SIZE`
    (48) surviving candidates in find order: every number wish met, then
    the price within `PRICE_NEAR_PERCENT` (10) over the cap with the rest
    met, then other misses, each tier in find order. Candidates past the
    front and the keyword tail keep their order and never jump ahead
    (2026-10-03: a soft budget never outranks relevance). Within a page the
    judge orders by verdict, then tier, then find order; on a judge
    timeout, error or cap the page keeps tier-then-find order.
  - A size matches a variant option value, ignoring case: offered and in
    stock is met, offered and sold out a miss, not offered met.
  - A cap in a currency other than the product's converts through USD with
    `config/currency-rates.json` (hand-entered, with `asOf`); an unlisted
    pair leaves the number unapplied while its chip still shows.
- **Code labels.** `price-near` / `price-far` carry the product's cheapest
  price in its currency and the cap as stated (`"105 USD"`, `"400 ILS"`);
  `size-missing` carries the size and up to two in-stock values nearest it
  in the merchant's option order. A code label replaces the judge's on the
  same card and holds after a judge timeout, error or cap.
- **Judge exclusions.** The judge answer gains `x`, the numbers of products
  the shopper excluded; `orderByVerdict` drops them from the page and they
  carry no label. `JUDGE_PROMPT_VERSION` is 2.
- **Chips.** One per kept fact, fields `priceMax`, `priceMin`, `size`,
  `availability`, `exclude`. A price chip's value is the shopper's own
  number with `currency` when they stated one; an exclude chip's value is
  the term as typed.

## Engine v2: refinement and the second reading (YOY-150)

"Same but cheaper" means nothing without the sentence before it, and
"wedding dress" can mean a bridal gown or a guest's dress. The engine
handles both with plain sentences, not a structured query form.

- **The chain on the wire.** Both APIs accept `previousQuery` (a plain
  string, at most 2,000 characters; never on a preview or the classic
  rescue). Every find-path response carries `carry`: the text the client
  sends as `previousQuery` next time. `nextCarry` builds it — the query
  alone on a fresh search or when the extraction says it replaces the
  chain; otherwise the chain's first sentence plus its two most recent
  refinements, one sentence per line. A late or failed extraction counts as
  refining. Previews and the rescue answer no `carry`.
- **Find.** With a previous chain, one embedding call embeds the new
  sentence alone and the chain plus the new sentence; the two nearest sets
  merge by distance, each product once at its nearer distance
  (`mergeNearest`). Keyword matches stay on the new sentence.
- **Extraction.** The prompt shows the previous search, says the new one
  may refine or replace it, and asks `refines`. A refining answer may carry
  the chain's wishes and is validated against the chain and the new
  sentence together; a replacing one against the new sentence alone. The
  chain is part of the extraction-cache key. `EXTRACT_PROMPT_VERSION` is 3.
- **Removed chips belong to their chain.** They hold across a refinement;
  a query the extraction says replaces the chain starts with none.
- **Judge.** The prompt shows the previous search too, and the answer gains
  `r` — a second reading of the search, at most four words in the
  shopper's language, or `""` — and `rn`, the numbers of the products that
  fit it. A reading no listed product fits, or one over four words, is
  dropped; it never invalidates the answer. The chain is part of the
  answer-cache key, and the stored answer holds the reading (a row from
  before it reads as no reading). The response carries it as
  `otherReading` on page 1 only. `JUDGE_PROMPT_VERSION` is 3.
- **Clients.** The widget and the playground hold `carry` in memory only.
  Every submitted search sends it; a chip removal re-asks with the chain
  that produced the results on screen. The overlay's and the playground's
  "New search" clear it; the theme-native path has no such control and
  gains none. `otherReading` renders as one chip at the start of the chip
  row, "{reading} instead?" from the EN and HE catalogs, with the reading
  in a `<bdi>`; tapping it searches the reading afresh with no
  `previousQuery`. No dialog, no blocking question.

## Storefront search API over the app proxy (YOY-46)

The storefront widget reaches the orchestrator through a Shopify app proxy:
`shopify.app.toml` routes `/apps/unfiltered/*` on the shop domain to the app
(`[app_proxy]`, `prefix = "apps"`, `subpath = "unfiltered"`), so the endpoint
is same-origin from the shopper's browser by construction — no CORS surface.
The route is `apps/shopify-app/app/routes/apps.unfiltered.search.tsx`
(`POST /apps/unfiltered/search`); parsing, serialization, and the production
orchestrator wiring live in `apps/shopify-app/app/search/proxy.server.ts`.

**Auth.** Every request is authenticated with
`authenticate.public.appProxy`, which verifies Shopify's proxy signature over
the query params. A missing or invalid signature is answered `401` with an
empty body before any search code runs. The shop identity used for retrieval
comes exclusively from the signature-verified query params (`shop`) — never
from the request body, which a shopper controls. A malformed body is answered
`400`, also with an empty body.

**Request.** The widget sends GET query parameters (YOY-60 AC-1: the proxy
edge rejects browser POSTs, which carry `Origin`); the route's action keeps
the same contract as a JSON POST body, and both go through
`parseProxySearchBody`:

```json
{
  "query": "elegant dress for a wedding",
  "sessionId": "widget-generated-id",
  "mode": "preview | classic — absent on a submitted search",
  "page": 1,
  "pageSize": 24,
  "previousQuery": "the previous response's carry, as-is",
  "removedChips": [{ "field": "exclude", "value": "black" }]
}
```

`query` and `sessionId` are required. `mode=preview` is a keystroke preview
and `mode=classic` the client-timeout rescue; both are bare classic fetches
and reject `previousQuery` (400). `page`/`pageSize` are lenient (see Pages
above); `previousQuery` (at most 2,000 characters) and `removedChips` (at
most 20, each a known chip field) are strict, and a violation answers 400.

**Response JSON** — the exact contract, pinned by a shape test; no field
beyond it appears in any response body, including on the degraded path, and
no Shopify tokens or internal error details ever do. The orchestrator's
`stages` ledger (YOY-114) is deliberately NOT on it — the widget has no use
for it and the storefront wire stays pinned (`proxy-contract.test.ts`
asserts its absence on every route); instead the route logs one structured
line per submitted search, never per preview:
`[search] stages {"searchId","route","routeReason","latencyMs","stages"}`.

```json
{
  "searchId": "uuid",
  "route": "classic | ai",
  "degraded": false,
  "results": [
    {
      "productId": "gid://shopify/Product/1",
      "title": "…",
      "url": "… | null",
      "imageUrl": "… | null",
      "priceMin": 100,
      "priceMax": 150,
      "currencyCode": "ILS",
      "available": true,
      "label": { "template": "price-near", "values": ["…"] }
    }
  ],
  "chips": [{ "field": "priceMax", "value": "400", "currency": "ILS" }],
  "closeMatches": [{ "…": "results shape; a judged page's close products" }],
  "page": 1,
  "totalCount": 87,
  "labelsPending": true,
  "carry": "elegant dress for a wedding",
  "otherReading": "bridal gowns"
}
```

`label` is on every submitted-search result (null when it carries none) and
absent on classic results. `closeMatches` appears only on a judged page that
holds both a match and a close product (`splitCloseVerdicts`, YOY-166); `page` and `totalCount` on a
paged response; `labelsPending` only after a judge deadline miss; `carry` on
every submitted-search response; `otherReading` only when a page-1 product
fits it. The serializer re-maps every field explicitly
(`serializeProxySearchResponse`), so orchestrator-internal diagnostics like
`routeReason` and the judge's verdicts — and anything the orchestrator
response grows later — cannot leak to a shopper.

**Search logging (YOY-47).** Every submitted search request — degraded,
zero-hit, throttled, and classic-rescued included — writes exactly one
`SearchEvent` row (searchId, shop, sessionId, query, resolved route, the
orchestrator's `routeReason`, degraded flag, latency, result count) through
`app/search/events.server.ts`. The write is an observer: a logging failure
is swallowed and logged server-side, never failing the shopper's response.
`routeReason` (YOY-96 AC-9; nullable, rows from before the column are null)
is what tells a row's cause apart in the ledger — the judge's outcome on a
submitted search, `capped` for a throttled or capped one, or the widget's
`client-timeout-rescue` — so rescue frequency and judged searches can be
measured rather than inferred. The table's `intent`
and `normalizedQuery` columns are kept but no longer written.

**The classic rescue (YOY-108, YOY-96 AC-9).** When the widget's SUBMITTED
search runs out its own client-side budget it re-asks the same query with
`mode=classic`: the proxy routes it through the orchestrator's
`forceClassic` path with reason `client-timeout-rescue` — zero LLM calls,
no throttle budget consumed, `degraded: true` — and, unlike a
`mode=preview` keystroke fetch, logs it as a real `SearchEvent` and returns
an attributable `searchId`, so the widget keeps it as `currentSearchId` and
a click on a rescued card beacons like any other. Like `preview`, `classic`
is a bare classic fetch and rejects `previousQuery` (400).

**Click beacon (YOY-47).** `POST /apps/unfiltered/click`
(`app/routes/apps.unfiltered.click.tsx`), signature-verified exactly like
the search route. Body: `{ searchId, sessionId, productId, position }`. The
searchId must name a `SearchEvent` of the signed shop — the body is
shopper-controlled, so an unknown or foreign searchId answers `404` and
writes nothing. Success answers `204` with an empty body and one
`ClickEvent` row.

**Per-session AI throttle (YOY-47).** `app/search/throttle.server.ts` keeps
an in-process sliding one-minute window per `sessionId`. Once a session has
run `SEARCH_AI_THROTTLE_PER_MINUTE` (default 10) find-path searches inside
the window, its further submitted searches are served find order with no
judge call — route `classic`, reason `capped`, on the unchanged contract
shape — and still logged. Only page 1 of a search served with route `ai`
spends budget (YOY-157 AC-29); a later page, a preview and a classic rescue
neither consume budget nor get forced. Removing a chip is a submitted
search like any other and spends budget the same way. The state is
deliberately in-process: the limit is per Node instance, so horizontal
scaling multiplies the effective ceiling, and a restart clears the
windows — accepted for now; a distributed store is a later milestone's
concern.

## AI cost metering

Every AI call must be metered before any code capable of live LLM calls
exists. The `CostRecorder` port lives in the engine's public API so provider
adapters can depend on it; the app's Prisma implementation
(`apps/shopify-app/app/ai/cost-recorder.server.ts`) computes USD cost from
the committed price table
`config/ai-prices.json` (per-1M-token paid-tier rates; unknown model IDs
throw rather than metering $0) and appends one `AiCall` ledger row per call.
The internal admin at `/internal/costs` renders ledger aggregates and is
gated by `ADMIN_TOKEN` (`?token=` query parameter): without the exact token
it answers 404, indistinguishable from a nonexistent route.

A submitted search's model spend is one query embedding (cached per find
step, so later pages re-embed nothing), one wish extraction (`extract`,
answered from the extraction cache on a repeated sentence) and one judge
call per page inside the find set (`judge`, answered from the answer cache
on a repeated page); previews and the rescue spend nothing. Ingestion's
spend is the `enrichment`, `vision`, `card` and `embedding` operations.

Embedding calls are the one estimated entry in the ledger: Gemini
`batchEmbedContents` returns no usage metadata, so the adapter meters input
tokens as `ceil(chars / ESTIMATED_CHARS_PER_TOKEN)` with
`ESTIMATED_CHARS_PER_TOKEN = 4` (`packages/provider-gemini/src/index.ts`) —
the common Latin-script heuristic. Error bound: roughly a factor of two;
non-Latin scripts (Hebrew) tokenize to fewer characters per token, so the
estimate skews low for HE-heavy text. If the API ever returns real usage
metadata for embeddings, it replaces the estimate.

Aborted calls are metered by the same estimate (YOY-125 AC-6). A structured
completion cut short by the caller's signal or by the adapter's own request
timeout raises `GeminiTimeoutError` before any usage metadata exists, but
Google bills the prompt tokens of a request it has begun — and the judge's
give-up (`JUDGE_GIVE_UP_MS`) and every client's request timeout cut calls
short as a normal outcome, not a rare accident.
The adapter therefore records one `AiCall` row with `inputTokens` estimated
from the prompt through the same `ESTIMATED_CHARS_PER_TOKEN` path,
`outputTokens: 0` (whatever the model produced before the abort never reached
us), and the call's own `operation`/`storeId`/`searchId`, then rethrows
`GeminiTimeoutError` unchanged. Only the prompt text is estimated: inline
image bytes are not, so an aborted vision call would be under-counted —
nothing aborts vision calls today. A non-abort failure (an API error, a
malformed response) is still not metered.

## Test-location rule

New test files do not go inside `apps/shopify-app/app/routes/`: route tests
live beside the app code instead (e.g. `app/ai-costs.test.ts` exercising
`app/routes/internal.costs.tsx`). The backstop making this a convention
rather than a footgun is React Router's route registration
(`apps/shopify-app/app/routes.ts`), which uses
`flatRoutes({ ignoredRouteFiles: ["**/*.test.*"] })` so a `*.test.*` file can
never register as a route — which is also why the M1-era suites that predate
the rule (`app/routes/webhooks.test.ts`, `app.auth.test.ts`,
`healthz.test.ts`) are safe where they are. The `include` globs in the root
`vitest.config.ts` (`apps/*/app/**/*.test.{ts,tsx}`,
`apps/*/scripts/**/*.test.ts`, and `packages/*/test/**/*.test.ts`) are the
single source of truth for where tests live; a test outside those globs
silently never runs, so new test locations must be added there
deliberately. The `scripts` glob (YOY-114) exists for operational scripts
whose measurement logic is testable without a network — the latency probe's
percentile math and exit semantics — not for smoke-testing scripts against
live services.

## Storefront widget and UI test lane

**Server pages (YOY-146).** Every submitted search — widget and playground —
asks for one page (`page`, `pageSize`: the theme's configured page size on
the theme-native path, 24 on the overlay and the playground); keystroke
previews stay unpaged. `main.ts` hands each submitted response a page loader
(`ResponseHandlers.pages`) for the same query and refinement context, which
refuses pages once the search is superseded. The theme-native view holds
every page it fetched for the search, so a page selected again needs no
request; its page links number 1 to `ceil(totalCount / pageSize)`, the count
line states `totalCount`, and when the last row enters the viewport the next
page is fetched once and held. A results URL naming `page=N` requests page N
first. When the theme's search page has no pagination to mirror, later pages
append as the shopper scrolls instead. The overlay and the playground append
the next page below as the last card comes into view, with one quiet
"Loading more…" line, until the shown count reaches `totalCount`; a failed
page leaves the shown cards and says nothing. Click-beacon positions count
through the whole result order. The harness stubs and the playground fixture
mode (`paged`, `paged slow`, `paged fail`) answer page requests the way the
endpoint does.

The storefront search widget (YOY-43 scaffold, YOY-48 takeover) is plain
TypeScript + CSS in `apps/shopify-app/widget/src/`, built by Vite
(`apps/shopify-app/widget/vite.config.ts`) into one self-contained IIFE
bundle emitted by `npm run build:widget` under the theme app extension's
assets (`apps/shopify-app/extensions/unfiltered-widget/assets/`). The bundle
is not committed (YOY-102): CI builds it, and the `predev`/`predeploy`
scripts build it before `npm run dev` and `npm run deploy`. The stylesheet
ships inside the
bundle: all widget DOM lives in an open shadow root and the CSS is injected
there as a `<style>` element, so theme CSS cannot break the overlay layout
and widget CSS cannot leak onto host elements, while inheritable typography
(font-family, color) still flows in from the host page. The extension's app
embed block (`blocks/unfiltered-search.liquid`, `target: body`) loads the
bundle and calls `window.UnfilteredWidget.init({ locale, storeId })`.

Widget behavior (YOY-48): `init` locates the theme's own search input
(`input[type="search"]`, or a `/search`-action form's `q` input) and takes
it over — focus or typing opens a results overlay, typing is debounced into
`GET /apps/unfiltered/search` (query + a sessionStorage-held per-session
sessionId), and results render as product cards: image or placeholder,
title, price formatted with the currency code (a range when
priceMin ≠ priceMax), and a sold-out marker. While the overlay is open the
theme's native search submission is suppressed; a close control and Escape
both dismiss it, retaining the query text. Clicking a card fires a
fire-and-forget keepalive beacon to `POST /apps/unfiltered/click`
(searchId, productId, position) and navigates to the card's server-resolved
`url` verbatim regardless of the beacon's outcome; a card whose `url` is null
renders linkless — no navigation, no beacon (YOY-87). Degradation is total silence: no
recognizable search input means nothing mounts, and a failed or timed-out
search request removes the widget so the theme's native search behaves
exactly as without the app — no error UI ever. `init` is idempotent and
never throws into the merchant's page.

AI states (YOY-49, YOY-149, YOY-150): a submitted search's kept stated
facts render as a chip row above the grid — one removable chip per fact,
labeled by `chipLabel` in the shopper's language ("Under ₪400", "Size M",
"In stock", "Not black" with the value struck) with an accessible remove
label, and the second-reading chip ("{reading} instead?") first when the
response carries one. Removing a chip re-asks the same query with every
chip removed so far in this chain (`removedChips`) and the chain that
produced the results on screen, and the whole overlay re-renders from the
response. The widget holds the latest response's `carry` in memory only
(page-view lifetime, never persisted): a follow-up typed into the bar sends
it as `previousQuery` so the server refines rather than restarts, and each
response's `carry` replaces the held one. A "New search" control clears the
held chain, removed chips, input, and results. A submitted search with no
results renders a "Nothing matches all of these" message and the
still-removable chip row; a judged page's `closeMatches` render as
standard cards under a "Close matches" divider after its matches (YOY-166).
Each card shows its label line (DESIGN W-11). Degraded responses render
plain cards with no error messaging.

UI tests are a separate lane from Vitest: Playwright
(root `playwright.config.ts`, specs in `apps/shopify-app/widget/test-ui/`)
starts the widget dev harness — the same Vite config serving
`widget/index.html` (fake storefront with a theme-like search form and
contract-shaped stubbed search/beacon endpoints selected via `?fixture=`:
results, empty, error, timeout, delayed, beacon-missing, ai, ai-zero-hit,
ai-delayed, degraded, and the find-path states — chips with a removed-chip
echo, refinement, the second reading, labels, the close-matches divider and
pages),
`widget/no-search-form.html`, and `widget/hostile-css.html` (a deliberately
hostile theme for the style-isolation tests) — and runs fully offline.
`npm run test:ui` from the root is the single entry point, locally and in
CI; `.claude/yoyo.md` records it as `ui_test_command` with `ui_paths`
covering the widget and extension directories, so every future UI-touching
pull request must extend this lane.

## Playground catalogs and generic ingestion (YOY-88)

The M4 playground's store-preload mode ingests arbitrary PUBLIC catalogs
without an app install — the first consumer of a generic ingestion path
beside the Shopify Admin API one. Everything lives under
`apps/shopify-app/app/playground/`:

- **Catalog-source port** (`catalog-source.server.ts`): `SourceProduct`
  (`sourceId`, `title`, plain-text `description`, `tags`, `vendor`,
  `productType`, `priceMin`/`priceMax`/`currencyCode`, `available`,
  `imageAltTexts`, `imageUrl`, `url`, `sourceUpdatedAt`) and
  `CatalogSource` (`kind`, `fetchProducts({ maxProducts, onProgress })`).
  Nothing in the port or the pipeline names a commerce platform; a source
  may stop reading once `maxProducts` are in hand.
- **Registry** (`PlaygroundCatalog` model): one row per catalog — `slug`
  (`[a-z0-9-]{1,40}`, unique), `name`, `storeKey` (unique; always
  `playground:<slug>`, the tenant-key value the catalog's rows carry in the
  `shopDomain` column of `CatalogProduct` / `ProductEnrichment` /
  `ProductEmbedding` / `SearchEvent` / `ClickEvent` / `AiCall`, so a
  playground tenant can never collide with a real shop domain), `sourceUrl`,
  `sourceKind`, `productCount`, `lastIngestedAt`.
- **Pipeline** (`ingest-public.server.ts`): `ingestPublicCatalog({ db, slug,
  name, source, sourceUrl, maxProducts, llm, embeddings })` maps
  `SourceProduct`s to `CatalogProduct` rows under the store key
  (`productId = sourceId`, `status = "ACTIVE"`, `publishedAt = now`,
  `handle = ""`, `featuredImageUrl`/`url` display-only, `contentHash` via
  the shared `computeContentHash` so caching is keyed identically to the
  Shopify path), upserts idempotently (unchanged hash → untouched; a drifted
  display-only field is refreshed without dirtying the hash; gone from the
  source → deleted with its enrichment and embedding rows in one
  transaction), then runs the existing `enrichCatalog` and `embedCatalog`
  for that key and upserts the registry row. Products beyond `maxProducts`
  and products with no title or no price are skipped and counted, never
  ingested. A second run over an unchanged source reports all
  `unchanged`/`cached` and makes zero LLM/embedding calls.
  `deletePublicCatalog({ db, slug })` removes one catalog's rows across all
  four tables and nothing else.
- **Polite fetch** (`polite-fetch.server.ts`): the one HTTP helper every
  source reads through — `User-Agent: UnfilteredBot/1.0 (+<contact URL>)`,
  15 s timeout, `429`/`503` honored via `Retry-After` with exponential
  backoff (max 3 retries), one request in flight per host, and `robots.txt`
  `Disallow` rules for our agent (or `*`) respected: a disallowed path is
  never fetched — it raises `RobotsDisallowedError` and is counted.
- **Sources**:
  - The Shopify public storefront feed (`shopify-public-source.server.ts`,
    `kind: "shopify-public"`, an adapter): pages
    `/products.json?limit=250&page=N` until an empty page, maps the feed's
    fields (`body_html` → text, variant price min/max and any-available,
    first image, alt texts, `updated_at`), resolves `url` as
    `https://<host>/products/<handle>`, and reads the currency (and the
    store name) from `/meta.json` with `/cart.js` as the currency fallback,
    failing loudly when neither answers.
  - The generic sitemap → schema.org Product JSON-LD crawler (YOY-89;
    `jsonld-crawl-source.server.ts`, `kind: "jsonld-crawl"`, platform-free):
    discovers sitemaps from `robots.txt` `Sitemap:` lines, else
    `/sitemap.xml` (`sitemap.server.ts`: indexes followed recursively,
    `.xml.gz` / gzip bodies inflated), fetches page URLs product-ish paths
    first (`/product/`, `/products/`, `/p/`, `/item/`, `/shop/`) through the
    polite helper — the CLI configures it with 4 in flight per host and
    ≥250 ms between request starts — until the page budget (`--pages`,
    default 3000) is spent or `maxProducts` are in hand; non-HTML responses
    are skipped without parsing. Extraction (`jsonld.server.ts`) parses
    every `<script type="application/ld+json">` (arrays and `@graph`
    included): `Product` nodes (any subtype, `@type` string or array) become
    one `SourceProduct` each — `name`, `description` (HTML stripped),
    `brand.name`, `category`, first `image`, `offers`
    (`Offer`/`AggregateOffer`: `price` | `lowPrice`/`highPrice`,
    `priceCurrency`, availability ending in `InStock`/`PreOrder`), `sku` |
    `productID` | `@id` | page canonical → `sourceId`, `url` = JSON-LD `url`
    else `<link rel=canonical>` else the fetched URL; a `ProductGroup` (or
    `hasVariant`) collapses to one product spanning its variants' prices and
    any-in-stock availability. Products without a price or currency are
    skipped and counted; a page yielding two Products with one `sourceId`
    counts once; robots-disallowed pages are skipped (never fetched) and
    the crawl continues. Limits: no JavaScript rendering (pages that only
    inject JSON-LD client-side are unsupported), no microdata / RDFa /
    OpenGraph fallback, no crawl state between runs (each run is a full
    crawl; the pipeline's hashing makes it idempotent downstream). An
    opt-in live smoke test runs only under `LIVE_CRAWL_TESTS=1` with
    `LIVE_CRAWL_URL`.
- **CLI** (`scripts/ingest-public.mts`, logic in
  `ingest-public-cli.server.ts`): `npm run ingest:public -- --url <store URL>
  --slug <slug> [--name "<Store>"] [--max <N, default 2000>] [--source
  shopify-public|jsonld-crawl] [--pages <N, default 3000>] [--path-prefix
  </locale/>]` from
  `apps/shopify-app` (env-loaded like `npm run ingest`; `PLAYGROUND_URL`
  becomes the User-Agent contact when set) detects a Shopify storefront
  (`/products.json?limit=1` answers JSON with a `products` array) and uses
  the adapter; any other URL uses the JSON-LD crawler; `--source` forces one
  (`--source shopify-public` on a non-Shopify URL exits 1 with `no supported
  catalog source for <url>`); a robots-disallowed feed, or a site with no
  sitemap at all, aborts with a clear message and writes nothing. It prints
  ingest/enrich/embed counts, the skips, the crawl report (sitemaps, URLs,
  pages fetched vs budget, products found, per-reason skips, budget
  exhaustion) with progress every 100 pages, the `AiCall` cost of the run,
  and the fetch counters. `--path-prefix <path>` (YOY-117 AC-4) is the
  locale hint for multi-region stores — White Stuff's EU sitemap was
  crawled first and EUR sale prices landed instead of the UK storefront's:
  for `jsonld-crawl` only sitemap URLs whose path is the prefix or starts
  with `prefix/` are fetched (discovery unchanged; the rest are counted as
  `outside prefix` in the crawl line), and for `shopify-public` the feed
  is read from `<origin><prefix>/products.json` and product URLs are
  `<origin><prefix>/products/<handle>` (store meta stays at the origin).
  `--delete --slug <slug>` removes the catalog. No
  HTTP/admin trigger exists; re-ingestion is a manual re-run.

Tests (`app/playground/*.test.ts`) run fully offline against fixture feed
pages and a fixture crawl store (`app/playground/fixtures/crawl/**`: robots
→ sitemap index → two child sitemaps, one gzipped → WooCommerce-, Magento-,
and ProductGroup-shaped pages, a priceless product, a duplicate-sku page, a
no-product page, a PDF, and a robots-disallowed section) served by an
in-memory fake store (`app/testing/fake-store.server.ts`), fixture
LLM/embedding clients, and the PGlite test DB.

## Playground search and click API (YOY-90)

The playground has no widget and no Shopify proxy, so its pages reach the
engine through a first-party, unauthenticated API on our own origin. It runs
the SAME orchestrator the storefront proxy runs — `getProxySearchOrchestrator`
— over a catalog chosen per request, and answers the proxy's card contract
plus the engine details the playground shows on demand.

- **`GET /api/playground/search`** (`app/routes/api.playground.search.tsx`)
  takes the proxy's own parameters — `query`, `sessionId`, `mode`, `page`,
  `pageSize`, `previousQuery`, `removedChips` — parsed by the proxy's own
  `parseProxySearchParams`, so preview, paging, refinement, and chip-removal
  semantics cannot drift between the two APIs. Plus `catalog`, a registry
  slug: absent means the seed catalog, whose tenant key comes from
  `PLAYGROUND_SEED_STORE_KEY`. An unset seed with no `catalog` answers `503`
  (a deployment gap, not a visitor error); an unknown slug answers `404`
  rather than silently searching the seed; a malformed request answers `400`.
  Every response — every status — carries `Cache-Control: no-store` and no
  CORS headers at all: the playground's pages are same-origin, and a third
  party must not be able to spend our AI budget from their site.
- **Response body** = the proxy contract (above) plus
  `details: { routeReason, latencyMs, limited, stages, judge,
  extractionInTime, extractionCached }`, built by
  `serializePlaygroundSearchResponse` (`app/playground/api.server.ts`), which
  delegates the card and chip mapping to the proxy's own serializer and adds
  exactly those fields — `stages` copied key by key in pipeline order
  (YOY-114), `judge` the judge's outcome, per-result verdicts and call times
  (null off the find path). A shape test pins the top-level keys and the
  `details` keys, so a later orchestrator field cannot leak out.
- **`POST /api/playground/click`** (`app/routes/api.playground.click.tsx`)
  takes the beacon body `{ searchId, sessionId, productId, position }` and
  the same `catalog` parameter. POST rather than the proxy's GET because
  there is no proxy edge here to work around. The `searchId` must name a
  search THAT catalog ran — the body is visitor-controlled — else `404` and
  no row.

### Abuse guards

Unauthenticated means the exposure is the AI bill, so three guards sit in
front of the judge. Every one serves the composed find order with no judge
call (route `classic`, reason `capped`) rather than an error: a visitor who
trips a ceiling still gets a working search, told honestly through
`details.limited`.

| Guard | Env var | Default | `details.limited` |
|---|---|---|---|
| Per-IP AI searches per minute | `PLAYGROUND_AI_THROTTLE_PER_MINUTE` | 10 | `"ip"` |
| Trusted `X-Forwarded-For` hops (how the IP is read) | `PLAYGROUND_TRUSTED_PROXY_HOPS` | 1 | — |
| Daily AI searches, all playground tenants | `PLAYGROUND_DAILY_AI_CAP` | 2000 | `"daily-global"` |
| Daily AI searches, one catalog | `PLAYGROUND_CATALOG_DAILY_AI_CAP` | 500 | `"daily-catalog"` |

The per-IP guard keys the proxy's sliding-window throttle by the visitor's IP
— the **last trusted `X-Forwarded-For` hop**, then the connection address the
runtime supplies, then a shared `"unknown"` bucket so a request with neither
is still limited rather than exempt (YOY-96 AC-11). "Last trusted hop" means
the entry `PLAYGROUND_TRUSTED_PROXY_HOPS` positions from the END of the header
(default 1: the last entry). Every reverse proxy, Render included, appends the
peer it saw to whatever header arrived, so the first entry is client-supplied
— keyed by it, a visitor minting a fresh `X-Forwarded-For` per request got a
fresh bucket every time and the guard never bound. The entry our own edge
appended is the one the client cannot forge; put a CDN in front of Render and
set the hops to 2. A header with fewer entries than trusted hops did not come
through the configured edge and is not trusted at all. The guard is
in-process, so it is per-instance and resets on restart, exactly like the
proxy's session throttle.

The two daily ceilings are counted from `SearchEvent` rows with `route = "ai"`
since 00:00 UTC — from the log, not from memory, so a restart cannot reset a
spend guard and multiple instances share one count. Only page-1 rows with
route `ai` count (YOY-157 AC-29): a search served classic (capped, or a
classic rescue) spent no judge budget and must not consume the ceiling it
was denied.

Precedence when several would bind is broadest-first — global, then catalog,
then IP — because the broadest binding constraint is the one that explains
the degradation; naming `"ip"` while the whole playground is capped would
send a visitor chasing their own behavior for a condition they cannot affect.

Previews and classic rescues are never limited and never counted: both are
classic-only by contract, so neither can burn budget. A chip removal is a
submitted search and is guarded like one. Previews write no `SearchEvent`;
every submitted search writes exactly one, limited ones included — the
ceilings are counted from that table.

Route tests (`app/playground-api.test.ts`) run on the PGlite test DB with a
fake orchestrator threaded through the real `getProxySearchOrchestrator`, so
the production wiring is what they exercise.

## Quality gates

Vitest, ESLint, and `tsc --noEmit` run from the root as `npm test`,
`npm run lint`, and `npm run typecheck`; `.github/workflows/ci.yml` runs all
three on every pull request, plus the `ui` job running `npm run test:ui`
(Playwright, Chromium) against the widget harness, plus the `dist-seam` job
that builds the workspaces and runs the orchestrator suite through
compiled `dist/` (see "How the app resolves the workspace packages"). The engine-boundary rule
is mechanically enforced by `packages/engine/test/boundary.test.ts`, which
fails the suite if the engine's manifest or source ever references a
`@shopify/*` package.

## Marketing site, playground pages and UI lane (YOY-92)

The app serves Unfiltered's owned pages (docs/DESIGN.md "Owned pages") —
the marketing site and the playground — alongside the embedded admin, from
one app, one design, one deploy:

| Route | Route file | Page |
|---|---|---|
| `GET /` | `app/routes/_index/route.tsx` | Landing page; also keeps the `?shop=` → `/app` redirect |
| `GET /about`, `/how-it-works`, `/pricing`, `/faq`, `/privacy`, `/terms` | `app/routes/<name>.tsx` | Marketing pages |
| `GET /try` | `app/routes/try.tsx` | The playground, framed by the site nav and footer |
| `GET /s/<slug>` | `app/routes/s.$slug.tsx` | The playground over one store's catalog (below) |

**The marketing site** was ported from the founder's Claude-Design export
into `app/site/`: `components/` (SiteNav, SiteFooter, and React
re-implementations of the export's design-system components), `pages/` (one
per route), `paths.ts` (the site's URLs and the `public/site/` assets), and
`site.css`. It styles on the same `playground/tokens.css` and self-hosted
`playground/fonts.css` as the playground, and every rule in `site.css` hangs
off a `site-`/`unf-` class so it cannot reach into `.playground` on `/try`.

**The playground** is at `/try` — the surface a merchant judges the product
on before installing anything. The `?shop=` redirect into the embedded admin
stays on `/`, because that is the URL Shopify opens the app on.

**Where the code lives.** `app/routes/try.tsx` is the route (loader, meta,
and the site chrome around the page); `app/playground/` holds the page: `tokens.css` and
`playground.css`, the `strings.ts` catalog, the components, and
`search-client.ts`. The playground shares no DOM rendering with the
storefront widget — the two surfaces answer to different design cases (the
widget inherits its host's design; the playground is drawn) — and imports
only the widget's `formatPrice`, so a price never reads differently on the
two.

**Chrome language is resolved server-side.** `resolveChromeLocale` reads
`?lang=`, then `Accept-Language`, then falls back to English, and `root.tsx`
stamps `<html lang dir>` from it: a client-side flip would paint one frame of
LTR before mirroring. `ownedPageKind` sorts paths: only the playground's own
(`/try`, `/s/<slug>`) resolve a language; the marketing site is English and
LTR; the merchant admin is English-only and LTR by design (DESIGN A-4), and a
Hebrew browser must not flip Polaris into RTL just by visiting. Owned pages —
site and playground — load no Shopify-CDN stylesheet (YOY-96 AC-13); every
other path keeps Polaris's Inter stylesheet.

**The interaction model is the widget's** (YOY-68): typing issues debounced
`mode=preview` requests that are classic-only, spend no AI budget, and write
no `SearchEvent`; Enter or the magnifier submits the full pipeline (and a
`mode=classic` rescue, logged with `routeReason: client-timeout-rescue`, is
accepted exactly as on the proxy — YOY-96 AC-9). One
in-flight request at a time, so a slower earlier response can never overwrite
a newer one.

**Two mechanical design guards** run in the normal test suite rather than
waiting for review, because both invariants are greppable:
`playground-css.test.ts` fails on a raw hex or pixel literal outside
`tokens.css` (P-8) and on any physical `left`/`right` property (F-5), and it
asserts its own patterns catch violations so it cannot silently stop working.

### AI states (YOY-93)

What the shell renders is a search box; what makes the playground worth
showing is the layer above it — the part a filter UI cannot do.

- **Chips are output, not input.** A submitted search's kept stated facts
  render as removable pills through the widget's own `chipLabel`, so Hebrew
  display cannot drift between the two surfaces (P-5). They never render on
  a preview, on classic results, or on a degraded response: a chip claims
  an understanding, and a degraded response is keyword results (W-7).
- **Refinement lives in the bar, not in a transcript.** Exactly one chain is
  held, in memory: each response's `carry` replaces it, a follow-up sends it
  as `previousQuery`, and removing a chip re-requests with `removedChips`
  and re-renders from the answer rather than editing the chip row locally.
  "New search" drops it. There is no history and no chat (NG-2, X-2), and
  nothing is persisted.
- **Engine details are opt-in and live in the URL.** The toggle writes
  `?details=1`, so an opened panel survives a reload and can be shared as a
  link; closed, the panel is absent from the DOM rather than hidden with its
  space reserved. The panel's rows are the route, the routeReason, the
  latency, `degraded` and `limited`; its stage rows
  (`[data-testid="playground-details-stages"]`, YOY-114) list one
  `<stage> · <ms> ms` row per stage the search ran, in pipeline order, from
  `details.stages`; a preview's lone `classic` row is the visible proof it
  made no model call.
- **Example queries are the page's argument for itself.** Six are shown —
  four in the chrome language and two in the other, because the claim is
  that either works. Each is tagged with the capability it demonstrates
  (negation, price cap, occasion, soft attribute, colour plus availability,
  refinement) and `playground-examples.test.ts` asserts the set still covers
  all six, so an edit cannot quietly cost the page its point.

Fixture mode gains the matching states (`ai`, `ai-delayed`, `degraded`,
the chip, refinement and second-reading states `v2-budget`, `v2-refine`,
`v2-two-meanings`, the label, close-divider and paged states) plus a
removed-chips echo: removing a chip answers a response with that chip gone
AND, once the price cap is among them, the product the cap kept out back in
the set, so a broken remove-and-re-render cannot pass. The
fixture is chosen by whole words in the query, not substrings — "ai" lives
inside "rail" and "available".

### Store-preload pages (YOY-94)

`GET /s/<slug>` is the same playground pointed at one store's preloaded
public catalog — the link outreach shares. The loader resolves the slug in
`PlaygroundCatalog` and passes the catalog's `name` and `productCount`;
every search, preview, and click request from that page carries
`catalog=<slug>`, so nothing else about the page has to know it is a store's.

**The store's name is the only new element** (P-7): one line of body type
above the bar with a muted product count. No logo, no colours, no per-store
copy — the page is visibly the store's because it names the store, not
because it dresses up as it. A Playwright spec enumerates every class on
`/s/<slug>` and on `/try` (inside `.playground`) and asserts the two lists are identical apart from the
store line, so per-store chrome cannot creep in later.

An unknown slug answers a real **404** with a designed page in the
playground's own shell — one sentence and a link back to `/try`. It never falls
back to the seed catalog: an outreach link with a typo would otherwise demo
somebody else's catalog under that store's name. These pages are `noindex`
(`/try` stays indexable); a search engine indexing a demo of someone else's
catalog helps nobody.

### The UI lane

`playwright.config.ts` runs two projects behind the one `npm run test:ui`
entry point: `widget` against the Vite harness, and `playground` against the
REAL built app with `PLAYGROUND_FIXTURES=1`. The built app rather than a dev
server is the point — SSR `lang`/`dir` and the meta tags cannot be proven any
other way — so CI's `ui` job builds the app first.

The same project covers the marketing site: `site.spec.ts` opens each site
route and `/try`, and asserts the page renders, every nav and footer link
answers 200, and nothing is logged as a console error.

In fixture mode `/api/playground/*` answers from committed JSON chosen by the
query text (`results`, `empty`, `error`, `timeout`, `delayed`, `preview`), so
the lane needs no database, no Gemini key, and no network. Two branches make
that work and both are unreachable without the flag: the API routes answer
from `fixture-mode.server.ts`, and `shopify.server.ts` swaps
`PrismaSessionStorage` — which probes the session table as it boots and exits
the process when nothing answers — for an in-memory implementation. Visual
baselines are per-OS, like the widget's.

## Latency measurement (YOY-114)

The M5 latency bars — AI p50 < 2000 ms and p95 < 3500 ms, classic p95
≤ 500 ms, all server-side — are stated and measured per **docs/LATENCY.md**,
the binding method: server-side `latencyMs`, warm instance with the warm-up
discarded, the live seed catalog, N ≥ 20 runs per set over the committed
query set, nearest-rank percentiles, EN and HE AI reported separately and
combined. Three pieces implement it:

- **`stages` on every orchestrator response** (above): where the
  milliseconds went, per pipeline stage actually run.
- **The proxy log line** `[search] stages {...}` (one per submitted
  storefront search) and **`details.stages`** on the playground API: the
  two places the ledger is observable — never the storefront contract, never
  the database.
- **`apps/shopify-app/scripts/latency-probe.mts`**: drives the deployed
  playground with `scripts/latency-probe-queries.json` (5 classic, 5 EN AI,
  5 HE AI), one discarded warm-up then sequential runs with a fresh
  `sessionId` each, and prints per set n, p50, p95, the mean per stage, the
  count of `degraded`/`limited` responses, the share composed without the
  wish extraction and the share the extraction cache answered, and a last
  line for the judge stage (its p50/p95, the outcomes, `judgeRows`, and the
  slowest and median single call). Every AI-set request carries an
  invisible marker (four zero-width format characters as base-4 digits of a
  per-invocation nonce plus the run number, appended after a space) so its
  text differs per run and per invocation: without it, runs 2..N would be
  answered by the judge's answer cache and the extraction cache with no
  model call and the probe would measure the caches, not the pipeline. The
  marker is invisible, not absent: the orchestrator passes the raw query to
  the embedding, the wish extraction and the judge, so each receives the
  committed query plus the marker as-is — a few extra input tokens per call
  — and the AI bars are measured on committed-query-plus-marker, not on a
  byte-identical shopper query; only `visibleQueryText` strips it, and only
  for the probe's reporting. `--assert-classic-p95`,
  `--assert-ai-p50`, `--assert-ai-p95` turn the bars into an exit code. The
  AI sets are paced under the playground's per-IP throttle so the probe
  measures the pipeline, not the guard. `scripts/latency-probe.test.ts`
  pins the nearest-rank math (including n=20) and the exit semantics.

## Daily live smoke (YOY-112)

`apps/shopify-app/scripts/live-smoke.mts` runs four read-only probes against
the deployment — `/healthz` (HTTP 200 and `engine.version` equal to the
engine's source `version`), the keystroke preview `dress` (classic, zero
model calls), and the submitted EN `elegant evening dress under 400` and HE
`שמלה אלגנטית לערב מתחת ל-400` (the find-path shape: not degraded, results,
`page` and `totalCount`) — with the ceilings in
`scripts/live-smoke.config.json`, prints a JSON report and a one-screen
summary, and exits 1 on any failure; every probe runs even after an earlier
failure. `scripts/live-smoke.test.ts` drives it against an in-process fake
deployment (`app/testing/fake-store.server.ts`). A Claude Code cloud routine
runs it daily at 06:00 UTC and posts to Slack only on failure; the routine's
prompt, the phone checklist for creating it (network allowlist, Slack-only
connectors), and how to read a failure are in **docs/SMOKE.md**. It is a
canary between milestone live runs, not a benchmark: no trend log, no
percentiles — those are docs/LATENCY.md's.

## Deployment (YOY-91)

The playground is deployed as a single Docker web service on Render, built
from the repo-root `Dockerfile` and described by the repo-root `render.yaml`
blueprint; `docs/DEPLOY.md` is the operational record (setup, env var
sources, free-plan behavior, logs and rollback, custom domain).

Two properties are architectural rather than operational. First, the image
builds the whole workspace, not the app alone: `apps/shopify-app`'s Vite
build aliases `@unfiltered/engine` and `@unfiltered/provider-gemini` to their
TypeScript source (see "How the app resolves the workspace packages"), so an
app-only image — what the Shopify template shipped — cannot build. Second,
`docker-entrypoint.sh` applies migrations before serving and refuses to start
at all without `DATABASE_URL`: `/healthz` exercises the engine and never
touches the database, so a database-less service would pass its health check
while every search 500s. Failing loudly at boot is the only way that
misconfiguration stays visible.

The Shopify app record is not re-pointed at this deployment; the embedded app
and its storefront proxy keep their existing configuration.

### The theme-native path

On the theme-native path (`widget/src/native-render.ts`, `native-page.ts`)
a submitted search lands on the theme's own search-results page holding
our ranked results, whatever page it was submitted from.

- **The page is mirrored.** The theme's search page is fetched once per
  page view for a term that always renders its results state, parsed inert,
  and its main content becomes the shell. Entering the results view hides
  the origin page's main content in place (nodes are never moved, and they
  are restored exactly on leave), appends the shell, and puts the widget's
  results section where the theme's results list was. The theme's count
  line is rewritten to our total and the shopper's query, and the theme's
  own pagination is driven over our pages (or, when it has none, later
  pages append as the last row comes into view). Navigation is a
  `history.pushState` to the theme's search URL, so Back returns to the
  page the shopper searched from. When the shell cannot be fetched, the
  section shows bare in the same place.
- **The cards are the theme's.** Each result is rendered as the theme's
  own product card: Variant A fetches the product through an alternate
  template that renders only the card snippet (`?view=…`); Variant B
  clones the first card of a page that already renders theme cards and
  refills it through configured selectors. A result whose card cannot be
  produced falls back to a plain card of ours in the same grid slot.
- **Owned elements.** Inside the theme's page the widget adds only the
  removable chips row (and the second-reading chip), the status text
  (loading, no results, the zero-hit message), the "Close matches" heading
  as a full-row divider inside the page's grid on a judged page with
  matches, and the one label
  line under a card's price (DESIGN W-11). Everything else is the theme's.
- **No new-search control.** Unlike the overlay, the theme-native view has
  no new-search/close control (DESIGN W-2): the browser's Back leaves the
  view, and the theme's own search box starts the next search.

## Deferred components

The merchant dashboard (the embedded admin is still the app template's
starter page) and billing are future milestones and intentionally absent
from the current codebase.
