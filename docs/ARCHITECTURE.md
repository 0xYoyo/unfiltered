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
  package with its own `tsc` build and zero runtime dependencies. Currently a
  stub: the public API is real, the implementation returns an empty,
  well-typed result. Also home of the vendor-free AI ports (`LlmClient`,
  `EmbeddingClient`, `CostRecorder`) that provider adapters implement.
- **`packages/provider-gemini`** — the Google AI Studio (Gemini) adapter
  implementing the engine's LLM and embedding ports over plain `fetch`, with
  every call metered through the `CostRecorder` port. Model IDs come only
  from configuration/env (`geminiModelsFromEnv()`; defaults
  `gemini-3.5-flash-lite` for classification/enrichment and for the vision
  enrichment pass (YOY-121, `GEMINI_VISION_MODEL`) and the card writer
  (YOY-143, `GEMINI_CARD_MODEL`), `gemini-3.6-flash`
  for intent, `gemini-embedding-001` for embeddings); the API key comes from
  `GEMINI_API_KEY`. Fixture tests only by default; live round-trips run
  solely under `LIVE_LLM_TESTS=1` locally, never in CI.

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
tree whose `dist/` predated it kept executing the old retriever, so every
AI-routed search returned zero rows and every `AiCall` lost its tenant while
every source-aliased test stayed green (YOY-104 M1).

**After pulling engine or provider changes:** nothing — restart the dev
server if it is running and the new source is what executes. `npm install`
is needed only when dependencies or the Prisma schema changed, exactly as
before. If `npm run typecheck` in the app complains about engine types that
clearly exist in source, the stale part is `dist/index.d.ts`: run
`npm run build --workspace @unfiltered/engine --workspace @unfiltered/provider-gemini`.

The seam is still guarded for consumers of the built artifact: CI's
`dist-seam` job runs `npm run build` and then `orchestrator.test.ts` +
`retrieval-store.test.ts` through `vitest.dist-seam.config.ts` — the same
suites **without** the src alias, resolving `@unfiltered/*` through
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
those and no others. Coverage attributes reach retrieval through the
embedding text only — no intent-schema or filter change (NG-2).

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
which it reads, and before embedding; cards are not embedded yet and no
search reads them yet.

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

**Reports.** `npm run ingest` prints `cards: written N, cached M, failed K,
cost $X` after the `vision:` line (cost = the run's `card` ledger rows for
the store); `/internal/costs` shows the `card` operation. `ingest:public`
writes cards only with `--cards`, so the existing playground catalogs get
no paid card calls unless an operator asks; without it the line reads
`cards: written 0, … (off: pass --cards to write cards)`. Estimate ≈ $4 per
1,000 products for the card text plus the images (PRD §3 Refinement 6);
measured on the seed catalog in the slice after merge.

### Multi-tenant vector search on one shared index (YOY-105)

Every tenant's vectors live in one `ProductEmbedding` table under one HNSW
cosine index — an expression index over the dimension-typed cast, built at run
time by `ensureEmbeddingIndex()` (`app/catalog/embed.server.ts`), because the
`embedding` column is deliberately dimensionless.

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

