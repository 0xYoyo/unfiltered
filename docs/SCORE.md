# The hidden score

The release gate for Engine v2 (docs/PRD.md §3 Quality gate): a fixed set of
human-style searches, run through the playground's own search, the top six
results of each graded 0–3 by a model against a fixed rubric. A change ships
only if the hidden score goes up. The tooling lives in
`apps/shopify-app/app/score/` with its command lines in
`apps/shopify-app/scripts/score-*.mts` (YOY-140).

## Method

1. **Build the set** — `npx tsx scripts/score-build-set.mts --hidden-out <path outside the repo>`.
   Every submitted search of the playground store keys is read from
   `SearchEvent` (query, store key, date) and de-duplicated on its normalized
   text. Only shopper-shaped searches are kept: submitted on or after
   2026-08-10 (the playground era — earlier rows are M1 test searches), at
   least three characters after trimming, no zero-width format character
   (the latency probe's marker), and not one of the probe's committed
   queries in `scripts/latency-probe-queries.json`. Each is filed under a language by script alone: Hebrew → `he`,
   Arabic → `ar`, Cyrillic → `ru`, everything else → `en`. French and Spanish
   are never taken from the log.
2. **Fill** — each of `en, he, ar, ru, fr, es` is filled to exactly 25
   searches: log queries first (the newest 25 when there are more), then Flash-Lite filler shaped
   60 % one to three words, 30 % medium, 10 % long or vague. Each entry
   carries `source: "log" | "model"`; a language with no log entry is marked
   `modelWritten: true`.
3. **Split** — each language is split 13 public / 12 hidden by a seeded
   shuffle (seed 140): the same set always splits the same way. The public
   half is written to `apps/shopify-app/app/score/data/public-set.json`. The
   hidden half is written base64-encoded to `--hidden-out`; the builder
   refuses, writing nothing, when that path is inside the repository or the
   encoded file is 48 KB or larger.
4. **Run** — the runner seeds an in-process PGlite database from a fixture
   (`scripts/score-export-fixture.mts <storeKey> --out <file>`: the store
   key's `CatalogProduct`, `ProductEnrichment` and `ProductEmbedding` rows,
   vectors as base64 Float32, with the catalog's `ingestedAt` date), then runs
   every search through `runPlaygroundSearch` — the same function
   `/api/playground/search` calls — with a 24-result limit, and grades the
   top six.
5. **Grade** — one Flash-Lite call per search (temperature 0, thinking level
   low, ledger operation `score-grade`), a grade 0–3 per result against the
   rubric below. `GEMINI_SCORE_MODEL` overrides the model. The grader sees
   what a shopper sees: per result its title, type, vendor and price, then
   the enrichment's category, colours and occasions, its fit, style tags and
   five vision attributes (sleeve length, neckline, garment length, pattern,
   material appearance) where present, and the description's first 300
   characters, HTML stripped and whitespace collapsed.
6. **Score** — a search's score is the mean of six grades divided by 3, a
   missing result slot graded 0. A language's score is the mean over its
   searches.
7. **Print** — the run captures all console output and prints the score
   table only: per language its score, search count, `modelWritten` flag,
   share of searches under 1 s, and failed searches, then one cost line —
   `cost $N over N model calls`, the run's spend read from its own cost
   ledger (every search call and every grade) before the scratch database
   is discarded — then, when any search failed, one line per distinct
   stage and error class, `failed <search|grade> <ClassName> <count>`. A
   failure is named by its error's class only, never its message, which can
   carry the query. Query text never reaches the output.

`npm run score:public` runs the public half against
`app/score/data/seed-fixture.json.gz` (`--set`, `--fixture` and
`--hidden-set <file>` override). Fixtures whose name ends in `.gz` are
written and read gzipped; the seed fixture is committed that way, its size
cap applies to the compressed file, and it always holds every product.
Every command takes `--synthetic` where it reads data: a synthetic catalog,
a synthetic search log and replay clients — offline, $0, for tests and dry
runs.

## The hidden run

The hidden half lives only in the `HIDDEN_SET_B64` repository secret — the
base64 file `score-build-set.mts` wrote to `--hidden-out` — and is scored by
`.github/workflows/score.yml`:

```bash
gh workflow run score.yml -f ref=main   # ref: any branch, tag or SHA
gh run view --log
```

One choice input picks the judge: `judge` (`gemini` or `jev`, sets
`JUDGE_PROVIDER`; YOY-152). It defaults to what production serves (YOY-157
AC-19): `jev` (see "Decision — Jev is the default judge"), so a plain
dispatch scores production; pass `-f judge=gemini` to score the
alternative. There is one engine (YOY-155); the previous one is kept at the
tag `engine-v1-last`.
A judge input that is not on the default branch's workflow yet is dispatched
with `--ref <branch>`, so the branch's own workflow file runs.

The workflow runs on `workflow_dispatch` only — never on push or pull
request, never inside `ci.yml`. It has two jobs on separate machines, so the
scored ref's code and the leak guard never share a filesystem (YOY-157
AC-31). The `run` job checks out `ref`, writes the secret to the runner's
temp directory, runs `score-run.mts --hidden-set` with `GEMINI_API_KEY`, and
captures every byte the runner writes. Before the run it prints the names —
never the values — of the `GEMINI_*` variables it has. It
prints none of the output and writes no job summary: it uploads the output
as a one-day artifact, encrypted with the hidden-set secret, because until
the check has run the output may hold hidden query text. The `check` job
then checks out the workflow's own commit (`github.sha`) only, never the
scored ref (YOY-157 AC-2), decrypts the artifact, and runs
`score-leak-check.mts`, which fails the job if
any hidden query appears in that output as whole words (the score table,
the cost line and the failure lines excepted: each is matched by its exact
shape and holds only language codes, numbers, a stage or a class name),
printing a count and never the query. It exits with the run's own status.

A run with more than 2 failed searches of 72 is not a baseline: its cause
is fixed first and the run is dispatched again. Only a
clean output is printed to the log and written to the job summary.

**Which languages gate (2026-10-03, YOY-150 decision A).** A hidden-run
gate binds on the languages with real log searches — en and he: neither
may fall below the run it is compared with by more than its noise band.
The model-written languages — ar, ru, fr and es — are tracked, not gated:
a drop beyond the band in one of them is recorded under Results with the
run that must re-check it, and two consecutive hidden runs below the
reference value in the same language make a fix issue before the next
engine issue is picked. Run 4's fr (−0.069 against run 3) is the first
such record; hidden run 5 re-checks fr against run 3's 0.569.

## Rubric

The grader's prompt carries this text verbatim (a test holds the two equal):

```
Grade each result for the shopper's search, the way the shopper would judge it.
3 — exactly: it is what the shopper asked for, and every stated wish is met.
2 — close: the right kind of product, with one stated wish off or not shown.
1 — weak: related to the search, but not a product the shopper would pick for it.
0 — no: unrelated, or it breaks something the shopper asked for or ruled out.

Example, grade 1: search "black running shoes", result "Black leather dress shoes" — black shoes, but not for running.
Example, grade 0: search "dress not in red", result "Red wrap dress" — the shopper ruled red out.
```

## Calibration

`npx tsx scripts/score-calibrate.mts` reads `app/score/data/calibration.json`
— an array of `{ "query", "results": [{ "title", "productType"?, "vendor"?,
"priceMin"?, "priceMax"?, "currencyCode"?, "details"? }], "grades": [0–3 per
result] }` graded by a reader outside the grader's model family (the
co-manager chat in M6) — grades the same results, and prints exact
agreement and within-one agreement as percentages.

