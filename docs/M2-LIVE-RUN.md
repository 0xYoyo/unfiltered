# M2 live-run evidence — `unfiltered-dev`

- **Date:** 2026-08-07
- **Executed by:** Yoyo (owner), guided per YOY-28
- **Store domain:** unfiltered-dev.myshopify.com
- **Engine version:** 0.3.0
- **Billing:** Gemini Tier 1 (`REGEN_PACE_MS=500`)

This document is the live-verification counterpart to the offline M2 suites:
one complete run against the real dev store, real Neon Postgres, and real
Gemini calls. It closes YOY-28.

## 1. Quality bar — PASSED

Evidence: the committed real-model recordings and scorecard (PR #25).

| Metric | Result | Bar |
|---|---|---|
| Hit rate | 90% (18/20) | ≥80% |
| Hard-constraint violations | 0 | 0 |
| Blended cost /1k AI searches | $1.10 | ≤$2.00 |
| One-time indexing (60 products) | $0.0126 | — |

The two absorbed misses (g12, g14) are enrichment variance on sparse product
text, not retrieval or intent failures. The strategic answer to sparse-text
enrichment is tracked in YOY-36.

## 2. Lite-as-intent experiment — REJECTED on evidence

flash-lite as the intent model was measured against the same eval bar
(YOY-34). Comparison, from the live run of 2026-08-07:

| Metric | flash-lite intent | flash intent (default) | Bar |
|---|---|---|---|
| Hit rate | 90% (18/20) | 90% (18/20) | ≥80% |
| Hard-constraint violations | **2** (p10 work, p06 beach/casual surfaced against an `evening` constraint — lite under-extracted the occasion, loosening the filter) | 0 | **0** |
| Cost /1k AI searches | $0.40 | $1.10 | ≤$2.00 |
| One-time indexing (60 products) | $0.0122 | $0.0126 | — |

**Decision:** the accuracy-tier default (gemini-3.6-flash) stays for intent
extraction. The 2.7× cost saving does not buy hard-constraint violations — a
violated constraint is a shopper seeing what they excluded. **Revisit
trigger:** a future lite-tier model release, or margin pressure at scale per
PRD §8.

This table's committed home is this document, closing YOY-34's AC-2 failure
branch.

## 3. Live store walkthrough — all PASS

Per docs/DEV-STORE.md: `npm run dev` tunnel, ingestion on the dev store,
webhook sync, admin routes, clean shutdown.

| Step | Result | Evidence |
|---|---|---|
| Webhook sync ladder | PASS | PRODUCTS_CREATE → "created" (16:24:16); immediate redundant PRODUCTS_UPDATE → "unchanged" (16:24:16, content-hash dedup live); title edit → PRODUCTS_UPDATE → "updated" (16:25:32) |
| `/healthz` on the tunnel | PASS | `{"status":"ok","engine":{"version":"0.3.0",...}}` |
| `/internal/costs` | PASS | 404 without token; renders the ledger with `ADMIN_TOKEN` |
| Live Neon ledger | PASS (0 calls — CORRECT) | All AI-call ledger evidence lives in the test-harness database from the regeneration runs; no app-triggerable AI operation exists until the M3 search route. Not a defect. |
| Shutdown | PASS | `git status` clean after shutdown |

## 4. Hardening earned during the runbook

Each item below was surfaced by the live run and merged before the evidence
above was recorded:

- Free-tier pacing + 429 backoff for live fixture regeneration (PR #20).
- Gemini nullable-dialect translation for JSON-Schema nullable unions (PR #21).
- Transient-transport retry + per-request abort timeout + `REGEN_PACE_MS`
  tunable pacing + `ADMIN_TOKEN` `.env.example` entry (PR #22).
- Canonical taxonomy (PR #23, YOY-31).
- Unknown-passes filtering + prompt precision + category groups + strict
  nullable enums (PR #24, YOY-35).
- Real-model recordings + golden-constraint sync (PR #25).

## 5. M2 exit state

Milestone complete. Deferred findings live in YOY-30/33 (factory) and YOY-36
(vision; PRD decision at the M3 boundary).
