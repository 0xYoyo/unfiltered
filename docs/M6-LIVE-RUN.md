# M6 live-run runbook — Engine v2 measured on the deployment

- **Date:** 2026-10-05 (Part 3's probe, agent) — the founder-lane parts not yet run
- **Executed by:** founder (Parts 1, 2, 4's store half, 5's store half, 6) + agents (Parts 3, 4's playground half, 5's playground half, 7)
- **Deployment URL:** `https://unfiltered-eu.onrender.com` (Frankfurt)
- **Engine version:** `0.4.0` (expected at `/healthz`; the value
  `packages/engine/src/index.ts` exports)

M6 replaced the engine behind every submitted search: Engine v2 finds over the
card index, composes the stated wishes, and judges each page with Jev
(YOY-152), on by default since YOY-153. The next step, YOY-155, deletes the
old engine — the one M6 step that cannot be undone cheaply. Before it, PRD §3
requires the parity floor verified live, and the judge's local numbers (the
469 ms median of YOY-152 was measured from a laptop) need their Frankfurt
counterpart. No offline test settles either: they need the real seed catalog,
the real dev store and its theme, real Jev through OpenRouter, both languages,
and a real Render instance.

This runbook is M6's evidence run — the counterpart of
[M5-LIVE-RUN.md](M5-LIVE-RUN.md). Follow the numbered steps in order and fill
the evidence table in Part 8. Defects found along the way are **filed as
Linear issues and linked from the table — never fixed in this document's PR**
(YOY-154 NG-1). No hidden-score run happens here (NG-2), and no old-engine code
is touched (NG-3).

The acceptance criteria this runbook covers are YOY-154 AC-1 … AC-9. Spend
(estimate): a few dozen live searches, ≈ $0.10.

## Header block — fill before starting

Record what the run actually ran against, before running anything. Redact
every secret to its shape (`sk-or-…`, `AIza…`, last four characters at most);
never paste a live key or connection string into this file.

| Field | Value |
| --- | --- |
| Date / time (UTC) | |
| Deployment URL | `https://unfiltered-eu.onrender.com` |
| Render service / region / plan | `unfiltered-eu` / Frankfurt / |
| Commit deployed (SHA) | `autoDeploy: true` on `main` — if a merge lands mid-run, name the build that served each part, as the M5 header did |
| Engine version at `/healthz` | |
| `ENGINE_V2` | expected **unset** (= Engine v2, YOY-153); `0` here voids the run |
| `JUDGE_PROVIDER` / `OPENROUTER_JUDGE_MODEL` | expected **unset** = `jev` / `typesafe/jev-1.13` (docs/DEPLOY.md) |
| `OPENROUTER_API_KEY` | **redacted** (`sk-or-…`) — set in `unfiltered-prod` |
| `JUDGE_DEADLINE_MS` / `JUDGE_GIVE_UP_MS` / `JUDGE_ROW_CHARS` | expected **unset** = 1500 / 6000 / 480 outside Part 6; Part 6 changes the deadline and restores it |
| `DATABASE_URL` | Neon — **redacted**; pooled or direct |
| `GEMINI_API_KEY` | **redacted** (`AIza…`) |
| `PLAYGROUND_AI_THROTTLE_PER_MINUTE` | expected default 10 — the probe paces under it |
| Keep-awake monitor | UptimeRobot on `/healthz`, 5-minute interval |
| Seed catalog size (products) | from step 3 |
| Dev store / theme | `unfiltered-dev.myshopify.com` / the live theme's name and version; Unfiltered app embed **on** |

## Conventions

- Run every command from **`apps/shopify-app`**. The scripts load
  `apps/shopify-app/.env` themselves; its `DATABASE_URL` must point at the
  **same** Neon database the deployment uses (direct host locally).
- `SERVICE` below is `https://unfiltered-eu.onrender.com`.
- Database evidence comes from the committed Prisma script (no `psql`):

  ```bash
  npx tsx scripts/evidence.mts counts               # index size for EVIDENCE_SHOP
  npx tsx scripts/evidence.mts searches 5           # latest SearchEvent rows
  npx tsx scripts/evidence.mts costs SEARCH_ID      # AiCall rows for one search
  npx tsx scripts/evidence.mts judge SINCE_ISO      # judge log since a time (AC-8, AC-9)
  ```

  `EVIDENCE_SHOP` defaults to `unfiltered-dev.myshopify.com` — the seed store
  the playground and the dev store both search.
