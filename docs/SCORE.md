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

The workflow runs on `workflow_dispatch` only — never on push or pull
request, never inside `ci.yml`. It checks out `ref`, writes the secret to
the runner's temp directory, runs `score-run.mts --hidden-set` with
`GEMINI_API_KEY`, and captures every byte the runner writes. Before the
run it prints the names — never the values — of the `GEMINI_*` and
`INTENT_*` variables it has. `score-leak-check.mts` then fails the job if
any hidden query appears in that output as whole words (the score table,
the cost line and the failure lines excepted: each is matched by its exact
shape and holds only language codes, numbers, a stage or a class name),
printing a count and never the query.

A run with more than 2 failed searches of 72 is not a baseline: its cause
is fixed first and the run is dispatched again. Only a
clean output is printed to the log and written to the job summary.

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

## Results

Hidden-half scores per language. "Under 1 s" is the latency probe's share
of searches under 1,000 ms server-side against the deployment
(`scripts/latency-probe.mts --runs 5 --set all`, docs/LATENCY.md); the
score runner's own under-1-s column times a local run and is not the
deployment's. The runner's "no extraction" column (YOY-149 AC-4) is the
share of Engine v2 searches composed without the wish extraction — it
answered after the grace or failed — and "—" on the old engine.

| Run | Engine | en | he | ar | ru | fr | es | Under 1 s | Cost |
|-----|--------|----|----|----|----|----|----|-----------|------|
| 1 | M5 engine | 0.472 | 0.269 | 0.398 | 0.431 | 0.324 | 0.306 | classic 96 % · AI 34 % (EN 40 %, HE 28 %), 2026-10-01 | $0.0571 |
| 2 | Engine v2 find step (`ENGINE_V2=1`) | 0.597 | 0.278 | 0.569 | 0.569 | 0.574 | 0.384 | — (not deployed) | $0.0276 |
| 3 | Engine v2 find step + judge reading facts (`ENGINE_V2=1`, judge deadline 4,000 ms) | 0.644 | 0.366 | 0.491 | 0.676 | 0.569 | 0.431 | — (not deployed) | $0.1858 |
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
