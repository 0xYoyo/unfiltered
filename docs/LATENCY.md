# Latency — the measurement method and bars

Binding for every latency number quoted on an issue, PR, or live-run
row. A number produced any other way is an anecdote, not a measurement.
Owner: founder. Amend via PR only. Established by YOY-114.

## The bars

Every **submitted** search takes one path — find, the wish extraction, the
judge (Jev since YOY-152) — whatever its length (YOY-153, 2026-10-04):

| Path | Bar | Statistic |
|---|---|---|
| Submitted search (all three probe sets: the short `classic` set's queries are submitted searches too), EN and HE, each and combined | p50 **< 2000 ms** and p95 **< 3500 ms** | server-side `latencyMs` |
| Keystroke preview (`mode=preview`, keyword only, zero model calls) | ceiling **≤ 800 ms** (a canary, not a percentile bar) | the daily smoke's preview probe, one sample a day (docs/SMOKE.md) |

The bars are strict (`<`). A bar met on the combined set but missed in one
language is missed. The keyword store behind the preview met its own
p95 ≤ 500 ms bar in M5 ("Classic bar — met" below). The probe reports two
shares beside the percentiles, both tracked, neither a bar yet: `under-1s`
— the PRD's "half of searches under 1 s" gate, measured, then decided (PRD
§3 Refinement 10) — and `no-extraction`, the share composed without the
wish extraction.

## The method

1. **Server-side `latencyMs`.** The number is the orchestrator's wall time
   as the deployment reports it in `details.latencyMs` — the same figure
   the `SearchEvent` ledger keeps. Network time between the probe and the
   service is never in it: the bars are about the engine, not the probe's
   connection.
2. **Warm instance, warm-up discarded.** The probe sends one request
   before measuring and throws its result away. A Render instance that
   just woke, a cold connection pool, or a cold keep-alive pool is not
   what the bars describe; if the deployment is asleep, that is a
   deployment fact recorded separately, not a latency sample.
3. **Live seed catalog.** Measurements run against the deployed playground
   (`GET /api/playground/search`) over the seed catalog — no `catalog`
   parameter — unless the row says otherwise. Local runs are for
   development only and are never quoted as a bar.
4. **N ≥ 20 runs per set.** The committed query set
   (`apps/shopify-app/scripts/latency-probe-queries.json`: 5 classic, 5 EN
   AI, 5 HE AI) is run sequentially, every query of the set, `--runs`
   times (20 minimum), each request with a fresh `sessionId`. A set's
   sample is therefore ≥ 100 responses. Every AI-set request carries an
   invisible per-invocation, per-run marker (zero-width format characters
   after a trailing space) so that the judge's answer cache (YOY-148) and
   the extraction cache (YOY-149 AC-18) never answer a run from a previous
   run: each AI sample pays the full path. The visible query text is the
   committed one.
5. **Nearest-rank percentiles.** Sort a set's `latencyMs` ascending and
   take the value at rank ⌈p/100 · n⌉ (1-based). No interpolation: every
   reported percentile is a latency that actually happened.
6. **EN and HE AI reported separately and combined.** Three AI rows
   (`ai-en`, `ai-he`, `ai-combined`) plus the classic row, each with n,
   p50, p95, the mean per pipeline stage, and the count of `degraded` and
   `limited` responses. A degraded response is the keyword order (the
   query embedding failed) and a limited one is find order with no judge
   call; each is counted and shown, never folded silently into an AI
   percentile's story. Each row also reports
   `under-1s`: the share of the set's responses under 1,000 ms server-side
   — the "half of searches under 1 s" line of the 90 % rule (docs/PRD.md
   §3 Quality gate; YOY-141).

Per-stage means come from `details.stages` (the orchestrator's ledger:
`find | compose | classic | hydrate | judgeRows | judge`,
whole ms per stage actually run). They explain a percentile; they are not
a bar.

## The tool

```bash
cd apps/shopify-app
npx tsx scripts/latency-probe.mts --url https://unfiltered-eu.onrender.com \
  --runs 20 --set all
# Bars as exit code (CI-shaped):
npx tsx scripts/latency-probe.mts --url https://unfiltered-eu.onrender.com \
  --runs 20 --set all \
  --assert-classic-p95 500 --assert-ai-p50 2000 --assert-ai-p95 3500
```

`--set classic|ai-en|ai-he|all` chooses the sets; `--catalog <slug>`
targets a registry catalog instead of the seed. With `--assert-*` flags the
probe exits 1 on any breach; a failed request (non-200) also exits 1,
because an incomplete sample is not a pass. The AI sets are paced under the
playground's per-IP AI throttle (10 per sliding minute, `--ai-per-minute`)
so the probe measures the pipeline rather than the guard. The percentile
math and the exit semantics are unit-tested in
`scripts/latency-probe.test.ts`.

