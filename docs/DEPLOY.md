# Deployment (Render)

The playground runs as a single Docker web service on Render in the
**Frankfurt** region (moved from Oregon under YOY-115), built from the
repo-root `Dockerfile` and described by the repo-root `render.yaml`
blueprint. This document is the operational record: how to bring the service
up, where each environment value comes from and how it reaches the service
(the environment group), how to re-create the service in a new region, how
the free plan behaves, and how to attach a custom domain later.

**The Shopify app record is NOT re-pointed at this deployment.** The embedded
app and its storefront proxy keep pointing at whatever `shopify app dev`
tunnel or app configuration they already use. This service exists to give the
playground a public, stable URL; nothing here runs `shopify app deploy` or
edits `shopify.app.toml`.

- The theme app extension's widget bundle (`unfiltered-widget.js`) is no longer committed (YOY-102).
- `npm run deploy` (`shopify app deploy`) builds it first via the `predeploy` script.
- CI builds it and uploads it as the `unfiltered-widget` artifact.

## What gets deployed

`Dockerfile` (multi-stage, Node 22 Alpine) installs the whole workspace tree,
compiles `packages/engine` and `packages/provider-gemini`, generates the
Prisma client, builds `apps/shopify-app` with React Router, then prunes dev
dependencies into the runtime stage. `docker-entrypoint.sh` runs
`prisma migrate deploy` and only then starts `react-router-serve` on `$PORT`.

The install is a single `npm ci`. The workspace packages carry no `prepare`
hooks (YOY-96 AC-12): the root `postinstall` runs `npm run build:packages`,
which compiles `engine` and then `provider-gemini` in that order, so
`provider-gemini`'s `tsc` always finds the `engine` `dist/` it types against.
(Before that, npm ran the two `prepare` hooks concurrently and the install
failed whenever `provider-gemini` lost the race; the Dockerfile worked around
it with a two-phase install.)

A container with no `DATABASE_URL` exits non-zero at startup with a stated
reason. That is deliberate: `/healthz` never touches the database, so a
misconfigured service would otherwise pass its health check while every
search 500s.

## Environment: the `unfiltered-prod` group

Every environment value the service needs lives in one Render
**environment group** named `unfiltered-prod`, attached to the service by
`render.yaml` (`envVars: - fromGroup: unfiltered-prod`). The service declares
no per-key values of its own, so:

- A service is created with its full environment in one step, with no one
  typing a secret into a form. Re-creating the service (region move, plan
  change that needs a fresh service, accidental deletion) is a link, not a
  re-entry.
- Values are edited in one place — dashboard → **Environment Groups** →
  `unfiltered-prod` — and every service linked to the group redeploys.
- The group is filled and verified by
  `apps/shopify-app/scripts/render-migrate.mts` over the Render REST API.
  The script holds values in memory only and prints key names, never values;
  its output is safe to paste anywhere. `RENDER_API_KEY` (a Render personal
  API key, dashboard → Account Settings → API Keys) is loaded in-process from
  `apps/shopify-app/.env` or the repo-root `.env`; never `cat` or `source` it.

```bash
cd apps/shopify-app
npx tsx scripts/render-migrate.mts preflight                    # RENDER_API_KEY: present
npx tsx scripts/render-migrate.mts inspect <serviceId>          # settings + env var key names
npx tsx scripts/render-migrate.mts create-group <serviceId> <group>   # copy a service's env into a new group
npx tsx scripts/render-migrate.mts link-group <group> <serviceId>     # attach a group to a service
npx tsx scripts/render-migrate.mts create-service <oldServiceId> <name> <region>  # re-create a service elsewhere
npx tsx scripts/render-migrate.mts trigger-deploy <serviceId>         # start a build-and-deploy
npx tsx scripts/render-migrate.mts wait-deploy <serviceId> [deployId] # poll until live / failed (15 min)
npx tsx scripts/render-migrate.mts set-group-var <group> <key> <value> # set one non-secret group value
```

