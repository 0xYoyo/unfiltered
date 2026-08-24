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
  - render.yaml
  - "**/billing/**"
  - "**/auth/**"
  - "**/webhooks/**"
  - ".claude/**"

ui_paths:
  - apps/shopify-app/extensions/
  - apps/shopify-app/widget/
  - apps/shopify-app/app/playground/
  - apps/shopify-app/app/routes/_index/
  - apps/shopify-app/app/routes/s.$slug.tsx

ui_test_command: npm run test:ui

slack_channel_id: C0BL7QBNER4
max_fix_rounds: 2
