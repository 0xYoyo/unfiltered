# M3 live-run runbook — `unfiltered-dev`

- **Date:** _fill in when executed_
- **Executed by:** _fill in_
- **Store domain:** unfiltered-dev.myshopify.com
- **Engine version:** 0.4.0
- **Billing:** Gemini Tier 1

M3's behavior is verified offline by Vitest/PGlite and the Playwright widget
harness; nothing yet proves the widget, app proxy, fallback ladder, throttle,
and logging work on a real storefront with live Shopify signing and live
Gemini. This runbook is the milestone's user-executed evidence run, the
M3 counterpart of [M2-LIVE-RUN.md](M2-LIVE-RUN.md). It is deliberately
manual: follow the numbered steps in order and fill the evidence template at
the end. Defects found along the way are filed as Linear findings, not fixed
in this document's PR.

## Known proxy-edge constraint (YOY-60)

The first execution of this run (2026-08-09) found Shopify's shop-domain
app-proxy edge rejecting every proxy **POST that carries an `Origin` header**
with a bodied 400 before forwarding — and browsers attach `Origin` to every
fetch POST, so no browser POST can ride the proxy at all (header bisection:
`Origin` alone flips forwarded→rejected; GET with `Origin` forwards fine).
This was observed on the password-protected dev store; whether an unlocked
production store behaves the same is unproven, so the widget does not bet on
it: **both the search request and the click beacon ride GET with query
parameters** (`widget/src/search-client.ts`), which forwards in every
observed case. Two related mappings to know when probing:

- Shopify forwards `/apps/unfiltered/*` to `app_proxy.url` + the path
  **remainder** — and the dev CLI pushes the bare tunnel root as the proxy
  URL, so in dev the forwarded paths are `{tunnel}/search` and
  `{tunnel}/click`. The app serves those remainder paths (and the full
  `/apps/unfiltered/*` paths) with identical signed handlers.
- The theme's native predictive search is suppressed by the widget while it
  owns the input (capture-phase interception); if a native SUGGESTIONS
  dropdown appears over the overlay, the widget is not mounted or has gone
  inert.

Conventions used below:

- Run every command from the **repo root** unless a step says otherwise.
- `TUNNEL_HOST` is the `*.trycloudflare.com` (or similar) host printed by
  `shopify app dev`.
- Database snippets use `psql` with the Neon `DATABASE_URL` from
  `apps/shopify-app/.env`. If you prefer a UI over `psql`, `npm --workspace
  app run prisma -- studio` browses the same tables.

## Part 1 — Deploy the extension and enable the embed

1. Prerequisites — dependencies installed and the app linked to the Partner
   org per [DEV-STORE.md](DEV-STORE.md) (steps 1–6 there). Additionally,
   `apps/shopify-app/.env` must define, for this run:

   - `DATABASE_URL` — the Neon Postgres connection string (pgvector enabled).
   - `GEMINI_API_KEY` — a valid Google AI Studio key.
   - `ADMIN_TOKEN` — any secret string; gates `/internal/costs`.

   **Expected outcome:** `npm install` completes; the three variables are
   present in `apps/shopify-app/.env` (which is gitignored — never commit it).

2. Start the dev server and tunnel:

   ```bash
   npm --workspace app run dev
   ```

   Select `unfiltered-dev` when prompted.

   **Expected outcome:** the CLI prints the tunnel URL, runs
   `prisma migrate deploy` against Neon, serves the
   `unfiltered-widget` theme app extension as a draft to the dev store, and
   updates the app's URLs (including the `/apps/unfiltered/*` proxy) to the
   tunnel. Leave this process running for the entire run.

3. Sanity-check the wiring before touching the storefront:

   ```bash
   curl -s https://TUNNEL_HOST/healthz
   ```

   **Expected outcome:** `{"status":"ok","engine":{"version":"0.4.0",...}}`.

4. Enable the app embed: Shopify admin → **Online Store → Themes →
   Customize** → the **App embeds** panel (puzzle-piece icon) → toggle
   **Unfiltered search** on → **Save**.

   **Expected outcome:** the embed toggle is on and saved. Opening the
   storefront and viewing page source shows `unfiltered-widget.js` loading;
   focusing the theme's search input opens the widget overlay.

## Part 2 — Ingest, enrich, and embed the dev catalog

The pipeline functions (`ingestCatalog`, `enrichCatalog`, `embedCatalog`) are
committed app modules with no admin-UI trigger yet (a merchant-facing
indexing surface is a later milestone). For this run, execute them directly
with a throwaway script — the offline access token persisted in the `Session`
table authenticates the Admin API calls.