### Classic bar — met (YOY-115)

Classic p95 ≤ 500 ms was met on 2026-08-26 at **19 ms** (row 2 below:
Frankfurt, one-statement search, unpooled) — 26× under the bar, from
50 ms on the two-statement code and 919–978 ms on the Oregon deployment
that motivated it. The pooled-connection row (row 3) is the deployment's
final form; it was measured in YOY-124 AC-11 on 2026-08-28 at **50 ms**
(the subsection below), still 10× under the bar — pooling is not what meets the
bar, and it does not cost the bar either.

### Pooled classic — the deployment's final form (YOY-124 AC-11)

The env-group switch ran on **2026-08-28 18:28 UTC**
(`render-migrate.mts pool-database-url unfiltered-prod`: `DIRECT_DATABASE_URL`
written from the previous `DATABASE_URL`, `DATABASE_URL` rewritten to the
`-pooler` host with `pgbouncer=true`), then `trigger-deploy` and `wait-deploy`
— deploy `dep-da8t6h9srm7s73ahjil0`, live 18:29:16 UTC, commit `52a638c`.
`/healthz` answered `200` with engine `0.4.0`, and the four-probe smoke passed
`4/4` at 18:59 UTC.

The four 2026-08-27 PR #129 rows below say "pooled" in their Code column; that
label is wrong. `pool-database-url` refuses an already-pooled host and it
succeeded on 2026-08-28, writing `DIRECT_DATABASE_URL` from the then-current
`DATABASE_URL` — so every row before 2026-08-28 ran direct. The rows are left
as recorded rather than rewritten; this paragraph is the correction.

Classic on the pooled connection is **p50 37 ms, p95 50 ms** (the 2026-08-28
rows below) against 13 ms / 22 ms on the unpooled rows of 2026-08-26 and
2026-08-27: PgBouncer costs roughly 20–25 ms per statement here, and the bar
still clears by 10×. Full probe output on
[YOY-124](https://linear.app/0xyoyo/issue/YOY-124).

### The extraction's grace (YOY-171 AC-6)

Every Engine v2 search now books the wish extraction in its stage ledger:
`extract` — the call's wall time from its start with the search to its
settle; when it misses the 800 ms grace (`extractionGraceMs`), the time the
page waited for it, a lower bound, since the call runs on to fill the
extraction cache — and `extractLate`, `1` for a missed grace, `0` otherwise.
The playground's details panel shows `extract` first, marked `late` on a miss.
The probe reports `extract-late` (the share that missed the grace) and the
extraction's p50/p95 per set, beside `no-extraction` (missed the grace or
failed).

**How often the grace is missed today:** at most **8 %** of AI searches — the
`no-extraction` share of the 2026-10-06 bar run (50 searches, `main` at
`bb9f80f`, the last full run on the deployment), which counts a missed grace
and a failed call alike, so it bounds the late share from above. The
`extract-late` share and the extraction's own p50/p95 come from the first
probe after this slice deploys: the deployment answers without the `extract`
stage until then. No grace change in this AC.

## Recorded measurements

Every quoted row names the deployment region and the code it ran, and
links the issue comment carrying the probe's full output. The AI-set rows
measured on the previous engine (2026-08-26 to 2026-08-28) are kept in this
file at the tag `engine-v1-last`; the keyword-store rows of that period
stay below.

