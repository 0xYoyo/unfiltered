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
   share of searches under 1 s, and failed searches. Query text never
   reaches the output.

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
`GEMINI_API_KEY`, and captures every byte the runner writes.
`score-leak-check.mts` then fails the job if any hidden query appears in
that output as whole words (score-table lines excepted: they hold only
language codes and numbers), printing a count and never the query. Only a
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
result] }` hand-graded by a person — grades the same results, and prints exact
agreement and within-one agreement as percentages.

## Budget rules

- The set is 150 searches: 25 per language, 13 public and 12 hidden each.
- The hidden half runs six times in M6, on demand: the M5 baseline, after
  the find step, after the judge, after chips, the judge comparison, and
  before the old engine is deleted. Never on every push or PR.
- The public half runs only at the ship of an engine issue.
- One run is ≈ $0.05 on the M5 engine and ≈ $0.20 with the judge
  (estimates until measured).
- The hidden half never enters the repository.

## Results

| Run | Engine | en | he | ar | ru | fr | es | Under 1 s | Cost |
|-----|--------|----|----|----|----|----|----|-----------|------|