Optional variables (`GEMINI_*`, `PLAYGROUND_TRUSTED_PROXY_HOPS`) are added to
the same group from the dashboard when needed. Do not add env vars to the
service directly: a service-level value shadows the group's and the next
re-creation silently loses it.

## First-time setup

1. Make sure the `unfiltered-prod` environment group exists with every
   variable in the table below (dashboard → **Environment Groups**). It does
   — it was created from the Oregon service under YOY-115 — so this is a
   check, not a task, unless you are standing up a second copy.
2. Render dashboard → **Blueprints** → **New Blueprint Instance** → pick this
   repository. Render reads `render.yaml` and proposes one web service named
   `unfiltered` on the free plan in Frankfurt, health check `/healthz`,
   auto-deploy from `main`, with the `unfiltered-prod` group attached. It
   should prompt for **nothing**. If it asks for a value, stop and cancel:
   the group is not being matched (wrong workspace, or the name differs) —
   fix that rather than retyping secrets. In practice the dialog did not
   link the existing group (see the re-creation runbook), so prefer
   `create-service` + `link-group` over the blueprint for a real re-creation.
3. Apply. The first build takes several minutes (a cold image build with no
   layer cache). Watch **Logs**: `prisma migrate deploy` output appears, then
   `[react-router-serve] http://localhost:3000`.
4. Verify: `curl https://<service>.onrender.com/healthz` → `200` with the
   engine version, and
   `curl "https://<service>.onrender.com/api/playground/search?query=dress&sessionId=s1"`
   → `200` with the playground contract.
5. If the Shopify app's own configuration should carry this origin, set
   `SHOPIFY_APP_URL` in the `unfiltered-prod` group to it
   (`render-migrate.mts set-group-var`), then `trigger-deploy` — a group
   change did not start a deploy by itself on 2026-08-25.

## Environment variables and where they come from

All of these live in the `unfiltered-prod` group (see above).

