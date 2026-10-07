# Sparse-catalog quality harness

The M2 quality gate (YOY-27): proves the AI search pipeline clears a
measurable bar on a deliberately thin catalog, and that the cost model holds
— deterministically, offline, inside default `npm test`.

## What runs

`harness.test.ts` seeds the fixture catalog into an embedded Postgres
(PGlite + pgvector), then runs the real production pipeline end to end:

    enrichment → embedding → classification → intent → retrieval

Every LLM/embedding port call is answered by the replay clients
(`replay.server.ts`) from the recorded outputs in `fixtures/recorded/`, and
metered into the cost ledger with the recorded model IDs and token counts —
zero network calls, identical ledger shape to a live run.

## Fixtures

- `fixtures/catalog.json` — 78 sparse fashion products (EN + HE): one-line or
  empty descriptions, ≤2 tags. Deliberately low-quality by design (NG-3).
  p67–p78 (YOY-118) are the products the Constructor-bar set needs: bridal
  gowns (p67, p68) vs. wedding-guest dresses (p69, p70), sleeveless (p71,
  p73) vs. long-sleeve (p72, p74) tops, and multi-material items (p75 cotton-
  linen shirt, p76 wool-cashmere coat, p77 nylon down coat, p78 vegan-leather
  tote).
  p64–p66 "Rib Knit Top in Pink / in Navy / in Black" are one colourway
  family (YOY-117): the harness seeds them with the same `familyKey` every
  ingestion path computes, and the stores return one card per family.
  p62 "Mesh Over Dress in Pink" (colourways pink, black, navy; primary pink)
  and p63 "Tie Waist Dress in Black" pin the primary-colour exclusion rule
  (YOY-110).
- `fixtures/goldens.json` — 35 golden natural-language queries (EN, HE,
  mixed), each with expected product IDs and the hard constraints its results
  are checked against. g24 `summer dress, not black, under 200` expects the
  pink colourway dress: an excluded colour is judged by `primaryColor`, not
  by any colourway. g25 `summer dress, not black, under 100` is a **zero-hit
  golden** (`zeroHit: { relaxedFirst: "priceMax" }`, no expected products;
  YOY-111): its intersection is empty by design, and it scores the
  close-match ladder — hits empty, close matches non-empty with no
  black-primary product, the budget relaxed first. A satisfied zero-hit
  golden counts as a hit. g26 `pink rib knit top` (classic, as the live
  classifier routes it) and g27 `pink rib knit top under 200` (AI) expect
  the pink family member first and carry `mustNotProductIds` (the navy and
  black colourways): any of them in the top 10 is a violation (YOY-117
  AC-3).
