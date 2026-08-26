# Latency — the M5 measurement method and bars

Binding for every latency number quoted on an M5 issue, PR, or live-run
row. A number produced any other way is an anecdote, not a measurement.
Owner: founder. Amend via PR only. Established by YOY-114.

## The bars

| Path | Bar | Statistic |
|---|---|---|
| AI (EN and HE, each and combined) | p50 **< 2000 ms** and p95 **< 3500 ms** | server-side `latencyMs` |
| Classic | p95 **≤ 500 ms** | server-side `latencyMs` |

The AI bars are strict (`<`); the classic bar is inclusive (`≤`). A bar met
on the combined AI set but missed in one language is missed.

## The method

1. **Server-side `latencyMs`.** The number is the orchestrator's wall time
   as the deployment reports it in `details.latencyMs` — the same figure
   the `SearchEvent` ledger keeps. Network time between the probe and the
   service is never in it: the bars are about the engine, not the probe's
   connection.
2. **Warm instance, warm-up discarded.** The probe sends one request
   before measuring and throws its result away. A Render instance that
   just woke, a cold connection pool, or a cold classifier cache is not
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
   after a trailing space) so that exact-query intent reuse (YOY-64 AC-4)
   never answers a run from a previous run's stored intent: each AI sample
   pays the full pipeline, and the summary's `reused` count must be 0 for
   the row to count. The visible query text is the committed one.
5. **Nearest-rank percentiles.** Sort a set's `latencyMs` ascending and
   take the value at rank ⌈p/100 · n⌉ (1-based). No interpolation: every
   reported percentile is a latency that actually happened.
6. **EN and HE AI reported separately and combined.** Three AI rows
   (`ai-en`, `ai-he`, `ai-combined`) plus the classic row, each with n,
   p50, p95, the mean per pipeline stage, and the count of `degraded` and
   `limited` responses. A degraded or limited response is a classic
   answer wearing the AI route's request; it is counted and shown, never
   folded silently into an AI percentile's story.

