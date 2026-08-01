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

## Link the app to your Partner organization

4. From the app workspace, link the local project to a Shopify app record.
   The CLI opens a browser for Partner login the first time:

   ```bash
   cd apps/shopify-app
   npm run config:link
   ```

   Choose your Partner organization, then **create a new app** named
   `unfiltered` (or select it if it already exists). The CLI writes
   `client_id` and app URLs into `shopify.app.toml`. `client_id` is a public
   identifier and safe to commit; never commit the client secret.

5. Environment variables are injected by the CLI during `shopify app dev` —
   no `.env` file is required for this runbook. (`.env.example` exists for
   the credential-free smoke test described in the README; if you want a
   local `.env` for other tooling, run `npm run env -- pull` and note that
   `.env` files are gitignored.)

## Run and install

6. Start the dev server (from `apps/shopify-app`):

   ```bash
   npm run dev
   ```

   When prompted, select `unfiltered-dev` as the development store. The CLI
   starts a tunnel, runs `prisma migrate deploy` automatically (creating
   `prisma/dev.sqlite`), and prints a preview URL.

7. Press `p` (or open the printed preview URL). Shopify shows the
   install/consent screen for `unfiltered-dev`. Accept it. The embedded app
   must load inside the Shopify admin with no errors in the page or in the
   terminal. **[Evidence → AC-2]**

## Verify session persistence

8. Confirm a session row exists for the store:

   ```bash
   sqlite3 apps/shopify-app/prisma/dev.sqlite \
     'SELECT id, shop, isOnline FROM "Session";'
   ```

   Expect at least one row with `shop = unfiltered-dev.myshopify.com`.

9. Reload the embedded app in the Shopify admin (or close and reopen it from
   Apps). It must load straight into the app with **no second install
   prompt** — the persisted session is being reused. **[Evidence → AC-3]**

## Verify the engine wiring

10. Open `https://<your-tunnel-host>/healthz` (the tunnel host is shown in
    the `shopify app dev` output; `/healthz` is the route that calls the
    engine's public API — see docs/ARCHITECTURE.md). Expect:

    ```json
    {"status":"ok","engine":{"version":"0.1.0","search":{"hits":[],"totalCount":0,"query":"healthcheck"}}}
    ```

    **[Evidence → AC-4]**

## Wrap up

11. Stop `shopify app dev` with `Ctrl+C`.
12. Commit any config the CLI corrected in `shopify.app.toml` (client_id,
    application_url, redirect URLs). Before committing, search the diff for
    secrets — the API secret and any access tokens must never appear:

    ```bash
    git diff | grep -iE "secret|shpat_|shpss_" || echo "no secrets in diff"
    ```

13. Fill in the verification record below with the date, store domain, and
    evidence (pasted output and/or screenshots) and commit it on this branch.

---

## Verification record

> **PENDING HUMAN RUN** — this section is completed by the person executing
> the runbook. Replace each placeholder with real evidence; the PR reviewer
> confirms the manual pass from this record alone.

- **Date:** _pending_
- **Executed by:** _pending_
- **Store domain:** _pending (expected: unfiltered-dev.myshopify.com)_

### AC-2 — install and embedded load

_Pending: paste the CLI output around the install, and a screenshot (or
description) of the embedded app loaded in the Shopify admin without errors._

### AC-3 — session persisted and reused

_Pending: paste the `sqlite3` query output showing the Session row, and note
that reloading the embedded app produced no second install prompt._

### AC-4 — engine route renders

_Pending: paste the JSON response from `https://<tunnel-host>/healthz`._

### AC-6 — config corrections and secret check

_Pending: list any `shopify.app.toml` fields the CLI changed (committed in
this PR), and paste the output of the secret-grep from step 12._
