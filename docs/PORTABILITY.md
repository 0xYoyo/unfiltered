# Adapter-Boundary Portability Map

**Audit date:** 2026-08-15
**Source:** the YOY-81 "Yoyo-diagnose report" comment (read-only audit of
`main` through PR #67). This document is hand-written from that report; it
is not generated and is not covered by the repo-map drift guard.
**Scope:** every shopper-facing and data-path mechanism — search entry,
proxy/auth, results rendering, chips, refinement, attribution/click beacon,
ingestion/sync, rate limiting — classified as **engine** (generic),
**adapter** (Shopify-specific by necessity), or **LEAK** (Shopify
assumptions inside what should be generic).

## Standing boundary rule

From the PRD portability amendment (binding, 2026-08-13; see
`docs/PRD.md`, "Portability constraint"): v1 is built Shopify-first, but
every shopper-facing mechanism must state its generic-store (Door 2) analog
at design time. **Shopify-specific code is an adapter around a generic
mechanism, never the mechanism itself.** A design whose generic analog
cannot be stated is rejected at spec time.

## Classification table

| Component | Classification | Why |
| --- | --- | --- |
| `packages/engine/src/*` (index, classify, intent, taxonomy, retrieve, classic) | Engine | All data access goes through platform-free ports (`RetrievalStore`, `ClassicSearchStore`, `LlmClient`, `EmbeddingClient`, `CostRecorder`). Constraints, taxonomy, refinement, and scoring carry zero platform assumptions. One naming caveat → LEAK-1. |
| `app/search/orchestrator.server.ts` (hybrid ladder: routing → intent → retrieval → fallbacks → hydration) | Engine (engine-adjacent backend, portable) | Fully platform-free. Its Prisma dependency is our own infrastructure, which Door 2 reuses as-is (feed + snippet + our backend); Postgres is not a Shopify assumption. |
| `app/search/events.server.ts`, throttle interface, `SearchEvent` / `ClickEvent` / `AiCall` schema | Engine | Generic multi-tenant attribution (searchId validated against the tenant's own searches). Portable. |
| `CatalogProduct` schema shape | Engine | title/description/tags/price/availability/images is a generic catalog row. Shopify appears only in comments and the tenant key name. |
| Proxy wire contract (`proxy.server.ts`) | Engine | Explicit re-mapping, platform-free fields — except `handle` → LEAK-2. |
| App-proxy auth in `routes/apps.unfiltered.search.tsx` / `.click.tsx` | Adapter | Signature verification + signed shop identity, all above the platform-free call into the orchestrator. Clean boundary. |
| GET-only transport | Adapter (not a leak) | The rationale is Shopify's (its proxy edge rejects browser POSTs); the mechanism (GET + query params) is universally portable. |
| Catalog ingestion / webhook sync / `mapping.server.ts` | Adapter | Shopify Admin payloads → generic rows. This IS the adapter, exactly where it belongs. |
| Theme app embed (extension/liquid), OAuth `Session` model | Adapter | Adapter by definition. |
| `shopDomain` as the tenant key in engine port types, `WidgetConfig`, and every DB table | LEAK-1 (naming) | Value is opaque, so nothing breaks — but the "catalog-agnostic by contract" surface speaks Shopify. |
| `/products/${handle}` hardcoded in `widget/src/overlay.ts` (`card()`); `handle` as the card-contract field | LEAK-2 (structural) | Shopify's storefront URL scheme inside otherwise platform-free rendering code. |
| Host-discovery heuristics in `widget/src/main.ts` (`findThemeSearchInput()`, Enter/submit suppression) | LEAK-3 (soft, config-level) | Assumes `input[type=search]` / `form[action*="/search"]` + `input[name=q]` and `/search` navigation. Degrades safely (no match → no mount). |

## Leaks: generic-store analogs and routing

### LEAK-1 — `shopDomain` is the tenant key in the engine's own port types

- **Where:** `StoreQueryRequest`, `RetrievalRequest`, `ClassicSearchRequest`,
  `StructuredCompletionRequest`, `EmbeddingRequest`, `AiCallUsage` (engine),
  `WidgetConfig` (widget), and every DB table.
- **Nature:** naming leak, not structural. The value is opaque — any string
  works — so nothing breaks at Door 2, but M4's playground is the first
  non-Shopify consumer and would pass a fake "shop domain" for a seeded
  catalog, baking the false name in deeper.
- **Generic analog:** `storeId` / `tenantId` in the ports; the Shopify adapter
  passes the myshopify domain as its value.
- **Cost:** mechanical rename (engine + provider-gemini + app call sites; DB
  column renames optional/deferred — the port name is the leak, the column is
  internal).
- **Routing:** stable code → **filed as YOY-84** — resolved: engine and
  widget ports now name the tenant key `storeId`; DB columns keep
  `shopDomain` per YOY-84 NG-1.

### LEAK-2 — `/products/${handle}` hardcoded in the widget core

- **Where:** `widget/src/overlay.ts` (`card()`), plus `handle` as the
  card-contract field (`proxy.server.ts`, orchestrator hydration).
- **Nature:** the one structural leak — Shopify's storefront URL scheme inside
  otherwise platform-free rendering code.
- **Generic analog:** the server sends a per-card `url` resolved adapter-side
  (Shopify: `/products/{handle}`; generic: the feed's product URL); the widget
  renders `result.url` and never composes URLs.
- **Bites in M4:** the playground reuses the same card language (DESIGN.md
  P-5) over a seeded catalog with no `/products/` routes, so the link target
  is undefined there — M4 must resolve this regardless.
- **Routing:** **folded into the M4 spec** (contract change: `url` field in
  `ProxyResult` + hydration + widget; `handle` may remain
  Shopify-adapter-internal).

### LEAK-3 — host-discovery heuristics in the widget core

- **Where:** `widget/src/main.ts` — `findThemeSearchInput()` matches
  `input[type=search]` / `form[action*="/search"]` + `input[name=q]`, and
  Enter/submit suppression assumes `/search` navigation.
- **Nature:** soft leak. The takeover mechanism is generic and degrades safely
  (no match → no mount), and `/search?q=` is near-universal e-commerce
  convention.
- **Generic analog:** discovery is config-overridable — the embed config
  already exists; add optional `searchInputSelector` / suppression config.
- **Routing:** **folded into M6 / the YOY-70 spike contract** — theme-card
  cloning and YOY-82 chrome derivation rework exactly this file; a standalone
  issue now would be rewritten.

## Verdict (from the audit)

The boundary is in good shape: engine and adapters are correctly separated;
three leaks total, one structural (LEAK-2, resolves in M4 by necessity), two
naming/config-level. Door 2 remains an adapter-writing exercise. Every audited
mechanism is classified above; nothing is unexplained.