5. Create the script at `apps/shopify-app/m3-index.mts` (paste as-is):

   ```bash
   cat > apps/shopify-app/m3-index.mts <<'EOF'
   import { PrismaClient } from "@prisma/client";
   import { ingestCatalog } from "./app/catalog/ingest.server";
   import { enrichCatalog, createEnrichmentLlmClient } from "./app/catalog/enrich.server";
   import { embedCatalog, createCatalogEmbeddingClient } from "./app/catalog/embed.server";

   const SHOP = "unfiltered-dev.myshopify.com";
   const db = new PrismaClient();

   const session = await db.session.findFirstOrThrow({
     where: { shop: SHOP, isOnline: false },
   });
   const graphql = (query: string, options?: { variables?: Record<string, unknown> }) =>
     fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
       method: "POST",
       headers: {
         "Content-Type": "application/json",
         "X-Shopify-Access-Token": session.accessToken,
       },
       body: JSON.stringify({ query, variables: options?.variables }),
     });

   console.log("ingest:", await ingestCatalog({ db, shopDomain: SHOP, graphql }));
   console.log("enrich:", await enrichCatalog({ db, shopDomain: SHOP, llm: createEnrichmentLlmClient(db) }));
   console.log("embed:", await embedCatalog({ db, shopDomain: SHOP, embeddings: createCatalogEmbeddingClient(db) }));

   await db.$disconnect();
   EOF
   ```

6. Run it with the app's `.env` loaded (second terminal; the dev server keeps
   running):

   ```bash
   cd apps/shopify-app && set -a && source .env && set +a && npx tsx m3-index.mts
   ```

   **Expected outcome:** three result lines, e.g.
   `ingest: { created: N, updated: 0, unchanged: 0, deleted: 0 }`,
   `enrich: { enriched: N, cached: 0, failed: 0 }` (failed must be 0), and
   `embed: { embedded: N, ... }`, where N is the dev-catalog product count.
   Re-running is idempotent: content hashes make the second pass report
   `unchanged`/`cached`.

7. Confirm the index and its one-time cost:

   ```bash
   psql "$DATABASE_URL" -c 'SELECT
       (SELECT count(*) FROM "CatalogProduct"  WHERE "shopDomain" = '"'"'unfiltered-dev.myshopify.com'"'"') AS products,
       (SELECT count(*) FROM "ProductEnrichment" WHERE status = '"'"'enriched'"'"') AS enriched,
       (SELECT count(*) FROM "ProductEmbedding") AS embedded;'
   ```

   and open `https://TUNNEL_HOST/internal/costs?token=ADMIN_TOKEN`.

   **Expected outcome:** the three counts are equal; the cost page renders
   the `AiCall` ledger with `enrichment` and `embedding` rows for the run
   (M2 reference for 60 products: ~$0.013 one-time). Without the exact
   token the page is a 404.

8. Delete the script — the repo must stay unchanged (`git status` clean):

   ```bash
   rm apps/shopify-app/m3-index.mts
   ```

## Part 3 — Storefront verification pass

Perform every step in the storefront (theme with the embed enabled), in one
browser session — the throttle and refinement checks depend on session
continuity. After each search, confirm its log row:

```bash
psql "$DATABASE_URL" -c 'SELECT "searchId", left(query, 40) AS query, route,
    degraded, "resultCount", "latencyMs"
  FROM "SearchEvent" ORDER BY "createdAt" DESC LIMIT 5;'
```

and its per-search AI cost (substitute the `searchId` from the row above):

```bash
psql "$DATABASE_URL" -c 'SELECT operation, "modelId", "costUsd"
  FROM "AiCall" WHERE "searchId" = '"'"'SEARCH_ID'"'"';'
```

9. **EN classic query.** Focus the theme's search input and type an exact
   product-title word from the dev catalog (e.g. `snowboard`).

   **Expected outcome:** the overlay opens and renders product cards (image,
   title, price, sold-out marker where applicable) with **no chip row**.
   `SearchEvent`: `route = classic`, `degraded = f`, `resultCount > 0`.
   `AiCall` for that searchId: **zero rows** (heuristic-settled classic
   queries make no LLM call; a classification row alone is also acceptable
   when the heuristics deferred to the model).

10. **EN typo query.** Clear the input and type a one/two-edit typo of the
    same product (e.g. `snowbaord`).

    **Expected outcome:** the intended product still appears (pg_trgm
    word-similarity ranking). `SearchEvent`: `route = classic`,
    `resultCount > 0`.