- Every search returns a `searchId`; **every evidence row carries one**. On
  the playground, the engine-details panel (`?details=1`) shows the route,
  routeReason, `engine`, latency and per-stage times. On the dev store, read
  the `searchId` off the network tab's `POST /apps/unfiltered/search` response.
- A one-line read of a playground search, for the steps that need ids:

  ```bash
  curl -s "SERVICE/api/playground/search?query=QUERY&sessionId=m6-$RANDOM" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); x=d["details"]; print(d["searchId"], x["engine"], x["routeReason"], x["stages"].get("judge"), d.get("page"), d.get("totalCount")); [print(r["productId"], r["title"], r.get("label")) for r in d["results"][:24]]'
  ```

- **Every step is PASS/FAIL, and a FAIL is recorded, not fixed** (NG-1).
  Part 8 is the only place a result belongs.

## Part 1 — Preconditions (founder)

1. **The deployment is live, current, and on Engine v2.**

   ```bash
   curl -s SERVICE/healthz
   ```

   **Expected outcome:** `200`, engine `0.4.0`, and the Render dashboard's
   live deploy commit matches the header. Then one playground search with
   `?details=1`: the panel reads `engine: v2` and a judge routeReason
   (`judged`, `judge-cached`, `judge-timeout` or `judge-error`). `engine: v1`
   means `ENGINE_V2=0` is set — stop; the run measures nothing.
2. **The keep-awake monitor is running** — a cold start would put a
   20-second outlier into every number below.

## Part 2 — Parity floor on the dev store (founder) — AC-2

PRD §3's parity floor: for a simple query, Unfiltered's first page is never
worse than the theme's stock search. Judged side by side, by eye, on the dev
store, per query.

3. **Record the index size**: `npx tsx scripts/evidence.mts counts` (agent or
   founder). Products = enriched = embedded, and the count goes in the header.