| Variable | Source | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon dashboard → connection string, **pooled** | Must be Neon's pooled host — `ep-<name>-<id>-pooler.<region>.aws.neon.tech` — with `pgbouncer=true&sslmode=require` (YOY-115 AC-4/AC-5). Serves every query; the pooler is PgBouncer in transaction mode. Written by `render-migrate.mts pool-database-url unfiltered-prod`, never by hand. |
| `DIRECT_DATABASE_URL` | the same string on the **direct** (unpooled) host | Prisma's `directUrl`: `prisma migrate deploy` runs over it on every boot. `pool-database-url` writes it as the previous unpooled `DATABASE_URL`; the entrypoint defaults it to `DATABASE_URL` when unset, so an unpooled deployment keeps working. |
| `GEMINI_API_KEY` | Google AI Studio | Required — the playground search route builds its metered Gemini clients per request and 500s without it. |
| `OPENROUTER_API_KEY` | OpenRouter dashboard → Keys | Required only when `JUDGE_PROVIDER=jev` (YOY-152): the Jev judge client is built only for that provider and fails at construction without the key (`OpenRouterConfigError`). Also the `OPENROUTER_API_KEY` repository secret, for `score.yml -f judge=jev`. |
| `SHOPIFY_API_KEY` | `npm run env -- pull --workspace app`, or the Partner dashboard | Client ID of the app record. |
| `SHOPIFY_API_SECRET` | same | Client secret. |
| `SHOPIFY_APP_URL` | this service's own URL | `https://<service>.onrender.com`, or the custom domain once attached. Not written back to the Shopify app record. |
| `SCOPES` | `shopify.app.toml` | e.g. `write_products`. |
| `ADMIN_TOKEN` | you (any long random string) | Guards `/internal/costs`; that route 404s while unset. |
| `PLAYGROUND_SEED_STORE_KEY` | the seed catalog's tenant key | Searched when a request names no `?catalog=` slug; unset makes those requests answer `503`. |
| `PLAYGROUND_SEED_NAME` | you | Display name of the seed catalog for the playground's pages. |
| `PLAYGROUND_AI_THROTTLE_PER_MINUTE` | optional | Default `10` AI-routed submits per IP per minute. |
| `PLAYGROUND_TRUSTED_PROXY_HOPS` | optional | Default `1`: the visitor IP is the last `X-Forwarded-For` entry — the one Render's edge appended. Set `2` if a CDN sits in front of Render. |
| `PLAYGROUND_DAILY_AI_CAP` | optional | Default `2000` AI searches/day across all playground catalogs. |
| `PLAYGROUND_CATALOG_DAILY_AI_CAP` | optional | Default `500` AI searches/day per catalog. |
| `GEMINI_*_MODEL`, `GEMINI_EMBEDDING_DIMENSION` | optional | Pin a model instead of the documented defaults in `packages/provider-gemini`. |
| `JUDGE_PROVIDER` | optional | Which provider answers Engine v2's judge call (YOY-147); default `gemini`, or `jev` — TypeSafe's Jev via OpenRouter, one typed question set per product in parallel (YOY-152). An unknown name fails loudly when the orchestrator is built. The judge model is the provider's own: `GEMINI_JUDGE_MODEL` (default `gemini-3.5-flash-lite`) or `OPENROUTER_JUDGE_MODEL`. |
| `OPENROUTER_JUDGE_MODEL` | optional | The `jev` judge's model (YOY-152 AC-1); default `typesafe/jev-1.13`. Must have a row in `config/ai-prices.json`, or the first metered call fails loudly. |
| `GEMINI_JUDGE_THINKING_LEVEL` | optional | Thinking level of the judge call; default `low`. `model-default` sends no thinking config; an empty value fails loudly (`GeminiConfigError`). |
| `GEMINI_EXTRACT_MODEL` | optional | Model of the wish extraction (YOY-149 AC-1); default `gemini-3.5-flash-lite`. |
| `GEMINI_EXTRACT_THINKING_LEVEL` | optional | Thinking level of the wish extraction; default `low`. `model-default` sends no thinking config; an empty value fails loudly (`GeminiConfigError`). |
| `JUDGE_DEADLINE_MS` | optional | How long the judge may take after its call started before the page is served in find order with routeReason `judge-timeout` (YOY-147 AC-6); default `1500`; score runs set `4000` (AC-18) and production keeps the default, a positive integer, malformed fails loudly naming the variable. |
| `JUDGE_ROW_CHARS` | optional | Characters each candidate row of the judge prompt is cut to (YOY-147 AC-2, AC-17); default `480`, a positive integer, malformed fails loudly naming the variable. |
| `JUDGE_GIVE_UP_MS` | optional | When a judge call past its deadline is given up, counted from its start (YOY-148 AC-6); until then it runs on, its answer is cached and its labels are served by the labels endpoint. Default `6000`, a positive integer, malformed fails loudly naming the variable. |
| `EXTRACTION_GRACE_MS` | optional | How long a v2 page waits for the wish extraction after find finishes before composing without it (YOY-149 AC-3); the wait ends the moment it lands. Default `800` (AC-18), a non-negative integer, malformed fails loudly naming the variable. |
| `PRICE_NEAR_PERCENT` | optional | How far over a stated cap a price is still "near" (the second number tier and the `price-near` label, YOY-149 AC-5, AC-12); default `10`, a non-negative integer, malformed fails loudly naming the variable. |
| `TIER_FRONT_SIZE` | optional | How many find candidates (after the walls) the number tiers reorder (YOY-149 AC-5, 2026-10-03); candidates past it keep find order. Default `48`, a non-negative integer, malformed fails loudly naming the variable. |
| `GEMINI_INTENT_THINKING_LEVEL` | optional | Thinking level of the intent-extraction call; default `low` (YOY-109). `model-default` sends no thinking config and restores the model's own default. |
| `GEMINI_INTENT_LITE_THINKING_LEVEL` | optional | Thinking level of the **lite-tier** intent call (YOY-116); default `low`. `model-default` sends no thinking config. An empty value fails loudly (`GeminiConfigError`). These six knobs are read when the search orchestrator singleton is built — on the first search after boot — and a malformed value throws there, naming the variable, rather than silently falling back to a default. The lite-first ladder they tune is described in docs/ARCHITECTURE.md "Query understanding". |
| `GEMINI_INTENT_LITE_TIMEOUT_MS` | optional | Per-call abort of the lite intent call; default `3000` (was `8000` before YOY-124 AC-12), a positive integer, malformed fails loudly (`GeminiConfigError`). A hung lite call escalates to the accuracy tier only while the ladder deadline (`GEMINI_INTENT_TIMEOUT_MS`) has budget left — the default sits 1.5 s below the deadline precisely so that rescue exists; set the two equal and a hung lite call degrades to classic instead. |
| `GEMINI_INTENT_TIMEOUT_MS` | optional | Per-call abort of the accuracy-tier intent call **and** the wall-clock deadline of the whole lite-first ladder (YOY-64 AC-3) — the shopper's worst-case wait; default `4500` (YOY-124 AC-12, decided on the 2026-08-28 live run: AI p95 3421 ms; was `8000`), a positive integer, malformed fails loudly (`GeminiConfigError`). Must stay ≥ the widget's classic-rescue budget, ≤ its primary budget, and > `GEMINI_INTENT_LITE_TIMEOUT_MS` at the defaults (all asserted by `orchestrator.test.ts`). |
| `INTENT_ESCALATION_THRESHOLD` | optional | Lite confidence floor below which the accuracy tier answers (YOY-116); default `0.8`, a number in `[0, 1]`, malformed fails loudly (`INTENT_ESCALATION_THRESHOLD must be a number within [0, 1]`). |
| `INTENT_HEDGE_AFTER_MS` | optional | How long an escalation-class accuracy call may stay pending before the lite tier is fired alongside it and the first schema-valid answer wins (YOY-64 AC-6); default `2500`, a positive number of milliseconds, malformed or non-positive fails loudly naming the variable. Keep it below `GEMINI_INTENT_TIMEOUT_MS`, or the hedge fires after the ladder deadline has already degraded the search (`intent-escalation.test.ts` asserts the committed default is < 4500). |
| `INTENT_REUSE_WINDOW_MINUTES` | optional | Window in which a repeated AI query (same store, same normalized text) is answered from its stored intent with zero LLM calls (YOY-64 AC-4); default `60`, a non-negative number, `0` disables reuse, malformed fails loudly naming the variable. |

