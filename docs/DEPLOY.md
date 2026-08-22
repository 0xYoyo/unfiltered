# Deployment (Render)

The playground runs as a single Docker web service on Render, built from the
repo-root `Dockerfile` and described by the repo-root `render.yaml`
blueprint. This document is the operational record: how to bring the service
up, where each environment value comes from, how the free plan behaves, and
how to attach a custom domain later.

**The Shopify app record is NOT re-pointed at this deployment.** The embedded
app and its storefront proxy keep pointing at whatever `shopify app dev`
tunnel or app configuration they already use. This service exists to give the
playground a public, stable URL; nothing here runs `shopify app deploy` or
edits `shopify.app.toml`.

## What gets deployed

`Dockerfile` (multi-stage, Node 22 Alpine) installs the whole workspace tree,
compiles `packages/engine` and `packages/provider-gemini`, generates the
Prisma client, builds `apps/shopify-app` with React Router, then prunes dev
dependencies into the runtime stage. `docker-entrypoint.sh` runs
`prisma migrate deploy` and only then starts `react-router-serve` on `$PORT`.

The install runs in two phases, and the order is load-bearing: npm runs the
workspaces' `prepare` hooks concurrently, `provider-gemini` types against
`engine`'s `dist/`, and losing that race fails the install. Phase one installs
the root plus `engine` alone so its `dist/` always exists before phase two
installs everything else.

A container with no `DATABASE_URL` exits non-zero at startup with a stated
reason. That is deliberate: `/healthz` never touches the database, so a
misconfigured service would otherwise pass its health check while every
search 500s.

## First-time setup

1. Render dashboard → **Blueprints** → **New Blueprint Instance** → pick this
   repository. Render reads `render.yaml` and proposes one web service named
   `unfiltered` on the free plan, health check `/healthz`, auto-deploy from
   `main`.
2. Render prompts for every `sync: false` variable (see the table below).
   Fill them in; they are stored in Render, never in the repo.
3. Apply. The first build takes several minutes (a cold image build with no
   layer cache). Watch **Logs**: `prisma migrate deploy` output appears, then
   `[react-router-serve] http://localhost:3000`.
4. Verify: `curl https://<service>.onrender.com/healthz` → `200` with the
   engine version, and
   `curl "https://<service>.onrender.com/api/playground/search?query=dress&sessionId=s1"`
   → `200` with the playground contract.

## Environment variables and where they come from

| Variable | Source | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon dashboard → connection string | Pooled Postgres URL with `sslmode=require`. Migrations run against it on every boot. |
| `GEMINI_API_KEY` | Google AI Studio | Required — the playground search route builds its metered Gemini clients per request and 500s without it. |
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
| `GEMINI_INTENT_THINKING_LEVEL` | optional | Thinking level of the intent-extraction call; default `low` (YOY-109). `model-default` sends no thinking config and restores the model's own default. |

`PORT` is supplied by Render and honoured by the entrypoint; do not set it.

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
