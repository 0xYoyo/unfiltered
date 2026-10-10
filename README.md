# Unfiltered

> **Maintenance notice:** any change that alters setup commands, workspace
> layout, auth model, data layer, or the engine API must update this file and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) in the same pull request. Doc
> accuracy is part of review.

Unfiltered replaces rigid filter-based product search on fashion Shopify
stores with free-text search that understands how shoppers actually describe
what they want ("elegant summer wedding dress, not black, under ₪400"), in
any language, and proves its value to the merchant in attributed
orders. It ships as a self-serve Shopify app backed by a catalog-agnostic
search engine.

- Product source of truth: [docs/PRD.md](docs/PRD.md)
- Architecture record: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Monorepo layout

npm-workspaces monorepo with three workspaces:

| Workspace | Purpose |
| --- | --- |
| `apps/shopify-app` | Embedded Shopify app (official Shopify React Router + TypeScript template). Consumes the engine as a client. |
| `packages/engine` | Catalog-agnostic search engine with a versioned, typed public API: the wish extraction, the judge, the enrichment vocabularies and the classic keyword-search port — all data and AI access through vendor-free ports (LLM, decision model, embedding, cost metering, classic-search store). |
| `packages/provider-gemini` | Google AI Studio (Gemini) adapter implementing the engine's LLM and embedding ports, metered through the cost-recorder port. |

## Follow-up queries (refinement)

After a result set, "same but cheaper" or "בלי שרוולים" means *modify that
search*, not start a new one. Every submitted response carries a `carry` —
the chain's first sentence plus its two most recent refinements — and the
client sends it back as `previousQuery` on the next search. The find step,
the wish extraction and the judge read it; the extraction also answers
whether the new sentence refines the chain or replaces it ("nike air max 90"
starts a new one). The server stores nothing between searches: the client
holds the carry. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
full contract and `apps/shopify-app/app/search/refinement.test.ts` for the
tests that pin the behavior.

## Setup

Requires Node.js `>=20.19 <22 || >=22.12`.

Install all workspaces from the repo root:

```bash
npm install
```

## Quality gates

TypeScript `strict` is enabled in every workspace. From the root:

```bash
npm run typecheck
```

Vitest runs the test suites of both workspaces, including the boundary test
that fails if `packages/engine` ever references a `@shopify/*` package:

```bash
npm test
```

ESLint runs per workspace via:

```bash
npm run lint
```

UI tests (Playwright) drive the storefront widget against its local dev
harness — no Shopify and no network:

```bash
npm run test:ui
```

All four commands run in CI (`.github/workflows/ci.yml`) on every pull
request and must pass before merge.

## Storefront widget

The storefront search widget lives in `apps/shopify-app/widget/`
(TypeScript + CSS, bundled by Vite) and ships to themes through the theme
app extension in `apps/shopify-app/extensions/unfiltered-widget/`: an app
embed block loads the built assets and calls
`window.UnfilteredWidget.init({ locale, storeId })` with the storefront
locale and shop domain. Build the self-contained bundle into the extension's
`assets/` (the output is committed):

```bash
npm run build:widget
```

For manual development, the same Vite config serves a fake storefront
harness (theme-like search form + stubbed search endpoint, no Shopify):

```bash
npm run widget:harness --workspace app
# http://127.0.0.1:4173 and /no-search-form.html
```

## Run locally

The app runs through the Shopify CLI, which needs a Shopify Partner login and
a development store (see `.env.example` for the placeholder variables the app
reads):

```bash
npm run dev --workspace app
```

To smoke-test without Shopify credentials, build and start the server
directly with placeholder env values, then hit the health route that
exercises the engine wiring:

```bash
npm run build
npx prisma generate --schema apps/shopify-app/prisma/schema.prisma
SHOPIFY_API_KEY=placeholder SHOPIFY_API_SECRET=placeholder \
SHOPIFY_APP_URL=https://localhost:3000 SCOPES=write_products \
npm run start --workspace app
# in another shell:
curl http://localhost:3000/healthz
```

`/healthz` returns the engine version and a typed empty search result from
the engine stub.

## Outreach links

Ingest a public store's catalog and share the playground over it:

```bash
npm run ingest:public --workspace app -- \
  --url https://store.example.com --slug store-example --name "Store Example"
# then share https://<deployment>/s/store-example
```

`/s/<slug>` is the playground with that catalog preloaded; the store's name
is the only thing the page adds, and the page is `noindex`. An unknown slug
answers a designed 404, never the seed catalog. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Deployment

The playground runs as a Docker web service on Render, built from the
repo-root `Dockerfile` and described by `render.yaml`. The image builds every
workspace and the entrypoint applies migrations before serving; a container
without `DATABASE_URL` refuses to start. Full setup, environment values,
free-plan behavior, rollback, and custom-domain steps live in
[docs/DEPLOY.md](docs/DEPLOY.md).

```bash
docker build -t unfiltered .
```

CI builds the same image on every pull request.
