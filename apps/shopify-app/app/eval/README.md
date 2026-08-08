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

- `fixtures/catalog.json` — 60 sparse fashion products (EN + HE): one-line or
  empty descriptions, ≤2 tags. Deliberately low-quality by design (NG-3).
- `fixtures/goldens.json` — 20 golden natural-language queries (EN, HE,
  mixed), each with expected product IDs and the hard constraints its results
  are checked against.
- `fixtures/refinement-goldens.json` — 6 follow-up queries (EN, HE, mixed),
  each with the previous query's intent and the constraint outcome the merged
  intent must produce (YOY-42). They run intent extraction only: a follow-up
  is scored on what it does to the constraints, not on ranking.
- `fixtures/recorded/` — recorded model outputs the harness replays:
  `enrichment.json` (keyed by product title), `classification.json` (keyed by
  normalized query), `intent.json` and `intent-refinement.json` (keyed by raw
  query), `embeddings.json` (keyed by exact embedded text). Each recording
  file declares its `provenance`; the two intent files are merged at replay
  time and a key present in both is an error.

## Pass bar (enforced as failing tests)

- ≥80% of golden queries return at least one expected product in the top 10.
- Zero hard-constraint violations (price cap, excluded color, category,
  availability) anywhere in any query's top 10.
- Blended per-search cost ≤ $2.00 per 1,000 AI searches, computed from the
  ledger over the eval run with the committed price table
  `config/ai-prices.json`. Ledger rows carrying a `searchId` are per-search
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

    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npx vitest run apps/shopify-app/app/eval/regenerate-live.test.ts

Afterwards, re-run `npm test` to prove the harness still clears the bar on
the fresh recordings, then commit the changed JSONs.

Provenance of what is committed today:

- `enrichment.json`, `classification.json`, `intent.json`, `embeddings.json` —
  live Gemini output, recorded by the regenerate flow (YOY-28).
- `intent-refinement.json` — **synthesized** (`"provenance": "synthesized"`):
  hand-written in the vocabulary the refinement prompt requests, because the
  regenerate flow needs a live API key that CI and the build loop do not hold.
  It proves the refinement plumbing and scoring end to end, not the model's
  own refinement quality. The eval scorecard prints a NOTE whenever any
  replayed intent recording is synthesized. Regenerating (above) re-records
  these six follow-ups against the live model and flips the file's provenance
  to `live`; that run is what turns the refinement rows into real evidence.
