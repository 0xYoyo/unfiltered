# M4 live-run runbook — the deployed playground

- **Date:** _fill in when executed_
- **Executed by:** _fill in_
- **Deployment URL:** _fill in — `https://<service>.onrender.com`_
- **Engine version:** 0.4.0 (expected at `/healthz`)
- **Billing:** Gemini Tier 1

The playground is the project's public proof surface: a stranger opens a URL,
types a sentence, and either sees their own catalog answering it or does not.
Every part of that is verified offline — Vitest against the hermetic DB, the
Playwright fixture lane against the real rendered page — and none of it yet
proves the thing works on the real deployment, over the real seed catalog and
real public stores, in both languages, with real Gemini and a real cold start.

This runbook is M4's user-executed evidence run, the M4 counterpart of
[M3-LIVE-RUN.md](M3-LIVE-RUN.md). It is deliberately manual: follow the
numbered steps in order and fill the evidence table in Part 6. Defects found
along the way are filed as Linear issues and linked from the table — they are
**not** fixed in this document's PR (NG-1).

## Header block — fill before starting

Record what the run actually ran against. Redact every secret to its shape
(`sk-…`, last four characters at most); never paste a live key or connection
string into this file.

| Field | Value |
| --- | --- |
| Deployment URL | _e.g. `https://unfiltered-3khq.onrender.com`_ |
| Render service / plan | _service name, Free or Starter_ |
| Commit deployed (SHA) | _from Render → Deploys_ |
| `DATABASE_URL` | _Neon host + database only, credentials redacted_ |
| `GEMINI_API_KEY` | _redacted; note the AI Studio project/tier_ |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | _redacted; note the app record they came from_ |
| `SHOPIFY_APP_URL` | _the deployment's own origin_ |
| `SCOPES` | _e.g. `write_products`_ |
| `ADMIN_TOKEN` | _redacted (gates `/internal/costs`)_ |
| `PLAYGROUND_SEED_STORE_KEY` | _e.g. `unfiltered-dev.myshopify.com`_ |
| `PLAYGROUND_SEED_NAME` | _display name shown on `/`_ |
| `PLAYGROUND_AI_THROTTLE_PER_MINUTE` | _blank = default 10_ |
| `PLAYGROUND_DAILY_AI_CAP` | _blank = default 2000_ |
| `PLAYGROUND_CATALOG_DAILY_AI_CAP` | _blank = default 500; step 26 changes this temporarily_ |
| `GEMINI_*_MODEL` / `GEMINI_EMBEDDING_DIMENSION` | _blank = the documented defaults; list any pin_ |
| Keep-awake monitor | _e.g. UptimeRobot, 5-min ping, target path_ |

**Seed catalog provenance** (required by AC-2 — the recorded answer as of the
2026-08-16 import; re-state it here if the catalog is re-seeded):

