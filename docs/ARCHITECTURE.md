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

Five topics are registered in `shopify.app.toml` and handled under
`apps/shopify-app/app/routes/webhooks.*`: `app/uninstalled` (deletes the
shop's persisted sessions), `app/scopes_update`, and the three mandatory GDPR
compliance topics `customers/data_request`, `customers/redact`, and
`shop/redact` (acknowledge-and-200 — no shopper data is stored yet). Every
handler authenticates through the library's HMAC verification; signature and
auth behavior are covered by offline unit tests with fixture payloads
(`app/routes/webhooks.test.ts`, `app/routes/app.auth.test.ts`,
`app/session-storage.test.ts`).

## Data layer

Prisma on Postgres 18 with the pgvector extension
(`apps/shopify-app/prisma/schema.prisma`, currently the template's `Session`
model plus the `AiCall` cost-metering ledger; the baseline migration runs
`CREATE EXTENSION IF NOT EXISTS vector`). The app knows only a Postgres connection string: `DATABASE_URL`
from a gitignored `.env` (a managed Neon database in dev), documented in
`.env.example`. SQLite is gone.

Tests never require a live database: `createTestDb()`
(`apps/shopify-app/app/testing/helpers.server.ts`) spins up an in-process
embedded Postgres (PGlite) with pgvector loaded, applies the committed
migration SQL, and hands Prisma a driver adapter for it — so `npm test`
passes with no `DATABASE_URL` set and no external Postgres.

## Engine public API (current surface)

`packages/engine` (`@unfiltered/engine`) exports, from `src/index.ts`:

- `version: string` — semantic version of the API contract (`"0.2.0"`).
- `interface EngineDocument` — `{ id: string; fields: Record<string, string> }`.
- `interface SearchOptions` — `{ limit?: number; offset?: number }`.
- `interface SearchHit` — `{ documentId: string; score: number }`.
- `interface SearchResult` — `{ hits: SearchHit[]; totalCount: number; query: string }`.
- `interface Engine` — `{ readonly version: string; search(query, options?): Promise<SearchResult> }`.
- `createEngine(): Engine` — returns the stub implementation (every search
  resolves to an empty result).

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
