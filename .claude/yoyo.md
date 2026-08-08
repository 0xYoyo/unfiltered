# Yoyo-loop config

repo_slug: unfiltered
linear_team: YOY
test_command: npm test
lint_command: npm run lint
typecheck_command: npm run typecheck

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
  - ".claude/**"

slack_channel_id: C0BL7QBNER4
max_fix_rounds: 2
