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

- `fixtures/catalog.json` — 63 sparse fashion products (EN + HE): one-line or
  empty descriptions, ≤2 tags. Deliberately low-quality by design (NG-3).
  p62 "Mesh Over Dress in Pink" (colourways pink, black, navy; primary pink)
  and p63 "Tie Waist Dress in Black" pin the primary-colour exclusion rule
  (YOY-110).
- `fixtures/goldens.json` — 32 golden natural-language queries (EN, HE,
  mixed), each with expected product IDs and the hard constraints its results
  are checked against. g24 `summer dress, not black, under 200` expects the
  pink colourway dress: an excluded colour is judged by `primaryColor`, not
  by any colourway.
- `fixtures/refinement-goldens.json` — 6 follow-up queries (EN, HE, mixed),
  each with the previous query's intent and the constraint outcome the merged
  intent must produce (YOY-42). They run intent extraction only: a follow-up
  is scored on what it does to the constraints, not on ranking.
- `fixtures/recorded/` — recorded model outputs the harness replays:
  `enrichment.json` (keyed by product title), `classification.json` (keyed by
  normalized query), `intent.json` and `intent-refinement.json` (keyed by raw
  query; the accuracy tier), `intent-lite.json` and
  `intent-lite-refinement.json` (the same keys answered by the lite tier,
  each answer carrying its `confidence` — YOY-116), `embeddings.json` (keyed
  by exact embedded text). Each recording file declares its `provenance`;
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
cost) so a regression is diagnosable, not just red.

## Regenerating the recordings

`regenerate-live.test.ts` re-records every fixture output against the live
Gemini APIs and rewrites `fixtures/recorded/*.json` in place. It runs only
under `LIVE_LLM_TESTS=1` with a local `GEMINI_API_KEY` — never by default and
never in CI, which holds no key (NG-2):

    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm run regen:live
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=lite npm run regen:live   # lite-tier intents only
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=catalog npm run regen:live   # enrichment + missing entries only

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
- `intent-lite.json`, `intent-lite-refinement.json` — live
  `gemini-3.5-flash-lite` output at thinking level `low`, recorded on
  YOY-116 (2026-08-26) with the confidence-bearing prompt. The accuracy
  recordings predate the `confidence` field and carry none; the ladder
  never reads the accuracy tier's confidence, so they stay valid evidence. The eval scorecard still prints
  a NOTE whenever any replayed intent recording is synthesized, so a future
  hand-written stopgap cannot pass silently as live evidence.
