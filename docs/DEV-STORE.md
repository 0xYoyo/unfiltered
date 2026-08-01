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

3. Install the Shopify CLI globally (the app template expects it on PATH):

   ```bash
   npm install -g @shopify/cli@latest
   ```

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
   starts a tunnel, runs `prisma migrate deploy` automatically (creating
   `prisma/dev.sqlite`), and **auto-installs the app on the dev store** — no
   consent screen appears (the CLI output includes "App has been installed").

8. Open the app from the Shopify admin: use the **Dev Console** panel →
   **Previews** → **Web**, or navigate to **Apps → unfiltered**. The embedded
   app must load inside the Shopify admin with no errors in the page or in
   the terminal. **[Evidence → AC-2]**

## Verify session persistence

9. Confirm a session row exists for the store:

   ```bash
   sqlite3 apps/shopify-app/prisma/dev.sqlite \
     'SELECT id, shop, isOnline FROM "Session";'
   ```

   Expect at least one row with `shop = unfiltered-dev.myshopify.com`.

10. Reload the embedded app in the Shopify admin (or close and reopen it from
    Apps). It must load straight into the app with **no second install
    prompt** — the persisted session is being reused. **[Evidence → AC-3]**

## Verify the engine wiring

11. Open `https://<your-tunnel-host>/healthz` (the tunnel host is shown in
    the `shopify app dev` output; `/healthz` is the route that calls the
    engine's public API — see docs/ARCHITECTURE.md). Expect:

    ```json
    {"status":"ok","engine":{"version":"0.1.0","search":{"hits":[],"totalCount":0,"query":"healthcheck"}}}
    ```

    **[Evidence → AC-4]**

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
