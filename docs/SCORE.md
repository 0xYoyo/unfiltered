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
   are never taken from the log. The Hebrew log lives under the seed store
   (`unfiltered-dev.myshopify.com`), so `PLAYGROUND_SEED_STORE_KEY` must be
   given on the command line when the local `.env` lacks it.
2. **Fill** — the simple set fills each of `en, ar, ru, fr, es` to 25
   (YOY-175 AC-1; 25 everywhere before); `he` takes every shopper-shaped log
   search, up to 75, and never filler, so a short log gives a smaller `he`
   (67 on 2026-10-14) and the build prints `set simple he <n>`. Log
   queries come first, newest first, then Flash-Lite filler shaped 60 % one
   to three words, 30 % medium, 10 % long or vague. Each entry carries
   `source: "log" | "model"` and `set: "simple"`; a language with no log
   entry is marked `modelWritten: true`. The hard set is described under
   "The grown set and the hard set" below.
3. **Split** — each set's languages are split public `ceil(n/2)` / hidden
   `floor(n/2)` by a seeded shuffle (seed 140): 25 → 13 / 12, 75 → 38 / 37,
   30 → 15 / 15. The same set always splits the same way. A language kept
   from an earlier build keeps its old halves exactly, and the shuffle
   splits only the searches added to it (see "The grown set and the hard
   set" below). Both public halves
   are written to `apps/shopify-app/app/score/data/public-set.json`. Both
   hidden halves are written to one base64 file at `--hidden-out`, each
   entry carrying its `set`; the builder refuses, writing nothing, when that
   path is inside the repository or the encoded file is 48 KB or larger.
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
   carry the query. A hidden run then prints one line per search,
   `grade <lang> <index> <score>` (see "Per-search lines" below). Query text
   never reaches a hidden run's output.

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

One choice input picks the judge: `judge` (`gemini`, `jev` or `none`, sets
`JUDGE_PROVIDER`; YOY-152, YOY-172). It defaults to what production serves (YOY-157
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
the cost line, the failure lines and the `grade` lines excepted: each is
matched by its exact shape and holds only language codes, numbers, a stage
or a class name),
printing a count and never the query. It exits with the run's own status.

**A score run waits for the extraction (YOY-171 AC-17, 2026-10-11).** The
workflow sets `EXTRACTION_GRACE_MS=4000` next to `JUDGE_DEADLINE_MS=4000`
and echoes it with the other settings: a hidden run measures judgment, not
the wish extraction's latency, so a slow Flash-Lite call never scores a
search composed without wishes (no price tier, no size, no exclusion).
Production keeps its 800 ms grace; the extraction's speed is the latency
probe's (docs/LATENCY.md). Before this rule a run's "no extraction" share
varied with the day's Flash-Lite latency — 0 % on the AC-16 bisect runs,
he 17 % on its fix run — which alone can move he by the width of its band.
Under the table the runner prints one `no-extraction <language> N%` line
per language, and every Results row from AC-17 on carries that share.

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

## Per-search lines, the no-judge run and the control loop (YOY-172)

**Per-search lines.** After the table and the `no-extraction` lines a
hidden run prints one line per scored search:

```
grade <lang> <index> <score>
grade <lang> <index> failed
```

`<index>` is the search's 0-based position in the decoded hidden file and
`<score>` its score with three decimals. The rule: **a hidden line carries
the index only, never the query** — the leak check admits exactly
`^grade (en|he|ar|ru|fr|es) \d+ (\d\.\d{3}|failed)$` and nothing else new.
Two hidden runs compared index by index show which searches fell, without
either output naming one. **A public line may carry the query:**
`npm run score:public -- --per-search` prints
`grade <lang> <index> <score> <query>` per public search after the table,
each followed by one `title <lang> <index> <position> <title>` line per
graded result (position 1–6 in served order; YOY-173), so two public runs
can be compared page by page. A hidden run never prints a title line.
`--per-search` with `--hidden-set` is refused (exit 1, before any call).

**`judge=none`.** `JUDGE_PROVIDER=none` builds the engine with no judge:
every page is the composed find order — extraction, exclusions, stock
filter, price and size tiers — served with route reason `find-only`, with
no judge call, no OpenRouter key and no pending labels. Chips and the
code-computed labels (price, size, colour) are still there. It measures
the engine without its judge, so `jev` minus `none` on the same SHA, run
on the same day, is the judge's own contribution. `none` is a choice only:
an unset `JUDGE_PROVIDER` still means `jev`, everywhere.

**The control loop.** A control is the same full SHA dispatched N times:

```bash
SHA=$(git rev-parse origin/main)   # the full 40-character SHA
for i in 1 2 3; do gh workflow run score.yml -f ref=$SHA -f judge=jev; done
```

A short SHA fails at checkout: `actions/checkout` fetches `ref` by name,
and an abbreviated SHA names nothing. List the N runs, newest first, then
read each one's output once it is green:

```bash
gh run list --workflow=score.yml --limit 3
gh run view <run id> --log | grep -E '^.*\s(language|en|he|ar|ru|fr|es|cost|no-extraction|grade|failed) '
```

The job summary of each run (`gh run view <run id>`, or the run's page)
names the scored ref in its heading and holds the clean output.

**The three-run reference (founder, 2026-10-14).** The reference for a
gate is three runs of the branch's base on the same day. Each language's
band is `max(spread of the three, the language's M5 band, 0.03)`, the
spread being the highest of the three minus the lowest. A single control
is not a reference.

## Find recall

`scripts/score-recall.mts` (YOY-174; code in `app/score/recall.server.ts`)
measures how much of a public search's relevant set the find step reaches.
That separates a loss in find from a loss in the judge.

1. **Truth.** Each of the 13 public `en` and 13 public `he` searches is
   graded against every product of the seed fixture, 48 products per call,
   with the score grader's rubric and prompt (ledger operation
   `score-recall`, temperature 0). A product graded 2 or more is relevant.
   The truth is written to `app/score/data/recall-truth.json` and committed,
   so a re-run makes no grading call. With the file present the script never
   grades unless `--rebuild-truth` is given.
   **The truth was graded without descriptions:** each product shows the
   grader's view minus its 300-character description excerpt, a decision
   taken 2026-10-14 to fit the build under its ledger cap, $0.50. If the
   ledger passes the cap, the build stops and writes the searches graded so
   far as a truth marked partial.
2. **Recall.** The find step runs alone (no extraction, no judge) at the
   production find-set size, `FIND_SET_SIZE` (150 by default). It embeds each
   query live, as production does, so a re-run's cost line shows 26
   embedding calls and rounds to $0.0000. Per search, the command prints the
   relevant count, how many are inside the find set, the recall share, and
   how many are inside the first 24 of the find order. Per language, it
   prints the mean recall and the count of searches under 0.5. A search with
   nothing relevant is left out of the mean and counted on its own.
   Counting is by family, one family per card: the find step shows one
   colourway per family, so a relevant colourway counts as reached when its
   family's card is reached.

`--synthetic` runs the command offline against the synthetic tenant, with a
grader that marks a title holding a query word as relevant. Without
`--truth <file>` it writes nothing.

### Find recall — the public en and he searches (2026-10-14; current set, built 2026-10-01)

The truth was built on 2026-10-14 (12:55–13:00 UTC) on branch
`YOY-174-find-recall` at `8baf481` (base `main` `96e8a17`), against
the committed seed fixture (465 products, 413 families). All 26 searches
were graded in 260 calls, and none was partial. **Measured cost $0.4169**,
against the offline estimate of ≈ $0.403 and the $0.50 ledger cap. The
truth was graded without descriptions. Recall was measured at the default
find-set size (150). A re-run reading the committed truth makes no grading
call: `cost $0.0000 over 26 model calls`, the 26 query embeddings.

Relevant, in-find-set and first-24 counts are families. "In first 24" counts
the relevant families inside the first 24 of the find order, before any
judge.

| # | Lang | Search | Relevant | In find set | Recall | In first 24 |
|---|---|---|---|---|---|---|
| 0 | en | long sleeve midi dress in black | 24 | 24 | 1.000 | 13 |
| 1 | en | beige boots in stock | 4 | 4 | 1.000 | 4 |
| 2 | en | midi dress with long sleeves under 300 | 25 | 25 | 1.000 | 14 |
| 3 | en | black dress | 40 | 40 | 1.000 | 23 |
| 4 | en | blue dress under 500 | 16 | 16 | 1.000 | 12 |
| 5 | en | a midi dress with long sleeves | 26 | 26 | 1.000 | 15 |
| 6 | en | dress for a wedding | 89 | 77 | 0.865 | 22 |
| 7 | en | t-shirt | 30 | 29 | 0.967 | 18 |
| 8 | en | same but under 300 | 184 | 71 | 0.386 | 12 |
| 9 | en | summer dress, not black under 400 dollars | 39 | 39 | 1.000 | 8 |
| 10 | en | Mesh Over Dress | 7 | 7 | 1.000 | 4 |
| 11 | en | floral summer dress under 50, not black | 0 | 0 | — | 0 |
| 12 | en | long sleeve midi dress | 25 | 25 | 1.000 | 13 |
| 13 | he | גינס | 1 | 1 | 1.000 | 1 |
| 14 | he | מעיל אוברסייז שנופל יפה פחות מ1000 דולר אבל | 31 | 31 | 1.000 | 17 |
| 15 | he | שמלה לחתונה עד 400 שקל שקל לא דולר | 7 | 7 | 1.000 | 3 |
| 16 | he | נעלי עקב שחורות לנשים | 1 | 1 | 1.000 | 0 |
| 17 | he | אותו דבר אבל עד 400 | 77 | 37 | 0.481 | 8 |
| 18 | he | מעיל אוברסייז שנופל יפה פחות מ100 דולר אבל | 1 | 1 | 1.000 | 1 |
| 19 | he | ומתחת 600 | 153 | 61 | 0.399 | 11 |
| 20 | he | שמלה לחתונה עד 400 שקל | 21 | 21 | 1.000 | 6 |
| 21 | he | מגפיים חומים במלאי | 8 | 8 | 1.000 | 7 |
| 22 | he | עזוב תביא לי בכלל מכנסיים ירוקים | 6 | 6 | 1.000 | 2 |
| 23 | he | שמלת מידי עם שרוולים ארוכים | 45 | 45 | 1.000 | 14 |
| 24 | he | חולצת טריקו טריקו עם הדפסה | 6 | 6 | 1.000 | 4 |
| 25 | he | סנדל עקב שחור | 4 | 4 | 1.000 | 3 |

| | Mean recall | Searches scored | Under 0.5 | Nothing relevant |
|---|---|---|---|---|
| en | 0.935 | 12 of 13 | 1 | 1 |
| he | 0.914 | 13 of 13 | 2 | 0 |

The three searches under 0.5 are follow-up phrasings: en 8 "same but under
300", he 17 "אותו דבר אבל עד 400" and he 19 "ומתחת 600". Graded alone,
without the search they follow, almost anything under the price is
relevant, so 184, 77 and 153 families are. The find set holds 150
candidates, so those three cannot reach 1.0. en 11 "floral summer dress
under 50, not black" has nothing relevant on the seed catalog.

**en:** find reaches 0.935 of the relevant families, and every search but
the one follow-up reaches at least 0.865. Against a public en score of
0.705 and a hidden C4 mean of 0.620, the larger loss on this set is the
judge, meaning the order and the page served after find, not find itself.

**he:** find reaches 0.914, and every search that is not a follow-up reaches
1.0. Against a public he score of 0.214 and a hidden C4 mean of 0.238, the
larger loss on this set is the judge, not find. The relevant families are in
the find set, and the page served does not show them. he 16 (black heels for
women) is the clearest case: its one relevant family is inside the find set
but not in the first 24.

## The grown set and the hard set (YOY-175)

**Hebrew at 75.** Twelve hidden Hebrew searches let same-code runs differ
by up to 0.06, so Hebrew's 0.090 band was the floor of what the set could
see. The simple set now holds 75 Hebrew searches: 38 public and 37 hidden.

`--keep-before <ISO time>` keeps the old set's en and he searches. It
rebuilds each language's newest 25 shopper-shaped log searches from before
that instant, splits them by the old 13 / 12 shuffle, and keeps the
language only when the old public half (`--previous-public`, the committed
file by default) comes back exactly: same entries, same order. Then the
hidden 12 are the rest of the same 25, so the old set is kept whole without
the hidden file ever being read. A kept Hebrew language adds every later
log search, up to 75 in all, and no filler: 67 on 2026-10-14, split 34 / 33. A kept language keeps its old halves
exactly (YOY-175 AC-1, amended): the old 13 public stay public and the old
12 hidden stay hidden, in their old order, and the seeded shuffle splits
only the added searches, so he's 50 go 25 / 25 and he is 38 / 37 in all. A
search that was public is already in the repository, so it never enters a
hidden half. The same holds for every added search. The added log
searches are drawn into halves rather than shuffled: the hidden added are
the newest whose normalized text (case-folded, whitespace collapsed)
appears in no tracked file (`git ls-files`), up to the hidden count (he:
25); the public added are the newest remaining log searches, up to the
public count (he: 25). Filler is used only when the log runs out; a known
filler search is pinned public, or written again once the public share is
full. The build prints one
`pinned <set> <lang> <n>` line per set and language: counts, never the
text. A synthetic build checks against no repository text, because its log
and filler live in a tracked file. A language that does not reproduce is
built fresh. The build prints `reproduce <lang> reproduced|not reproduced`
and, per set and language, its public, hidden, log and filler counts.

**The hard set.** It has 30 model-written searches per language in `en`
and `he`. Each is asked for one kind at a time, the five kinds in equal
parts (6 each): `reference` (a person or a look), `lookalike` (a brand the
catalog does not carry), `occasion`, `vague` and `two-wishes` (one sentence
with two wishes). Each entry carries `set: "hard"` and its `kind`, and the
hard set shares no search with the simple set. It splits 15 / 15. The
rubric's last paragraph (below) is what makes it measurable.

**One table per set.** The runner scores each set on its own and prints
its table after a strict `set simple` or `set hard` line, which the leak
check admits. `--set-name simple|hard|all` chooses (default `all`). The
per-search `grade` lines count indices within their own set. An entry with
no `set` field, from a set built before YOY-175, is a simple entry.

**Not comparable.** Every table above this section and under "Results"
predates YOY-175 and holds the **current set, built 2026-10-01**: 25
searches per language, 12 hidden each. The M7 tables (Hebrew 75, the hard
set, the M7 reference bands) are on a different set and are not comparable
to them. A gate names the set its reference was taken on.

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

A brand or person reference is graded on the look it names, not on the brand: "shoes that look like Prada" grades 3 for a loafer with the same shape and finish and 0 for a sandal. A person reference is graded on the garment the sentence describes when it describes one, and on the category alone when it does not.
```

The last paragraph was added for the hard set (YOY-175 AC-3). Without it, a
look-alike search such as "like Prada" grades 0 everywhere and the hard set
measures nothing. It changes nothing for a search that names no brand or
person.

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

## Baseline — the public half on the M5 engine (current set, built 2026-10-01)

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

## Public reference after AC-17 (main, 2026-10-03; current set, built 2026-10-01)

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

## Results — current set, built 2026-10-01

Every table in this section is on the current set, built 2026-10-01 (25
searches per language), and is not comparable to the M7 tables (see "The
grown set and the hard set"). Hidden-half scores per language. "Under 1 s" is the latency probe's share
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
| control C2 | `main` at `7a4d716` after the ten YOY-171 merges of 2026-10-10 (judge `jev`); the AC-5 reference from here on | 0.644 | 0.264 | 0.523 | 0.593 | 0.500 | 0.375 | — (not deployed) | $0.1295 |
| AC-16 fix' | AC-4 as amended, on `main` with AC-17 and AC-18 (`86a5e22`, judge `jev`, extraction grace 4,000 ms); no-extraction 0 % in every language | 0.606 | 0.199 | 0.495 | 0.616 | 0.454 | 0.329 | — (not deployed) | $0.1330 |
| control C3 | `main` at `505ccef` (judge `jev`, extraction grace 4,000 ms); the AC-16 reference; no-extraction 0 % in every language | 0.644 | 0.218 | 0.481 | 0.634 | 0.509 | 0.370 | — (not deployed) | $0.1337 |
| AC-16 fix (stop: he outside its band) | AC-4 as amended: far-over-budget cheapest first after the judge, within the page's groups (`45a9e50`, judge `jev`) | 0.630 | 0.245 | 0.481 | 0.662 | 0.500 | 0.338 | — (not deployed) | $0.1334 |
| 9 (stop: he outside its band) | AC-5 fallback: colour orders nothing — extraction, label, chip only (`b33298b`, judge `jev`) | 0.630 | 0.255 | 0.532 | 0.653 | 0.454 | 0.347 | — (not deployed) | $0.1341 |
| 8 (stop: he outside its band) | AC-5 as amended: colour ordered after the judge, within the page's groups (`7ecb1e4`, judge `jev`) | 0.653 | 0.218 | 0.500 | 0.620 | 0.495 | 0.370 | — (not deployed) | $0.1336 |
| 7 (stop: he outside its band) | Engine v2 + colour as a code-checked wish (YOY-171 AC-5 branch `662ebd8`, judge `jev`) | 0.625 | 0.259 | 0.472 | 0.676 | 0.477 | 0.347 | — (not deployed) | $0.1337 |
| 5 replay | Run 5's code re-run on 2026-10-10 (`5c5adfe`, `engine=v2`, judge `jev`; YOY-171 AC-9) | 0.569 | 0.370 | 0.569 | 0.639 | 0.523 | 0.431 | — (not deployed) | $0.1055 |
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

Run 5 replay — the he drop explained (YOY-171 AC-9):
[run 38071540704](https://github.com/0xYoyo/unfiltered/actions/runs/38071540704),
2026-10-10. Run 5's own commit `5c5adfe` was scored again with that
commit's workflow: a throwaway branch at `5c5adfe` was dispatched with
`--ref`, because today's workflow has no `engine` input and the runner at
`5c5adfe` needs `ENGINE_V2`. Green, leak check clean (72 checked), **0
failed searches**, $0.1055 over 1,944 model calls. Two earlier dispatches
failed before any model call, at $0: a short SHA the checkout cannot
fetch, and today's workflow without `ENGINE_V2`.

| he | Run 5 code (`5c5adfe`) | Run-6-era code (`main` `9843486`) |
|---|---|---|
| 2026-10-04 | 0.407 (run 5) | — |
| 2026-10-10 | **0.370** (replay) | **0.361** (run 6 control) |

The same code moves 0.037 between two days. The two code states re-run on
the same day are **0.009 apart, inside 0.05**. Run 6 itself (0.301) sits
0.060 below its control, on v2 code that the delete did not touch. So the
he drop from run 5 to run 6 is **judge variance**, not a v2 change, and the
grader rule stays as it is. By the AC's own rule, the numbers close it.
The other languages agree. Between the replay and the control: en −0.088,
ar −0.074, ru +0.009, fr −0.046, es −0.070. The replay's en moved −0.065
against its own first run, so en's day-to-day spread is as wide as the
gap.

No per-search list is posted. The hidden run prints per-language
aggregates only (the runner's design: the builder never sees a hidden query
or its grades, and the leak check guards the output). So the ten Hebrew
searches that lost the most cannot be read from any artifact. Producing
them would need a runner change under `app/score/` (a sensitive path)
printing per-entry grades by index. The variance result made that
unnecessary.

Run 7 — colour as a code-checked wish (YOY-171 AC-5):
[run 38087016294](https://github.com/0xYoyo/unfiltered/actions/runs/38087016294),
2026-10-10, dispatched with `ref=662ebd8` (the AC-5 branch) and
`judge=jev`. Green, leak check clean (72 checked), **0 failed searches**,
$0.1337 over 1,944 model calls, 72 extraction calls. Against the run 6
control (the reference YOY-171 names), with each band `max(M5 band, 0.03)`:
en −0.032 (band 0.111, inside), **he −0.102 (band 0.090: outside)**,
ar −0.023, ru +0.028, fr 0.000, es −0.014. By YOY-171's stop condition
the slice is **not merged** and the issue goes to `blocked`. One run cannot
tell a colour effect from judge variance (the same code moved 0.037 between
two days, and run 6 sat 0.060 under its control), but he is now 0.102 under
and outside the band, so the decision is the founder's.

Run 8 — colour after the judge only (YOY-171 AC-5 as amended 2026-10-11):
[run 38089165550](https://github.com/0xYoyo/unfiltered/actions/runs/38089165550),
2026-10-10, dispatched with `ref=7ecb1e4` and `judge=jev`. The colour no
longer moved anything before the judge. After it, a stable sort put the
asked colour first within each group of the judged page. Green, leak check
clean (72 checked), **0 failed searches**, $0.1336 over 1,944 model calls.
Against the run 6 control: en −0.004 (inside), **he −0.143 (band 0.090:
outside)**, ar +0.005, ru −0.028, fr +0.018, es +0.009. By the AC's
fallback, the in-page colour order is dropped. The extraction, the
`color-differs` label and the chip stay, and run 9 is dispatched.

Run 9 — the fallback: colour orders nothing (YOY-171 AC-5):
[run 38089808730](https://github.com/0xYoyo/unfiltered/actions/runs/38089808730),
2026-10-10, dispatched with `ref=b33298b` and `judge=jev`. The colour
changes no order anywhere; the branch differs from `main` only by the
extraction's colour fields (prompt version 8), the `color-differs` label
and the chip. Green, leak check clean (72 checked), **0 failed searches**,
$0.1341 over 1,943 model calls. Against the run 6 control: en −0.027
(inside), **he −0.106 (band 0.090: outside)**, ar +0.037, ru +0.005,
fr −0.023, es −0.014. By the AC, the slice is **not merged** and YOY-171
goes to `blocked`. Runs 7–9 put he at 0.259, 0.218 and 0.255 across three
different colour behaviours, the last of which moves nothing. Either the
extraction prompt change itself costs he, or the 0.361 control sits high
(run 6 on the same code scored 0.301).

Control C2 — the re-base (YOY-171 AC-5, co-manager decision 2026-10-11):
[run 38090753274](https://github.com/0xYoyo/unfiltered/actions/runs/38090753274),
2026-10-10, dispatched on `main` at `7a4d716` with `judge=jev`. Green, leak
check clean (72 checked), **0 failed searches**, $0.1295 over 1,944 model
calls. **he 0.264**, 0.097 under the run 6 control, on `main` without the colour
work. By the decision's Case B, the colour work is not what moved he; one of
the day's merges did. C2 becomes AC-5's reference. Against it, run 8 is en
+0.009 and he −0.046, both inside the band, so the run-8 version (the colour
first within its group after the judge) is the one that ships. Run 9 is en
−0.014 and he −0.009. Finding the merge that moved he is YOY-171 AC-16.

AC-16 — the bisect of 2026-10-10's merges (YOY-171 AC-16): four hidden
runs on `main` commits, judge `jev`, all green, leak check clean (72
checked), 0 failed searches, $0.5166 together. "Merged up to" is the last
YOY-171 PR on `main` at the scored commit.

| Run | `main` at | Merged up to | en | he | ar | ru | fr | es | Cost |
|-----|-----------|--------------|----|----|----|----|----|----|------|
| 6 control | `9843486` | before #221 | 0.657 | 0.361 | 0.495 | 0.648 | 0.477 | 0.361 | $0.1038 |
| B2 ([run](https://github.com/0xYoyo/unfiltered/actions/runs/38092455416)) | `acc62fb` | #224 (AC-1) | 0.597 | 0.329 | 0.523 | 0.630 | 0.477 | 0.366 | $0.1286 |
| B3 ([run](https://github.com/0xYoyo/unfiltered/actions/runs/38092929326)) | `85c48dd` | #225 (AC-2) | 0.662 | **0.361** | 0.519 | 0.597 | 0.468 | 0.394 | $0.1295 |
| B4 ([run](https://github.com/0xYoyo/unfiltered/actions/runs/38093443735)) | `0dc4618` | **#226 (AC-3, AC-4)** | 0.630 | **0.250** | 0.495 | 0.620 | 0.463 | 0.398 | $0.1289 |
| B1 ([run](https://github.com/0xYoyo/unfiltered/actions/runs/38092011490)) | `d8e48ba` | #227 (AC-6) | 0.648 | 0.259 | 0.500 | 0.616 | 0.500 | 0.361 | $0.1296 |
| control C2 | `7a4d716` | #233 (AC-15) | 0.644 | 0.264 | 0.523 | 0.593 | 0.500 | 0.375 | $0.1295 |

Every `main` up to #225 scores he 0.33–0.36; from #226 on, 0.25–0.26, a
−0.111 step between B3 and B4 (over twice the 0.05 variance line). en
stays inside its band throughout. #226's only ranking change was AC-4:
`composeWishes` re-sorted the far-over-budget products cheapest first
across the whole 48-product find front before the pages were cut, so a
cheap, low-relevance product could take a page-1 slot before the judge saw
the page — the mechanism of colour run 7. AC-3 is display only. The fix
(AC-4 as amended 2026-10-11): the far tier keeps find order before the
judge and is ordered cheapest first only inside the judged page, inside
each group, after the judge.

AC-16 fix run — the far tier after the judge only (YOY-171 AC-4 as
amended): [run 38127006913](https://github.com/0xYoyo/unfiltered/actions/runs/38127006913),
2026-10-11, dispatched with `ref=45a9e50` (branch `YOY-171-far-after-judge`)
and `judge=jev`. Green, leak check clean (72 checked), **0 failed
searches**, $0.1334 over 1,943 model calls, 72 extraction calls. en 0.630,
**he 0.245**, ar 0.481, ru 0.662, fr 0.500, es 0.338; no extraction en 8 %,
he 17 %. Against the run 6 control: en −0.027 (inside), **he −0.116 (band
0.090: outside; the gate is he ≥ 0.271)**. The slice is **not merged** and
YOY-171 goes to `blocked`. The fix removes the only ranking change #226
made before the judge, yet he sits where B4 (0.250) and C2 (0.264) sit, so
the pre-judge price sort alone does not explain the B3 → B4 step. (A first
dispatch, run 38126940734, failed at checkout on a short SHA before any
model call; $0.)

AC-16 under the AC-17 rule — control C3 and fix' (2026-10-11): with
`EXTRACTION_GRACE_MS=4000` both runs composed every search with its wishes
(no-extraction 0 % in every language), so the 17 % he share that clouded
the first fix run is gone. Control C3,
[run 38135081700](https://github.com/0xYoyo/unfiltered/actions/runs/38135081700),
`main` at `505ccef`: en 0.644, he 0.218, $0.1337. fix',
[run 38135086450](https://github.com/0xYoyo/unfiltered/actions/runs/38135086450),
the branch at `86a5e22` (AC-4 as amended, merged up to `main`): en 0.606,
he 0.199, $0.1330. Both green, leak check clean (72 checked), 0 failed
searches. Against C3: en −0.038 (band 0.111, inside), he −0.019 (band
0.090, inside). By AC-16 step (3) the fix ships. Note that `main` itself
scores he 0.218 today, below the 0.33–0.36 of the bisect's early runs, so
the after-judge price order is within the noise of today's `main`; the
B3 → B4 step is not reproduced by these two runs. AC-16 spend: bisect
$0.5166, first fix run $0.1334, C3 and fix' $0.2667; $0.92 in all.

One side reading for the M7 speed chain: the replay's "no extraction"
column (8–25 %) shows run 5's code missed the extraction grace on some
searches on 2026-10-10, where today's code (0 %) did not.

### M7 — current set: controls and baselines (current set, built 2026-10-01)

YOY-173, 2026-10-14: five hidden runs dispatched 11:52 UTC and completed
12:00–12:02 UTC, all with `ref=d401bdf6e231c87cda0e89f3a38343799f75b1dd`
(`main` after YOY-172), judge deadline and extraction grace 4,000 ms. Every
run was green with a clean leak check (72 checked), **0 failed searches**,
72 extraction calls and 72 `grade` lines. C4 a/b/c are the three-run
reference (judge `jev`): [a](https://github.com/0xYoyo/unfiltered/actions/runs/38559686447),
[b](https://github.com/0xYoyo/unfiltered/actions/runs/38559691020),
[c](https://github.com/0xYoyo/unfiltered/actions/runs/38559695290).
S1 is the engine with no judge (`judge=none`, every page the composed find
order, reason `find-only`):
[run 38559699502](https://github.com/0xYoyo/unfiltered/actions/runs/38559699502).
G1 is the Flash-Lite judge (`judge=gemini`):
[run 38559703962](https://github.com/0xYoyo/unfiltered/actions/runs/38559703962).
Each band is `max(spread of C4 a/b/c, the language's M5 band, 0.03)`. A
difference is from the C4 mean, and "inside" means its absolute value is
at most the band.

| | en | he | ar | ru | fr | es |
|---|---|---|---|---|---|---|
| C4 a | 0.639 | 0.255 | 0.500 | 0.644 | 0.458 | 0.384 |
| C4 b | 0.602 | 0.241 | 0.523 | 0.625 | 0.407 | 0.380 |
| C4 c | 0.620 | 0.218 | 0.481 | 0.657 | 0.463 | 0.361 |
| C4 mean | 0.620 | 0.238 | 0.501 | 0.642 | 0.443 | 0.375 |
| C4 spread | 0.037 | 0.037 | 0.042 | 0.032 | 0.056 | 0.023 |
| Band | 0.111 | 0.090 | 0.042 | 0.055 | 0.056 | 0.060 |
| S1 (`none`) | 0.657 | 0.315 | 0.537 | 0.611 | 0.625 | 0.361 |
| S1 − C4 mean | +0.037 inside | +0.077 inside | +0.036 inside | −0.031 inside | **+0.182 outside** | −0.014 inside |
| G1 (`gemini`) | 0.662 | 0.310 | 0.542 | 0.634 | 0.449 | 0.403 |
| G1 − C4 mean | +0.042 inside | +0.072 inside | +0.041 inside | −0.008 inside | +0.006 inside | +0.028 inside |

No-extraction share: 0 % in every language in all five runs. Cost lines:
C4 a $0.1328 over 1,924 model calls, C4 b $0.1337 over 1,943, C4 c $0.1334
over 1,942, S1 $0.0526 over 216, G1 $0.2097 over 289. Hidden total $0.6622.

S1 lands above the C4 mean in en and he, but inside both bands. fr is the
only language outside its band, and it is a tracked language, not a gated
one. Under 1 s (local) is 50–67 % per language for S1 and 0–8 % for every
judged run, because without the judge a search makes no second model
call. That is a local timing only, never this table's latency claim.

Per-index hidden Hebrew grades (index into the decoded hidden file, then
the search's score; index and score only):

| Index | C4 a | C4 b | C4 c | S1 |
|---|---|---|---|---|
| 12 | 0.000 | 0.000 | 0.000 | 0.167 |
| 13 | 0.111 | 0.000 | 0.111 | 0.111 |
| 14 | 0.167 | 0.278 | 0.167 | 0.167 |
| 15 | 0.000 | 0.000 | 0.000 | 0.000 |
| 16 | 0.000 | 0.000 | 0.000 | 0.389 |
| 17 | 0.778 | 0.722 | 0.667 | 0.556 |
| 18 | 0.000 | 0.000 | 0.000 | 0.000 |
| 19 | 0.000 | 0.000 | 0.000 | 0.556 |
| 20 | 0.000 | 0.000 | 0.000 | 0.000 |
| 21 | 0.611 | 0.556 | 0.611 | 0.611 |
| 22 | 0.667 | 0.611 | 0.333 | 0.500 |
| 23 | 0.722 | 0.722 | 0.722 | 0.722 |

Six of the twelve Hebrew searches (12, 15, 16, 18, 19, 20) score 0 in all
three C4 runs. Three of those score above 0 with no judge: 12 at 0.167, 16
at 0.389 and 19 at 0.556. On those three, the judge's page scores lower
than the find order it was given. 15, 18 and 20 score 0 with or without the
judge: their find order already scores 0.

P1, the public half with per-search grades (`--per-search`, judge `jev`,
judge deadline and extraction grace 4,000 ms), was run twice locally on
2026-10-14 between 12:05 and 12:16 UTC. Both outputs are attached to YOY-173.
The first ran on `main` at `d401bdf` with this issue's title lines. The second
ran on a local throwaway at `5c5adfe` (run 5's code), carrying only the
`--per-search` and title hunks of the score runner, with `ENGINE_V2=1`. Both
had 78 searches and 0 failed.

| | en | he | ar | ru | fr | es | Cost |
|---|---|---|---|---|---|---|---|
| P1 `main` (`d401bdf`) | 0.705 | 0.214 | 0.397 | 0.415 | 0.457 | 0.577 | $0.1468 over 2,095 model calls |
| P1 `5c5adfe` throwaway | 0.709 | 0.231 | 0.491 | 0.474 | 0.462 | 0.504 | $0.1140 over 2,105 model calls |

No public Hebrew search fell by 1.0 or more in mean grade (0–3 scale) from
`5c5adfe` to `main`. The largest falls were he 14 (−0.50) and he 23
(−0.34), and both served the same six titles in both runs, so those falls
are the grader's own variation. 41 of the 78 public searches served an
identical page in both runs.

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