The M6 set is the first ten `en` searches of `public-set.json`, in file
order, that return six results on the seed fixture — "beige boots in stock"
returns none and is skipped — each with its top six results exactly as the
grader sees them (the same fields and `details` line as a scored run).

### Agreement — M6

The grades were posted by the co-manager chat (Fable 5.1) on 2026-10-01 and
filled into `calibration.json` by exact query match.
`npx tsx scripts/score-calibrate.mts` with the default grader (Flash-Lite,
thinking level low), 2026-10-01:

| Graded results | Exact agreement | Within one |
|----------------|-----------------|------------|
| 60 | **58.3 %** | **88.3 %** |

"same but under 300" has no earlier turn to refer to, so the reader graded
every result 1 (related only).

## Budget rules

- The set is 150 searches: 25 per language, 13 public and 12 hidden each.
- The hidden half runs six times in M6, on demand: the M5 baseline, after
  the find step, after the judge, after chips, the judge comparison, and
  before the old engine is deleted. Never on every push or PR.
- The public half runs only at the ship of an engine issue.
- One run is ≈ $0.05 on the M5 engine and ≈ $0.20 with the judge
  (estimates until measured).
- The hidden half never enters the repository.

## Baseline — the public half on the M5 engine

The public half run three times on the current engine (`origin/main` at
`5584566`, 2026-10-01, `npm run score:public`). Each language's mean is the
baseline Engine v2 must beat; its noise band — highest minus lowest of the
three runs — is how far a score moves with no change at all, so a gain
smaller than the band is not a gain. The numbers are in
`apps/shopify-app/app/score/data/score-baseline.json`.

