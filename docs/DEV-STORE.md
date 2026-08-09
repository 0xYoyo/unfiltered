# Dev-store verification runbook — `unfiltered-dev`

Connects the app to the `unfiltered-dev` Shopify development store via the
Shopify CLI, installs it, and records the evidence. Requires a Shopify
Partner account with access to `unfiltered-dev`; nothing here needs hosting
or a deployed environment (the CLI tunnels to your machine).

## Prerequisites

1. Node.js `>=20.19 <22 || >=22.12` and a clone of this repository.
2. Install dependencies from the repo root (this also generates the Prisma
   client and builds the engine package):

   ```bash
   npm install
   ```

3. The Shopify CLI is a pinned devDependency of the app workspace
   (`@shopify/cli` in `apps/shopify-app/package.json`) and is installed by
   the `npm install` above — no global install, no `@latest` drift; version
   bumps happen via PR. Every CLI-invoking npm script passes `--path .`, so
   app-directory resolution is explicit. Invoke the CLI through the npm
   scripts (`npm --workspace app run dev`), or directly as
   `npm --workspace app exec shopify -- <command> --path apps/shopify-app`.

4. `apps/shopify-app/shopify.web.toml` must exist (it is committed in this
   repository). Without it the CLI treats the repo root as the app root and
   serves a placeholder app home instead of this app.

## Link the app to your Partner organization

5. From the repo root, link the local project to a Shopify app record.
   The CLI opens a browser for Partner login the first time:

   ```bash
   npm --workspace app run config:link
   ```

   Choose your Partner organization, then **create a new app** named
   `unfiltered` (or select it if it already exists). The CLI writes
   `client_id` and app URLs into `shopify.app.toml`. `client_id` is a public
   identifier and safe to commit; never commit the client secret.

6. Environment variables are injected by the CLI during `shopify app dev` —
   no `.env` file is required for this runbook. (`.env.example` exists for
   the credential-free smoke test described in the README; if you want a
   local `.env` for other tooling, run `npm run env -- pull` and note that
   `.env` files are gitignored.)

## Run and install

7. Start the dev server (from the repo root):

   ```bash
   npm --workspace app run dev
   ```

   When prompted, select `unfiltered-dev` as the development store. The CLI
   starts a tunnel, runs `prisma migrate deploy` automatically against the
   Postgres database named by `DATABASE_URL` (a managed Neon database in
   dev — SQLite is gone; set it in the gitignored
   `apps/shopify-app/.env`), and **auto-installs the app on the dev
   store** — no consent screen appears (the CLI output includes "App has
   been installed").

8. Open the app from the Shopify admin: use the **Dev Console** panel →
   **Previews** → **Web**, or navigate to **Apps → unfiltered**. The embedded
   app must load inside the Shopify admin with no errors in the page or in
   the terminal. **[Evidence → AC-2]**

## Verify session persistence

9. Confirm a session row exists for the store (using the `DATABASE_URL`
   from `apps/shopify-app/.env`):

   ```bash
   psql "$DATABASE_URL" \
     -c 'SELECT id, shop, "isOnline" FROM "Session";'
   ```

   (`psql` optional — `npm --workspace app run prisma -- studio` browses the
   same `Session` table.)

   Expect at least one row with `shop = unfiltered-dev.myshopify.com`.

10. Reload the embedded app in the Shopify admin (or close and reopen it from
    Apps). It must load straight into the app with **no second install
    prompt** — the persisted session is being reused. **[Evidence → AC-3]**

## Verify the engine wiring

11. Open `https://<your-tunnel-host>/healthz` (the tunnel host is shown in
    the `shopify app dev` output; `/healthz` is the route that calls the
    engine's public API — see docs/ARCHITECTURE.md). Expect the current
    engine version (`0.4.0` at the time of writing — the authoritative value
    is `version` in `packages/engine/src/index.ts`):

    ```json
    {"status":"ok","engine":{"version":"0.4.0","search":{"hits":[],"totalCount":0,"query":"healthcheck"}}}
    ```

    **[Evidence → AC-4]**

## M3 surfaces on the dev store

Beyond install/session/engine wiring, the app now serves storefront surfaces
(YOY-43…50). To exercise them on the dev store:

- **Theme app embed** — `shopify app dev` serves the `unfiltered-widget`
  extension as a draft; enable it under **Online Store → Themes →
  Customize → App embeds → Unfiltered search**. The embed loads the widget
  bundle and initializes it with the storefront locale (Hebrew locale →
  Hebrew chrome + RTL) and shop domain; the widget takes over the theme's
  search input.
- **Storefront search API** — `POST /apps/unfiltered/search` and the click
  beacon `POST /apps/unfiltered/click` ride the Shopify app proxy
  (signature-verified; same-origin from the storefront). The CLI points the
  proxy at the tunnel automatically.
- **Search/click logging and throttle** — every proxy search writes a
  `SearchEvent` row and verified clicks write `ClickEvent` rows;
  AI-routed searches are throttled per session
  (`SEARCH_AI_THROTTLE_PER_MINUTE`, default 10).
- **AI pipeline env** — live AI paths additionally need `GEMINI_API_KEY`,
  and `/internal/costs` needs `ADMIN_TOKEN`, in `apps/shopify-app/.env`.

The full user-executed verification pass over these surfaces — including
ingesting/enriching/embedding the dev catalog — is
[M3-LIVE-RUN.md](M3-LIVE-RUN.md).

## Wrap up

12. Stop `shopify app dev` with `Ctrl+C`.
13. Commit any config the CLI corrected in `shopify.app.toml` (client_id,
    application_url, redirect URLs). Before committing, search the diff for
    secrets — the API secret and any access tokens must never appear:

    ```bash
    git diff | grep -iE "secret|shpat_|shpss_" || echo "no secrets in diff"
    ```

14. Fill in the verification record below with the date, store domain, and
    evidence (pasted output and/or screenshots) and commit it on this branch.

---

## Verification record

> Historical evidence, recorded 2026-08-01 against the M1-era codebase: the
> session store was still SQLite (`prisma/dev.sqlite`, since replaced by
> Postgres/Neon) and the engine reported `0.1.0`. Kept verbatim as the
> record of that run; the steps above reflect current reality.

- **Date:** 2026-08-01
- **Executed by:** Yoyo (owner)
- **Store domain:** unfiltered-dev.myshopify.com

### AC-2 — install and embedded load

The app was auto-installed by the CLI during `npm --workspace app run dev`
("App has been installed" in the CLI output). The embedded app loaded in the
admin via Dev Console → Web preview: the template home page ("Congrats on
creating a new Shopify app") rendered with no errors, after two config
corrections committed in this PR (`shopify.web.toml` created; test files
excluded from the route glob). Screenshot retained by the operator.

### AC-3 — session persisted and reused

`sqlite3` query output:

```
offline_unfiltered-dev.myshopify.com|unfiltered-dev.myshopify.com|0
```

Reopening the app from Apps → unfiltered loaded directly with no second
install prompt.

### AC-4 — engine route renders

`GET /healthz` on the dev tunnel returned:

```json
{"status":"ok","engine":{"version":"0.1.0","search":{"hits":[],"totalCount":0,"query":"healthcheck"}}}
```

### AC-6 — config corrections and secret check

Config corrections committed in this PR: single `shopify.app.toml` under
`apps/shopify-app` with the real `client_id`; `shopify.web.toml` committed
(rendered from the `.liquid` template, now removed); `routes.ts`
`ignoredRouteFiles` for `*.test.*`; package-lock `hasInstallScript`.

Secret check output: `no secrets in diff`.