Per-stage means come from `details.stages` (the orchestrator's ledger:
`classify | intent | embed | retrieve | classic | hydrate | closeMatches`,
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
final form and is measured in YOY-124 AC-11; it is not what meets the bar.

### AI bars — EN met, HE missed on p95 (YOY-64, 2026-08-26)

First M5-method run on the YOY-64 code (PR #117: queued ledger, trimmed
prompt, ladder deadline, exact-query reuse, overlapping stages), rows
7–10 below. **p50 is met in both languages** — 908 ms EN, 976 ms HE,
933 ms combined against < 2000 — down from 1830/1820 ms on the baseline.
**EN p95 is met** at 3354 ms (< 3500; was 6784). **HE p95 is missed** at
8021 ms (was 7370), and so is the combined p95: 12 of the 100 HE samples
and 1 of the 100 EN samples came back `degraded` — classic answers served
after the accuracy-tier intent call hung to the 8 s ladder deadline
(`GEMINI_INTENT_TIMEOUT_MS`), all at 8013–8155 ms. Nine of the twelve HE
hangs are one query, `שמלה אלגנטית לערב מתחת ל-400`, three are
`משהו לחתונה על החוף שמסתיר את הידיים`; both are occasion-class queries
that skip the lite tier by design (YOY-116), so each hang is the accuracy
model alone. The non-degraded HE tail is inside the bar — the miss is the
hang rate, the same upstream failure class YOY-109 and YOY-116 recorded,
now bounded at 8 s instead of 20–40 s. `reused=0` on every set: the
per-run marker kept exact-query reuse out of the sample. The founder
decision on this (a hang-rate bar, a mitigation slice, or a re-run) is
recorded on YOY-64.

**Decision and mitigation (2026-08-26, co-manager, binding).** AC-6 now
reads "degraded ≤ 1 % of the run (≤ 2 of 200)": hangs are bounded by the
deadline, not eliminated. The first-choice mitigation — run the occasion
class lite-first like every other shape — regressed g09 on the eval
harness (the lite tier labels `gold strappy sandals for a summer wedding`
as `sneakers`; the golden needs `shoes`; hit rate 97 % → 94 %), and the
zero-regression baseline is never loosened, so the fallback shipped
instead: the occasion class stays on the accuracy tier and its call is
**hedged** — past `INTENT_HEDGE_AFTER_MS` (default 2500) the lite tier
runs alongside it and the first schema-valid answer wins (engine
`createEscalatingIntentExtractor({ hedgeAfterMs })`, docs/ARCHITECTURE.md).
On this run's numbers a hung accuracy call now lands a lite answer near
3.1–3.9 s instead of a classic degrade at 8 s; whether that clears the
3500 ms p95 is the next probe run's row, recorded below once deployed.

## Recorded measurements

Every quoted row names the deployment region and the code it ran, and
links the issue comment carrying the probe's full output.

| Date | Region | Code | Set | n | p50 | p95 | Notes |
|---|---|---|---|---|---|---|---|
| 2026-08-15 (YOY-95 step 12) | Oregon → Frankfurt DB | M4 | classic | 1 query | — | 919–978 ms | Pre-method hand-timed; the F-3 finding that motivated the bar. YOY-115 "Oregon before": the service moved to Frankfurt (PRs #109/#110) before any probe run, so the M5 rows below are all Frankfurt. |
| 2026-08-26 | Frankfurt | `main` before YOY-114 (unchanged code) | classic | 100 | 24 ms | 50 ms | The M5 baseline (YOY-114 AC-5) = YOY-115 AC-6 row 1 (two statements + a hydration query, unpooled); full probe output on the issue. Frankfurt, not Oregon: the service moved (YOY-115 gate) before the baseline ran. One 2057 ms outlier (rank 100). |
| 2026-08-26 | Frankfurt | `main` before YOY-114 | ai-en | 100 | 1830 ms | 6784 ms | 0 degraded, 0 limited. p95 misses the 3500 ms bar. |
| 2026-08-26 | Frankfurt | `main` before YOY-114 | ai-he | 100 | 1820 ms | 7370 ms | 0 degraded, 0 limited. p95 misses the 3500 ms bar. |
| 2026-08-26 | Frankfurt | `main` before YOY-114 | ai-combined | 200 | 1830 ms | 7370 ms | Per-stage means absent: the deployed code predates `details.stages`. |
| 2026-08-26 12:37 UTC | Frankfurt | PR #113 one-statement classic (YOY-115 AC-1..3), unpooled `DATABASE_URL` | classic | 100 | **9 ms** | **19 ms** | YOY-115 AC-6 row 2; `--assert-classic-p95 500` exit 0; full output on YOY-115. 1 `degraded` (a cold LLM-classifier timeout on "black shirt", served classic) — the classifier's cost, not the statement's: mean per stage classify 29 ms · classic 10 ms. |
| — | Frankfurt | one-statement classic + pooled `-pooler` host (`pgbouncer=true`) | classic | — | — | — | YOY-115 AC-6 row 3: pooled — measured in YOY-124 AC-11 after the founder-lane env-group switch (docs/DEPLOY.md "Switching to the pooled connection"). |
| 2026-08-26 ~21:30 UTC | Frankfurt | `main` at PR #117 (YOY-64 AC-1..5), unpooled | classic | 100 | **13 ms** | **22 ms** | YOY-64 AC-6 run; full output on YOY-64. One 948 ms sample (rank 100): "black shirt" is colour-shaped, so the model classified it while a speculative intent extraction ran alongside (AC-5) — the response was still classic; mean per stage classify 8 ms · classic 10 ms. |
| 2026-08-26 ~21:30 UTC | Frankfurt | `main` at PR #117 | ai-en | 100 | **908 ms** | **3354 ms** | Both bars met. 1 degraded (an 8043 ms accuracy-tier hang cut by the ladder deadline), 0 limited, 0 reused. Mean per stage: classify 623 · intent 1232 · embed 26 · retrieve 31 · hydrate 12 · closeMatches 20 ms. |
| 2026-08-26 ~21:30 UTC | Frankfurt | `main` at PR #117 | ai-he | 100 | **976 ms** | 8021 ms | p50 met; **p95 missed**: 12 degraded (accuracy-tier hangs at the 8 s deadline, 9 on one occasion-class query), 0 limited, 0 reused. Mean per stage: classify 585 · intent 2377 · embed 41 · retrieve 36 · hydrate 9 · closeMatches 18 ms. |
| 2026-08-26 ~21:30 UTC | Frankfurt | `main` at PR #117 | ai-combined | 200 | **933 ms** | 8016 ms | p50 met; p95 missed through the HE hang rate (13 degraded of 200). `--assert-ai-p50 2000 --assert-ai-p95 3500` exit 1: `ai-he p95=8021 ms >= 3500 ms`, `ai-combined p95=8016 ms >= 3500 ms`. |
