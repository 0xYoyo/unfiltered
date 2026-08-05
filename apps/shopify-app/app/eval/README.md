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
- `fixtures/recorded/` — recorded model outputs the harness replays:
  `enrichment.json` (keyed by product title), `classification.json` (keyed by
  normalized query), `intent.json` (keyed by raw query), `embeddings.json`
  (keyed by exact embedded text).

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
the fresh recordings, then commit the changed JSONs. The currently committed
recordings are synthesized (deterministic feature-hash vectors and
hand-labeled attributes/intents in the same vocabulary the prompts request);
regeneration replaces them with real model outputs wholesale.