- **Source:** `shopifypartners/shopify-product-csvs-and-images` →
  `csv-files/fashion.csv` (Shopify's Partner-education demo-data repo),
  trimmed to `fashion-seed-400.csv`: 465 products / 2,421 rows, demo-weighted
  towards womenswear. Every product has a price and ≥1 image; images are
  re-hosted on `cdn.shopify.com` at import.
- **License / rights:** the source repo disclaims its images as belonging to
  the respective theme-template owners, "intended for private use only".
  Product data is Shopify partner demo data. **Accepted for the dev phase
  only** — the dev store is password-gated and the playground has ~zero
  pre-outreach traffic.
- **Binding follow-up (pre-M8 gate):** before outreach links go out the seed
  catalog must be swapped to rights-clear data (a design partner's real
  catalog, or a generated catalog over openly-licensed images). This rides
  M8's spec session.
- **Known seed-data footnotes:** `imageAltTexts` is empty on 100% of rows, so
  alt-text signal contributes nothing to enrichment or embedding on this
  catalog; two distinct products share the title "Delicious Camisole" (a seed
  artifact, not an ingest fault — a fair dedupe/quality probe, not a defect).

## Conventions

- Run every command from **`apps/shopify-app`** unless a step says otherwise,
  with the app's env loaded:

  ```bash
  cd apps/shopify-app && set -a && source .env && set +a
  ```

  The local `.env` needs `DATABASE_URL` pointing at the **same** Neon database
  the deployment uses — the evidence queries read the rows the deployment
  writes.
- `SERVICE` below is the deployment origin from the header block.
- Database evidence comes from the committed Prisma script (no `psql`
  required):

  ```bash
  npx tsx scripts/evidence.mts counts            # index size for EVIDENCE_SHOP
  npx tsx scripts/evidence.mts searches 5        # latest SearchEvent rows
  npx tsx scripts/evidence.mts costs SEARCH_ID   # AiCall rows for one search
  npx tsx scripts/evidence.mts clicks 5          # latest ClickEvent rows
  ```

  `counts` and `searches` are scoped by `EVIDENCE_SHOP`, which defaults to
  `unfiltered-dev.myshopify.com`. For a public catalog, prefix the tenant key:
  `EVIDENCE_SHOP=playground:<slug> npx tsx scripts/evidence.mts counts`.
- Every playground search returns a `searchId`; the engine-details panel
  (step 15) shows route, routeReason, latency, degraded, and limited without
  a database round-trip. Use the panel for the fast read and the script for
  the durable evidence.

## Part 1 — Human prerequisites

These are one-time setup steps a human performs outside the repo. Do them
before the run; each has an expected outcome you can check.

1. **Partner + Neon + Gemini accounts.** The Shopify Partner org holds the
   `unfiltered-dev` dev store and the app record; Neon holds the Postgres
   database with the `vector` extension enabled; Google AI Studio holds the
   Gemini key (Tier 1 billing).

   **Expected outcome:** you can open all three dashboards, and the Neon
   database shows the `vector` extension installed.

2. **Fashion catalog imported into `unfiltered-dev`.** Import
   `fashion-seed-400.csv` (provenance above) via the dev-store admin →
   **Products → Import**. Some ~2015-era image URLs may 404 at import; Shopify
   skips those with a warning.

   **Expected outcome:** the dev store holds **≥200 products with images**
   (the recorded import: 465). If the import report shows heavy image
   failures, record it here — it changes how step 14's image check reads.

3. **Storefront password.** Either disable the dev store's storefront password
   (admin → **Online Store → Preferences**) or accept the password-page
   caveat: with the password on, product links opened from playground cards
   (step 18) land on the password page rather than the product page.

   **Expected outcome:** record which of the two applies. Both are valid runs;
   only the interpretation of step 18 changes.

4. **Render service created from the blueprint.** Render dashboard →
   **Blueprints → New Blueprint Instance** → this repository. Render reads
   `render.yaml` and proposes one web service, health check `/healthz`,
   auto-deploy from `main`. Fill every `sync: false` variable from the header
   block; values come from Neon and, for the Shopify pair,
   `npm run env -- pull --workspace app` or the Partner dashboard. Full
   reference: [DEPLOY.md](DEPLOY.md).

   **Expected outcome:** the service builds and reaches **Live**. The logs show
   `prisma migrate deploy` output followed by
   `[react-router-serve] http://localhost:3000`. A service that exits at
   startup with a stated `DATABASE_URL` reason is the deliberate refusal, not
   a bug.

   > Env-var edits trigger a redeploy. A **502 window during redeploy churn**
   > is expected and was observed on 2026-08-20; wait for the new deploy to go
   > Live before judging any failure.

5. **Keep-awake monitor.** The free plan spins down after ~15 minutes idle.
   Point a free uptime monitor (UptimeRobot and friends) at
   **`SERVICE/healthz`** on a ~5-minute interval, or run the local loop from
   [DEPLOY.md](DEPLOY.md). Do **not** enable it before step 27 — that step
   measures the cold start deliberately.

   **Expected outcome:** the monitor is configured against `/healthz` (the
   only path that never touches the database) and is currently **paused**.

## Part 2 — Index and deployment health

6. **Ingest the seed catalog.** With the dev store's offline session present
   (open the embedded app once if it has been days — the access token goes
   stale and only an embedded load refreshes it):

   ```bash
   npm run ingest
   ```

   **Expected outcome:** three result lines —
   `ingest: { created: N, ... }`, `enrich: { enriched: N, ..., failed: 0 }`
   (`failed` must be 0), `embed: { embedded: N, ... }` — where N is the
   dev-catalog product count (≥200). Re-running is idempotent: a second pass
   reports `unchanged`/`cached` with no AI spend.

7. **Confirm the index counts.**

   ```bash
   npx tsx scripts/evidence.mts counts
   ```

   **Expected outcome:** `products`, `enriched`, and `embedded` are equal and
   match N from step 6.

8. **One-time indexing cost.** Open
   `SERVICE/internal/costs?token=ADMIN_TOKEN`.

   **Expected outcome:** the `AiCall` ledger renders with `enrichment` and
   `embedding` rows for this run; record the one-time total. (M3 reference:
   $0.0044 for 18 products; M2: $0.0126 for 60.) Without the exact token the
   route is a 404 — that is the gate working.

9. **Health check.**

   ```bash
   curl -s SERVICE/healthz
   ```

   **Expected outcome:** `200` with
   `{"status":"ok","engine":{"version":"0.4.0",...}}`. This is the same path
   the Render health check and the keep-awake monitor use.

10. **Search API reachable.**

    ```bash
    curl -s "SERVICE/api/playground/search?query=dress&sessionId=m4-curl"
    ```

    **Expected outcome:** `200` with the playground contract — `searchId`,
    `route`, `degraded`, `results`, `chips`, `details`. A `503` here means
    `PLAYGROUND_SEED_STORE_KEY` is unset or names no tenant.

## Part 3 — Root playground (`/`), the proof surface

Do Part 3 in **one browser session** — the session id is shared per tab and
refinement depends on continuity. After each search, read the `searchId` from
the engine-details panel (step 15) or from:

```bash
npx tsx scripts/evidence.mts searches 5
```

11. **First load.** Open `SERVICE/` in a fresh tab.

    **Expected outcome:** the playground shell renders — product name in body
    type (no logo), the search bar, the curated example queries, the muted
    footer/demo disclaimer, and the language toggle. `<html lang>` matches the
    chrome language (`en` by default, or your `Accept-Language`).

12. **EN simple query — the parity floor.** Type an exact product-title word
    from the seed catalog (e.g. `dress`) and submit.

    **Expected outcome:** classic result cards, **no chip row**.
    `SearchEvent`: `route=classic`, `degraded=f`, `resultCount>0`; zero
    `AiCall` rows for that searchId (a lone `classification` row is also
    acceptable when the heuristics deferred to the model).

    **Also record perceived speed against the dev store's own stock search**
    for the same word (open the dev storefront's search in another tab). This
    is the *parity floor*: classic must not feel slower than what the merchant
    already has. Record both timings, not just an impression.

13. **EN natural-language query with chips.** Type a constraint-rich sentence,
    e.g. `summer dress, not black, under 200`.

    **Expected outcome:** a removable chip row above the results — one chip
    per applied constraint (category, excluded colour, price cap) — and ranked
    cards. `SearchEvent`: `route=ai`, `degraded=f`; `AiCall` rows for that
    searchId include `intent` (plus `classification`/`embedding`).

14. **Product-card images render.** On the step-13 results, look at the cards
    for ≥15 seconds.

    **Expected outcome:** every card shows its product image. **Known suspect
    defect (observed 2026-08-20 on the live deployment): card images render as
    blank dark boxes, persisting well past any loading race** — likely image
    URL resolution or a referrer/CORS interaction with Shopify CDN images from
    our origin. PASS/FAIL this explicitly and, on FAIL, capture the image URL,
    the browser console error, and the network-tab status for one image.

15. **Engine-details panel.** Click the engine-details toggle
    (`[data-testid="playground-details-toggle"]`), or load the page with
    `?details=1`.

    **Expected outcome:** the panel shows route, routeReason, latency,
    degraded, limited, and the extracted intent JSON (LTR even in Hebrew
    chrome). The panel's `searchId`/latency is the fast evidence for every
    later step.

16. **Refinement.** With step 13's results held, type a comparative follow-up,
    e.g. `same but cheaper`.

    **Expected outcome:** the request rides the held intent as
    `previousIntent`; the chips show the previous constraints with a tightened
    price bound, not a from-scratch intent. `SearchEvent`: `route=ai`.

17. **Chip removal, then New search.** Click the × on the price chip; then
    click the **New search** control.

    **Expected outcome (removal):** results and chips re-render from the
    response, the price chip is gone and does not return, and the result count
    is ≥ the previous one. A **new** `SearchEvent` is written whose searchId
    has **no** `intent` or `classification` `AiCall` rows — chip removal
    re-enters at retrieval, so only `embedding` is charged.

    **Expected outcome (new search):** chips, input, and results all clear back
    to the pre-search state with the examples visible.

18. **Card click opens the product and logs it.** Click a product card.

    **Expected outcome:** the product page opens in a **new tab**
    (`target="_blank" rel="noopener noreferrer"`); the playground tab keeps its
    results. Then:

    ```bash
    npx tsx scripts/evidence.mts clicks 5
    ```

    shows one `ClickEvent` with the clicked product's id, its list position,
    and a `searchId` matching the `SearchEvent` that rendered it. If the
    storefront password is still on (step 3), the new tab shows the password
    page — the `ClickEvent` must still be written.

19. **Hebrew NL query with RTL chrome.** Switch language with the language
    toggle (or load `SERVICE/?lang=he`), then type a Hebrew constraint-rich
    query, e.g. `שמלה אלגנטית לערב מתחת ל-400`.

    **Expected outcome:** `<html lang="he" dir="rtl">`, all chrome strings
    Hebrew, the layout mirrored (bar, chips, cards, footer), and Hebrew-labeled
    chips with the price formatted in the catalog currency. `SearchEvent`:
    `route=ai`, `degraded=f`.

20. **AI zero-hit with close matches.** Type a query nothing can satisfy, e.g.
    `pink wedding dress under 2`.

    **Expected outcome:** the "nothing matches all of these" message, the chip
    row still rendered and still removable, and a **close matches** section of
    classic keyword results under a distinct heading. `SearchEvent`:
    `route=ai`, `resultCount=0`.

    > Note from the M3 run: Hebrew query text against an English catalog
    > returns no classic backfill, so run this step in **English** to test the
    > close-matches path itself.

21. **Language toggle, dark mode, 360 px.** In order: (a) click the language
    toggle and confirm it round-trips EN↔HE while preserving the path and
    query string; (b) switch the OS/browser to dark mode and reload; (c) resize
    to a **360 px** wide viewport.

    **Expected outcome:** (a) the toggle's target href is the same path with
    the other `lang`; (b) dark tokens apply through
    `prefers-color-scheme: dark` with text contrast holding on cards, chips,
    and the details panel; (c) at 360 px nothing overflows horizontally — the
    bar, chip row, and card grid reflow, and the examples stay tappable.

## Part 4 — Public store catalogs (`/s/<slug>`)

22. **Ingest one real Shopify fashion store.** Pick a public storefront and:

    ```bash
    npm run ingest:public -- --url https://STORE.example --slug STORE-SLUG \
      --name "Store Name" --max 500 --source shopify-public
    ```

    **Expected outcome:** ingest/enrich/embed counts printed with `failed: 0`,
    and a `PlaygroundCatalog` row created with `storeKey =
    playground:STORE-SLUG`. Record the product count and the ingest cost delta
    from `/internal/costs`. Verify the index:

    ```bash
    EVIDENCE_SHOP=playground:STORE-SLUG npx tsx scripts/evidence.mts counts
    ```

23. **Ingest one non-Shopify fashion store.** Same command with
    `--source jsonld-crawl` (add `--pages N` to bound the crawl):

    ```bash
    npm run ingest:public -- --url https://OTHER.example --slug OTHER-SLUG \
      --name "Other Store" --max 500 --source jsonld-crawl --pages 3000
    ```

    **Expected outcome:** as step 22, over the JSON-LD crawl path. Record the
    crawl duration as well as the cost — the polite fetcher spaces requests
    deliberately (≤4 in flight per host, ≥250 ms apart), so a large store takes
    real wall-clock time.

24. **Query each preloaded store.** Open `SERVICE/s/STORE-SLUG` and then
    `SERVICE/s/OTHER-SLUG`; run one NL query on each.

    **Expected outcome:** the store line above the search bar reads
    `"{name}"` with a muted `{productCount} products` suffix
    (`[data-testid="playground-store-line"]`), `<title>` is
    `"{name} — Unfiltered"`, and the page carries
    `<meta name="robots" content="noindex">` (`/` does not). Everything else is
    identical to `/`. In the network tab, the `/api/playground/search` request
    carries `catalog=STORE-SLUG`. Record each query's searchId, latency, and
    per-search cost:

    ```bash
    npx tsx scripts/evidence.mts costs SEARCH_ID
    ```

    **Recall check (YOY-105):** these tenants are much smaller than the seed
    catalog and share one HNSW index. Confirm a query naming an attribute you
    can see in the store's own catalog actually returns those products — the
    iterative-scan fix exists exactly so a small tenant is not truncated by a
    large one.

25. **Unknown slug → designed 404.** Open `SERVICE/s/definitely-not-a-store`.

    **Expected outcome:** HTTP **404** (check the network tab, not just the
    page) with the designed not-found page in the same shell — one catalog
    sentence and a link back to `/`. Never a raw error page or a stack trace.

## Part 5 — Caps and cold start

26. **Per-catalog daily AI cap.** In Render, set
    `PLAYGROUND_CATALOG_DAILY_AI_CAP=2` and wait for the redeploy to go Live
    (a 502 window during churn is expected). Then, on `SERVICE/s/STORE-SLUG`,
    submit **three** distinct AI-shaped queries.

    **Expected outcome:** queries 1–2 route `ai` with chips. Query 3 is served
    **classic** with `degraded=true` and `details.limited = "daily-catalog"`
    (visible in the engine-details panel) — no error UI, no empty state, just
    classic cards. Its `SearchEvent` is written with `route=classic`,
    `degraded=t`, and it has **no** `intent` `AiCall` rows.

    **Restore** `PLAYGROUND_CATALOG_DAILY_AI_CAP` to its previous value (or
    delete the variable for the default 500) and confirm the next AI query on
    that catalog routes `ai` again. Record that the restore happened — a run
    that leaves the cap at 2 has broken the deployment.

27. **Free-tier cold start.** Ensure the keep-awake monitor is **paused**, then
    leave the service idle for **≥20 minutes** (free services spin down after
    roughly 15). Time the first request afterwards:

    ```bash
    time curl -s -o /dev/null -w '%{http_code} %{time_total}\n' SERVICE/healthz
    ```

    **Expected outcome:** the first hit takes tens of seconds (DEPLOY.md
    predicts ~30–60 s) and then returns `200`; the second hit is fast. Record
    both numbers — this is the measurement that decides when the paid tier
    becomes necessary (DEPLOY.md ties that to M8 outreach). Re-enable the
    keep-awake monitor afterwards and confirm it reports the service up
    against `/healthz`.

## Part 6 — Evidence table

Fill one row per step. The issue (YOY-95) closes only when **every** step has
a row. Every FAIL row must name the defect and, where filed, link its Linear
issue (NG-1: file, do not fix).

- **Date:** _fill in_
- **Executed by:** _fill in_
- **Deployment URL / commit:** _fill in_
- **Seed catalog size (products):** _fill in_
- **One-time indexing cost (`/internal/costs`):** _fill in_
- **Public catalogs ingested (slug / products / cost):** _fill in_

| # | Scenario | Expected | Result | Evidence |
|---|---|---|---|---|
| 1 | Partner / Neon / Gemini accounts reachable | all three dashboards open; `vector` installed | | |
| 2 | Fashion CSV imported into `unfiltered-dev` | ≥200 products with images | | |
| 3 | Storefront password disabled / caveat accepted | which one applies is recorded | | |
| 4 | Render blueprint service live | build succeeds, migrations run, server listens | | |
| 5 | Keep-awake monitor configured on `/healthz`, paused | monitor exists and is paused | | |
| 6 | `npm run ingest` | ingest/enrich/embed counts, `failed: 0` | | |
| 7 | Index counts equal | products = enriched = embedded = N | | |
| 8 | One-time cost at `/internal/costs` | AiCall ledger renders; total recorded | | |
| 9 | `/healthz` | `200`, engine `0.4.0` | | |
| 10 | `/api/playground/search` over curl | `200` with the playground contract | | |
| 11 | `/` first load | shell renders; `<html lang>` correct | | |
| 12 | EN simple query + parity floor | `route=classic`, no chips; both timings recorded | | |
| 13 | EN NL query with chips | `route=ai`, chips, `intent` AiCall rows | | |
| 14 | Product-card images render | images visible after 15 s (known suspect defect) | | |
| 15 | Engine-details panel | route/reason/latency/degraded/limited + intent JSON | | |
| 16 | Refinement honors `previousIntent` | prior constraints kept, price tightened | | |
| 17 | Chip removal + New search | embedding-only cost; state clears | | |
| 18 | Card click → new tab + `ClickEvent` | new tab; row with product id and position | | |
| 19 | HE NL query, RTL chrome | `dir="rtl"`, Hebrew chips, `route=ai` | | |
| 20 | AI zero-hit + close matches | message, chips, close-matches section | | |
| 21 | Language toggle / dark mode / 360 px | path preserved; dark contrast; no overflow | | |
| 22 | `ingest:public` real Shopify store | counts, `failed: 0`, catalog row, cost | | |
| 23 | `ingest:public` non-Shopify store | counts, `failed: 0`, catalog row, cost, duration | | |
| 24 | `/s/<slug>` on both, `catalog=` param, recall | store line, title, noindex, `catalog=` sent | | |
| 25 | Unknown `/s/` slug | HTTP 404 with the designed page and `/` link | | |
| 26 | Catalog daily AI cap = 2 | 3rd query classic `degraded` + `limited`; restored | | |
| 27 | Free-tier cold start | first hit tens of seconds, then `200`; both timed | | |

**Findings filed (defects observed during the run, as Linear issues):**

- _one line per filed issue: identifier, one-sentence symptom, status_
