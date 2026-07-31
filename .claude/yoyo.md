# Yoyo-loop config

repo_slug: unfiltered
linear_team: YOY
test_command: (none yet — bootstrap install; first spec must add a test suite)
lint_command: (none yet)
typecheck_command: (none yet)

sensitive_paths:
  - .github/workflows/
  - migrations/
  - "**/*.env*"
  - package.json
  - Makefile
  - shopify.app.toml
  - "**/billing/**"
  - "**/auth/**"
  - "**/webhooks/**"

max_fix_rounds: 2
