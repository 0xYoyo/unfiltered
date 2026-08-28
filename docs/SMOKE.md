# Daily live smoke — the routine and its phone checklist (YOY-112)

A canary between milestone live runs, never a replacement for them: once a
day a Claude Code cloud routine runs `apps/shopify-app/scripts/live-smoke.mts`
against the deployment and posts to Slack **only when something fails**. The
script is read-only (four GETs, fresh `sessionId`s, no writes anywhere); the
routine is read-only by construction (Slack is its only connector). Ceilings
live in `apps/shopify-app/scripts/live-smoke.config.json`
(`classicMaxMs: 800`, `aiMaxMs: 3500`); the origin is
`https://unfiltered-eu.onrender.com` (Frankfurt).

The ceilings were tightened from `1500`/`6000` to `800`/`3500` on
2026-08-28 (YOY-124 AC-9b). They are canary ceilings, not the bars: the
bars are docs/LATENCY.md's (classic p95 ≤ 500 ms, AI p95 < 3500 ms) over
≥ 100 samples, while the smoke takes one sample per probe per day. The
classic ceiling sits above the measured p95 (19–26 ms) with room for a
single slow sample; the AI ceiling is the bar itself, because a single AI
sample over 3500 ms is exactly the hedge-tail regression worth waking
someone for.

What the four probes assert is in the script's header comment; in one line:
`/healthz` is 200 and reports the engine version the source exports;
classic `dress` is classic, not degraded, has results and no chips, under
0.8 s; EN and HE AI queries are AI-routed, not degraded, have chips and
results, under 3.5 s.

## Phone checklist — creating the routine at https://claude.ai/code/routines

Everything below is done from the web form; no terminal is needed. Follow
the numbered order — the environment step (4) is the one people skip, and
without it every run fails on network access.

1. **Name:** `unfiltered — daily live smoke`
2. **Prompt:** paste the block under "The routine prompt" below, verbatim.
3. **Repository:** `0xYoyo/unfiltered`, branch `main` (the default).
4. **Cloud environment — network access.** Open the routine's environment
   settings. The default environment blocks every host except package
   registries, and the probe fetches the deployment directly, so: set
   **Network access → Custom**, **add `unfiltered-eu.onrender.com`**, and
   **keep the default package-manager list** (npm must still install). Save.
5. **Schedule:** daily at **06:00 UTC**.
6. **Connectors:** keep **Slack only**. Remove Linear, GitHub, and anything
   else. The routine must not be able to write anywhere but Slack — and it
   writes there only on failure.
7. **First green run:** open the routine → **Run now**. Expected: the run
   ends with `4/4 passed → exit 0` and **no Slack message**. Paste the run's
   timestamp on YOY-112.
8. **Induced failure:** open the routine → **Run now** → in the payload /
   message box, type `https://definitely-not-a-host.invalid`. Expected: the
   run ends with `0/4 passed → exit 1` and **exactly one** Slack message in
   `C0BL7QBNER4` carrying the four failing assertions and the JSON report.
   Paste that timestamp on YOY-112 too.

That is the founder gate (YOY-112 AC-3): two timestamps, five minutes.

## The routine prompt

Copy from the first line to the last, unchanged.

```
You are the daily live smoke for the unfiltered deployment. You are READ-ONLY: never edit the repository, never comment on or change anything in Linear, never touch the deployment, never open a PR, never commit. Your only permitted side effect is one Slack message, and only on failure.

1. Install: run `npm ci` at the repository root (branch main).
2. Target: the default target is https://unfiltered-eu.onrender.com. If the routine-fire-payload block contains a URL, run the probes against that URL instead of the default.
3. Run, from apps/shopify-app: `npx tsx scripts/live-smoke.mts --url <target>`. Capture its full output (the JSON report followed by the summary) and its exit code.
4. If the exit code is 0: do nothing else. Post nothing. End the run.
5. If the exit code is 1: post exactly ONE Slack message to channel C0BL7QBNER4 using the Slack connector, and nothing else. The message must contain: the target URL, the summary block (the PASS/FAIL rows with their failing assertions), and, for each failing probe, its searchId and latencyMs when present, followed by the full JSON report in a code block. Post once; never retry a successful post; never post a second message.
6. Never post on success, never write anywhere other than that Slack channel, never modify files, and never run anything other than the install and the probe script.
```

## Reading a failure

- `healthz`: `engine.version` mismatch → the deployment runs a stale build
  or the engine source moved without a deploy (YOY-104 class). HTTP ≠ 200 →
  the service is down or asleep.
- `classic`: chips ≠ 0 or route ≠ classic → routing regression; over
  `classicMaxMs` → the database path regressed (YOY-115 measured 19 ms p95).
- `ai-en` / `ai-he`: `degraded: true` or no chips → intent extraction is
  failing (YOY-109 class); over `aiMaxMs` → the LLM path regressed.
- All four failing with a network error → the environment allowlist (step
  4) is missing the host, or the host is wrong.

The routine is a canary, not a benchmark (NG-2): one sample per day, no
trend log, no percentiles — docs/LATENCY.md is where numbers live.