- `fixtures/constructor-goldens.json` — the **Constructor bar** (YOY-118):
  30 goldens, 15 EN and 15 HE, in three tagged groups of 10 —
  `negation` (colour, sleeve/category, and material negations: "not white",
  "top, no sleeves", "חולצה בלי שרוולים", "winter coat, not wool"),
  `priceCap` ("under", "below", "מתחת ל", "עד", with and without ₪/$), and
  `occasionVsCategory` ("dress for a wedding" → guest dresses and NOT bridal
  gowns; "wedding dress" → bridal gowns; "shoes for a wedding", "pants for
  the office", and HE equivalents). Each golden carries
  `expectedProductIds`, `hardConstraints`, and `mustNotProductIds`; the
  loader rejects a set under 24 goldens, 12 per language, or 8 per group.
  The set runs through the same orchestrator path as the goldens, on the
  same recording files, but is scored apart from the main bars: its hit
  rate is asserted against `fixtures/constructor-floor.json` (the achieved
  overall rate rounded down to a whole percent — it records what the engine
  does today and is raised only from a measured run), its hard-constraint
  violations must be zero, its `mustNot` leak may be no worse than the
  floor's committed count and clean-golden rate (see the pass bar below),
  and its spend is reported on its own line, never blended into the main
  cost bar.
- `fixtures/vision/` (YOY-122) — the listing images of the 14 text-sparse
  products p79–p92 (title-only, no description, no tags), one JPEG each,
  ≤ 200 KB, rights-clear with the source, author, and licence of every
  file in `fixtures/vision/SOURCES.md`. The harness seeds one
  `ProductImage` row per file (bytes hashed exactly as image capture does)
  and runs the production vision pass over them from
  `recorded/vision.json`. `fixtures/vision/cases.json` declares the
  **contamination cases**: 11 of those photos show a model wearing other
  garments, footwear, jewellery, or a bag beside the sold item, and each
  case names the sold item's categories and colours plus every other
  item's colours. The harness scores the vision pass's OWN answer
  (`visionAttributes`, before the merge) per case: the category must be
  the sold item's, no answered colour may be one that appears only on the
  other items, and no `styleTag` may name footwear, jewellery, or a bag
  (`CONTAMINATION_TERMS`). Bar: contamination violations 0.
- `fixtures/vision-goldens.json` (YOY-122 AC-2) — 12 **sparse-product
  goldens** (EN + HE) that only vision can satisfy: the expected products'
  titles carry no colour, sleeve, pattern, or material ("Sandals",
  "Hoodie", "Party Dress"), and each query asks for exactly such an
  attribute — "gold strappy heels under 400", "long sleeve dress under
  300", "שמלה עם שרוולים ארוכים עד 300", "hooded sweatshirt under 200",
  "striped breton top under 200". Every query carries a price cap so it
  routes to the AI path (a two-word attribute-plus-noun query would settle
  classic, where keyword search matches titles only). Scored end to end
  like the goldens, on their own scorecard block and never blended into
  the main bars; bar: ≥ 80 % hit.
- `fixtures/example-goldens.json` (YOY-136 AC-3) — the playground page's
  **curated example queries**, twelve goldens mirroring `EXAMPLE_QUERIES`
  in `app/playground/strings.ts` one-to-one: one per kind per locale, the
  query byte-identical to the committed text (the loader refuses any
  drift, so a curation edit fails offline until its recording lands). The
  two `refinement` examples carry the `previousIntent` the runbook hands
  them — the same locale's negation example — and run the full path with
  it. `expectedProductIds` is empty by design: a suggestion the page itself
  offers must never come back empty, so each is scored on answering at all
  (≥ 1 primary hit) on its own scorecard block, outside every bar below
  and outside the cost blend.
- `fixtures/refinement-goldens.json` — 9 follow-up queries (EN, HE, mixed),
  each with the previous query's intent and the constraint outcome the merged
  intent must produce (YOY-42). They run intent extraction only: a follow-up
  is scored on what it does to the constraints, not on ranking.
- `fixtures/recorded/` — recorded model outputs the harness replays:
  `enrichment.json` (keyed by product title), `classification.json` (keyed by
  normalized query), `intent.json` and `intent-refinement.json` (keyed by raw
  query; the accuracy tier), `intent-lite.json` and
  `intent-lite-refinement.json` (the same keys answered by the lite tier,
  each answer carrying its `confidence` — YOY-116), `vision.json` (keyed by
  product title: the vision pass's answer for each product with fixture
  images — YOY-122), `embeddings.json` (keyed by exact embedded text — the
  product texts are composed from the MERGED text + vision attributes). Each recording file declares its `provenance`;
  the intent files of one tier are merged at replay time and a key present
  in both is an error.
- `fixtures/baseline-hits.json` — the per-golden zero-regression baseline
  (YOY-116 AC-5): which goldens hit and which refinements were clean on the
  accuracy-only run before lite-first routing; `harness.test.ts` fails if
  any of them regresses. Regenerate it only when a golden legitimately
  changes, never to absorb a regression.

The harness runs intent extraction through the production lite-first ladder
(`createEscalatingIntentExtractor`) over the two recording sets, so the
committed escalation classes and threshold decide which tier's recording
answers exactly as they decide which model is called live. The scorecard
prints a tier column per golden, the escalation rate, and the intent calls
per tier.

## Pass bar (enforced as failing tests)

- ≥80% of golden queries return at least one expected product in the top 10.
- Zero hard-constraint violations (price cap, excluded color, category,
  availability) anywhere in any query's top 10.
- Every golden and refinement that hit at the committed baseline still hits
  (per-golden zero regression, `fixtures/baseline-hits.json`).
- Blended per-search cost ≤ $0.60 per 1,000 AI searches (YOY-116; was
  $2.00), computed from the ledger over the eval run with the committed
  price table `config/ai-prices.json`. Ledger rows carrying a `searchId` are per-search
  cost (classification + intent + query embedding); rows without one are the
  one-time indexing cost (enrichment + catalog embedding), reported
  separately.

The run prints a per-query scorecard (route, first-hit rank, violations,
cost) so a regression is diagnosable, not just red, followed by the
Constructor bar block (YOY-118): one row per Constructor golden, then
`Constructor bar: overall NN % (negation …, priceCap …, occasionVsCategory
…), mustNot violations N` with the per-group and per-language (EN / HE) hit
rates, hard-constraint violations, the set's escalation rate, and its cost
per 1,000 AI searches.

Vision pass bars (YOY-122, enforced as failing tests):

- Contamination violations 0 over every case in `fixtures/vision/cases.json`
  (`contamination violations: N over M cases (bar: 0)`).
- Sparse-product goldens ≥ 80 % hit (`sparse goldens: N/M (… %; bar: ≥ 80 %)`),
  every one on the AI path, zero hard-constraint violations.
- The vision pass is one-time indexing cost: its ledger rows carry no
  `searchId`, so they land in the one-time line and are also printed on
  their own (`one-time vision cost (N products with images, reported
  separately)`), never in the per-search blend. The main bars — per-golden
  zero regression, 0 violations, refinement misses 0, Constructor floor,
  blended ≤ $0.60/1K — are re-verified on the vision-enriched catalog by
  the same tests as before (AC-3).

Curated-examples bar (YOY-136 AC-3, enforced as a failing test): every
example golden returns ≥ 1 primary hit (`curated examples answered: N/12`),
and the negation, priceCap, occasion, and colorAvailability examples route
`ai` — the page's own suggestions never dead-end.

Constructor-bar pass bar (enforced as failing tests):

- Hard-constraint violations 0 across the set's top 10s.
- `mustNot` violations ≤ `mustNotViolationsMax` and the share of goldens
  with no `mustNot` appearance ≥ `mustNotCleanRatePercent`, both committed
  in `fixtures/constructor-floor.json`. The reported target is 0. YOY-133
  made negated attributes hard exclusions (`attributesExclude`) and the
  bridal form a category-like inclusion (`attributesInclude`), taking the
  measured leak from 18 appearances / 21 of 30 clean to 1 / 29 of 30
  (2026-08-27), and the purpose-phrase routing rule (founder decision
  2026-08-27: "sneakers for running" is purpose, which only the AI path
  reads, so the shape settles AI deterministically — co09 follows the
  engine to `expectedRoute: "ai"`, `category: sneakers, occasion: sport`,
  intents re-recorded live) took it to **0 / 30 of 30** (2026-08-28). The
  floor is 0 / 100. `fixtures/baseline-hits.json` `routes` commits every
  golden's route across the three sets and `harness.test.ts` asserts it,
  so any routing change shows as a diff, never as a silent pass.
- Overall hit rate ≥ `overallHitRatePercent` in the same file.

## The Constructor bar on Engine v2 (YOY-153)

`constructor-v2.test.ts` runs the 30 Constructor-bar goldens through Engine
v2 — the production default since YOY-153 — on its own scratch database:
the eval catalog is indexed from the same recordings as above, then its
cards are written and embedded, and every golden is searched through the
v2 path (find, wish extraction, the default `jev` judge) and scored on
page 1 (24 results). It asserts the v2 output three ways — a negation
golden's excluded products never appear on page 1; on a price-cap golden
the page leads in budget and, within each judge verdict, every in-budget
product comes before every over-budget one (the engine orders by verdict
first, `composeWishes`, so an `exact` over-budget product may precede a
`close` in-budget one; "over budget" is the code's `price-near` /
`price-far` label); and a guest-dress query
(`co01`, `co03`) never leads with a bridal gown — and holds the per-group
v2 floor: the `v2` object of `fixtures/constructor-floor.json`, hit rate
and top-10 `mustNot` leak per group, beside the old engine's fields, which
are untouched. The old engine's run of the same set stays in
`harness.test.ts`.

Its recordings are their own files: `fixtures/recorded/card.json` (the
card writer, keyed like enrichment by `Title:` plus an image digest),
`extract.json` (the wish extraction, keyed by `Query:`), `judge-jev.json`
(Jev's per-product decisions, keyed by the search text plus a digest of the
whole request — `decisionRecordingKey`) and `embeddings-v2.json` (card
sections and the goldens' raw sentences, the same model and dimension as
`embeddings.json`, which must agree on any shared text). Record them with
one live run of the same pipeline, from the repository root:

    LIVE_LLM_TESTS=1 REGEN_SCOPE=constructor-v2 GEMINI_API_KEY=... OPENROUTER_API_KEY=... \
      npx vitest run apps/shopify-app/app/eval/constructor-v2-regen.test.ts

It replays the old engine's enrichment, vision and product vectors (so the
index is byte-identical and none of those files changes) and rewrites the
four v2 files. Then run `npm test`, and raise the v2 floor only from a
measured run.