4. **Ten queries, each run twice on the dev store** — once with the
   Unfiltered app embed **off** (the theme's stock `/search?q=…`) and once
   with it **on** (the widget). Use the same theme, the same browser, a fresh
   session. The set:

   | # | Lang | Kind | Query |
   | --- | --- | --- | --- |
   | P1 | EN | plain keyword | `dress` |
   | P2 | EN | plain keyword | `jacket` |
   | P3 | EN | plain keyword | `boots` |
   | P4 | EN | typo | `sweter` |
   | P5 | EN | brand or title | a product title or vendor read off the catalog |
   | P6 | HE | plain keyword | `שמלה` |
   | P7 | HE | plain keyword | `מעיל` |
   | P8 | HE | plain keyword | `מגפיים` |
   | P9 | HE | typo | `סוודר` misspelled (`סודר`) |
   | P10 | HE | brand or title | a Hebrew-script title, or a Latin-script brand typed in the Hebrew storefront |

   **Expected outcome:** per query, the widget's first page is **at least as
   good** as the stock first page: every product the stock page leads with
   that answers the query is on the widget's page too, and the widget shows
   no product the stock page would rank as plainly wrong. Record, per query,
   the stock page's first three titles, the widget's first three titles, the
   widget `searchId`, and the verdict — `≥ stock` (PASS) or `< stock` (FAIL,
   with the product that makes it worse).

## Part 3 — Speed and the judge on the deployment (agent) — AC-3, AC-8, AC-9

5. **Note the start time** (`date -u +%Y-%m-%dT%H:%M:%SZ`) — step 7 reads the
   judge log from it.
6. **One probe at `--runs 5`, all sets, no assertions:**

   ```bash
   npx tsx scripts/latency-probe.mts --url SERVICE --runs 5 --set all
   ```

   **Expected outcome:** exit 0, `failed requests` absent, `limited=0` on
   every set. Record from the output:
   - **AC-3** — per set and `ai-combined`: `p50` (the median), `under-1s`, and
     `no-extraction` (the share composed without the wish extraction).
   - **AC-8** — the last line, `[judge, all sets]`: the judge stage's `p50`
     and `p95` as the server timed them in Frankfurt, and the `outcomes`.
     The `judge-error` share is printed; `judge-timeout` is a served
     find-order page, counted with it as a failure for AC-8.
7. **The judge log since step 5:**

   ```bash
   npx tsx scripts/evidence.mts judge START_ISO
   ```

   **Expected outcome:**
   - **AC-9** — `verdictRows` > 0 with `uncached` > 0, and the judge-call
     table names `typesafe/jev-1.13` — the Jev identity the verdict rows
     themselves do not carry; the ledger meters each Jev call against its
     `searchId`. Record the row counts.
   - **AC-8** — the `served partial` count: searches whose uncached verdicts
     outnumber their metered Jev calls, i.e. a call that timed out,
     rate-limited or failed over HTTP among the page's 24 parallel calls and
     was substituted. It is a lower bound (a metered call with an unusable
     answer is substituted too, and is not countable from the database).
   - **AC-8 failure share** = (`judge-error` + `judge-timeout` from step 6 +
     `served partial`) ÷ the probe's searches. **Expected (estimate):**
     median under 700 ms, failures under 2 %. **Over 5 % is a FAIL row.**

## Part 4 — Labels on both surfaces (founder + agent) — AC-4

The server names one of five label templates (YOY-151); every surface fills
it from its own string catalog. One search per template, in EN and HE, on the
playground (agent) and on the dev store's theme-native path (founder).

8. **Find one query per template.** Run candidates on the playground until
   each template appears on a card; record the query and the `searchId`.

   | Template | What makes it | Candidate (EN) |
   | --- | --- | --- |
   | `price-near` | a product just over a stated cap (within the near factor) | `dress under 120` |
   | `price-far` | a product well over a stated cap | `jacket under 30` |
   | `size-missing` | a stated size the product offers but not in stock | `boots size 41` |
   | `fact-differs` | the judge reads a stated fact the product does not have | `linen dress` |
   | `close-match` | the judge reads a near miss | `red evening gown` |

   The seed catalog cannot produce `size-missing` (YOY-161, 2026-10-06): all
   1,820 variants of its 465 products are available, so no stated size is
   ever offered but out of stock. Its rows are N/A on this catalog; the label
   is verified by `wishes.test.ts` and the UI label fixtures. The dev store
   carries the same catalog.

   Each template's Hebrew counterpart is the same wish in Hebrew. A template
   that no query on the seed catalog produces after five tries is a FAIL row
   naming the queries tried — not a reason to change the catalog.
9. **Playground half (agent):** for each of the ten searches, the card shows
   its label line in the page's language, under the price, filled with the
   wire's values (the price, the size, the fact) — not a template name, not
   an English line on the Hebrew page.
10. **Dev store half (founder):** the same ten queries on the dev store with
    the embed on, through the theme's own search results page (the
    theme-native path, not the overlay); storefront language switched for
    HE. The same label line shows on the same product, in the store's
    language, inside the theme's own card.

## Part 5 — Paging (founder + agent) — AC-5

11. **Dev store (founder):** search `dress` with the embed on. The theme's
    count line (e.g. "N results") equals the response's `totalCount` (network
    tab). Go to page 2 through the theme's own pagination: every product is
    new — none of page 1's — and the response's `page` is `2`.
12. **Playground (agent):** search `dress`; scroll to the end of the first
    page. The next page appends below it (a second `page=2` request, new
    cards, none repeated), and scrolling stops appending once
    `totalCount` cards are shown.

## Part 6 — Judge fallback (founder) — AC-6

The judge's deadline (`JUDGE_DEADLINE_MS`, default 1500) decides whether a
page waits for the judge; past it the page is served in find order with
`judge-timeout` (YOY-147 AC-6). The only live way to force it is the env var.

13. **Force the deadline:** set `JUDGE_DEADLINE_MS=1` in the Render
    environment and let the service restart. Record the time.
