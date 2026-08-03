# Unfiltered

> **Maintenance notice:** any change that alters setup commands, workspace
> layout, auth model, data layer, or the engine API must update this file and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) in the same pull request. Doc
> accuracy is part of review.

Unfiltered replaces rigid filter-based product search on fashion Shopify
stores with free-text search that understands how shoppers actually describe
what they want ("elegant summer wedding dress, not black, under ₪400"), in
English and Hebrew, and proves its value to the merchant in attributed
orders. It ships as a self-serve Shopify app backed by a catalog-agnostic
search engine.

- Product source of truth: [docs/PRD.md](docs/PRD.md)
- Architecture record: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Monorepo layout

npm-workspaces monorepo with three workspaces:

| Workspace | Purpose |
| --- | --- |
| `apps/shopify-app` | Embedded Shopify app (official Shopify React Router + TypeScript template). Consumes the engine as a client. |
| `packages/engine` | Catalog-agnostic search engine with a versioned, typed public API. Currently a stub implementation plus vendor-free AI ports (LLM, embedding, cost metering). |
| `packages/provider-gemini` | Google AI Studio (Gemini) adapter implementing the engine's LLM and embedding ports, metered through the cost-recorder port. |

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

All three commands run in CI (`.github/workflows/ci.yml`) on every pull
request and must pass before merge.

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
