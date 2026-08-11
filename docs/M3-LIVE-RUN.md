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
  `apps/shopify-app/.env`. `psql` is NOT required: the committed
  Prisma-based evidence script reads the same rows —
  from `apps/shopify-app`, after `set -a && source .env && set +a`:

  ```bash
  npx tsx scripts/evidence.mts counts             # index size (step 7)
  npx tsx scripts/evidence.mts searches 5         # SearchEvent log (Part 3)
  npx tsx scripts/evidence.mts costs SEARCH_ID    # AiCall rows per search
  npx tsx scripts/evidence.mts clicks 5           # ClickEvent log (step 15)
  ```

  If you prefer a UI, `npm --workspace app run prisma -- studio` browses
  the same tables.

## Part 1 — Deploy the extension and enable the embed

1. Prerequisites — dependencies installed and the app linked to the Partner
   org per [DEV-STORE.md](DEV-STORE.md) (steps 1–6 there). Additionally,
   `apps/shopify-app/.env` must define, for this run:

   - `DATABASE_URL` — the Neon Postgres connection string (pgvector enabled).
   - `GEMINI_API_KEY` — a valid Google AI Studio key.
   - `ADMIN_TOKEN` — any secret string; gates `/internal/costs`.

   **Expected outcome:** `npm install` completes; the three variables are
   present in `apps/shopify-app/.env` (which is gitignored — never commit it).

   Before Part 2, open the embedded app once — dev-store admin → Apps →
   unfiltered. The offline `Session` access token goes stale across
   multi-day gaps and only an embedded-app load refreshes it (hit live on
   2026-08-09); skipping this leaves Part 2's Admin API calls failing with
   auth errors until the app is opened.

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
indexing surface is a later milestone). Execute them with the committed
entrypoint `apps/shopify-app/scripts/ingest.mts` (YOY-69) — the offline
access token persisted in the `Session` table authenticates the Admin API
calls, so no tunnel is needed.

5. (Superseded by YOY-69: the script is committed; nothing to create.)

6. Run the ingest entrypoint with the app's `.env` loaded (second terminal;
   the dev server keeps running):

   ```bash
   cd apps/shopify-app && set -a && source .env && set +a && npm run ingest
   ```

   (Pass another shop with `npm run ingest -- SHOP.myshopify.com`.)

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

8. (Superseded by YOY-69: the script is a committed repo file — nothing to
   delete; `git status` stays clean by construction.)

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

- **Date:** 2026-08-09
- **Executed by:** Yoyo (Parts 1–2, steps 9, 10, 15); steps 11–18 agent-executed
- **Tunnel host:** repeated-ensures-plaza-arrange.trycloudflare.com (run 1; each restart mints a new tunnel — step 16 ran on sentence-radio-curious-ict, step 17 on section-disclaimers-fireplace-web)
- **Dev-catalog size (products):** 18
- **One-time indexing cost (from `/internal/costs`):** $0.004396

_Steps 11–18 were agent-executed under user supervision after in-run defects made continued manual execution unproductive; all evidence is from the live dev store._