## Regenerating the recordings

`regenerate-live.test.ts` re-records every fixture output against the live
Gemini APIs and rewrites `fixtures/recorded/*.json` in place. It runs only
under `LIVE_LLM_TESTS=1` with a local `GEMINI_API_KEY` — never by default and
never in CI, which holds no key (NG-2):

    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm run regen:live
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=lite npm run regen:live   # lite-tier intents only
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=catalog npm run regen:live   # enrichment + missing entries only
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=goldens npm run regen:live   # missing entries only (new goldens)
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=vision npm run regen:live    # every vision answer + missing entries

`REGEN_SCOPE=lite` re-records only `intent-lite.json` and
`intent-lite-refinement.json` and leaves every accuracy-tier recording
untouched, so a lite-tier change never silently reshuffles the baseline the
zero-regression bar is scored against.

`REGEN_SCOPE=catalog` (YOY-110) re-records the enrichment of every product —
for an enrichment prompt/schema/rule change, which invalidates every
enrichment recording — and then records only the **missing** classification,
intent (both tiers), and embedding entries: new goldens, new products, and
product texts whose composed embedding text changed with the fresh
attributes. Every existing intent recording stays byte-identical, so the
baseline is scored against the same intents. Orphaned embedding vectors are
dropped. The run prints its metered spend per operation from the ledger.
`REGEN_SCOPE=goldens` (YOY-111) is the same missing-only pass without the
enrichment re-record — for a new golden over an unchanged catalog, so the
product vectors stay byte-identical too. `REGEN_REQUERY=cn05,cn06,…`
(YOY-133) narrows an intent prompt/schema change to the goldens it
changes: under the goldens scope the named goldens' intent entries — both
tiers — are dropped first and re-recorded at the current prompt, every
other intent recording stays byte-identical, and the embedding step
records the re-recorded query texts and drops the orphaned vectors. A product with no enrichment
recording yet (added with the golden, YOY-117) is recorded and merged; every
existing enrichment entry is reused as-is. Every scope records the
Constructor-bar goldens alongside the main goldens (YOY-118): both sets
share the recording files, keyed by query — and the sparse-product goldens
(YOY-122) likewise. Every scope also records the vision pass
(`vision.json`) for the products with fixture images: `all`, `catalog`, and
`vision` re-record every answer, `goldens` records only the missing ones;
`REGEN_SCOPE=vision` exists for a vision prompt or model change, which
invalidates every vision answer but no text enrichment. Product embedding
texts are composed from the merged text + vision attributes, so a vision
re-record re-embeds exactly the products whose merged text moved.

