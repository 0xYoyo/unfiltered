# Dependency audit record

Status of every high-severity `npm audit` finding, per YOY-16. Rule: each
high is either resolved by a deliberate, individually-chosen upgrade or
documented here with the advisory, why it is unresolvable now, and the
exposure. `npm audit fix --force` is never used.

Last audited: 2026-08-03.

## Resolved

| Chain | Advisory | Resolution |
| --- | --- | --- |
| `minimatch` 9.0.0–9.0.6 via `@typescript-eslint/*` 6.21.0 (6 highs) | GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74 (ReDoS) | Deliberate upgrade of `@typescript-eslint/eslint-plugin` + `parser` to 7.18.0 in `apps/shopify-app` and `packages/engine` (the advisories require ≥ 7.5.1; 7.18.0 is the last 7.x, still compatible with ESLint 8.57). Dev-only exposure (lint toolchain). |
| `lodash` ≤ 4.17.23 via `@shopify/api-codegen-preset` → `@graphql-codegen/plugin-helpers` (7 highs) | GHSA-r5fr-rjxr-66jc (code injection via `_.template`), GHSA-f23m-r3pf-42rh (prototype pollution) | Root `overrides: { "lodash": "^4.18.1" }` — `@graphql-codegen/plugin-helpers` pins `~4.17.0`, so the patched line cannot arrive without an override. Dev-only exposure (GraphQL codegen toolchain). |

## Accepted (documented, not resolvable by a sane upgrade)

### `react-router` — GHSA-qwww-vcr4-c8h2 (8 highs, false positive at our version)

- **Installed:** `react-router@7.18.2` and `@react-router/*@7.18.2` (runtime
  dependency).
- **Why npm audit still flags it:** the maintainers backported the fix and
  [updated their advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2)
  to affected `>= 7.12.0, < 7.18.2` / patched `>= 7.18.2`, but GitHub's
  global advisory database — which `npm audit` consumes — still carries the
  pre-backport range (`>= 7.12.0, < 8.3.0`); the range-split update
  (github/advisory-database PR #8936) has not been merged. Our installed
  7.18.2 is the patched release; the audit hit is stale data, not exposure.
- **Defense in depth:** the advisory only affects applications using the
  unstable RSC APIs. This app uses classic React Router v7 framework mode
  (no RSC configuration anywhere), so the CSRF vector does not apply even to
  vulnerable versions.
- **Not chosen:** downgrade to 7.11.0 (npm's suggested "fix" — sheds a year
  of fixes to re-enter the truly patched-at-7.18.2 range) and forcing v8.3.0
  (outside `@shopify/shopify-app-react-router@1.x`'s `react-router ^7.6.2`
  peer range, untested pairing).
- **Revisit when:** GitHub merges the range split (audit goes quiet on its
  own), or when `@shopify/shopify-app-react-router` supports react-router 8.