| Date | Region | Code | Set | n | p50 | p95 | Notes |
|---|---|---|---|---|---|---|---|
| 2026-08-15 (YOY-95 step 12) | Oregon → Frankfurt DB | M4 | classic | 1 query | — | 919–978 ms | Pre-method hand-timed; the F-3 finding that motivated the bar. YOY-115 "Oregon before": the service moved to Frankfurt (PRs #109/#110) before any probe run, so the M5 rows below are all Frankfurt. |
| 2026-08-26 | Frankfurt | `main` before YOY-114 (unchanged code) | classic | 100 | 24 ms | 50 ms | The M5 baseline (YOY-114 AC-5) = YOY-115 AC-6 row 1 (two statements + a hydration query, unpooled); full probe output on the issue. Frankfurt, not Oregon: the service moved (YOY-115 gate) before the baseline ran. One 2057 ms outlier (rank 100). |
| 2026-08-26 12:37 UTC | Frankfurt | PR #113 one-statement classic (YOY-115 AC-1..3), unpooled `DATABASE_URL` | classic | 100 | **9 ms** | **19 ms** | YOY-115 AC-6 row 2; `--assert-classic-p95 500` exit 0; full output on YOY-115. Mean classic stage 10 ms. |
| 2026-08-26 ~21:30 UTC | Frankfurt | `main` at PR #117, unpooled | classic | 100 | **13 ms** | **22 ms** | YOY-64 AC-6 run; full output on YOY-64. Mean classic stage 10 ms. |
| 2026-08-27 ~09:45 UTC | Frankfurt | `main` at PR #119, unpooled | classic | 100 | **13 ms** | **22 ms** | YOY-64 AC-6 second run; full output on YOY-64. 0 degraded, 0 limited; mean classic stage 14 ms. |
| 2026-08-27 ~21:10 UTC (2026-08-28 00:10 IDT) | Frankfurt | `main` at PR #129, pooled | classic | 100 | **14 ms** | **26 ms** | YOY-133 AC-6; full output on YOY-133. 0 degraded, 0 limited; mean classic stage 13 ms. |
| 2026-08-28 18:29–18:59 UTC | Frankfurt | `main` at `52a638c` (PR #141), one-statement classic + pooled `-pooler` host (`pgbouncer=true`) | classic | 100 | **37 ms** | **50 ms** | YOY-115 AC-6 row 3 = YOY-124 AC-11: the pooled measurement, taken after the founder-lane env-group switch (docs/DEPLOY.md "Switching to the pooled connection"). `--assert-classic-p95 500` exit 0; full output on YOY-124. 0 degraded, 0 limited; mean classic stage 30 ms. |
| 2026-10-04 ~18:45 UTC | Frankfurt | `main` at `5c5adfe` (PR #182: Jev default judge) | short queries (`classic` set) | 5 | 1666 ms | 1730 ms | YOY-153 AC-4 single sample (`--runs 1`), not a bar measurement. All 5 served v2 and judged (`routes: ai=5`), 0 degraded, 0 limited; under-1s 0 %, no-extraction 0 %. Mean per stage: find 458 · hydrate 18 · judge 893 ms. |
| 2026-10-04 ~18:45 UTC | Frankfurt | `main` at `5c5adfe` | ai-combined | 10 | **1538 ms** | 2298 ms | YOY-153 AC-4 single sample: the median the smoke's `aiMaxMs` is restated from (docs/SMOKE.md). EN p50 1538 / p95 2298; HE p50 1559 / p95 1887. 0 degraded, 1 limited (one HE request hit the per-IP throttle and was served classic). under-1s 10 %, no-extraction 0 %. Mean per stage: find 354 · compose 114 · hydrate 67 · judge 737 ms. |
| 2026-10-06 14:31–14:36 UTC | Frankfurt | `main` at `bb9f80f` (PR #191: per-call judge limit 1,200 ms + shared keep-alive pool), | short queries (`classic` set) | 25 | 246 ms | 841 ms | YOY-159 AC-4 re-measure (`--runs 5 --set all`); full output on YOY-159. Every sample judge-cached (the set repeats its queries). under-1s 96 %. Mean per stage: find 172 · hydrate 32 · judgeRows 159 · judge 0 ms. |
| 2026-10-06 14:31–14:36 UTC | Frankfurt | `main` at `bb9f80f` | ai-combined | 50 | **1933 ms** | **2973 ms** | Both v2 bars met. EN p50 1996 / p95 2999; HE p50 1776 / p95 2535. 0 degraded, 0 limited; under-1s 0 %, no-extraction 8 %. Mean per stage: find 400 · compose 148 · hydrate 54 · judgeRows 240 · judge 689 ms. |
| 2026-10-06 14:31–14:36 UTC | Frankfurt | `main` at `bb9f80f` | judge stage, all sets | 75 | **487 ms** | **1206 ms** | YOY-159 AC-4 bars met: **judge-timeout 1 of 50 uncached (2 %)**, < 10 %; p95 < 1,500 ms. Outcomes judged 49 · judge-cached 25 · judge-timeout 1 · judge-error 0 (was 14 timeouts, p95 1781 ms on 2026-10-05). Split: judgeRows p50 183 / p95 553; slowest call p50 569 / p95 1201; median call p50 399 / p95 686 ms. |
| 2026-10-07 10:46–10:49 UTC | Frankfurt | PR #206 (a judge call's ledger wait bounded by its own signal), merged 10:23 UTC — 23 min before the run; the deployed commit is not observable (`/healthz` exposes none). | judge stage, all sets | 15 | **796 ms** | **1256 ms** | YOY-157 AC-24 re-measure (`--runs 1 --set all`, every search uncached: the answer-cache key changed in PR #205); full output on YOY-157. **Per-search slowest call ≤ 1202 ms on all 15 uncached searches** (bar ~1,300 ms): slowest call p50 792 / p95 1202 ms; median call p50 406 / p95 874 ms; served before every call settled 0. Outcomes judged 15 · judge-timeout 0 · judge-error 0. judgeRows p50 196 / p95 945 ms. ai-combined p50 2118 / p95 3251 ms (n=10, one run each, all uncached, warm-up 5003 ms discarded): **not a v2-bar measurement** — one cold run with no cache hits is not the bar's method; the v2 bars are last measured in the 2026-10-06 rows above. |