11. **Hebrew AI query with chips.** Switch the storefront language to Hebrew
    (theme editor → language selector, or the store's `/he` locale URL if
    published). Reload the storefront and type a constraint-rich Hebrew
    query, e.g. `שמלה אלגנטית לערב מתחת ל-400` ("elegant evening dress
    under 400").

    **Expected outcome:** the widget chrome is Hebrew and the overlay is
    RTL (`dir="rtl"` on the widget root). A chip row renders above the
    results — one removable chip per applied constraint (category, price
    cap, occasion), Hebrew-labeled with the price formatted with the
    currency. `SearchEvent`: `route = ai`, `degraded = f`. `AiCall` rows for
    the searchId include `intent` (and `classification` and `embedding`)
    operations — this is the per-search cost evidence for AC-2.

12. **Chip removal.** Click the × on the price chip.

    **Expected outcome:** results and chips re-render from the response; the
    price chip is gone and does not reappear; more (or equal) results show.
    A **new** `SearchEvent` row is written; its searchId has **no**
    `classification` or `intent` `AiCall` rows (chip removal re-enters at
    retrieval — embedding-only cost).

13. **Refinement.** With results still shown, type a comparative follow-up
    into the bar, e.g. `אותו דבר אבל יותר זול` ("same but cheaper").

    **Expected outcome:** the request rides the held intent as
    `previousIntent`; the response's chips show the previous constraints
    with a tightened price bound — not a from-scratch intent. `SearchEvent`:
    `route = ai`. (The "New search" control afterwards clears chips, input,
    and results.)

14. **AI zero-hit.** Type a query whose constraints nothing satisfies, e.g.
    `שמלת כלה ורודה מתחת ל-2` ("pink wedding dress under 2").

    **Expected outcome:** a "nothing matches all of these" message, the
    still-removable chip row, and a **close matches** section rendering
    classic keyword results as standard cards under a distinct heading.
    `SearchEvent`: `route = ai`, `resultCount = 0`.

15. **Click beacon.** Click a product card in any result set above.

    **Expected outcome:** the browser navigates to `/products/{handle}`.
    One `ClickEvent` row exists for that search:

    ```bash
    psql "$DATABASE_URL" -c 'SELECT "searchId", "productId", position
      FROM "ClickEvent" ORDER BY "createdAt" DESC LIMIT 3;'
    ```

    with the clicked product's id and its list position, and a `searchId`
    matching the `SearchEvent` that rendered it.

16. **Forced fallback (silent classic).** Stop `shopify app dev` (Ctrl+C).
    In `apps/shopify-app/.env`, set `GEMINI_API_KEY=invalid-key-m3-test`.
    Restart `npm --workspace app run dev`, reload the storefront, and repeat
    the AI query from step 11.

    **Expected outcome:** the shopper sees plain classic result cards — no
    chips, **no error UI of any kind** (the fallback ladder's type-blind
    catch). `SearchEvent`: `route = classic`, `degraded = t`. No `intent`
    `AiCall` rows are added. Restore the real `GEMINI_API_KEY` and restart
    the dev server before continuing.

17. **Throttle.** To avoid hand-running 11 AI searches, restart the dev
    server with a lowered window budget (in the terminal running it):

    ```bash
    SEARCH_AI_THROTTLE_PER_MINUTE=3 npm --workspace app run dev
    ```

    Reload the storefront and submit **four different** AI-shaped Hebrew
    queries (variants of step 11) within one minute.

    **Expected outcome:** searches 1–3 behave as step 11 (chips, `route =
    ai`). Search 4 silently returns classic cards with no chips:
    `SearchEvent` row 4 has `route = classic`, `degraded = t`, and its
    searchId has **zero** `AiCall` rows. After >60 seconds idle, a fifth AI
    query routes `ai` again (window cleared). Restart the dev server without
    the override afterwards (default budget 10/minute).

18. **Wrap up.** Stop the dev server. Confirm the repo is untouched:

    ```bash
    git status --porcelain
    ```

    **Expected outcome:** empty output (the run changed only the database
    and the dev store; `.env` edits are outside git).

## Part 4 — Evidence template

Copy this section into the PR (or fill it in place on the runbook branch)
when executing the run. The issue (YOY-51) is complete only when a passing
run is recorded here.

- **Date:**
- **Executed by:**
- **Tunnel host:**
- **Dev-catalog size (products):**
- **One-time indexing cost (from `/internal/costs`):**

| # | Scenario | Result | Evidence (paste rows / observations) |
|---|---|---|---|
| 2–3 | Dev server + `/healthz` 0.4.0 | ☐ PASS / ☐ FAIL | |
| 4 | App embed enabled, widget mounts | ☐ PASS / ☐ FAIL | |
| 6–7 | Ingest / enrich / embed counts equal, failed = 0 | ☐ PASS / ☐ FAIL | |
| 9 | EN classic query | ☐ PASS / ☐ FAIL | |
| 10 | EN typo query | ☐ PASS / ☐ FAIL | |
| 11 | Hebrew AI query — chips, RTL, `AiCall` rows | ☐ PASS / ☐ FAIL | |
| 12 | Chip removal — no intent/classification calls | ☐ PASS / ☐ FAIL | |
| 13 | Refinement — previousIntent honored | ☐ PASS / ☐ FAIL | |
| 14 | AI zero-hit — message + chips + close matches | ☐ PASS / ☐ FAIL | |
| 15 | Click beacon — `ClickEvent` row | ☐ PASS / ☐ FAIL | |
| 16 | Forced fallback — silent classic, degraded log | ☐ PASS / ☐ FAIL | |
| 17 | Throttle — 4th search degraded, window clears | ☐ PASS / ☐ FAIL | |
| 18 | Clean `git status` after the run | ☐ PASS / ☐ FAIL | |

**Findings filed (defects observed during the run, as Linear issues):**

- _none / YOY-NNN …_
