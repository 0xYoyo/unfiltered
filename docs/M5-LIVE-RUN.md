# M5 live-run runbook — every M5 bar measured on the deployment

- **Date:** _fill at run time_
- **Executed by:** founder (Parts 1, 5 and 7) + agents (Parts 2–4, 6)
- **Deployment URL:** `https://unfiltered-eu.onrender.com` (Frankfurt)
- **Engine version:** `0.4.0` (expected at `/healthz`; the value
  `packages/engine/src/index.ts` exports)

M5 makes five claims that no offline test can settle: the latency bars hold
on the real deployment (docs/LATENCY.md), the correctness law holds on the
real catalog (colour exclusion, close matches, negated attributes), colourway
families collapse to one card per family, vision enrichment covers the
catalog without contaminating it, and the shipped design is the approved one.
Every one of those is verified against fixtures and a hermetic database in
CI. None of that proves any of it over the real seed catalog, the real public
stores, real Gemini, both languages, and a real Render instance.

This runbook is M5's evidence run — the M5 counterpart of
[M4-LIVE-RUN.md](M4-LIVE-RUN.md) and [M3-LIVE-RUN.md](M3-LIVE-RUN.md). It is
deliberately manual: follow the numbered steps in order and fill the evidence
table in Part 8. Defects found along the way are **filed as Linear issues and
linked from the table — never fixed in this document's PR** (NG-1).

The acceptance criteria this runbook covers are YOY-124 AC-2 … AC-9. AC-11
(the pooled-connection switch) and AC-12 (the shopper worst-case wait) are
founder-lane steps recorded directly on the issue; Part 7 says where they sit
in the order.

## Header block — fill before starting

Record what the run actually ran against, before running anything. Redact
every secret to its shape (`AIza…`, last four characters at most); never
paste a live key or connection string into this file.