(`withTenantVectorScan()` in `app/catalog/hnsw.server.ts`, used by both
`app/search/retrieval-store.server.ts` — the hard-constraint and close-matches
paths alike, since both go through the same store port — and
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
The ceiling bounds how long a wedged scan can hold a pooled connection — about
ten times the 0.9–1.6 s the whole retrieval stage measures live, inside the
60 s intent-call abort above it — without turning a slow-but-correct scan into
a degraded answer; it is not the retrieval latency budget (YOY-64).

Two alternatives were rejected:

- **Per-tenant partial indexes** — unviable. Playground slugs are created
  dynamically, so this means an unbounded number of indexes created at
  ingestion time, and index count grows with the tenant count forever.
- **Scaling `hnsw.ef_search`** — a heuristic, not a fix. Any fixed multiple
  re-breaks at the next tenant-size asymmetry, and it inflates latency for
  every tenant to serve the smallest. Index and search-parameter tuning is
  separately out of scope (YOY-64 / M5).

The regression test is
`apps/shopify-app/app/search/retrieval-tenant-recall.test.ts`: a 400-row tenant
beside a 2,400-row one whose every vector is nearer to the query, run on the
hermetic PGlite database (its pgvector is 0.8.1, which supports iterative
scans, so no real-Postgres lane is needed). It forces the production-shaped
plan with **both** `enable_seqscan = off` and `enable_sort = off` — the first
alone leaves the planner the cheap fixture-scale option of pre-filtering
through `ProductEmbedding_shopDomain_idx` and sorting exactly, which is correct
but not the plan under test. Without iterative scans that plan reports
`Rows Removed by Filter: 40` and returns the small tenant **zero** rows.

## Engine public API (current surface)

`packages/engine` (`@unfiltered/engine`) exports, from `src/index.ts`:

- `version: string` — semantic version of the API contract (`"0.4.0"`).
- `interface EngineDocument` — `{ id: string; fields: Record<string, string> }`.
- `interface SearchOptions` — `{ limit?: number; offset?: number }`.
- `interface SearchHit` — `{ documentId: string; score: number }`.
- `interface SearchResult` — `{ hits: SearchHit[]; totalCount: number; query: string }`.
- `interface Engine` — `{ readonly version: string; search(query, options?): Promise<SearchResult> }`.
- `createEngine(): Engine` — returns the stub implementation (every search
  resolves to an empty result; real search runs through the classification /
  retrieval / classic-search ports below).

Query understanding (all LLM access through the `LlmClient` port):

- `createQueryClassifier({ llm, timeoutMs?, cacheSize? }): QueryClassifier` —
  routes a query to `"classic"` or `"ai"`: a deterministic heuristic layer
  settles clearly-simple queries as classic with zero LLM calls — and,
  since YOY-133 (founder decision 2026-08-27), **purpose phrases as AI**
  with zero LLM calls (reason `purpose-phrase`): "<noun phrase> for
  <purpose>" ("sneakers for running", "dress for a wedding", "something to
  wear to a wedding") and, in Hebrew, a category noun followed by a `ל…`
  purpose word ("סניקרס לריצה", "שמלה לחתונה", "מכנסיים למשרד"). Not every
  ל-initial word is the preposition, so `HEBREW_NON_PURPOSE_L_WORDS`
  (YOY-125 AC-15) excludes the colour forms "לבן"/"לבנה" (in
  `CLASSIFIER_COLOR_WORDS`) plus their plurals "לבנים"/"לבנות" — white is
  the only colour with ל-initial spellings — the negations "ללא"/"לא", and
  the common ל-initial nouns and brands "לוגו", "לייקרה", "לקוסט",
  "ליוויס", "לונג"; those shapes ask the model like any other query. Purpose is what
  keyword search cannot read, and the live classifier routed that shape
  classic in one of four cases (co09), so the shape never asks the model.
  Everything else asks the model (operation `"classification"`), cached by
  normalized query and failing safe to `classic`. A purpose-phrase search
  that later degrades to classic still counts toward the per-session and
  per-IP AI budgets, like a degraded model-routed one.
- `createIntentExtractor({ llm }): IntentExtractor` — turns free text into a
  vendor-free `Intent` (category, price bounds with currency, color
  inclusions/exclusions, **negated attributes** `attributesExclude` and
  **category-like attributes** `attributesInclude` (YOY-133, below),
  occasion, size, availability requirement, soft attributes, and the
  model's own `confidence` 0–1 that the hard constraints are complete and
  correct — required of every answer by `INTENT_SCHEMA` since YOY-116;
  answers recorded before it parse with none) via the model (operation
  `"intent"`), with one retry on schema violation and then a typed
  `IntentExtractionError`.
- **Negated attributes are hard exclusions (YOY-133; PRD §3 amendment
  (d), binding).** "top, no sleeves", "winter coat, not wool", "ז'קט לא
  מעור" return `attributesExclude: ["sleeves"]`, `["wool"]`, `["leather"]`
  — lowercase English words, never colours (those stay `colorsExclude`)
  and never soft attributes — and both stores apply each as a WHERE
  filter, never a preference (NG-1). `parseIntent` folds each word onto
  the engine's evidence lexicon (`ATTRIBUTE_EVIDENCE_TERMS` in
  `taxonomy.ts`: "sleeve", "woollen", "שרוולים" → `sleeves`, `wool`,
  `sleeves`), de-duplicates, and reads an absent array — every recording
  and stored intent from before the field — as none. Chips carry the
  negation (`{ field: "attributesExclude", value: "wool" }`, rendered
  "Not wool" / "לא צמר" by the widget's `chipLabel`), chip removal drops
  it with the same LLM-free surgery as a colour chip, refinement carry-over
  keeps it like every other constraint, and the close-match ladder never
  relaxes it (like `colorsExclude`, keyword fallback included). The
  negation rides the existing intent call — no new LLM call per search
  (NG-2); the prompt grew by the two field rules.
- **Occasion vs. category (YOY-133 AC-3).** "dress for a wedding" /
  "שמלה לחתונה" is the guest's query — `category: dress, occasion:
  wedding, attributesExclude: ["bridal"]` — while "wedding dress" /
  "שמלת כלה" is the bridal category-like intent: `attributesInclude:
  ["bridal"]`, a hard, evidence-required inclusion. `attributesInclude` is
  pinned by the schema to the closed `CATEGORY_LIKE_ATTRIBUTES` set (today
  `["bridal"]`) — a positive evidence filter the model could invent
  ("linen shirt" → require linen) would kill recall on a sparse catalog,
  so only attributes that behave like a category may be required; the
  exclusion side stays open. Required category-like words also embed in
  `composeQueryText` (after the wanted colours), exclusions never do. The
  ladder never relaxes the include either: a "wedding dress" zero-hit's
  rescues are the keyword close matches, not non-bridal dresses served as
  a relaxation.
- `createEscalatingIntentExtractor({ lite, accuracy, threshold?, classes? })`
  — the lite-first ladder (YOY-116): an `IntentExtractor` over two tier
  extractors that asks the lite tier first and escalates to the accuracy
  tier in exactly two cases — the query matches a committed **escalation
  class** (`INTENT_ESCALATION_CLASSES` in `intent-escalation.ts`: today
  `mixed-script`, Hebrew and Latin letters in one query, and `occasion`,
  occasion-bearing phrases EN/HE), in which case the accuracy tier is asked
  directly with no lite call — **hedged** (YOY-64 AC-6): when that accuracy
  call is still pending after `hedgeAfterMs` (`DEFAULT_INTENT_HEDGE_AFTER_MS`,
  2500; the app reads `INTENT_HEDGE_AFTER_MS`) the lite tier is fired
  alongside it and the first schema-valid answer wins, the loser aborted
  through its own signal; a lite win reports `escalation: { kind: "hedge" }`
  with `intentTier: "lite"`, and the confidence floor does not apply to it.
  The YOY-64 live run put the accuracy model at 1.5–7 s on occasion-class
  prompts with a hang to the 8 s deadline in 13 of 60 calls while the lite
  tier answered in 640–1400 ms; running the class lite-first instead
  regressed g09 on the harness (the lite tier labels gold wedding sandals
  `sneakers`, the golden needs `shoes`), so the class stays and the hedge
  bounds its tail. The accuracy call after a low-confidence or failed lite
  answer is never hedged; or the lite answer's `confidence` is below the
  threshold (`DEFAULT_INTENT_ESCALATION_THRESHOLD`, 0.8, the lowest
  confidence a correct lite answer reported on the eval set) or missing, in
  which case the accuracy answer replaces the lite one entirely. Both calls
  carry the same `searchId` and operation `"intent"` through their own port,
  so the ledger keeps their model ids apart. `extractDetailed` reports
  `{ intent, tier, escalation }`; the orchestrator surfaces the tier as
  `intentTier` (playground `details.intentTier`, the proxy's `[search]
  stages` log line — never the storefront contract). Refinements follow the
  same rules on the follow-up text; chip removal never reaches an extractor.
  Measured on the eval set (2026-08-26): 14 of 25 AI goldens escalate, all by class (11 `occasion`, 3 `mixed-script`), none by low confidence — every lite answer reported 0.8–1.0; 11 are answered by the lite tier with every rank preserved (gc05 improved 2 → 1); 1 of 9 follow-ups escalates (`mixed-script`). The one lite miss in the diff, g15, is the mixed-script class's reason to exist.
- Refinement (`extract(query, { previousIntent })`): a follow-up query is
  extracted against the intent of the previous one. The prompt asks the model
  to decide between a **refinement** — the previous intent with only the new
  query's deltas applied, every untouched constraint and soft attribute
  preserved, a comparative like "cheaper" tightening the existing bound — and
  a **topic change**, where the previous intent is discarded whole. The answer
  is always a complete `Intent` conforming to `INTENT_SCHEMA`, never a patch;
  the schema, the operation, and the retry ladder are unchanged. The engine
  holds no session state: `previousIntent` is supplied per call, and where a
  caller keeps it between requests is the caller's decision. Omitting it
  leaves the prompt byte-for-byte what it was before refinement existed, so
  recordings and caches keyed on it stay valid. Only one previous intent is
  ever considered — this is a refinement contract, not a chat history.

Retrieval (the AI result path; data reached only through injected ports):

- `interface RetrievalStore` — the store port the consumer implements over
  its own database (the app: Postgres/pgvector in
  `apps/shopify-app/app/search/retrieval-store.server.ts`). One
  `query({ storeId, constraints, vector, limit })` call returns products
  matching every hard constraint, ranked by cosine distance; constraints are
  WHERE filters inside the store, never post-ranking.
- `createRetriever({ embeddings, store, cacheSize? }): Retriever` —
  `retrieve({ intent, storeId, limit?, searchId? })` maps the Intent's
  hard constraints to store filters (`constraintsFromIntent`; size is
  deliberately unmapped — no per-size inventory exists to filter on), embeds
  the intent's descriptive signal (`composeQueryText`, metered as operation
  `"embedding"` and cached for identical inputs), and returns
  `{ hits: [{ productId, score }], appliedConstraints, timings? }` — `timings`
  is `{ embedMs, retrieveMs }`, the retrieval's own wall-time split
  (YOY-114; a cache hit reports an embed of ~0) — with
  `score = 1 - cosine distance`. Cosine distance spans [0, 2], so scores span
  [-1, 1]: anti-correlated vectors score below zero and are valid hits —
  consumers must not filter by `score > 0`. An intent with no descriptive
  signal (nothing for `composeQueryText` to embed) rejects with
  `EmptyQueryTextError` before any embedding call; the caller picks the
  fallback (e.g. classic constraint-only search).

Classic keyword search (the zero-LLM result path; YOY-41):

- `interface ClassicSearchStore` — the keyword-search port the consumer
  implements over its own database. One
  `search({ storeId, query?, constraints?, limit? })` call returns
  `{ hits: [{ productId, score }] }` — ranked keyword hits, score in [0, 1],
  higher is better. A request with constraints and no query text is
  constraint-only mode: results are filtered without text ranking and every
  hit scores 0. A classic search never issues an LLM or embedding call, so
  it writes no `AiCall` rows.
- The app's implementation (`apps/shopify-app/app/search/classic-store.server.ts`,
  `createPgTrgmClassicStore`) is Postgres/pg_trgm trigram search. The
  `20260808160000_pg_trgm_classic_search` migration enables the `pg_trgm`
  extension, defines `catalog_search_text(...)` — the lowercased join of
  `CatalogProduct`'s keyword fields (title, tags, vendor, productType,
  imageAltTexts) — and creates a trigram GIN index over that expression;
  classic queries filter with `query <% catalog_search_text(...)` (word
  similarity, threshold lowered to 0.30) and rank by
  `word_similarity(query, ...)`, so the index serves the plan and one- or
  two-edit typos ("nkie air max") still find the intended product, in
  English and Hebrew alike. **One statement per search (YOY-115 AC-1):**
  the threshold is set inside the statement — a one-row
  `SELECT set_config('pg_trgm.word_similarity_threshold', '0.3', true)`
  subquery is the outer side of a `CROSS JOIN LATERAL` whose inner side is
  the search and references that row, so the executor runs `set_config`
  before the `<%` scan reads the GUC (the plan is one Nested Loop with the
  threshold subquery outer; `classic-store.test.ts` pins that order and
  counts exactly one statement per search in both modes). `is_local` scopes
  the setting to the statement's transaction, so it never leaks through a
  pooler. The same statement returns the card fields (title, url, image,
  prices, currency, availability) on every hit (`ClassicCardHit`), so the
  orchestrator builds classic result cards without a follow-up hydration
  query — a classic-routed response's `stages` reads `classify, classic`
  with no `hydrate` (AC-3), and a keystroke preview or classic rescue is
  exactly one database round trip. A classic store that returns bare hits
  (a fake, another implementation) still hydrates as before. Constraint predicates mirror the pgvector store
  verbatim: unknown enrichment passes positive occasion/color constraints,
  category is evidence-required and expands through the taxonomy's category
  groups, a colour exclusion applies to `primaryColor` only, and a price cap
  compares against `priceMin`.

**One card per product family (YOY-117 AC-2, founder decision):** public
catalogs and the seed alike expose colourways as separate products ("Mesh
Over Dress in Pink" / "in Navy"; six "Wildfire Retro Treeline T-Shirt"
cards on `/s/tentree`). Both stores collapse each `familyKey` to one
representative INSIDE the SQL (`DISTINCT ON (family)` over the ranked
candidates, the limit applied after the collapse, so any page and any
count is of families, never colourways): the best-ranked member whose
`primaryColor` is one of the query's `colorsInclude` when it names
colours, else the best-ranked member. An empty `familyKey` is its own
family, and two products sharing vendor and title but not product type
never collapse, so the rule can never hide a different product. The
result shape is unchanged. The eval golden g26 `pink rib knit top` pins
it (pink member first, navy and black never in the top 10).

The vector candidate scan keeps a bound of its own (YOY-125 AC-10):
`max(limit, 1) * FAMILY_OVERSCAN` rows, `FAMILY_OVERSCAN = 8` in
`retrieval-store.server.ts`. An unbounded `ORDER BY distance` inside the
`candidates` CTE cannot use the HNSW iterative scan `withTenantVectorScan`
enables (YOY-105) — Postgres would compute the distance for every embedding
of the tenant passing the WHERE clause and sort them, on every AI search:
invisible on the seed catalog, a latency regression proportional to catalog
size on `/s/tentree`, `/s/whitestuff`, and any real merchant. The trade-off
the constant buys: a page whose window is filled by more than eight
colourways of one family can crowd out a further family that would otherwise
have made it. Eight is the headroom that keeps the common colourway depth
(three to six members) fully visible to the collapse.

**Attribute evidence rule (YOY-133, binding — PRD §3 amendment (d)):**
both stores judge `attributesExclude` and `attributesInclude` on the same
evidence text — `attributeConstraintSql` in `retrieval-store.server.ts`,
shared by the classic store — the product's platform-free snapshot text
(title, tags, description) plus the enrichment evidence (`fit`,
`styleTags`, and the five vision attribute values), concatenated with
`concat_ws` so an unenriched product is judged on its snapshot alone. One
predicate per word: `NOT (evidence ~* pattern)` for an exclusion (absent
evidence passes, as for every enrichment constraint) and `(evidence ~*
pattern)` for a category-like inclusion (evidence-required, as a category
is). The pattern (`attributeEvidencePattern`) is every surface form of the
word from the engine's lexicon — EN and HE; the word itself with its
singular/plural when unlisted, so "not polyester" still filters — matched
as a WHOLE word in either script ("sleeveless" is not "sleeves"; "long
sleeve" is), optionally behind one attached Hebrew preposition/article
(מצמר, העור), case-insensitively, and NEVER when the mention is negated:
a term right after "no", "not", "without", "non", "ללא", "בלי", "לא", or
read as "<term>-free", is a statement of absence — the nylon coat whose
description says "ללא צמר" survives "not wool", the tank top described
"ללא שרוולים" survives "no sleeves". A word the lexicon cannot turn into a
term (an empty or multi-word value) applies no predicate: a filter that
can match nothing is never applied. The eval's Constructor-bar set pins
the rule end to end (cn05–cn10, co01, co03, co04: 0 mustNot leaks; with
the purpose-phrase route for co09 the whole set is at 0 / 30 of 30 clean,
and `baseline-hits.json` `routes` pins every golden's route). The
generic-store analog (PRD portability rule) is the rule itself: every
evidence column is the platform-free snapshot or the enrichment row every
ingestion adapter fills, and the lexicon is the engine's; a Door 2 store
gets the identical predicate with no adapter work.

**Colour exclusion rule (YOY-110, binding — PRD §3 amendment, founder
decision 2026-08-22):** `colorsExclude` is applied by both stores against
the enrichment's `primaryColor` alone, case-insensitively — a pink dress
that also comes in black is not excluded by "not black" — and a null
`primaryColor` passes (unknown passes, as for every enrichment constraint).
`colorsInclude` is unchanged and still reads every colourway in `colors`.
The colour-evidence tier flag `colorUnknown` follows the evidence the
constraint reads: under an exclusion-only colour constraint it means
`primaryColor IS NULL`; under an inclusion it still means `colors` is empty
(`colorUnknownSql` in `retrieval-store.server.ts`, shared by both stores).
The eval harness's `findViolations` judges excluded colours by
`primaryColor` the same way. The live seed catalog re-enriches at version 1
on the next `npm run ingest` (AC-6, a separate slice).
- The eval harness routes goldens marked `expectedRoute: "classic"` through
  this store (≥8 classic goldens: exact EN, EN typo, Hebrew, and SKU-like
  queries) and asserts the expected product ranks in the top 5 at zero AI
  cost; the per-1,000-searches cost bar divides over AI-routed goldens only.

AI ports (vendor-free; implemented by provider adapter packages):

- `type JsonSchema` — `Record<string, unknown>` JSON Schema document.
- `interface StructuredCompletionRequest` — `{ prompt; schema; operation; temperature?; storeId?; searchId?; signal?; images? }`.
  `images?: InlineImage[]` (YOY-120 AC-3; PRD capability 14) carries raw
  image bytes with their MIME type, vendor-free; the Gemini adapter sends
  each as an `inlineData` part **before** the text part and meters usage
  exactly as `usageMetadata` reports it, image tokens included. Absent or
  empty, the request body is byte-for-byte the text-only call. No caller
  sends images yet (YOY-121 adds the vision pass).
- `interface InlineImage` — `{ mimeType: string; data: Uint8Array }`.
- `interface LlmClient` — `{ completeStructured(request): Promise<unknown> }`.
- `interface EmbeddingRequest` — `{ texts: string[]; operation?; storeId?; searchId? }`.
- `interface EmbeddingClient` — `{ readonly dimension: number; embed(request): Promise<number[][]> }`.
- `interface AiCallUsage` / `interface CostRecorder` — the metering port every
  adapter records through.

The app's `/healthz` route (`apps/shopify-app/app/routes/healthz.tsx`) calls
`createEngine().search(...)` and proves the wiring end to end.

## Hybrid search orchestrator and the fallback ladder (YOY-45)

`apps/shopify-app/app/search/orchestrator.server.ts`
(`createSearchOrchestrator({ db, classifier, extractor, retriever,
classicStore })`) is the one server-side entry point behind the product's
single search bar — a function; the HTTP surface over it is the app-proxy
endpoint below (YOY-46). `runSearch({ query, shopDomain, previousIntent?,
resolvedIntent?, forceClassic?, searchId?, limit? })` always resolves to one
response shape:
`{ searchId, route, routeReason, intent, hits, chips, degraded,
closeMatches, stages }`, where `hits` and `closeMatches` are display-ready product
cards (`productId`, `title`, `url`, `imageUrl`, `priceMin`/`priceMax`,
`currencyCode`, `available`; `handle` never leaves the adapter — YOY-87)
hydrated from the `CatalogProduct` snapshot in
hit order, and `chips` echoes the retrieval's applied constraints. One
`searchId` is generated per search (unless the caller threads its own) and
forwarded to every AI port call, so all `AiCall` rows serving one search
share it. `previousIntent` is passed through to the extractor context
unchanged; the orchestrator holds no session state. `resolvedIntent` (YOY-46
chip removal) is an intent the caller already holds: the orchestrator skips
classification and extraction — zero LLM calls — and enters the AI path at
retrieval, with `routeReason: "resolved-intent"` and the same fallback
ladder below it. `forceClassic` (YOY-47 throttle) skips the classifier
entirely and serves classic keyword results with `degraded: true` and
`routeReason: "throttled"` — also zero LLM calls.

Routing: the classifier's heuristics settle clearly-simple queries instantly;
everything else the LLM classifier decides. Classic-routed queries run the
trigram keyword engine on the raw query and carry no chips. AI-routed queries
run intent extraction → vector retrieval and return ranked hits plus chips
derived from the applied constraints.

The fallback ladder — every edge, top to bottom; no error shape from the AI
path ever reaches the caller:

1. **Classifier failure or timeout** — the classifier never rejects; it
   answers `{ route: "classic", reason: "model-error" }`, which the
   orchestrator serves as classic keyword results with `degraded: true`.
2. **Any AI-path failure** — intent LLM error or timeout (the Gemini
   adapter's `GeminiTimeoutError`/`GeminiApiError` taxonomy propagating
   through the port), `IntentExtractionError`, embedding failure, retrieval
   store error — yields classic keyword results for the raw query with
   `degraded: true` and no chips. The catch is deliberately type-blind:
   whatever threw, the shopper gets results.
3. **`EmptyQueryTextError`** (intent has constraints but no descriptive text,
   e.g. "not black under ₪400") is a designed edge, not a failure: the
   orchestrator runs constraint-only classic search, KEEPS the chips for the
   applied constraints, and does not set `degraded`.
4. **AI zero-hits** — retrieval succeeded but nothing satisfied every
   constraint: the response keeps the chips, an empty primary hit list, and
   `closeMatches` from classic keyword search on the raw query.

Classic-store errors are not caught: classic search is the ladder's floor and
shares its database with everything else, so a failure there is an
infrastructure outage that must surface to the caller's own error handling.

The eval harness (`apps/shopify-app/app/eval/harness.server.ts`) routes every
golden — classic and AI alike — through `runSearch`, and treats a `degraded`
response as a hard error: offline replay must never let the silent fallback
mask a broken recording as classic-quality results.

### Latency work on the AI path (YOY-64)

Four mechanisms, all inside the orchestrator and its wiring, none touching
retrieval semantics:

- **The ledger leaves the hot path (AC-1).** Production wraps the Prisma
  `CostRecorder` in `createQueuedCostRecorder`
  (`app/ai/cost-recorder.server.ts`): `record` validates the usage
  synchronously (an unpriced model still throws, before anything is queued)
  and resolves as soon as the insert is queued; writes chain in order, a
  failed insert is logged (`[ai-cost] ledger write failed …`) and never
  fails the search, and `flush()` awaits the queue. The synchronous
  recorder is what tests and the eval harness use, so ledger assertions
  stay exact.
- **Per-operation intent abort (AC-3).** The accuracy-tier intent client
  runs with `GEMINI_INTENT_TIMEOUT_MS` (default 4500 — the shopper's
  worst-case wait, YOY-124 AC-12; 8000 before) and the lite tier with
  `GEMINI_INTENT_LITE_TIMEOUT_MS` (default 3000, strictly below the
  deadline so a hung lite call still escalates), and the same
  `GEMINI_INTENT_TIMEOUT_MS` is the **deadline of the whole lite-first
  ladder**: `createEscalatingIntentExtractor({ deadlineMs })` arms one
  `AbortSignal` per extraction and forwards it to both tiers through
  `IntentExtractionContext.signal` → `StructuredCompletionRequest.signal`,
  which the Gemini adapter honours on top of its own per-request timeout.
  A lite call that fails with the budget spent degrades right there instead
  of escalating (lite 8 s + accuracy 8 s in series was ~16 s before the
  classic fallback); an accuracy call reached with budget left is cut at the
  deadline. So a never-answering upstream degrades the search to classic
  inside the widget's budgets — after its 3 s classic-rescue budget and long
  before its 30 s primary budget (`orchestrator.test.ts` asserts the relation
  against the widget's exported constants, over the whole ladder). The
  adapter's 60 s default stays for enrichment and embedding.
- **Exact-query intent reuse (AC-4).** Every submitted AI search that was
  served non-degraded stores its `Intent` and the normalized query
  (trimmed, whitespace-collapsed, case-folded) on its `SearchEvent`
  (`intent`, `normalizedQuery`; migration
  `20260826150000_search_event_intent_reuse`). A later query with the same
  normalized text from the same store within
  `INTENT_REUSE_WINDOW_MINUTES` (default 60; `0` disables) is answered from
  that intent with **zero LLM calls** — no classification, no extraction —
  as `routeReason: "intent-reuse"`, `intentTier: null`, and `stages` without
  `classify`/`intent`; retrieval still runs, so a catalog change reaches
  the repeated query. Refinements (`previousIntent`) and chip removals never
  reuse; a lookup failure falls through to the full ladder. A reuse is
  logged as a normal `SearchEvent` but spends no budget: the per-session and
  per-IP throttles and the playground's daily ceilings skip it. Exact text
  only — semantic caching is deferred (NG-5).
- **Concurrency (AC-5).** Intent extraction depends on the query, not on
  the classifier's decision, so when the classifier has no settled answer
  (`QueryClassifier.settled` — a heuristic rule or a cached model decision;
  an engine peek that never spends a call) the extraction starts alongside
  the model classification; a model-decided classic route discards the
  in-flight extraction and its cost is the price of the overlap on that
  rare shape, while heuristic-classic queries stay LLM-free. On the AI path
  the zero-hit rescue's keyword search runs alongside retrieval and is
  dropped when retrieval finds hits. `stages` books each stage's own wall
  time, so their sum may now exceed the response's wall time — that excess
  is the overlap; no single stage exceeds it.

The intent prompt itself was trimmed on AC-2 (the category vocabulary left
the prompt — the response schema's enum binds it — and every rule is stated
once) and the eval harness prints `intent input tokens: before N / after M
(−P %)` against `fixtures/intent-token-baseline.json`, asserting ≥ 30 % fewer
input tokens with every quality bar intact. Two guardrails survived the trim
on live evidence against the lite tier (6 samples per golden): the occasion
vocabulary stays spelled out with "null when the query states no occasion",
and the "omit / never invent" rule sits last, right before the query —
without either the lite model invents an occasion on g10/r09 in 2–3 of 6
samples. The comment on `buildIntentPrompt` carries the numbers.

### Per-stage timing: `stages` (YOY-114)

Every response carries `stages: Partial<Record<SearchStage, number>>` — whole
milliseconds per pipeline stage the search actually ran, keyed in pipeline
order from the fixed set in `app/search/stages.ts`:
`classify | intent | embed | retrieve | classic | hydrate | closeMatches`. A
stage that did not run is absent, so the key set is itself the route's
evidence: a classic search reads `classify, classic, hydrate`; an AI search
`classify, intent, embed, retrieve, hydrate`; a preview or forced-classic
response has no `classify`; a chip removal starts at `embed`. `embed` and
`retrieve` come from the retriever's own split (`RetrievalResult.timings`);
`hydrate` accumulates every card hydration the response needed (hits and
close matches both); `closeMatches` covers the zero-hit rescue — the
relaxation ladder plus the keyword fallback. Values are floored, so their sum never
exceeds the wall time around `runSearch` (`orchestrator.test.ts` pins both
the key sets per route and the sum bound). `stages` is diagnostic: the
playground shows it, the proxy route logs it, nothing persists it (no
migration), and the storefront contract never carries it. The measurement
method built on it is docs/LATENCY.md.

### Close matches: the relaxation ladder (YOY-111)

**Binding (PRD §3 amendment, founder decision 2026-08-22):** close matches
never violate an explicit exclusion, constraints relax one at a time —
price first — and the shopper is told which constraint was relaxed. On an
AI zero-hit (`retrieve` ran and nothing satisfied every constraint) the
orchestrator re-queries the vector store with the intent's cached
embedding down a fixed ladder (`relaxationLadder` in
`orchestrator.server.ts`): rung by rung it drops one more constraint group
— `priceMin`/`priceMax` (together, as the budget) → `occasion` →
`availabilityRequired` → `colorsInclude` → `category` — keeping every
constraint not yet relaxed, skipping groups the intent never stated, and
stopping at the first rung with hits. `colorsExclude` is never relaxed: it
rides every rung, and the final fallback — the raw-query trigram search
that already ran alongside retrieval (YOY-64 AC-5) — now runs in constraint
mode with the same exclusions, so a "not black" close match can never be
black-primary (the exclusion itself is judged by `primaryColor`, YOY-110).
`attributesExclude` rides every rung and the keyword fallback the same way
(YOY-133: a "not wool" close match is never a wool coat), and
`attributesInclude` rides every rung too — neither is a `RelaxedConstraint`.
The response carries `closeMatchesRelaxed: RelaxedConstraint[]` — the names
relaxed, in order; `[]` when nothing was (every non-zero-hit response, and
a zero-hit with no close matches). Both APIs serialize it beside
`closeMatches` (present exactly when `closeMatches` is); nothing else in the
contracts changed. The playground and the widget (overlay and native view)
render the close-matches heading from the string catalog as "Close matches
— <a>, <b>" (`closeMatchesHeadingText`): budget → "over your budget" /
"מעל התקציב", occasion → "other occasions" / "אירועים אחרים",
availability → "including sold out" / "כולל אזל מהמלאי", colour
inclusions → "other colours" / "צבעים אחרים", category → "other
categories" / "קטגוריות אחרות"; plain "Close matches" when the list is
empty. Chips, the zero-hit status line, `CLOSE_MATCH_LIMIT` (10), and card
anatomy are unchanged. The constraint-only classic path (an intent with no
descriptive text, `EmptyQueryTextError`) has no vector to relax and still
answers `closeMatches: []`. The eval harness scores the ladder with a
zero-hit golden (g25, `zeroHit: { relaxedFirst: "priceMax" }`) and counts
an excluded primary colour among close matches as a hard-constraint
violation.

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

**Request JSON.**

```json
{
  "query": "elegant dress for a wedding",
  "sessionId": "widget-generated-id",
  "previousIntent": { "…": "the previous response's intent, echoed as-is" },
  "removeChip": { "field": "occasion", "value": "wedding" }
}
```

`query` and `sessionId` are required (`sessionId` is carried for later
milestones; nothing is persisted — no query logging in this issue).
`previousIntent` alone marks a refinement: it is passed to the intent
extractor's context unchanged. `removeChip` (requires `previousIntent`) is
chip removal, below.

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
      "available": true
    }
  ],
  "chips": [{ "field": "occasion", "value": "wedding" }],
  "intent": { "…": "full intent, absent optionals as null — or null" },
  "closeMatches": [{ "…": "results shape; present only on AI zero-hits" }]
}
```

`intent` is what the client echoes back as `previousIntent` on a follow-up.
The serializer re-maps every field explicitly (`serializeProxySearchResponse`),
so orchestrator-internal diagnostics like `routeReason` — and anything the
orchestrator response grows later — cannot leak to a shopper.

**Search logging (YOY-47).** Every submitted search request — degraded,
zero-hit, throttled, and classic-rescued included — writes exactly one
`SearchEvent` row (searchId, shop, sessionId, query, resolved route, the
orchestrator's `routeReason`, degraded flag, latency, result count) through
`app/search/events.server.ts`. The write is an observer: a logging failure
is swallowed and logged server-side, never failing the shopper's response.
`routeReason` (YOY-96 AC-9; nullable, rows from before the column are null)
is what tells a classic row's cause apart in the ledger — a heuristic or
model decision, a `throttled` session, or the widget's
`client-timeout-rescue` — so rescue frequency and AI-value searches can be
measured rather than inferred.

**The classic rescue (YOY-108, YOY-96 AC-9).** When the widget's SUBMITTED
search runs out its own client-side budget it re-asks the same query with
`mode=classic`: the proxy routes it through the orchestrator's
`forceClassic` path with reason `client-timeout-rescue` — zero LLM calls,
no throttle budget consumed, `degraded: true` — and, unlike a
`mode=preview` keystroke fetch, logs it as a real `SearchEvent` and returns
an attributable `searchId`, so the widget keeps it as `currentSearchId` and
a click on a rescued card beacons like any other. Like `preview`, `classic`
is a bare classic fetch and rejects `previousIntent`/`removeChip` (400).

**Click beacon (YOY-47).** `POST /apps/unfiltered/click`
(`app/routes/apps.unfiltered.click.tsx`), signature-verified exactly like
the search route. Body: `{ searchId, sessionId, productId, position }`. The
searchId must name a `SearchEvent` of the signed shop — the body is
shopper-controlled, so an unknown or foreign searchId answers `404` and
writes nothing. Success answers `204` with an empty body and one
`ClickEvent` row.

**Per-session AI throttle (YOY-47).** `app/search/throttle.server.ts` keeps
an in-process sliding one-minute window per `sessionId`. Once a session has
run `SEARCH_AI_THROTTLE_PER_MINUTE` (default 10) AI-routed searches inside
the window, further searches from it are forced onto the classic path with
zero LLM calls — served `degraded: true` on the unchanged contract shape,
and still logged. Classic-routed searches and chip-removal requests neither
consume budget nor get forced (chip removal makes no classification or
intent call to begin with). The state is deliberately in-process: the limit
is per Node instance, so horizontal scaling multiplies the effective
ceiling, and a restart clears the windows — accepted for now; a distributed
store is a later milestone's concern.

**Chip removal.** A request carrying the previous response's `intent` plus
one `removeChip` (`field` + `value`) recomputes results without that
constraint: the server drops the constraint from the intent
(`removeChipFromIntent` — pure intent surgery; array-valued fields remove
just the named value, `availability` clears the flag) and runs the
orchestrator with `resolvedIntent`, which skips classification and
extraction entirely. The round-trip makes zero LLM calls — no new `AiCall`
rows with a `classification` or `intent` operation — and the response's chip
list no longer carries the removed chip. Embedding calls (cached, estimated)
still occur, as the adjusted intent is re-retrieved.

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

Intent extraction is lite-first (YOY-116): the app wires
`createEscalatingIntentExtractor` over two metered Gemini clients —
`GEMINI_INTENT_LITE_MODEL` (default `gemini-3.5-flash-lite`) at
`GEMINI_INTENT_LITE_THINKING_LEVEL` (default `low`, explicit, never the model
default) and `GEMINI_INTENT_MODEL` (the accuracy tier, unchanged) — with
`INTENT_ESCALATION_THRESHOLD` (default the engine's 0.8) as the confidence
floor. The eval harness replays the same ladder over two recording sets
(`intent-lite*.json` beside the accuracy `intent*.json`) and prints the
escalation rate, calls per tier, and the blended per-search cost, whose bar
is **≤ $0.60 per 1,000 AI searches** (PRD §8). `config/ai-prices.json` was
corrected on YOY-116 AC-8: `gemini-3.6-flash` is $0.75 / $3.75 per 1M tokens
through 2026-12-31 (the $1.50 / $7.50 the table carried is the 2027 price),
so every cost figure from before that date is 2× over-metered on the
accuracy tier. Measured on the eval harness (2026-08-26, YOY-116): blended per-search cost **$0.52 per 1,000 AI searches** on the routed blend (the accuracy-only blend at the same corrected prices is $0.54; at the over-metered 2026 table it read $1.07), refinement follow-ups $0.60 per 1,000, escalation rate 56% of AI searches and 11% of follow-ups, intent calls 19 lite / 15 accuracy across 25 AI goldens and 9 follow-ups. Under the corrected accuracy price the bar is met by pricing alone by a hair; lite-first is what moves the blend off the line and, on the live tail, is the cheaper tier for the majority of plain queries.

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
Google bills the prompt tokens of a request it has begun — and since the
intent hedge (`hedgedAccuracy`) aborts the losing tier on every occasion-class
query, an aborted intent call is a normal outcome, not a rare deadline cut.
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
`POST /apps/unfiltered/search` (query + a sessionStorage-held per-session
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

AI states (YOY-49): an AI-routed response renders its applied constraints
as a chip row above the grid — one removable chip per constraint, labeled
in English ("dress", "Under 400", "Not black", "In stock") with an
accessible remove label. Removing a chip resends the last query carrying
the held intent plus the dismissed chip (the endpoint's chip-removal
contract — zero LLM calls server-side) and the whole overlay re-renders
from the response. The widget holds the latest response's echoed `intent`
in memory only (page-view lifetime, never persisted — NG-4): a follow-up
typed into the bar rides it as `previousIntent` so the server refines
rather than restarts, and each response's echo replaces the held one. A
"New search" control clears the held intent, input, chips, and results; the
next request carries no `previousIntent` field at all. AI zero-hits render
a "Nothing matches all of these" message, the still-removable chip row, and
the response's `closeMatches` as standard cards under a "Close matches"
heading that names what the server relaxed to find them (YOY-111:
"Close matches — over your budget"). Degraded responses (route classic, `degraded: true`) render as
plain classic cards with no chips and no error messaging.

UI tests are a separate lane from Vitest: Playwright
(root `playwright.config.ts`, specs in `apps/shopify-app/widget/test-ui/`)
starts the widget dev harness — the same Vite config serving
`widget/index.html` (fake storefront with a theme-like search form and
contract-shaped stubbed search/beacon endpoints selected via `?fixture=`:
results, empty, error, timeout, delayed, beacon-missing, ai, ai-zero-hit,
ai-delayed, degraded — plus a contract-correct chip-removal echo),
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
  takes the proxy's own parameters — `query`, `sessionId`, `mode=preview`,
  `previousIntent`, `removeChip` — parsed by the proxy's own
  `parseProxySearchParams`, so preview, refinement, and chip-removal
  semantics cannot drift between the two APIs. Plus `catalog`, a registry
  slug: absent means the seed catalog, whose tenant key comes from
  `PLAYGROUND_SEED_STORE_KEY`. An unset seed with no `catalog` answers `503`
  (a deployment gap, not a visitor error); an unknown slug answers `404`
  rather than silently searching the seed; a malformed request answers `400`.
  Every response — every status — carries `Cache-Control: no-store` and no
  CORS headers at all: the playground's pages are same-origin, and a third
  party must not be able to spend our AI budget from their site.
- **Response body** = the proxy contract (`searchId`, `route`, `degraded`,
  `results[]`, `chips`, `intent`, `closeMatches?`) plus
  `details: { routeReason, latencyMs, limited, stages }`, built by
  `serializePlaygroundSearchResponse` (`app/playground/api.server.ts`), which
  delegates the card/chip/intent mapping to the proxy's own serializer and
  adds exactly those four fields — `stages` copied key by key in pipeline
  order (YOY-114). A shape test pins the top-level keys and the `details`
  keys, so a later orchestrator field cannot leak out. Primary hits are
  capped at 24.
- **`POST /api/playground/click`** (`app/routes/api.playground.click.tsx`)
  takes the beacon body `{ searchId, sessionId, productId, position }` and
  the same `catalog` parameter. POST rather than the proxy's GET because
  there is no proxy edge here to work around. The `searchId` must name a
  search THAT catalog ran — the body is visitor-controlled — else `404` and
  no row.

### Abuse guards

Unauthenticated means the exposure is the AI bill, so three guards sit in
front of the AI path. Every one degrades to classic results rather than to an
error: a visitor who trips a ceiling still gets a working search, told
honestly through `degraded` and `details.limited`.

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
spend guard and multiple instances share one count. Only AI-routed rows
count: a search served classic (throttled, capped, or simply keyword-routed)
spent no LLM budget and must not consume the ceiling it was denied.

Precedence when several would bind is broadest-first — global, then catalog,
then IP — because the broadest binding constraint is the one that explains
the degradation; naming `"ip"` while the whole playground is capped would
send a visitor chasing their own behavior for a condition they cannot affect.

Previews and chip removals are never limited and never counted: a preview is
classic-only by contract and a chip removal makes no LLM call, so neither can
burn budget. Previews write no `SearchEvent`; every submitted search writes
exactly one, limited ones included — the ceilings are counted from that table.

Route tests (`app/playground-api.test.ts`) run on the PGlite test DB with a
fake orchestrator threaded through the real `getProxySearchOrchestrator`, so
the production wiring is what they exercise.

## Quality gates

Vitest, ESLint, and `tsc --noEmit` run from the root as `npm test`,
`npm run lint`, and `npm run typecheck`; `.github/workflows/ci.yml` runs all
three on every pull request, plus the `ui` job running `npm run test:ui`
(Playwright, Chromium) against the widget harness, plus the `dist-seam` job
that builds the workspaces and runs the retrieval-path suites through
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

- **Chips are output, not input.** An AI-routed response's applied
  constraints render as removable pills through the widget's own
  `chipLabel`, so Hebrew display cannot drift between the two surfaces
  (P-5). They never render on a preview, on classic results, or on a
  degraded response: a chip claims an understanding, and a degraded response
  is classic results wearing the AI route's name (W-7).
- **Refinement lives in the bar, not in a transcript.** Exactly one intent is
  held, in memory: each response's echoed intent replaces it, a follow-up
  rides it as `previousIntent`, and removing a chip re-requests with
  `removeChip` and re-renders from the answer rather than editing the chip
  row locally. "New search" drops it. There is no history and no chat
  (NG-2, X-2), and nothing is persisted.
- **Engine details are opt-in and live in the URL.** The toggle writes
  `?details=1`, so an opened panel survives a reload and can be shared as a
  link; closed, the panel is absent from the DOM rather than hidden with its
  space reserved. The intent JSON is the one place monospace is permitted
  (P-4, DESIGN §2). The panel's stage rows
  (`[data-testid="playground-details-stages"]`, YOY-114) list one
  `<stage> · <ms> ms` row per stage the search ran, in pipeline order, from
  `details.stages`; a classic search's missing `intent`/`embed`/`retrieve`
  rows are the visible proof it made no LLM call.
- **Example queries are the page's argument for itself.** Six are shown —
  four in the chrome language and two in the other, because the claim is
  that either works. Each is tagged with the capability it demonstrates
  (negation, price cap, occasion, soft attribute, colour plus availability,
  refinement) and `playground-examples.test.ts` asserts the set still covers
  all six, so an edit cannot quietly cost the page its point.

Fixture mode gains the matching states (`ai`, `ai-zero-hit`, `ai-delayed`,
`degraded`, `color-unknown`) plus a chip-removal echo: removing a constraint
answers a response with that chip gone from the intent AND the products it
excluded back in the set, so a broken remove-and-re-render cannot pass. The
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
  `sessionId` each, and prints per set n, p50, p95, the mean per stage, and
  the count of `degraded`/`limited`/`reused` responses. Every AI-set request
  carries an invisible marker (four zero-width format characters as base-4
  digits of a per-invocation nonce plus the run number, appended after a
  space) so its exact-query reuse key differs per run and per invocation:
  without it, runs 2..N would be answered from the stored intent with zero
  LLM calls (YOY-64 AC-4) and the probe would measure the cache, not the
  pipeline. The marker is invisible, not absent: the orchestrator passes the
  raw query to the LLM classifier and the intent model, so both receive the
  committed query plus the marker as-is — roughly 6 extra input tokens per
  call, no retrieval change — and the AI bars are measured on
  committed-query-plus-marker, not on a byte-identical shopper query; only
  `visibleQueryText` strips it, and only for the probe's reporting.
  `reused` in the summary is the count of samples the marker failed to
  protect and must read 0. `--assert-classic-p95`,
  `--assert-ai-p50`, `--assert-ai-p95` turn the bars into an exit code. The
  AI sets are paced under the playground's per-IP throttle so the probe
  measures the pipeline, not the guard. `scripts/latency-probe.test.ts`
  pins the nearest-rank math (including n=20) and the exit semantics.

## Daily live smoke (YOY-112)

`apps/shopify-app/scripts/live-smoke.mts` runs four read-only probes against
the deployment — `/healthz` (HTTP 200 and `engine.version` equal to the
engine's source `version`), classic `dress`, EN AI `elegant evening dress
under 400`, HE AI `שמלה אלגנטית לערב מתחת ל-400` — with the ceilings in
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

## Deferred components

Real widget search behavior (calling the proxy endpoint, theme-search
takeover, result rendering), merchant dashboard, and billing are future
milestones and intentionally absent from the current codebase.
