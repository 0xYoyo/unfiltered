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
  `gemini-3.5-flash-lite` for classification/enrichment, `gemini-3.6-flash`
  for intent, `gemini-embedding-001` for embeddings); the API key comes from
  `GEMINI_API_KEY`. Fixture tests only by default; live round-trips run
  solely under `LIVE_LLM_TESTS=1` locally, never in CI.

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
model, the `AiCall` cost-metering ledger, and the `CatalogProduct` per-shop
catalog snapshot (unique per `shopDomain` + `productId`, content-hashed for
idempotent re-ingestion via `app/catalog/ingest.server.ts`); the baseline migration runs
`CREATE EXTENSION IF NOT EXISTS vector`, and the classic-search migration
`CREATE EXTENSION IF NOT EXISTS pg_trgm`). The app knows only a Postgres connection string: `DATABASE_URL`
from a gitignored `.env` (a managed Neon database in dev), documented in
`.env.example`. SQLite is gone.

Tests never require a live database: `createTestDb()`
(`apps/shopify-app/app/testing/helpers.server.ts`) spins up an in-process
embedded Postgres (PGlite) with pgvector and pg_trgm loaded, applies the committed
migration SQL, and hands Prisma a driver adapter for it — so `npm test`
passes with no `DATABASE_URL` set and no external Postgres.

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
  settles clearly-simple queries with zero LLM calls, everything else asks
  the model (operation `"classification"`), cached by normalized query and
  failing safe to `classic`.
- `createIntentExtractor({ llm }): IntentExtractor` — turns free text into a
  vendor-free `Intent` (category, price bounds with currency, color
  inclusions/exclusions, occasion, size, availability requirement, soft
  attributes) via the model (operation `"intent"`), with one retry on schema
  violation and then a typed `IntentExtractionError`.

Retrieval (the AI result path; data reached only through injected ports):

- `interface RetrievalStore` — the store port the consumer implements over
  its own database (the app: Postgres/pgvector in
  `apps/shopify-app/app/search/retrieval-store.server.ts`). One
  `query({ shopDomain, constraints, vector, limit })` call returns products
  matching every hard constraint, ranked by cosine distance; constraints are
  WHERE filters inside the store, never post-ranking.
- `createRetriever({ embeddings, store, cacheSize? }): Retriever` —
  `retrieve({ intent, shopDomain, limit?, searchId? })` maps the Intent's
  hard constraints to store filters (`constraintsFromIntent`; size is
  deliberately unmapped — no per-size inventory exists to filter on), embeds
  the intent's descriptive signal (`composeQueryText`, metered as operation
  `"embedding"` and cached for identical inputs), and returns
  `{ hits: [{ productId, score }], appliedConstraints }` with
  `score = 1 - cosine distance`. Cosine distance spans [0, 2], so scores span
  [-1, 1]: anti-correlated vectors score below zero and are valid hits —
  consumers must not filter by `score > 0`. An intent with no descriptive
  signal (nothing for `composeQueryText` to embed) rejects with
  `EmptyQueryTextError` before any embedding call; the caller picks the
  fallback (e.g. classic constraint-only search).

Classic keyword search (the zero-LLM result path; YOY-41):

- `interface ClassicSearchStore` — the keyword-search port the consumer
  implements over its own database. One
  `search({ shopDomain, query?, constraints?, limit? })` call returns
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
  similarity, threshold lowered to 0.30 transaction-locally) and rank by
  `word_similarity(query, ...)`, so the index serves the plan and one- or
  two-edit typos ("nkie air max") still find the intended product, in
  English and Hebrew alike. Constraint predicates mirror the pgvector store
  verbatim: unknown enrichment passes positive occasion/color constraints,
  category is evidence-required and expands through the taxonomy's category
  groups, and a price cap compares against `priceMin`.
- The eval harness routes goldens marked `expectedRoute: "classic"` through
  this store (≥8 classic goldens: exact EN, EN typo, Hebrew, and SKU-like
  queries) and asserts the expected product ranks in the top 5 at zero AI
  cost; the per-1,000-searches cost bar divides over AI-routed goldens only.

AI ports (vendor-free; implemented by provider adapter packages):

- `type JsonSchema` — `Record<string, unknown>` JSON Schema document.
- `interface StructuredCompletionRequest` — `{ prompt; schema; operation; shopDomain?; searchId? }`.
- `interface LlmClient` — `{ completeStructured(request): Promise<unknown> }`.
- `interface EmbeddingRequest` — `{ texts: string[]; operation?; shopDomain?; searchId? }`.
- `interface EmbeddingClient` — `{ readonly dimension: number; embed(request): Promise<number[][]> }`.
- `interface AiCallUsage` / `interface CostRecorder` — the metering port every
  adapter records through.

The app's `/healthz` route (`apps/shopify-app/app/routes/healthz.tsx`) calls
`createEngine().search(...)` and proves the wiring end to end.

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

Embedding calls are the one estimated entry in the ledger: Gemini
`batchEmbedContents` returns no usage metadata, so the adapter meters input
tokens as `ceil(chars / ESTIMATED_CHARS_PER_TOKEN)` with
`ESTIMATED_CHARS_PER_TOKEN = 4` (`packages/provider-gemini/src/index.ts`) —
the common Latin-script heuristic. Error bound: roughly a factor of two;
non-Latin scripts (Hebrew) tokenize to fewer characters per token, so the
estimate skews low for HE-heavy text. If the API ever returns real usage
metadata for embeddings, it replaces the estimate.

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
`vitest.config.ts` (`apps/*/app/**/*.test.{ts,tsx}` and
`packages/*/test/**/*.test.ts`) are the single source of truth for where
tests live; a test outside those globs silently never runs, so new test
locations must be added there deliberately.

## Quality gates

Vitest, ESLint, and `tsc --noEmit` run from the root as `npm test`,
`npm run lint`, and `npm run typecheck`; `.github/workflows/ci.yml` runs all
three on every pull request. The engine-boundary rule is mechanically
enforced by `packages/engine/test/boundary.test.ts`, which fails the suite if
the engine's manifest or source ever references a `@shopify/*` package.

## Deferred components

Real search logic, vector store, catalog ingestion, merchant dashboard,
billing, and deployment/hosting are all future milestones and intentionally
absent from the current codebase.
