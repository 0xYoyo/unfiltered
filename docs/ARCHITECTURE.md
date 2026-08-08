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
model, the `AiCall` cost-metering ledger, the write-only `SearchEvent` and
`ClickEvent` shopper activity logs (YOY-47; one `SearchEvent` per proxy
search — degraded, zero-hit, and throttled included — and one `ClickEvent`
per verified click beacon, both indexed on `(shopDomain, createdAt)`;
nothing reads them yet except the beacon's searchId validation), and the
`CatalogProduct` per-shop catalog snapshot (unique per `shopDomain` + `productId`, content-hashed for
idempotent re-ingestion via `app/catalog/ingest.server.ts`; also carries the
display-only fields `handle` and `featuredImageUrl` (YOY-44) for result
cards — deliberately outside `contentHash`, so ingestion and webhook sync
refresh them even when searchable content is unchanged, and a display-only
change never triggers re-enrichment or re-embedding); the baseline migration runs
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

## Hybrid search orchestrator and the fallback ladder (YOY-45)

`apps/shopify-app/app/search/orchestrator.server.ts`
(`createSearchOrchestrator({ db, classifier, extractor, retriever,
classicStore })`) is the one server-side entry point behind the product's
single search bar — a function; the HTTP surface over it is the app-proxy
endpoint below (YOY-46). `runSearch({ query, shopDomain, previousIntent?,
resolvedIntent?, forceClassic?, searchId?, limit? })` always resolves to one
response shape:
`{ searchId, route, routeReason, intent, hits, chips, degraded,
closeMatches }`, where `hits` and `closeMatches` are display-ready product
cards (`productId`, `title`, `handle`, `imageUrl`, `priceMin`/`priceMax`,
`currencyCode`, `available`) hydrated from the `CatalogProduct` snapshot in
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
no Shopify tokens or internal error details ever do:

```json
{
  "searchId": "uuid",
  "route": "classic | ai",
  "degraded": false,
  "results": [
    {
      "productId": "gid://shopify/Product/1",
      "title": "…",
      "handle": "…",
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

**Search logging (YOY-47).** Every search request — degraded, zero-hit, and
throttled included — writes exactly one `SearchEvent` row (searchId, shop,
sessionId, query, resolved route, degraded flag, latency, result count)
through `app/search/events.server.ts`. The write is an observer: a logging
failure is swallowed and logged server-side, never failing the shopper's
response.

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

## Storefront widget and UI test lane

The storefront search widget (YOY-43 scaffold, YOY-48 takeover) is plain
TypeScript + CSS in `apps/shopify-app/widget/src/`, built by Vite
(`apps/shopify-app/widget/vite.config.ts`) into one self-contained IIFE
bundle emitted — and committed — under the theme app extension's assets
(`apps/shopify-app/extensions/unfiltered-widget/assets/`; rebuild with
`npm run build:widget` from the root). The stylesheet ships inside the
bundle: all widget DOM lives in an open shadow root and the CSS is injected
there as a `<style>` element, so theme CSS cannot break the overlay layout
and widget CSS cannot leak onto host elements, while inheritable typography
(font-family, color) still flows in from the host page. The extension's app
embed block (`blocks/unfiltered-search.liquid`, `target: body`) loads the
bundle and calls `window.UnfilteredWidget.init({ locale, shopDomain })`.

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
(searchId, productId, position) and navigates to `/products/{handle}`
regardless of the beacon's outcome. Degradation is total silence: no
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
heading. Degraded responses (route classic, `degraded: true`) render as
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

## Quality gates

Vitest, ESLint, and `tsc --noEmit` run from the root as `npm test`,
`npm run lint`, and `npm run typecheck`; `.github/workflows/ci.yml` runs all
three on every pull request, plus the `ui` job running `npm run test:ui`
(Playwright, Chromium) against the widget harness. The engine-boundary rule
is mechanically enforced by `packages/engine/test/boundary.test.ts`, which
fails the suite if the engine's manifest or source ever references a
`@shopify/*` package.

## Deferred components

Real widget search behavior (calling the proxy endpoint, theme-search
takeover, result rendering), merchant dashboard, billing, and
deployment/hosting are all future milestones and intentionally absent from
the current codebase.