| # | Scenario | Result | Evidence (paste rows / observations) |
|---|---|---|---|
| 2–3 | Dev server + `/healthz` 0.4.0 | PASS | `{"status":"ok","engine":{"version":"0.4.0",...}}` on the tunnel host; proxy `Using URL` ends in `/apps/unfiltered`. (Start required `--path .` — see YOY-52 AC-8.) |
| 4 | App embed enabled, widget mounts | PASS | Embed toggled on and saved; `unfiltered-widget.js` loads; focusing the theme search input opens the shadow-DOM overlay. |
| 6–7 | Ingest / enrich / embed counts equal, failed = 0 | PASS | `ingest/enrich/embed` = 18/18/18, `failed: 0`; counts query returned products=18, enriched=18, embedded=18; `/internal/costs` renders the AiCall ledger, one-time cost $0.004396. |
| 9 | EN classic query | PASS | `snowboard` → overlay cards, no chip row; `route=classic degraded=f resultCount>0`, zero AiCall rows. |
| 10 | EN typo query | PASS | `snobroad` → intended snowboards still appear via pg_trgm; `route=classic results=10` (searchId `d1bd4c0d…`). Finding: "Gift Card" ranked #1 above actual boards → YOY-52 AC-13. Result set also exposed draft/archived products → YOY-61 (2). |
| 11 | Hebrew AI query — chips, RTL, `AiCall` rows | FAIL | (a) Digit-bearing runbook query shape misroutes to classic — YOY-61 (1). Digit-free 2-word `סנובורד כחול` ALSO heuristic-routes classic: `route=classic degraded=f results=0`, zero AiCalls (searchIds `fba7934a…`, `b4d2aa60…`) — misroute is not digit-only. (b) Digit-free constraint-rich `סנובורד כחול מתחת למאתיים` routed ai server-side (searchId `9c0a4875…`, 9853ms, classification+intent+embedding AiCalls) but the widget aborts searches at its 5s client timeout (`search-client.ts DEFAULT_TIMEOUT_MS`) and went permanently inert (`goInert` self-removal) — at current live AI latency (YOY-52 AC-12) no AI response can ever render. Chips evidence was collected under a labeled client-side `searchTimeoutMs=30000` override: `route=ai degraded=f results=1 latency=24477ms` (searchId `8487feaa…`), Hebrew RTL chrome (`dir="rtl"`, `docLang=he`), chips rendered: `עד 200` (priceMax=200) + `כחול` (colorsInclude=blue). |
| 12 | Chip removal — no intent/classification calls | PASS | Clicked the color chip's ×: chip gone, `עד 200` retained, results 1→3. New SearchEvent `58f2c2d5…` `route=ai degraded=f results=3 latency=1056ms`, AiCalls = embedding only ($3e-7) — no intent/classification. (Run under the step-11 timeout override.) |
| 13 | Refinement — previousIntent honored | FAIL | `אותו דבר אבל יותר זול` (digit-free) → `route=ai results=3 latency=18267ms` (searchId `6d7848c5…`, classification+intent+embedding). previousIntent honored: the price-free follow-up echoed the held `priceMax=200` chip. But the bound was NOT tightened (200 → 200; result set unchanged) — the "tightened price bound" expectation failed. |
| 14 | AI zero-hit — message + chips + close matches | FAIL | `שמלת כלה ורודה` (digit-free) → zero-hit message shown ("שום פריט לא מתאים לכל הסינונים"), removable chips rendered (`שמלה`/`ורוד`/`חתונה`), `route=ai results=0 latency=16091ms` (searchId `f40cb940…`, intent AiCalls present). Close-matches section stayed empty/hidden: classic keyword backfill returns 0 for Hebrew text against the EN catalog (same gap YOY-61 (1) records), so the close-matches expectation failed. |
| 15 | Click beacon — `ClickEvent` row | PASS | ClickEvent written for searchId `d1bd4c0d…`, product `gid://shopify/Product/8029965779019`, position 4. Finding: the clicked product was "The Archived Snowboard" and navigation landed on a storefront 404 — archived/draft products indexed and served, filed as YOY-61 (2). |
| 16 | Forced fallback — silent classic, degraded log | PASS | Restarted with `GEMINI_API_KEY=invalid-key-m3-test` as an env-var prefix (`.env` untouched). AI-shaped query `סנובורד כחול מתחת למאתיים` → no chips, no error UI, widget stays live; SearchEvent `26d57fa6…` `route=classic degraded=t latency=642ms`, zero AiCall rows. (resultCount=0 is the known Hebrew-vs-EN-catalog classic gap, not error UI.) |
| 17 | Throttle — 4th search degraded, window clears | PASS | Restarted with `SEARCH_AI_THROTTLE_PER_MINUTE=3`, one browser session, four digit-free Hebrew AI queries (כחול/אדום/שחור/ירוק) completing 18:06:19–18:06:47Z: q1 `bd13605a…` ai, q2 `8dd2dff0…` ai, q3 `47fb5b98…` ai (all chips rendered), q4 `43357016…` `route=classic degraded=t results=0 latency=378ms`, **zero** AiCall rows. After 65s idle, q5 `סנובורד סגול מתחת למאתיים` → `1bca4c31…` `route=ai` with chips (window cleared). |
| 18 | Clean `git status` after the run | PASS | Dev server stopped (throttle override not left running), no background processes. Deleted throwaway `m3-evidence.mts` (and the leftover Part-2 `m3-index.mts`); restored the dev-CLI's uncommitted `uid` addition to `shopify.extension.toml`. `git status --porcelain` empty. |

**Findings filed (defects observed during the run, as Linear issues):**

- YOY-60 — shop-domain proxy edge 400s browser POSTs; fixed in-run (GET transport + remainder paths + `--path` proxy URL), PRs #40/#41, Done.
- YOY-61 — (1) NL queries misroute to classic (digit-bearing per the filed evidence; this run adds that a digit-free 2-word Hebrew query misroutes too) and (2) archived/draft products indexed and served (404 on click). Open, Urgent.
- YOY-52 ACs 8–14 — appended from this run: CLI `--path` pinning + doc reality (AC-8), proxy `Cache-Control: no-store` (AC-9), duplicate-`shop`-param probe (AC-10), extension `locales/` ENOENT noise (AC-11), live AI latency 8–24s vs <2s target (AC-12 — this run adds: the widget's 5s client abort turns that latency into permanent widget self-removal on every AI search), classic ranking title-dominance / Gift-Card-first (AC-13), magnifier no-op while overlay open (AC-14).
