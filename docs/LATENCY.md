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
   sample is therefore ≥ 100 responses.
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

## Recorded measurements

Every quoted row names the deployment region and the code it ran, and
links the issue comment carrying the probe's full output.

| Date | Region | Code | Set | n | p50 | p95 | Notes |
|---|---|---|---|---|---|---|---|
| 2026-08-15 (YOY-95 step 12) | Oregon → Frankfurt DB | M4 | classic | 1 query | — | 919–978 ms | Pre-method hand-timed; the F-3 finding that motivated the bar. |
| 2026-08-26 | Frankfurt | `main` before YOY-114 (unchanged code) | classic | 100 | 24 ms | 50 ms | The M5 baseline (YOY-114 AC-5); full probe output on the issue. Frankfurt, not Oregon: the service moved (YOY-115 gate) before the baseline ran. One 2057 ms outlier (rank 100). |
| 2026-08-26 | Frankfurt | `main` before YOY-114 | ai-en | 100 | 1830 ms | 6784 ms | 0 degraded, 0 limited. p95 misses the 3500 ms bar. |
| 2026-08-26 | Frankfurt | `main` before YOY-114 | ai-he | 100 | 1820 ms | 7370 ms | 0 degraded, 0 limited. p95 misses the 3500 ms bar. |
| 2026-08-26 | Frankfurt | `main` before YOY-114 | ai-combined | 200 | 1830 ms | 7370 ms | Per-stage means absent: the deployed code predates `details.stages`. |