`PORT` is supplied by Render and honoured by the entrypoint; do not set it.

## Switching to the pooled connection (YOY-115 AC-5)

Neon's direct host holds one server connection per client connection;
the pooled `-pooler` host fronts them with PgBouncer in transaction mode,
which is what a web service that opens many short connections should use.
Prisma needs two strings for that: queries over the pooled URL
(`pgbouncer=true`), migrations over the direct one (`directUrl`). The
switch is one agent command plus a deploy — no value is ever displayed:

```bash
cd apps/shopify-app
npx tsx scripts/render-migrate.mts pool-database-url unfiltered-prod   # DIRECT_DATABASE_URL := DATABASE_URL; DATABASE_URL := -pooler + pgbouncer=true
npx tsx scripts/render-migrate.mts trigger-deploy srv-da6uhoh5efls73cvfis0
npx tsx scripts/render-migrate.mts wait-deploy srv-da6uhoh5efls73cvfis0
curl -s -o /dev/null -w "%{http_code}\n" https://unfiltered-eu.onrender.com/healthz   # 200
```

Then one classic and one AI search against the origin (docs/LATENCY.md's
probe with `--runs 1` is the quickest), and the AC-6 measurement. The
command refuses to run twice (a host already carrying `-pooler`) and
refuses a non-Neon host, and it writes the direct URL before the pooled
one so a failed second write leaves the group consistent.

