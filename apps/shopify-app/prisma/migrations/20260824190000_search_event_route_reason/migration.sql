-- SearchEvent.routeReason (YOY-96 AC-9): why a submitted search took its
-- route — the orchestrator's routeReason, so a classic row can be told apart
-- by cause (heuristic/model decision, throttled session, or the widget's
-- "client-timeout-rescue"). Nullable, no backfill: rows from before this
-- column correctly read as "pre-column". Single statement for the PGlite
-- test-DB loader.
ALTER TABLE "SearchEvent" ADD COLUMN "routeReason" TEXT;