`vision.json` is keyed by `<title>#<digest>` — the product title plus a short
digest of its ordered image bytes (YOY-125 AC-14) — because two products with
the same title and different photos would otherwise share one recorded
answer, the second silently scored on the first product's image. Changing a
product's images therefore changes its key, so the entry is re-recorded on
the next run rather than answered from the old photo. Use `REGEN_SCOPE=vision`
to re-key the file wholesale after such a change; the digest is computed
identically by the recorder and by the replay client
(`recordingKeyFromRequest` in `replay.server.ts`), so the two cannot drift.

The root `regen:live` script pins the run to the root `vitest.config.ts`,
whose alias resolves `@unfiltered/*` to the TypeScript source. Invoking
vitest directly with a working directory inside `apps/shopify-app` picks up
the app's alias-less `vite.config.ts` instead and would score the stale
compiled `dist/` output (YOY-52 run 6); a source-execution guard in the test
now fails loudly before the first paid call if that happens.

Afterwards, re-run `npm test` to prove the harness still clears the bar on
the fresh recordings, then commit the changed JSONs.

Provenance of what is committed today:

- `enrichment.json` — live `gemini-3.5-flash-lite` output recorded on
  YOY-110 (2026-08-27) with the `primaryColor` prompt, via
  `REGEN_SCOPE=catalog`.
- `classification.json`, `intent.json`, `embeddings.json` —
  live Gemini output, recorded by the regenerate flow (YOY-28); g24's
  entries and the re-enriched product vectors were added on YOY-110.
- `intent-refinement.json` — live Gemini output (`"provenance": "live"`)
  since the run-8 regeneration (YOY-67): the refinement rows are real model
  evidence, not hand-written plumbing checks.
- `vision.json` — live `gemini-3.5-flash-lite` output at thinking level
  `low` with the anchored anti-contamination prompt, recorded on YOY-122
  (2026-08-27) via `REGEN_SCOPE=goldens` over the 14 fixture images.
- `intent.json` and `intent-lite.json` entries for the ten negation and
  wedding goldens (cn05–cn10, co01–co04) — live output recorded on YOY-133
  (2026-08-27) with the `attributesExclude` / `attributesInclude` prompt
  via `REGEN_SCOPE=goldens REGEN_REQUERY=…`; every other intent entry is
  byte-identical to its pre-YOY-133 recording (the arrays parse as empty).
- `intent-lite.json`, `intent-lite-refinement.json` — live
  `gemini-3.5-flash-lite` output at thinking level `low`, recorded on
  YOY-116 (2026-08-26) with the confidence-bearing prompt. The accuracy
  recordings predate the `confidence` field and carry none; the ladder
  never reads the accuracy tier's confidence, so they stay valid evidence. The eval scorecard still prints
  a NOTE whenever any replayed intent recording is synthesized, so a future
  hand-written stopgap cannot pass silently as live evidence.