## Re-creating the service (region move, YOY-115)

Render cannot change a service's region in place: moving Oregon → Frankfurt
means a new service, a new `https://<name>-<hash>.onrender.com` URL, and
deleting the old one. With the environment in a group, the agent creates
the service and does the data work over the API; the founder does two
dashboard actions (monitor re-point, old-service delete).

Current service (created 2026-08-25 under YOY-115): **`unfiltered-eu`**,
id `srv-da6uhoh5efls73cvfis0`, region `frankfurt`, origin
`https://unfiltered-eu.onrender.com`. The name `unfiltered` was rejected by
Render as already in use at creation time, hence the `-eu` suffix.

**Agent (before the founder starts):**

1. `npx tsx scripts/render-migrate.mts inspect <oldServiceId>` — record the
   settings (repo, branch, dockerfile path, health check path, plan,
   autoDeploy, region, URL) and the key names.
2. `npx tsx scripts/render-migrate.mts create-group <oldServiceId> unfiltered-prod`
   — copies every env var into the group and confirms the key set (and
   values) match. The script refuses if the group already exists.
3. Land `render.yaml` with `region: frankfurt` and the group attachment (this
   is the state on `main` now; it documents the intended shape — the
   service itself is created in step (a) over the API).
4. **(a)** `npx tsx scripts/render-migrate.mts create-service <oldServiceId> unfiltered frankfurt`
   — creates the web service with the old service's repo, branch,
   autoDeploy, Docker settings, health check and plan in the new region
   and prints the new service id, URL and initial deploy id. If Render
   answers `name: (unfiltered) already in use`, re-run with
   `unfiltered-eu`. This replaces the dashboard's **New Blueprint
   Instance** because that dialog creates a suffixed, empty copy of the
   environment group instead of linking the existing `unfiltered-prod`.
5. `npx tsx scripts/render-migrate.mts link-group unfiltered-prod <newServiceId>`,
   then `inspect <newServiceId>` — the linked group must list the 12 keys.
6. `npx tsx scripts/render-migrate.mts wait-deploy <newServiceId>` (use
   `trigger-deploy` first if no deploy started), then verify `/healthz` →
   200 and an AI-routed playground search on the new URL.
7. `npx tsx scripts/render-migrate.mts set-group-var unfiltered-prod SHOPIFY_APP_URL https://<new URL>`
   — the group change alone did not start a deploy on 2026-08-25, so run
   `trigger-deploy <newServiceId>`, `wait-deploy <newServiceId>`, and
   re-check `/healthz`.
8. Update every place that references the origin (the list below) with the
   new URL and open a PR.

**Founder:**

- **(b)** UptimeRobot → the `/healthz` monitor → edit the URL to the new
  service's `https://<new URL>/healthz`.
- **(c)** Once the new service answers `/healthz` and a playground search
  correctly, delete the old service: old service → **Settings** → **Delete
  Web Service**. Env values are untouched — they live in the group.

### The onrender.com URL changes — every place it is referenced

The old origin is `https://unfiltered-3khq.onrender.com`; the new one is
`https://unfiltered-eu.onrender.com`. Places that reference it:

| Where | What to do |
| --- | --- |
| `SHOPIFY_APP_URL` in the `unfiltered-prod` environment group | Set to the new origin (runbook step 7; done 2026-08-25). |
| UptimeRobot `/healthz` monitor | Re-point (founder step (b)). |
| `docs/M4-LIVE-RUN.md` | Historical record of the M4 run; keeps the old URL, with a note at the top that the service moved. |
| `docs/DEPLOY.md` (this section) | Records the current origin. |
| Shared `/s/<slug>` playground links and any pasted URLs in Linear (YOY-91, YOY-95, YOY-115) or Slack | Old links 404 after step (c); re-share from the new origin. No redirect is configured. |
| Shopify app record (`shopify.app.toml`, Partner dashboard) | **Not referenced** — the app record was never re-pointed at Render (NG-1); nothing to change. |
| Code, widget, CI | **Not referenced** — nothing in the repo assumes the hostname (`grep -r onrender.com` finds only the docs above). |