14. **Search on the playground with `?details=1`,** one EN (`linen dress`) and
    one HE (`שמלת פשתן`) query. **Expected outcome:** results appear, the
    panel's routeReason is `judge-timeout`, no error state or message is
    visible, and no card carries a verdict-derived label at first paint. The
    order is the find order: the response's `details.judge.verdicts` are all
    `null`, and the body carries `labelsPending: true` (the late labels may
    still arrive — YOY-148 — without reordering the page). Record both
    `searchId`s.
15. **Restore:** remove `JUDGE_DEADLINE_MS` (unset = 1500), let the service
    restart, and confirm one search reads `judged` again. Record the time.
    **Part 3's numbers must not straddle this window** — run Part 3 before
    step 13 or after step 15.

## Part 7 — Filing (agent) — AC-7

16. **Every FAIL row gets its own Linear issue** on team YOY, labelled
    `repo:unfiltered`, with the query, the `searchId`, expected and observed,
    and a link back to the row. This issue does not fix any of them (NG-1).
    The issue id goes in the row's Evidence column.

## Part 8 — Evidence table

Fill one row per check. **YOY-154 closes only when every row has a result
and a `searchId`** (or, for steps with no search, the command's output).
Every FAIL row links the Linear issue filed for it (AC-7).

- **Date:** 2026-10-05 10:02–10:13 UTC (Part 3 step 6, two probe runs); the rest not yet run
- **Executed by:** builder (rows 1's engine half, 14, 15, 17–21 and 28 — the playground halves, 10:20–10:40 UTC); founder lane pending for the rest
- **Deployment URL / commit:** `https://unfiltered-eu.onrender.com`; `/healthz` `200`, engine `0.4.0` at 10:02:33 UTC. The live commit is the founder's read off the Render dashboard (row 1); `main` was at the runbook merge at the time — a docs-and-scripts-only change, the engine identical either way.
- **Seed catalog size (products):**

| # | AC | Check | Query | searchId | Expected | Observed | Result |
|---|---|---|---|---|---|---|---|
| 1 | — | `/healthz`, deployed commit, Engine v2 | `dress` | | `200`, `0.4.0`, `engine: v2`, judge routeReason | **Engine half (agent, 10:02:33 UTC):** `/healthz` `200`, engine `0.4.0`; every probe search answered with a judge routeReason (`judged`, `judge-cached`, `judge-timeout`), which only Engine v2 serves — e.g. `47a137e3-bcdb-43a8-937b-4c2e5472dbb2` (`dress`, `judge-cached`). Deployed commit: founder, Render dashboard. | _pending founder half_ |
| 2 | — | Keep-awake monitor | — | — | monitor up for the whole run | | |
| 3 | — | Index counts | — | — | products = enriched = embedded | | |
| 4 | AC-2 | Parity P1 (EN keyword) | `dress` | | widget first page ≥ stock; stock top 3 / widget top 3 named | | |
| 5 | AC-2 | Parity P2 (EN keyword) | `jacket` | | as row 4 | | |
| 6 | AC-2 | Parity P3 (EN keyword) | `boots` | | as row 4 | | |
| 7 | AC-2 | Parity P4 (EN typo) | `sweter` | | as row 4 | | |
| 8 | AC-2 | Parity P5 (EN brand or title) | | | as row 4 | | |
| 9 | AC-2 | Parity P6 (HE keyword) | `שמלה` | | as row 4 | | |
| 10 | AC-2 | Parity P7 (HE keyword) | `מעיל` | | as row 4 | | |
| 11 | AC-2 | Parity P8 (HE keyword) | `מגפיים` | | as row 4 | | |
| 12 | AC-2 | Parity P9 (HE typo) | `סודר` | | as row 4 | | |
| 13 | AC-2 | Parity P10 (HE brand or title) | | | as row 4 | | |
| 14 | AC-3 | Speed probe `--runs 5` | probe set | `47a137e3-bcdb-43a8-937b-4c2e5472dbb2` … `876eea74-6378-4915-992a-88edfd93cd4d` (run 2; every sample's id is in the probe output) | per set: median, under-1-s share, no-extraction share | **Recorded run** 10:08:22–10:13:25 UTC, `--runs 5 --set all`, exit 0, `degraded=0 limited=0 reused=0` on every set, no failed request. **classic** median 273 ms, under-1 s 100 %, no-extraction 0 %; **ai-en** median 2276 ms, under-1 s 0 %, no-extraction 0 %; **ai-he** median 2164 ms, under-1 s 0 %, no-extraction 4 %; **ai-combined** median 2167 ms, under-1 s 0 %, no-extraction 2 %. Overall 25 of 75 under 1 s (33 %) — the PRD's "half under 1 s" gate is measured, then decided, so this row records it. A first run minutes earlier (10:02:33–10:07:38, without per-sample ids) read classic 248 ms / 92 %, ai-combined 1864 ms / 0 %, no-extraction 0 %. | **PASS** (recorded) |
| 15 | AC-8 | Jev on the deployment | probe set | as row 14 | judge p50 < 700 ms (estimate); failures < 2 % (estimate); > 5 % FAIL | Run 2: judge stage **p50 941 ms, p95 1781 ms** (n=75, server-timed in Frankfurt); outcomes judged 36, judge-cached 25, **judge-timeout 14**, judge-error 0 → **18.7 % of all searches, 28 % of the 50 uncached ones** served unjudged in find order. Run 1: p50 778 / p95 1705 ms, judge-timeout 8 (10.7 %), judge-error 0. Every timeout is an AI-set search, EN and HE alike; e.g. `3a190302-61a5-456c-a555-f2e943b464a8` (`elegant evening dress under 400`), `0271ee00-b10e-4c7b-b9e4-f73224743cb6` (HE). The `partial` share is the founder lane's `evidence.mts judge 2026-10-05T10:02:33Z` (row 16) — the row fails on timeouts alone. | **FAIL — YOY-159** |
| 16 | AC-9 | Judge log rows | probe set | as row 14 | `uncached` > 0; Jev identity `typesafe/jev-1.13` in the ledger; row count recorded | Pending the founder lane: `npx tsx scripts/evidence.mts judge 2026-10-05T10:02:33Z` covers both probe runs (the agent's database read was not permitted). | _pending_ |
| 17 | AC-4 | Label `price-near` — playground EN / HE | EN `dress under 120`; HE `שמלה עד 450` | EN `2825ba25-406a-4dda-8be5-151f5ef69ea7` (judge-cached); HE `294b33ce-2458-4e52-a7e0-93fa14ca4088` (judged) | label line filled, page language | EN: `Mesh Over Dress in Navy` carries `price-near` [`128 USD`, `120 USD`]; `/try?lang=en` renders "128 USD, slightly over 120 USD". HE: `Tie Waist Dress in Black` carries `price-near` [`148 USD`, `450 ILS`] on the wire. **But when the judge is late the label does not hold:** `344b42f7-78aa-431f-bdd2-37a092b362cf` (`dress under 120`, `judge-timeout`) served `price-near` and the late-labels endpoint replaced it — and all 23 `price-far` labels — with `close-match`; a re-run of the HE query on `/try?lang=he` rendered "התאמה קרובה" on the card the API had labelled `price-near`. | **FAIL — YOY-160** |
| 18 | AC-4 | Label `price-far` — playground EN / HE | EN `jacket under 30`; HE `ז'קט עד 30` | EN `b4605dde-c6db-47bc-af3d-f68b39725d96` (judged); HE `cf3ec840-5a3b-40f8-a81e-1f942a047499` (judge-timeout) | as row 17 | EN: 24 of 24 `price-far`, e.g. `Marquee Coat in Steel` [`318 USD`, `30 USD`]; `/try?lang=en` renders "358 USD, over your 120 USD" on the `dress under 120` page. HE: 24 of 24 `price-far` [`318 USD`, `30 ILS`] on the wire — a `judge-timeout` search, so the same late overwrite as row 17 applies on the page. | **FAIL — YOY-160** (same defect as row 17) |
| 19 | AC-4 | Label `size-missing` — playground EN / HE | eight EN tries: `boots size 41`, `dress size XS`, `boots size 8`, `sweater size L`, `dress in size 2`, `jeans size 28`, `sneakers size 39`, `t-shirt size XXL` | `dbf715ae…`, `95c1883d…`, `8bc66477…`, `1269e6f3…`, `0745469c…`, `fb9f020e…`, `ea0e4d2a…`, `b3ebabfc…` (full ids on YOY-161) | as row 17 | No `size-missing` label on any card of any of the eight — the runbook's five-tries rule. HE not tried while EN produces none. Diagnosed 2026-10-06 (YOY-161): the size is extracted (size chip on `4f744277…`, `9176c202…`, `d1aab011…`), but the seed catalog has 0 unavailable variants of 1,820, so the label cannot appear. | **N/A on this catalog** — label verified by `wishes.test.ts` and the UI label fixtures (YOY-161) |
| 20 | AC-4 | Label `fact-differs` — playground EN / HE | EN `linen dress`, `silk dress`, `wool sweater`, `leather jacket` | `9b34ad51-0d9e-4fee-8146-adf51d562b33`, `5fd1d556-9c6f-435d-9d68-2c39f1d614d1`, `116aaedf-01b0-4012-aaae-27017c8e9ab9`, `a5ad7305-8594-45ee-abf9-25f9fa07a540` | as row 17 | **Not producible under the Jev judge, by design:** the decision judge writes no text, so a product off the ask carries `close-match` instead (`packages/engine/src/judge.ts`, `decisionVerdict`, YOY-152 AC-3); the merchant-fact label with Jev is the post-M6 YOY-158. All four searches showed `close-match` and no `fact-differs`, as the code says they must. Needs a co-manager decision: score this row N/A under Jev, or run it with `JUDGE_PROVIDER=gemini`. | _decision needed_ |
| 21 | AC-4 | Label `close-match` — playground EN / HE | EN `red evening gown`; HE `שמלת ערב אדומה` | EN `8211d33b-c23a-4ad6-8045-bacc4d116d1e` (judged); HE `efb90be6-d4f0-4d8a-828a-3fb6fc6a2b5c` (judged) | as row 17 | EN: 4 cards `close-match`, e.g. `Robe Dress`; `/try?lang=en` renders "close match". HE: 8 cards `close-match`, e.g. `Groove Dress`; `/try?lang=he` (`dir=rtl`, `lang=he`) renders "התאמה קרובה". | **PASS** |
| 22 | AC-4 | Label `price-near` — dev store theme-native EN / HE | | | same label, store language, theme card | | |
| 23 | AC-4 | Label `price-far` — dev store theme-native EN / HE | | | as row 22 | | |
| 24 | AC-4 | Label `size-missing` — dev store theme-native EN / HE | | | as row 22 | | |
| 25 | AC-4 | Label `fact-differs` — dev store theme-native EN / HE | | | as row 22 | | |
| 26 | AC-4 | Label `close-match` — dev store theme-native EN / HE | | | as row 22 | | |
| 27 | AC-5 | Paging — dev store | `dress` | | page 2 all new; count line = `totalCount` | | |
| 28 | AC-5 | Paging — playground scroll | `dress` | `a4fe87af-a234-4c97-b31a-e748588f0df9` | scroll appends page 2; stops at `totalCount` | `/try?lang=en`, `dress`: page 1 = 24 cards, `totalCount` 172. A real wheel scroll to the end shows "Loading more…" and the grid grows to 48 cards, **48 unique** product links — page 2 appended with no repeat (first card of page 2: `sleeveless-dress-in-black`). A programmatic `window.scrollTo` did not trigger the observer; a wheel scroll did, as a shopper's does. The stop at `totalCount` (172 = 7 full pages + 4) was not scrolled to the end. | **PASS** (append); end-of-list not exercised |
| 29 | AC-6 | Fallback EN, deadline forced | `linen dress` | | `judge-timeout`, results in find order, no error visible | | |
| 30 | AC-6 | Fallback HE, deadline forced | `שמלת פשתן` | | as row 29 | | |
| 31 | AC-6 | Deadline restored | `dress` | | `judged` again; env var unset | | |
| 32 | AC-7 | Every FAIL row filed | — | — | one Linear issue per FAIL row, linked above | | |