| Language | Run 1 | Run 2 | Run 3 | Mean | Noise band |
|----------|-------|-------|-------|------|------------|
| en | 0.462 | 0.573 | 0.491 | 0.509 | 0.111 |
| he | 0.222 | 0.231 | 0.141 | 0.198 | 0.090 |
| ar | 0.440 | 0.449 | 0.432 | 0.440 | 0.017 |
| ru | 0.338 | 0.308 | 0.363 | 0.336 | 0.055 |
| fr | 0.269 | 0.265 | 0.265 | 0.266 | 0.004 |
| es | 0.385 | 0.325 | 0.355 | 0.355 | 0.060 |

No search failed in any run. `ar, ru, fr, es` are model-written (no log
searches in those languages).

## Measured cost

Read from each run's cost ledger (the run's cost line): one public run —
78 searches, 268 model calls including the grades — costs **$0.0595**
(runs: $0.0597, $0.0595, $0.0594). Hidden run 1 — 72 searches, 255 model
calls — costs **$0.0571**, read from the cost line in its workflow log.

## Public reference after AC-17 (main, 2026-10-03)

The public half on `main` at `7251eda` (YOY-147's facts rows and YOY-148
merged), Engine v2, `JUDGE_DEADLINE_MS=4000`, one pass, 78 searches, 0
failed, $0.1837 over 234 model calls
([posted on YOY-147](https://linear.app/0xyoyo/issue/YOY-147/m6-the-judge-one-call-per-page-verdict-order-deadline-and-reject-all#comment-cb087bde)).
This is the public comparison for every issue from YOY-149 on — not the
2026-10-02 "run-3 public" numbers, which predate AC-17. Judge a change by
the noise band of the M5 baseline above.

| | en | he | ar | ru | fr | es |
|---|---|---|---|---|---|---|
| Reference | 0.590 | 0.368 | 0.470 | 0.402 | 0.406 | 0.581 |

**Runner guards (2026-10-03).** Each search prints a progress line to
stderr as it finishes (`[n/78] <lang> ok|fail <stage>`, never the query);
a search plus its grade that takes over 90 s counts as failed
(`ScoreSearchTimeout`); grader, judge and extraction calls time out at
30 s; and after 5 consecutive failed searches the run stops, prints the
partial table with `aborted after 5 consecutive failures` and its spend
so far, and exits 1. The leak check reads all of these as strict lines.

**Noise band floor (2026-10-03).** Every language's band is
`max(M5 band, 0.03)`: ar's 0.017 and fr's 0.004 came from too few M5 runs
to be a real band for Engine v2. This applies to YOY-149's AC-17 and to
every later gate. Effective bands: en 0.111, he 0.090, ar 0.030, ru 0.055,
fr 0.030, es 0.060.

**Known catalog effects.** The seed catalog is priced in USD with a median
of $314; only 67 of its 465 products cost under $130.51 (400 ILS at the
2026-10-02 ECB rate, 3.065 per USD), and only 2 of its 99 dresses and none
of its 30 coats do (at 600 ILS, $195.76: 114 products, 5 dresses, no
coat). Six of the 13 public Hebrew searches state a shekel cap, so on this
catalog a Hebrew budget almost never has an in-budget relevant product, and
Hebrew scores
are sensitive to how the number tiers treat that case (YOY-149: tiers
sorted over the whole find set put cheap unrelated products on page 1 —
he 0.150 against a 0.368 reference — until the tiers were limited to the
find front). A run on a cheaper catalog will move Hebrew for that reason,
not because the engine changed.

## Results

Hidden-half scores per language. "Under 1 s" is the latency probe's share
of searches under 1,000 ms server-side against the deployment
(`scripts/latency-probe.mts --runs 5 --set all`, docs/LATENCY.md); the
score runner's own `under 1 s (local)` column times a local, in-process run
and is never the source of this table's value (YOY-157 AC-3). The runner's "no extraction" column (YOY-149 AC-4) is the
share of Engine v2 searches composed without the wish extraction — it
answered after the grace or failed — and "extraction cached" (AC-18) the
share the extraction cache answered with no call; both read "—" on the
old engine. `score-run.mts --passes 2` runs the set twice on one scratch
database, cold then warm, each pass with its own cost and `extract calls`
line.

| Run | Engine | en | he | ar | ru | fr | es | Under 1 s | Cost |
|-----|--------|----|----|----|----|----|----|-----------|------|
| 1 | M5 engine | 0.472 | 0.269 | 0.398 | 0.431 | 0.324 | 0.306 | classic 96 % · AI 34 % (EN 40 %, HE 28 %), 2026-10-01 | $0.0571 |
| 2 | Engine v2 find step (`ENGINE_V2=1`) | 0.597 | 0.278 | 0.569 | 0.569 | 0.574 | 0.384 | — (not deployed) | $0.0276 |
| 3 | Engine v2 find step + judge reading facts (`ENGINE_V2=1`, judge deadline 4,000 ms) | 0.644 | 0.366 | 0.491 | 0.676 | 0.569 | 0.431 | — (not deployed) | $0.1858 |
| 4 | Engine v2 + stated wishes (YOY-149) + refinement and second reading (YOY-150) (`ENGINE_V2=1`, judge deadline 4,000 ms) | 0.671 | 0.407 | 0.500 | 0.657 | 0.500 | 0.421 | — (not deployed) | $0.2128 |
| 5 (gemini judge) | Engine v2 as run 4, judge `JUDGE_PROVIDER=gemini` (YOY-152 branch) | 0.667 | 0.389 | 0.537 | 0.657 | 0.583 | 0.394 | — (not deployed) | $0.2054 |
| 5 (jev judge) | Engine v2 as run 4, judge `JUDGE_PROVIDER=jev` (YOY-152 branch) | 0.634 | 0.407 | 0.574 | 0.657 | 0.542 | 0.398 | — (not deployed) | $0.1053 |
| 6 control | Engine v2 on `main` at `9843486`, before the delete (YOY-155 AC-8 reference, judge `jev`) | 0.657 | 0.361 | 0.495 | 0.648 | 0.477 | 0.361 | — (not deployed) | $0.1038 |
| 6 | One engine after the delete (YOY-155 branch, judge `jev`) | 0.606 | 0.301 | 0.495 | 0.616 | 0.444 | 0.366 | — (not deployed) | $0.1043 |
| 1b — v1 re-check | M5 engine on `main` before its deletion (YOY-155 AC-1) | 0.560 | 0.287 | 0.375 | 0.463 | 0.407 | 0.236 | — | $0.0552 |
| 3 (first, superseded) | Engine v2 find step + judge reading the summary (`ENGINE_V2=1`, deadline 1,500 ms) | 0.597 | 0.292 | 0.556 | 0.648 | 0.542 | 0.403 | — (not deployed) | $0.0928 |
| 1 (invalid: 18 failures) | M5 engine | 0.306 | 0.032 | 0.181 | 0.083 | 0.167 | 0.106 | — | $0.0391 |

Run 1 — M5 engine: [run 36908656314](https://github.com/0xYoyo/unfiltered/actions/runs/36908656314),
2026-10-01, dispatched on the branch that added the failure lines
(`f94f374`; the engine is `main` at `c94880c` unchanged — the branch
touches only the score tooling and the workflow). Green, leak check clean
(72 checked), **0 failed searches**. Env settings present:
`GEMINI_API_KEY` only.

Run 2 — the find step: [run 37001240933](https://github.com/0xYoyo/unfiltered/actions/runs/37001240933),
2026-10-02, dispatched with `ref=YOY-145-find-step` and `engine=v2` on the
branch that adds the find step (YOY-145), so `ENGINE_V2=1`: every search is
the raw sentence's nearest products merged with keyword matches, no model
call before the grade. Green, leak check clean (72 checked), **0 failed
searches**. Env settings present: `GEMINI_API_KEY` only. Against run 1 every
language is up — en +0.125 (above the en noise band, 0.111), he +0.009, ar
+0.171, ru +0.138, fr +0.250, es +0.078. 144 model calls (72 query
embeddings, 72 grades) cost $0.0276.

Run 3 — the judge: [run 37009009491](https://github.com/0xYoyo/unfiltered/actions/runs/37009009491),
2026-10-02, dispatched with `ref=YOY-147-judge` (`878b7ee`) and `engine=v2`
on the branch that adds the judge (YOY-147): the find step, then one
Flash-Lite judge call per page inside the find set (deadline 1,500 ms).
Green, leak check clean (72 checked), **0 failed searches**. Env settings
present: `GEMINI_API_KEY` only. Against run 2: en 0.000 (equal), he +0.014,
ar −0.013, ru +0.079, fr −0.032, es +0.019. The gate — above run 2 in every
language with log queries (en, he) — is **not met**: en is equal. The
runner's own under-1-s column is 0 % in every language. 216 model calls
(72 query embeddings, 72 judge calls, 72 grades) cost $0.0928.

Run 3, repeated after the judge reads facts (YOY-147 AC-17, AC-18):
[run 37111633995](https://github.com/0xYoyo/unfiltered/actions/runs/37111633995),
2026-10-03, dispatched with `ref=729b096` and `engine=v2` on the judge
branch. Each candidate row now carries the card's `facts` and the five
vision attributes instead of the card summary (480 characters), the prompt
makes `exact` conditional on every stated wish being met by the row, and
the workflow sets `JUDGE_DEADLINE_MS=4000` so the score measures judgment,
not speed. Green, leak check clean (72 checked), **0 failed searches**. Env
settings present: `GEMINI_API_KEY` only. Against run 2: en **+0.047**, he
**+0.088**, ar −0.078, ru +0.107, fr −0.005, es +0.047. The gate — above
run 2 in every language with log queries (en, he) — is **met**. ar, fr are
model-written sets and outside the gate; ar's drop is noted for run 4. 216
model calls cost $0.1858, about double the first run 3: longer rows, and
with 4,000 ms no judge call is cut off. Before the re-run, the offline
probe (seed fixture, recorded query vector, live judge on page 1, 'long
sleeve midi dress') held **4 of 6** long-sleeve dresses in the judged top
six on 3 of 3 calls (find order alone: 1 of 6), up from 1–3 of 6 with the
summary rows; the 3 calls took 963–2,481 ms and cost $0.0075 from their
ledger rows ($2.50 per 1,000 page-1 judge calls of 24 rows).

Run 4 — wishes and refinement: [run 37143790016](https://github.com/0xYoyo/unfiltered/actions/runs/37143790016),
2026-10-03, dispatched with `ref=YOY-150-refinement-two-meanings` (`64d06b2`)
and `engine=v2`: `main` with YOY-149's stated wishes, then YOY-150's
judge and extraction prompts (version 3, both reading a previous sentence
when one is sent — the score set sends none) and the currency table at the
2026-10-02 ECB rates. Green, leak check clean (72 checked), **0 failed
searches**. Env settings present: `GEMINI_API_KEY` only. Against run 3,
with each band `max(M5 band, 0.03)`: en +0.027, he **+0.041** (he holds —
the YOY-149 directive), ar +0.009, ru −0.019 (band 0.055), **fr −0.069
(band 0.030: a miss)**, es −0.010 (band 0.060). Composed without the
extraction: 2 of 72 searches (ru 1, fr 1; en, he, ar, es 0). 288 model
calls (72 embeddings, 72 extractions, 72 judge calls, 72 grades) cost
$0.2128. The public half on the same branch the same day (`npm run
score:public -- --engine v2`, one pass, 0 failed, $0.2251): en 0.692,
he 0.278, ar 0.462, ru 0.419, fr 0.432, es 0.530 — fr +0.026 against the
public reference, so the hidden fr drop does not show on the public half.
Decision A (2026-10-03): en and he hold, so the gate is met; fr is tracked
and re-checked at hidden run 5 against run 3's 0.569 (see "Which languages
gate" under The hidden run).

Run 5 — the judge comparison (YOY-152 AC-7): dispatched twice on
2026-10-04 with `ref=YOY-152-jev-judge`, `engine=v2` and `--ref
YOY-152-jev-judge` (the `judge` input exists only on the branch), once per
judge: [run 37217854638](https://github.com/0xYoyo/unfiltered/actions/runs/37217854638)
(`judge=gemini`) and [run 37217856382](https://github.com/0xYoyo/unfiltered/actions/runs/37217856382)
(`judge=jev`). Both green, leak check clean (72 checked), **0 failed
searches**. Everything but the judge is the same: run 4's engine with the
Flash-Lite extraction and Flash-Lite grader. The Jev run's 1,944 model calls
are 72 embeddings, 72 extractions, 72 grades and 1,728 one-product judge
questions (24 per page). fr re-check (decision A): the Gemini judge's fr is
0.583, above run 3's 0.569 — the run-4 drop does not repeat; the Jev judge's
fr is 0.542, 0.027 under run 3, inside the 0.030 band.

Run 1b — v1 re-check (YOY-155 AC-1): [run 38060035565](https://github.com/0xYoyo/unfiltered/actions/runs/38060035565),
2026-10-10, dispatched on `main` at `9843486` (the commit tagged
`engine-v1-last`) with the old engine and `judge=jev` (unused by it).
Green, leak check clean (72 checked), **0 failed searches**, $0.0552 over
256 model calls. It is the check that the old engine still scored at its
M5 level before it was deleted: en 0.560 (+0.088 against run 1, band
0.111) and he 0.287 (+0.018, band 0.090) both sit inside their bands. The
latest v2 hidden score (run 5, Jev) is above run 1 in every language.

Run 6 — after the delete (YOY-155 AC-8): [run 38063360614](https://github.com/0xYoyo/unfiltered/actions/runs/38063360614),
2026-10-10, dispatched with `--ref YOY-155-delete-old-engine`,
`ref=YOY-155-delete-old-engine` (`ce3bb15`) and `judge=jev`. Green, leak
check clean (72 checked), **0 failed searches**, $0.1043 over 1,942 model
calls, 72 extraction calls. Against run 5 (Jev), with each band
`max(M5 band, 0.03)`: en −0.028 (band 0.111), **he −0.106 (band 0.090:
outside)**, ar −0.079, ru −0.041, fr −0.098, es −0.032.

Run 6 control — the reference (YOY-155 AC-8, re-based 2026-10-10):
[run 38065068705](https://github.com/0xYoyo/unfiltered/actions/runs/38065068705),
2026-10-10, dispatched on `main` at `9843486` (the commit the delete branch
started from) with `engine=v2` and `judge=jev`. Green, leak check clean (72
checked), **0 failed searches**, $0.1038 over 1,918 model calls. Run 6
against it: en −0.051 (band 0.111) and he −0.060 (band 0.090) — **both
inside the band, the gate is met**; ar 0.000, ru −0.032, fr −0.033,
es +0.005. Engine v2 on `main` already sat below run 5 before the delete
(he 0.361 against 0.407): the he drop against run 5 is tracked on YOY-171
AC-9, not on the delete.

### Judge comparison — Flash-Lite versus Jev (YOY-152, 2026-10-04)

Per-language score: hidden run 5 above. Median latency, cost and stability:
`npx tsx scripts/judge-compare.mts --judge gemini|jev` — the public half (78
searches) over the seed fixture on a scratch database, Engine v2, the
production orchestrator with the score run's 4,000 ms judge deadline, a
local run from Israel (not the deployment). Latency is the judge stage's
median over the 78 judged searches; cost is the judge's ledger rows
(operation `judge`) over those searches, per 1,000; stability is the first
five public searches run five times each, the answer cache emptied before
every run, as the share of page-1 products whose verdict was identical in
all five runs.

| | Flash-Lite (gemini) | Jev (jev) |
|---|---|---|
| en (gated) | **0.667** | 0.634 |
| he (gated) | 0.389 | **0.407** |
| ar | 0.537 | **0.574** |
| ru | 0.657 | 0.657 |
| fr | **0.583** | 0.542 |
| es | 0.394 | **0.398** |
| Judge median latency | 1,504 ms | **469 ms** |
| Cost per 1,000 uncached searches (judge only) | $2.266 | **$0.815** |
| Stability (5 searches × 5 runs, identical verdicts) | 75.8 % (91/120) | **95.8 %** (113/118) |
| Merchant-fact label possible ("in grey, not black") | **yes** | no |
| Second-reading chip possible (YOY-150's two meanings) | **yes** | no |
| Hidden run 5 total cost (72 searches, grades included) | $0.2054 | $0.1053 |

Against each language's band (`max(M5 band, 0.03)`): en −0.033 for Jev
(band 0.111) and he +0.018 for Jev (band 0.090) — the gated languages are
equal within noise. ar +0.037 for Jev and fr −0.041 for Jev each sit just
past the 0.030 band, in opposite directions; ru and es are equal. Flash-Lite's
median sits at the production deadline (1,500 ms), so about half its
page-1 calls would serve find order first and add labels late; Jev's
median is under a third of it. Jev's cost is ≈ 30,000 input tokens per page
(24 products × the questions and one row each, ≈ 716 tokens per product,
output free) — above the PRD's ≈ $0.30–0.40 estimate; Flash-Lite's is above
the $0.958 measured at YOY-147 because the rows are now facts rows (AC-17).

#### Decision — Jev is the default judge (founder, 2026-10-04)

The founder named **`jev`** on YOY-152 (AC-8, 2026-10-04). From YOY-152's
closing slice (AC-9) on, `JUDGE_PROVIDER` unset means `jev`
(`DEFAULT_JUDGE_PROVIDER` in `packages/engine/src/judge.ts`); `gemini` stays
selectable behind the same swap point, with its tests green. No automatic
failover between the two (NG-2). The reasons, from the table above:

1. **Quality is a tie.** The gated languages are equal inside their noise
   bands (en −0.033, band 0.111; he +0.018, band 0.090); ar and fr move
   just past 0.030 in opposite directions.
2. **Speed.** Jev's judge median is 469 ms against Flash-Lite's 1,504 ms at
   the 1,500 ms production deadline, so Jev's labels arrive with page 1.
3. **Stability and cost.** Jev gave identical verdicts 95.8 % of the time
   against 75.8 %, at $0.815 against $2.266 per 1,000 uncached searches
   (judge only, measured 2026-10-04).

Accepted with it: under Jev the merchant-fact label ("in grey, not black")
and the two-meanings chip are dormant — Jev answers `close-match` where
Flash-Lite writes `fact-differs`, and writes no second reading. The code
keeps both for the Flash-Lite judge; the follow-up is YOY-158.

`score.yml`'s `judge` input defaulted to `gemini` at the time (a sensitive
path, unchanged by this slice); it defaults to `jev` since YOY-157 AC-19.

### Jev's merchant-fact label from closed-list picks (YOY-158, 2026-10-10)

**Measured first (AC-1, $0).** `npx tsx scripts/evidence.mts facts
2026-10-04T19:16:31Z` — the deployment's `JudgeVerdict` rows since Engine v2
became the default, every store, each product once per search: the `fact`
missed-wish flag is up on **75.2 %** of judged products (7,433 of 9,884,
419 judged searches; he 92.1 %, Latin-script 68.8 % — the log keeps no
language, so en, fr and es share one bucket; no ar or ru searches). Far over
the 5 % stop line, so the label was built. The flag barely discriminates under
Jev: it is up on 2,515 of 2,541 close verdicts, but also on 1,681 of 4,023
exact ones. So the label rests on the two picks below, not on the flag.

**Built (AC-2, AC-3).** Per product, in the same Jev request as the verdict,
two pick-one questions over closed lists, each with `none`:
- which of the product's option names the asked fact concerns;
- which word or adjacent word pair of the sentence names the asked value.

When the verdict is labelled, the flag is up and both picks land, the label
is `fact-differs`: the picked option's values from the variants table, and
the shopper's own words. Otherwise it is `close-match` as before (details:
`docs/ARCHITECTURE.md`, "Jev's fact picks"). Labels never move a card, so
the served order is unchanged and no hidden run was spent.

**Cost re-measured (AC-5).** `npx tsx scripts/judge-compare.mts --judge jev`
on the branch, same method as the table above (public half, 78 searches,
seed fixture, local run from Israel):

| | Jev at YOY-152 (2026-10-04) | Jev with fact picks (2026-10-10) |
|---|---|---|
| Cost per 1,000 uncached searches (judge only) | $0.815 | **$1.141** |
| Judge median latency | 469 ms | 557 ms |
| Stability (5 searches × 5 runs, identical verdicts) | 95.8 % (113/118) | 95.0 % (113/119) |

The increase is **+$0.326 per 1,000 uncached searches (+40 %)**: Jev bills
input only, and each product's request now carries the two lists. The
sentence's words and pairs, and the product's option names, each come with a
one-line criterion. The run's judge spend was $0.088 over 1,780 calls; one
of 78 searches timed out into find order (`judge-error`). Still under half
of Flash-Lite's $2.266.

**Second reading — design note, not built (AC-6).** Could a pick-one over the
page's distinct product types stand in for the second-reading phrase that Jev
cannot write ("Bridal gowns instead?")? The chip would show the picked type.

- **On the seed catalog, no.** It has 21 product types, all of the form
  `women's dresses` or `men's coats & jackets`. PRD §3's own example, "dress
  for a wedding" against "wedding dress", sits inside one type: the
  catalog's one gown ("Rhesus Gown") is typed `women's dresses`, like every
  guest dress. A type pick has no choice that names the other meaning.
- **Where it would work:** readings that cross types, such as gender or
  garment. "shirt" pulls `men's button-ups` (11 seed titles), `women's
  button-ups` (9), `women's dresses` (5, shirt dresses) and `men's t-shirts`
  (4); a type pick could offer "Men's button-ups instead?". That is a
  department switch, not the two-meanings chip the PRD describes.
- **What it would cost:** about one more choice question per product, the
  order of one fact pick.

Open for the founder at the M7 spec session: build the type pick for the
cross-type case, or look for a closed list that does separate meanings
within a type (the page's vision attributes, or the distinguishing words
of its titles).

### The public half at the Engine v2 default (YOY-153 AC-8, 2026-10-04)

At the ship of YOY-153 (Engine v2 on by default), on its branch, `npm run
score:public -- --engine v2` with `JUDGE_PROVIDER=jev` — the production
default judge — one pass, 0 failed, 2,106 model calls (78 embeddings, 78
extractions, 78 grades, 1,872 one-product Jev questions), $0.1135:

| | en | he | ar | ru | fr | es |
|---|---|---|---|---|---|---|
| YOY-153 ship (v2, Jev) | **0.748** | **0.248** | 0.449 | 0.427 | 0.462 | 0.573 |
| Last recorded public (run-4 branch, v2, Flash-Lite judge) | 0.692 | 0.278 | 0.462 | 0.419 | 0.432 | 0.530 |
| Difference | +0.056 | −0.030 | −0.013 | +0.008 | +0.030 | +0.043 |
| Band (`max(M5 band, 0.03)`) | 0.111 | 0.090 | 0.030 | 0.055 | 0.030 | 0.060 |

The gate (en and he not below the last public numbers by more than their
bands) is **met**: en +0.056, he −0.030 inside its 0.090 band. The
model-written languages are tracked, not gated (decision of 2026-10-03):
ar −0.013 is inside its band, the rest are up.

An earlier pass the same day ran with the Flash-Lite judge by mistake: the
runner loads the local `.env`, whose `JUDGE_PROVIDER` named `gemini`, so
that pass measured the fallback, not the default (312 model calls, one judge
call per search; en 0.675, he 0.363, ar 0.449, ru 0.436, fr 0.423, es 0.526;
$0.2326). It is superseded by the Jev pass above and recorded only so the
spend is accounted for. Pass `JUDGE_PROVIDER` explicitly on the command line
when a local `.env` sets it — the environment wins over the file.

Speed and judge cost (YOY-147 AC-15), measured locally on the public half
(78 searches over the seed fixture, `ENGINE_V2=1`, 2026-10-02; a local run
from Israel, not the deployment): search latency median **1,510 ms**,
**0 %** under 1 s (the find step alone: 100 % under 1 s); judge stage median
1,136 ms; 20 of 78 judge calls passed the 1,500 ms deadline and served find
order. Judge ledger rows: 78 calls, mean 1,841 input and 162 output tokens,
**$0.958 per 1,000 uncached searches**. These were measured with the
summary rows (320 characters), before AC-17; the facts rows are longer, and
the offline probe's ledger puts a 24-row page-1 judge call at $0.0025 ($2.50
per 1,000). The speed gate is the latency probe's, on the deployment, at
run 4.

Run 1 (invalid): [run 36905483201](https://github.com/0xYoyo/unfiltered/actions/runs/36905483201)
at `bdcc41e`, 18 of 72 searches failed and scored 0 (en 2, he 2, ar 3,
ru 2, fr 5, es 4 of 12). It predates the failure lines, so its causes were
not recorded; the re-run under the same environment had none.