## Free plan behavior

The free web service **spins down after roughly 15 minutes without traffic**.
The next request pays a cold start of tens of seconds while the container
boots and migrations re-run (a no-op once applied). Free services also have a
monthly build-minute budget; a busy day of merges can exhaust it and stall
auto-deploys.

Sleeping during development is **accepted**, not a problem to engineer around:
no paid tier and no keep-alive infrastructure while the playground is only
being built and tested. Handle it the cheap way instead.

### Dev-phase keep-awake

1. **Before any live test session, hit the URL once and wait for warm-up.**
   A cold start takes roughly 30–60 seconds. Loading the page and waiting is
   the entire procedure — do it before you start, not during a demo.
2. **Optional keep-alive while actively developing or testing.** Either a free
   uptime monitor (UptimeRobot and friends) pointed at `/healthz`, or a local
   loop in a spare terminal:

   ```bash
   while true; do curl -s https://<service>.onrender.com/healthz > /dev/null; sleep 600; done
   ```

   A ping every ~10 minutes keeps the instance from sleeping. Render's free
   tier allows roughly 750 instance-hours a month, so pinging continuously
   stays within quota — but it is pointless outside an active work session, so
   stop the loop when you stop working.
3. **When outreach links go out (M8), flip to the paid starter tier.** That is
   the moment always-on actually matters: a stranger clicking a shared
   `/s/<slug>` link will not wait through a cold start. It is a one-click
   change — Render dashboard → service → **Settings** → **Instance Type** →
   Starter — with no code or blueprint edit, and it is the natural moment to
   attach the custom domain as well (see "Attaching a custom domain later"
   below).

## Logs and rollback

- **Logs**: service → **Logs** (live tail). Startup prints the migration
  output, then the server's listen line; each request logs method, path, and
  status.
- **Rollback**: service → **Deploys** → pick the last good deploy →
  **Rollback to this deploy**. Render redeploys that image. Note this rolls
  back *code only*: `prisma migrate deploy` never reverses a migration, so a
  rollback across a schema change needs a compensating migration, not a
  redeploy.
- **Manual redeploy**: **Manual Deploy** → **Clear build cache & deploy**
  when a build looks stale rather than wrong.

## Attaching a custom domain later

Nothing in the code assumes the `onrender.com` hostname, so this is a
dashboard-plus-DNS operation:

1. Service → **Settings** → **Custom Domains** → **Add Custom Domain**, enter
   the hostname (`unfiltered.example.com` or the apex).
2. Add the DNS record Render shows, at your registrar:
   - subdomain → `CNAME` to `<service>.onrender.com`
   - apex/root → the `A` record (ALIAS/ANAME where your DNS provider supports
     it) that Render displays.
3. Wait for Render to verify the record and issue the TLS certificate
   (automatic, Let's Encrypt).
4. Update `SHOPIFY_APP_URL` in the service's env vars to the new origin and
   redeploy, so the app's own configuration matches the URL it is served on.
   The Shopify app record still is not re-pointed (NG-1); doing that is a
   separate, deliberate decision.

## Local rehearsal

The same image runs locally:

```bash
docker build -t unfiltered .
docker run --rm \
  -e DATABASE_URL='postgresql://postgres:pw@host.docker.internal:5432/unfiltered' \
  -e GEMINI_API_KEY=dummy-key \
  -e SHOPIFY_API_KEY=x -e SHOPIFY_API_SECRET=y \
  -e SHOPIFY_APP_URL=http://localhost:3000 -e SCOPES=write_products \
  -e PLAYGROUND_SEED_STORE_KEY=seed-store \
  -p 3000:3000 unfiltered
curl http://localhost:3000/healthz
```

Point `DATABASE_URL` at a Postgres with the `vector` extension available
(`pgvector/pgvector:pg16` works). Omit `DATABASE_URL` to see the startup
refusal.