| Field | Value |
| --- | --- |
| Date / time (UTC) | **2026-08-28 18:28–20:49** (Parts 1–7; step 9's playground half only — the rows below say what each one covers). |
| Deployment URL | `https://unfiltered-eu.onrender.com` |
| Render service / region / plan | `unfiltered-eu` (`srv-da6uhoh5efls73cvfis0`) / **Frankfurt** / _fill_ |
| Commit deployed (SHA) | **Per part** — `render.yaml` sets `autoDeploy: true` on `main`, and five docs-only merges landed while the run was in progress, so the live build moved between parts. The engine is byte-identical across all three (every delta is under `docs/`). **`52a638c`** (PR #141, deploy `dep-da8t6h9srm7s73ahjil0`, live 18:29:16–19:29:40 UTC): Parts 1, 3, 5, 7, and Part 2 step 5's recorded search (`02a945db…`, 19:28:47). **`4aa3feb`** (PR #142, deploy `dep-da8u2cgae00c73a7ivh0`, live 19:29:40–19:42:43): Part 2's route-comparison searches (19:29:59–19:30:13) and the first seven searches of Part 4 step 10 (19:41:45–19:42:37). **`611ff72`** (PR #143, deploy `dep-da8u8g0u01pc73ckn58g`, live from 19:42:43): the rest of step 10 and steps 11–14 (19:42:46–19:47). **`8804fe1`** (PR #144, deploy `dep-da8uo9jncjis738sv6d0`, live from 20:16:27): Part 6 step 17's gate check, re-run at 20:32:07 UTC on this build so the row is unambiguous. **`debd56d`** (PR #145, deploy `dep-da8v6seq1p3s7383r6ng`, live from 20:47:39): step 9's three playground loads at 20:48:34–20:48:50, comfortably after the cutover. Part 2 steps 3, 4 and 6 and Part 6 step 16 read the database directly and depend on no deployed build. |
| Engine version at `/healthz` | `0.4.0` ✓ |
| `DATABASE_URL` | Neon, `vector` enabled — **redacted**. Record **pooled or direct**: pooled is `…-pooler.<region>.aws.neon.tech` with `pgbouncer=true` (AC-11). **This run: pooled**, switched 18:28 UTC — AC-11 |
| `DIRECT_DATABASE_URL` | **redacted**; set iff pooled (Prisma `directUrl`, migrations on boot). **This run: set** by the AC-11 switch (= the previous `DATABASE_URL`) |
| `GEMINI_API_KEY` | **redacted** (`AIza…`) — Google AI Studio, Tier 1 billing |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | both **redacted** — the existing app record; **not** re-pointed (NG-2) |
| `SHOPIFY_APP_URL` | `https://unfiltered-eu.onrender.com` |
| `ADMIN_TOKEN` | **redacted** — gate re-verified in step 17 (`/internal/costs` without the exact token is `404`) |
| `PLAYGROUND_SEED_STORE_KEY` / `PLAYGROUND_SEED_NAME` | _fill_ |
| `PLAYGROUND_AI_THROTTLE_PER_MINUTE` | _fill; blank = default 10_ |
| `PLAYGROUND_DAILY_AI_CAP` / `PLAYGROUND_CATALOG_DAILY_AI_CAP` | _fill; blank = defaults 2000 / 500_ |
| **Model pins** — `GEMINI_*_MODEL`, `GEMINI_EMBEDDING_DIMENSION` | _fill each, or "unset = provider default"; the defaults live in `packages/provider-gemini`_ |
| `GEMINI_INTENT_THINKING_LEVEL` / `GEMINI_INTENT_LITE_THINKING_LEVEL` | _fill; blank = `low`_ |
| `GEMINI_INTENT_TIMEOUT_MS` / `GEMINI_INTENT_LITE_TIMEOUT_MS` | _fill; blank = 8000 / 8000. AC-12 may change these — record the values **this run** used_ |
| `INTENT_ESCALATION_THRESHOLD` / `INTENT_HEDGE_AFTER_MS` / `INTENT_REUSE_WINDOW_MINUTES` | _fill; blank = 0.8 / 2500 / 60_ |
| Keep-awake monitor | _name, interval, target — must be on `/healthz` and **running** for this run (unlike M4 step 27, M5 measures no cold start)_ |
| Seed catalog size (products) | **465** — `evidence.mts counts`: products 465 = enriched 465 = embedded 465 (step 3) |

**Seed catalog provenance.** Unchanged from the M4 run unless the catalog was
re-seeded: `shopifypartners/shopify-product-csvs-and-images` →
`csv-files/fashion.csv`, trimmed to `fashion-seed-400.csv` (465 products).
Dev-phase only; the pre-M8 swap to rights-clear data is recorded in
[M4-LIVE-RUN.md](M4-LIVE-RUN.md). If the catalog **was** re-seeded, re-state
the source, the licence position, and the product count here.

## Conventions

- Run every command from **`apps/shopify-app`** with the app's env loaded:

  ```bash
  cd apps/shopify-app && set -a && source .env && set +a
  ```

  The local `.env` needs `DATABASE_URL` pointing at the **same** Neon database
  the deployment uses — the evidence queries read the rows the deployment
  writes. Use the direct (unpooled) host locally even when the deployment is
  pooled; `pgbouncer=true` is for the service, not for a one-shot script.
- `SERVICE` below is `https://unfiltered-eu.onrender.com`.
- Database evidence comes from the committed Prisma script (no `psql`):

  ```bash
  npx tsx scripts/evidence.mts counts               # index size for EVIDENCE_SHOP
  npx tsx scripts/evidence.mts searches 5           # latest SearchEvent rows
  npx tsx scripts/evidence.mts costs SEARCH_ID      # AiCall rows for one search
  npx tsx scripts/evidence.mts clicks 5             # latest ClickEvent rows
  npx tsx scripts/evidence.mts vision               # visionStatus coverage (AC-7)
  npx tsx scripts/evidence.mts attributes ID [ID…]  # enrichment per product (AC-7)
  ```

  `counts`, `searches`, `vision` and `attributes` are scoped by
  `EVIDENCE_SHOP`, which defaults to `unfiltered-dev.myshopify.com`. For a
  public catalog, prefix the tenant key:
  `EVIDENCE_SHOP=playground:<slug> npx tsx scripts/evidence.mts counts`.
- Every playground search returns a `searchId`. The engine-details panel
  (`?details=1`, or the `[data-testid="playground-details-toggle"]` control)
  shows route, routeReason, latency, degraded and limited without a database
  round-trip. Use the panel for the fast read and the script for the durable
  evidence.
- Reading `productId`s off a result set, for the steps that need them:

  ```bash
  curl -s "SERVICE/api/playground/search?query=QUERY&sessionId=m5-$RANDOM" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["searchId"]); [print(r["productId"], r["title"]) for r in d["results"][:5]]'
  ```

- **Every step is PASS/FAIL, and a FAIL is recorded, not fixed** (NG-1). Part 8
  is the only place a result belongs.

## Part 1 — Preconditions (founder)

1. **The deployment is live, current, and awake.**

   ```bash
   curl -s SERVICE/healthz
   ```

   **Expected outcome:** `200` with
   `{"status":"ok","engine":{"version":"0.4.0",…}}`, and the Render dashboard
   shows the live deploy's commit matching the SHA in the header block. A
   version mismatch is the YOY-104 stale-build class — stop and redeploy
   before measuring anything.

2. **The keep-awake monitor is running** against `SERVICE/healthz`.

   **Expected outcome:** the monitor reports the service up. M5 measures a
   *warm* instance in every step; a spun-down instance would put a cold start
   into the first sample of every set. (M4 step 27 measured the cold start
   deliberately; M5 does not re-measure it.)

## Part 2 — Index health and vision coverage (agent) — AC-7

3. **Index counts.**

   ```bash
   npx tsx scripts/evidence.mts counts
   ```

   **Expected outcome:** `products`, `enriched` and `embedded` are **equal**;
   record the number as the seed catalog size in the header block. Unequal
   counts mean an interrupted ingest — re-run `npm run ingest` and record that
   it was needed.

4. **Vision coverage ≥ 90 %.**

   ```bash
   npx tsx scripts/evidence.mts vision
   ```

   **Expected outcome:** the final line reads
   `vision coverage: N/M products enriched (≥ 90.0%)`. Record the exact
   percentage and the `none` / `failed` counts. `none` is "no images or never
   run"; `failed` is "two attempts failed" — a large `failed` count is a
   defect to file, a large `none` count on a catalog with images means the
   vision pass never ran.

5. **Vision attributes reach retrieval.** Submit `long sleeve midi dress` on
   `SERVICE/` (English chrome) and read the top five `productId`s with the
   snippet in Conventions, then:

   ```bash
   npx tsx scripts/evidence.mts attributes ID1 ID2 ID3 ID4 ID5
   ```

   **Expected outcome:** **≥ 4 of the 5** rows show `sleeveLength=long`. This
   is the whole point of the vision pass: `sleeveLength` exists on no product
   feed, so a hit here can only have come from the images. Record the table
   and the searchId.

6. **Anti-contamination spot check.** Pick one contamination-prone seed
   product — a dress or top photographed on a model wearing shoes and
   jewelry — and read its enrichment:

   ```bash
   npx tsx scripts/evidence.mts attributes PRODUCT_ID
   ```

   **Expected outcome:** neither the merged columns nor the printed
   `visionAttributes` JSON carries a footwear or jewelry attribute. The
   anchored prompt describes the *garment being sold*, not everything in the
   frame (YOY-121). Record the product, its title, and the JSON verbatim. A
   leak here is a defect to file.

## Part 3 — Latency (agent) — AC-2 and AC-3

7. **The full probe with the bars asserted.**

   ```bash
   npx tsx scripts/latency-probe.mts --url SERVICE --runs 20 --set all \
     --assert-classic-p95 500 --assert-ai-p50 2000 --assert-ai-p95 3500
   ```

   **Expected outcome:** **exit 0** with `assertions: all bars met`, and four
   summary rows (`classic`, `ai-en`, `ai-he`, `ai-combined`) each showing n,
   p50, p95 and the per-stage means. The bars: classic p95 **≤ 500 ms**, AI
   p50 **< 2000 ms** and p95 **< 3500 ms**, **in each language and combined**
   — a bar met combined but missed in one language is missed
   (docs/LATENCY.md). Paste the full output on YOY-124 and add the four rows
   to docs/LATENCY.md's "Recorded measurements" table, naming the region and
   the deployed commit.

8. **Zero degraded responses in the run.**

   **Expected outcome:** every summary row shows `degraded=0`. `reused=0` is
   also required for the row to count (the per-run invisible marker exists to
   keep exact-query intent reuse out of the sample). A `limited>0` count means
   the probe outran the per-IP AI throttle — re-run with a lower
   `--ai-per-minute` rather than recording it as a latency fact.

   > The one thing this step must not do is average a degrade away. A
   > `degraded` response is a classic answer wearing an AI request; it is
   > counted and shown, never folded into an AI percentile's story.

9. **Parity floor: classic `dress`, three warm loads, both surfaces.** Load
   `SERVICE/?query=dress` three times (warm, after one discarded load), and
   the dev storefront's own stock search for `dress` three times in another
   tab.

   **Expected outcome:** the playground's **server** `latencyMs` (the
   engine-details panel, or `details.latencyMs` from the API) is **≤ 500 ms**
   on all three loads. Record all six numbers — the three server latencies and
   the three storefront timings. This is the M4 F-3 finding's re-test: classic
   must not feel slower than the search the merchant already has.

## Part 4 — The correctness law (agent) — AC-4, AC-5, AC-6

Do Part 4 in **one browser session** per language — the session id is shared
per tab and refinement depends on continuity.

10. **The twelve curated examples.** The page shows six
    (`EXAMPLES_SHOWN`: four in the chrome language, two in the other); the
    committed set is six per language in
    `apps/shopify-app/app/playground/strings.ts`. Submit **all twelve** —
    the six EN on `SERVICE/?lang=en` and the six HE on `SERVICE/?lang=he`:

    | # | EN | HE | kind |
    | --- | --- | --- | --- |
    | 1 | `summer dress, not black` | `שמלת קיץ, לא שחורה` | negation |
    | 2 | `linen shirt under 300` | `חולצת פשתן עד 300` | priceCap |
    | 3 | `something to wear to a wedding` | `משהו ללבוש לחתונה` | occasion |
    | 4 | `an oversized coat that drapes well` | `מעיל אוברסייז שנופל יפה` | softAttribute |
    | 5 | `beige boots in stock` | `מגפיים בז' במלאי` | colorAvailability |
    | 6 | `same but cheaper` | `אותו דבר אבל זול יותר` | refinement |

    Run the refinement example **immediately after** its language's example 1,
    so it has a held intent to refine.

    **Expected outcome:** every one of the twelve returns **≥ 1 primary
    result**. The negation, priceCap, occasion and colorAvailability examples
    (rows 1, 2, 3, 5 — eight searches) additionally route **`ai`** with **≥ 1
    chip**. Record a table of all twelve: query, searchId, route, chip count,
    result count, latency. An example query that returns nothing is worse than
    a bad answer — it is the page's own suggestion failing in public.

11. **Colour law, under 200.** Submit `summer dress, not black, under 200`
    (EN chrome).

    **Expected outcome:** the results are **both 128-unit Mesh Over Dresses**
    — the two products whose *primary* colour is not black. Colour exclusion
    applies to the product's primary colour, not to any colourway it has ever
    been offered in (YOY-110), and the colourway family collapses to one card
    per family (YOY-117). Record the searchId, the chips, and both titles.

12. **Colour law, under 100 — the honest zero.** Submit
    `summer dress, not black, under 100`.

    **Expected outcome:** **zero primary hits**, the "nothing matches all of
    these" status, and a close-matches section headed **"Close matches — over
    your budget"** — the caption naming the *one* constraint that was relaxed,
    price first (YOY-111). **Zero of the close-match cards may be
    black-primary**: an explicit exclusion is never relaxed. Count the cards
    and check each one's primary colour with
    `npx tsx scripts/evidence.mts attributes ID…`. Record the searchId, the
    exact caption text, the card count and the colour readback.

13. **Both laws in Hebrew.** Repeat steps 11 and 12 on `SERVICE/?lang=he`
    with `שמלת קיץ, לא שחורה, עד 200` and `שמלת קיץ, לא שחורה, עד 100`.

    **Expected outcome:** identical behaviour to steps 11 and 12 — same
    products, same zero, same relaxed-price caption in Hebrew — with
    `<html lang="he" dir="rtl">` and the chips Hebrew-labelled. A law that
    holds in one language only is not a law. Record both searchIds.

14. **Families and currency on the public catalogs.** Open
    `SERVICE/s/tentree` and submit `t-shirt`; then open
    `SERVICE/s/whitestuff` and read the prices on any result set.

    **Expected outcome:** tentree returns **24 distinct titles** — one card
    per product family, not one per colourway (YOY-117). Count them; a count
    above 24 with repeated titles is the family key failing. White Stuff's
    prices render in **GBP** (`£`), the catalog's own currency, not converted
    and not the seed catalog's. Record both searchIds and the tentree title
    list.

## Part 5 — Design (founder) — AC-4's visual half

15. **Eyes on the shipped design, both languages.** Open `SERVICE/` on a
    phone and on a laptop, in EN and HE, and run: `summer dress, not black` ·
    `winter coat, not wool` · `dress for a wedding` ·
    `שמלה לחתונה, לא שחורה, עד 400` · one nonsense query.

    **Expected outcome:** the chips are **truthful** (every chip is a
    constraint the engine actually applied, and every applied constraint has a
    chip); the negation chip is **tinted** as an exclusion rather than reading
    like an inclusion; the wedding-guest query returns **no bridal gown**; the
    close-match caption is honest about what it relaxed; and the page matches
    the approved design spec (the binding YOY-123 comment and
    [DESIGN.md](DESIGN.md)) in both directions, including RTL mirroring. Say
    "looks right" on YOY-124 or list precisely what does not.

## Part 6 — Cost (agent) — AC-8

16. **Mean per-search cost.** Open
    `SERVICE/internal/costs?token=ADMIN_TOKEN` after Parts 3–5 have run, so
    the ledger covers this run's AI searches.

    **Expected outcome:** "Cost per search (mean)" is **≤ $0.0006**
    (**$0.60 per 1,000 searches**). Record the mean, the total, and the call
    count. If the mean is dominated by a handful of refinement searches,
    record that — the bar is per search, and a refinement is a search.

17. **The gate still holds.** Load `SERVICE/internal/costs` with **no** token
    and with a **wrong** token.

    **Expected outcome:** **404** both times — not 401, not 403, not a login
    page. A cost ledger that answers a stranger is the defect, not the gate.

18. **Vision's one-time cost per 1,000 products.** From the ledger's
    operation rows, take the `vision` (image-enrichment) total and the number
    of products it covered.

    **Expected outcome:** a recorded figure, normalised to **cost per 1,000
    products**, with the product count it was computed from. This is a
    one-time indexing cost, not a per-search cost, and it is the number that
    decides whether vision enrichment scales to a real merchant catalog.

## Part 7 — Smoke, and the two founder-lane ACs

19. **Smoke thresholds are tightened (AC-9b).** Already shipped in this
    document's PR: `apps/shopify-app/scripts/live-smoke.config.json` now reads
    `classicMaxMs: 800`, `aiMaxMs: 3500` (was `1500` / `6000`), and
    [SMOKE.md](SMOKE.md) records why. Confirm the deployed branch carries it:

    ```bash
    npx tsx scripts/live-smoke.mts --url SERVICE
    ```

    **Expected outcome:** `4/4 passed → exit 0` against the tightened
    ceilings. A failure here at the new ceilings, with Part 3's bars met, means
    the single-sample canary is catching a tail the percentiles smooth over —
    record it, do not loosen the ceiling back.

20. **The daily routine (AC-9a, AC-9c) — NOT in this run.** Founder decision
    2026-08-26, restated on YOY-124 on 2026-08-28: the routine is created on
    **submission day**, so the schedule starts when the site must stay up
    unattended, not weeks earlier. The phone checklist is
    [SMOKE.md](SMOKE.md); the first green run and the induced failure
    (`https://definitely-not-a-host.invalid`) are recorded there and then.

    **Expected outcome for this run:** AC-9a and AC-9c are marked **DEFERRED**
    in Part 8 with a link to the submission-day checklist — not PASS, and not
    FAIL.

21. **AC-11 (pooled connection) and AC-12 (shopper worst-case wait) are
    founder-lane and are recorded on the issue, not here.** Order matters:
    AC-11's pooled switch happens **before** step 7, because AC-2's run may
    then be performed pooled and the header block must say which it was. AC-12
    is measured **after** step 7, because it reads the same AI sets' degraded
    count and max latency. Both post their probe output as YOY-124 comments;
    AC-11 additionally replaces docs/LATENCY.md's row 3 placeholder.

## Part 8 — Evidence table

Fill one row per step. **YOY-124 closes only when every step has a row.**
Every FAIL row must name the defect and link the Linear issue filed for it,
or the hardening-tail AC it was appended to (AC-10; NG-1: file, do not fix).

- **Date:** 2026-08-28 (partial — Parts 1–7 executed; step 9's storefront half and step 18 wait on the founder, and row 2 is unfilled)
- **Executed by:** founder (steps 1, 7–8, 15, 19, 21) + builder (steps 3–6, 9 playground half, 10–14 and 16–17 executed; the rest of this table from the founder's pasted output on YOY-124)
- **Deployment URL / commit:** `https://unfiltered-eu.onrender.com` @ `52a638c` → `4aa3feb` → `611ff72` — the build moved twice mid-run under `autoDeploy`; the header block above says which part each one served, and all three deltas are docs-only
- **Connection at run time:** **pooled** (switched 18:28 UTC, AC-11)
- **Seed catalog size (products):** 465
- **Vision coverage:** 100.0 % (465/465 enriched, 0 none, 0 failed)
- **Mean cost per search:** **$0.000373** ($0.37 / 1,000) over this run's 16 AI searches — see row 16 for the method and its caveat
- **Vision one-time cost per 1,000 products:** _fill_

| # | AC | Scenario | Expected | Result | Evidence |
|---|---|---|---|---|---|
| 1 | — | `/healthz` and deployed commit | `200`, engine `0.4.0`, commit matches header | **PASS** | `/healthz` `200`, engine `0.4.0`; Render deploy `dep-da8t6h9srm7s73ahjil0` live 18:29:16 UTC at `52a638c`. YOY-124 comment 2026-08-28. |
| 2 | — | Keep-awake monitor running | monitor reports the service up | | |
| 3 | AC-7 | Index counts | products = enriched = embedded | **PASS** | `evidence.mts counts` on `unfiltered-dev.myshopify.com`: products 465, enriched 465, embedded 465 — equal, and 465 is the documented seed size. No re-ingest needed. |
| 4 | AC-7 | Vision coverage | ≥ 90 % `visionStatus=enriched` | **PASS** | `evidence.mts vision`: `vision coverage: 465/465 products enriched (100.0%)`, `none: 0`, `failed: 0`. |
| 5 | AC-7 | `long sleeve midi dress` top 5 | ≥ 4 of 5 have `sleeveLength=long` | **FAIL — YOY-134** | `long sleeve midi dress` routes **classic** (`routeReason: model`, searchId `02a945db-0d67-48d7-b631-0fc8fa9b31b4`); its top five is `long, three-quarter, three-quarter, long, long` = **3 of 5**, and includes a sweater and a tee. Forcing the AI route (`midi dress with long sleeves under 300`, searchId `de21039f-e079-424c-aefc-8f1fca713f19`) is worse: `three-quarter, sleeveless, long, long, short` = **2 of 5**. Cause and both `evidence.mts attributes` tables are on YOY-134. |
| 6 | AC-7 | Anti-contamination spot check | no footwear/jewelry attribute | **PASS** | `Lark Dress` `gid://shopify/Product/8057389875275` — model photographed in black fringed ankle boots and a silver ring. Enrichment: `{"fit":"regular","colors":["grey","brown","black"],"pattern":"check","category":"dress","neckline":"boat","occasions":["casual","work","evening"],"styleTags":["avant-garde","minimal","chic"],"primaryColor":"grey","sleeveLength":"short","garmentLength":"midi","materialAppearance":"linen"}` — no footwear or jewelry attribute in the columns or the raw JSON. |
| 7 | AC-2 | Full probe, bars asserted | exit 0, `assertions: all bars met`, four rows | **PASS** | `--runs 20 --set all` with all three `--assert-*` flags: exit 0, `assertions: all bars met`. classic p50 37 / p95 50; ai-en 1008 / 2228; ai-he 1060 / 3421; ai-combined 1017 / 3275. Four rows added to docs/LATENCY.md (2026-08-28, pooled). |
| 8 | AC-2 | Degraded count | `degraded=0` (and `reused=0`) on every set | **FLAG — founder decision open** | `reused=0` and `limited=0` on every set ✓, but ai-he shows **`degraded=1`** (routes ai=99, classic=1) → 1 of 200 AI samples. That is inside the binding docs/LATENCY.md bar for the AI run (YOY-64 AC-6, amended 2026-08-26: degraded ≤ 1 %, ≤ 2 of 200) and outside AC-2's literal `degraded=0`. Not recorded as PASS or FAIL until the founder says which governs; AC-2 stays unticked meanwhile. |
| 9 | AC-3 | Parity floor, 3 warm loads each | server `latencyMs` ≤ 500 ms on all three | **PARTIAL — playground half PASS, storefront half founder-lane** | Playground, 2026-08-28 20:48 UTC on `debd56d`, one discarded warm-up then three measured loads of `?query=dress` (all `route: classic`, `short-query`, 24 results): server `latencyMs` **49 / 43 / 43 ms** — the bar is 500, so it clears by 10× on all three. searchIds `8e67428e…`, `733cc2c3…`, `29152c34…`. Storefront half **not obtainable by an agent**: `https://unfiltered-dev.myshopify.com/search?q=dress` answers `302 → /password`, so the dev store's stock search cannot be timed without the storefront password. The founder running those three loads and pasting the timings completes AC-3. |
| 10 | AC-4 | Twelve curated examples (EN + HE) | all 12 ≥ 1 result; the 8 named route `ai` with ≥ 1 chip | **FAIL — YOY-136** | Route half **passes**: all twelve route `ai`, and negation / priceCap / occasion / colorAvailability carry 2–3 truthful chips in both languages. Result half **fails on 4 of 12**: `beige boots in stock` (`249436cc…`) and `מגפיים בז' במלאי` (`a3937bcb…`) return 0 primary + 8 close matches (the catalog has no beige boot in stock); `same but cheaper` (`6fba5e68…`) and `אותו דבר אבל זול יותר` (`2b3c9113…`) return 0 primary + 10 close matches (the refinement over-narrows the cap). The other eight return 9–24 results at 69–2351 ms, 0 degraded. Full table on YOY-136. |
| 11 | AC-5 | `…not black, under 200` | both 128-unit Mesh Over Dresses | **FLAG — spec conflict, founder call** | searchId `3b7a3ca6…`, `route: ai`, chips `dress` / `priceMax 200` / `colorsExclude black` (+ `occasion casual`). **One** result: `Mesh Over Dress in Navy` ($128). Its sibling `Mesh Over Dress in Pink` ($128, non-black, in stock) is a member of the same product family, and YOY-117 collapses a family to one card — which this very step also cites. The colour law itself holds (no black-primary product is served); the "both" expectation predates the family collapse. Not scored until the founder says which clause wins. |
| 12 | AC-5 | `…not black, under 100` | zero hits, "Close matches — over your budget", 0 black-primary | **PASS** | searchId `50e51d1f…`: **0** primary results, `closeMatchesRelaxed: ["priceMax"]` (price relaxed first, and only price), 10 close-match cards. `evidence.mts attributes` on all ten: silver, navy, royal blue, blue, grey, navy, grey, mist, multi, navy — **0 black-primary**. The explicit exclusion survived the relaxation. |
| 13 | AC-5 | Both laws in Hebrew | same behaviour, RTL chrome, Hebrew chips | **PASS (engine half)** | `שמלת קיץ, לא שחורה, עד 200` (`fbe2f990…`) returns the same single `Mesh Over Dress in Navy` with the same three chips; `שמלת קיץ, לא שחורה, עד 100` (`58ea6434…`) returns 0 primary with `closeMatchesRelaxed: ["priceMax"]` and 10 close matches. Identical behaviour to steps 11–12, so the law is not language-specific. Two notes: the HE intents carry `currency: "ILS"` against a USD catalog (the cap is applied as a bare number), and the RTL chrome half was covered by the founder's step-15 pass, not re-checked here. |
| 14 | AC-6 | `/s/tentree` `t-shirt`; `/s/whitestuff` prices | 24 distinct titles; GBP | **FAIL — YOY-135, YOY-137** | tentree `t-shirt` (`340911ce…`) returns 24 results but **22 distinct titles**: `Wildfire Retro Treeline T-Shirt` and `Juniper T-Shirt` each render twice (different colourway handles). It routes **classic**, and the family collapse is AI-only — the same catalog on an AI-routed query (`e7b7ade2…`) returns 24 results / **24 distinct** titles. Filed as YOY-135. whitestuff (`f3003d30…`) prices render **EUR**, not GBP: the catalog was crawled from the `/eu/` storefront, so EUR is its own currency — the law holds, the AC's expectation of GBP does not. Filed as YOY-137. |
| 15 | AC-4 | Design eyes, EN + HE, phone + laptop | chips truthful, negation tinted, no bridal gown, spec matched | **PASS (founder)** | Founder ran the five named queries in EN and HE (go-signal step 3) and reported "Eye test looks about right" — YOY-124 comment 2026-08-28 19:08 UTC. No searchIds were captured, so AC-4's twelve-example table (step 10) is still open. |
| 16 | AC-8 | Mean cost per search | ≤ $0.60 / 1,000 searches | **PASS (computed from the ledger, not read off `/internal/costs`)** | `evidence.mts costs SEARCH_ID` over all 16 AI searches of Part 4 (the twelve curated examples plus the four colour-law queries): total **$0.005967**, mean **$0.000373** = **$0.37 per 1,000**, against a $0.60 bar. Spread $0.000000–$0.000655; the four ~$0 searches are `intent-reuse` (no model call) and the dearest is a refinement (`6fba5e68…`, $0.000655 — classification $0.000080 + intent $0.000574), the shape the step says to call out. Excluding the reuses, the mean is $0.000497 ($0.50 / 1,000), still under. **Caveat:** the ledger page's own aggregate was not opened — see row 17's note — so this is a per-search readback over an enumerated set, not `/internal/costs`'s run-wide mean. |
| 17 | AC-8 | `/internal/costs` gate | `404` with no token and with a wrong token | **PASS** | `GET /internal/costs` → **404**; `?token=definitely-not-the-token` → **404**; `?token=` (empty) → **404**. No 401, no 403, no login page — the route does not admit that it exists. Run at **20:32:07 UTC** on `8804fe1` (the first attempt straddled the `611ff72` → `8804fe1` cutover, so it was repeated on one known build). |
| 18 | AC-8 | Vision one-time cost | recorded per 1,000 products | **OPEN — founder** | Vision `AiCall` rows carry no `searchId`, so `evidence.mts costs` (which is keyed by search) cannot reach them; the figure lives only in `/internal/costs`'s operation rows, which needs `ADMIN_TOKEN`. Reading that secret from `.env` was denied to the agent by the permission guard, and the denial was not worked around. The founder opening `SERVICE/internal/costs?token=…` once and pasting the `vision` operation total plus its product count closes this row and completes AC-8. |
| 19 | AC-9b | Smoke at the tightened ceilings | `4/4 passed → exit 0` | **PASS** | `live-smoke.mts` at 18:59:43 UTC: `4/4 passed → exit 0` against `classicMaxMs: 800` / `aiMaxMs: 3500` — healthz ✓, classic 126 ms (`short-query`), ai-en 1517 ms (3 chips), ai-he 3418 ms (3 chips, `purpose-phrase`). YOY-124 comment. |
| 20 | AC-9a/c | Daily routine | **DEFERRED** to submission day (SMOKE.md) | | |
| 21 | AC-11/12 | Founder-lane ACs | recorded on YOY-124, not here | **AC-11 PASS / AC-12 open** | AC-11: pooled switch + redeploy + `/healthz` + smoke + `--assert-classic-p95 500` exit 0 at p95 50 ms; docs/LATENCY.md row 3 replaced by the measured 2026-08-28 pooled row. AC-12: the `--set all` summary reports p50/p95, not the **max** latency AC-12 asks for, so the 4500 ms decision has no evidence yet. |

**Findings filed (defects observed during the run, as Linear issues):**

- **Step 5 (AC-7) — YOY-134, priority High.** "Positive vision attributes
  never constrain retrieval": the vision pass covers 465/465 products, but
  `long sleeve midi dress` routes classic (keyword ranking, where the vision
  columns do not rank), and on the AI route every non-bridal positive
  attribute becomes a `softAttribute` — embedding text with no predicate — so
  a `sleeveless` dress outranks a `long` one. The negative side is hard
  (YOY-133 `attributesExclude`); the positive side never was.
- **Step 10 (AC-4) — YOY-136, priority Medium.** Two of the six curated
  example kinds return zero primary results on the seed catalog, in both
  languages: `colorAvailability` (no beige boot is in stock) and `refinement`
  (the cheaper cap empties the set). The engine answers honestly in all four
  cases; the curated set is what needs changing, or AC-4 does.
- **Step 14 (AC-6) — YOY-135, priority High.** One card per product family is
  implemented only in the pgvector candidate query, so the classic route —
  every keystroke and every short query — still returns colourway duplicates.
- **Step 14 (AC-6) — YOY-137, priority Low.** The White Stuff catalog was
  crawled from the EU storefront, so its prices are EUR. Either re-ingest from
  the UK path or amend the AC to name the catalog's own currency.
- _one bullet per FAIL: the finding, the issue filed or the hardening-tail AC
  it was appended to, and the priority. AC-10 is not met until every FAIL row
  above has one._
