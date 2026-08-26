#!/bin/sh
# Container entrypoint (YOY-91): migrate, then serve.
#
# A running app pointed at an unmigrated or absent database is the failure
# mode worth spending a boot on: it answers 200 on /healthz (which never
# touches the DB) while every search 500s. So the container refuses to start
# unless the database is configured and every migration applies.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: DATABASE_URL is not set. The app cannot run without a database; refusing to start." >&2
  exit 1
fi

# Migrations run over the direct (unpooled) connection (YOY-115 AC-5, Prisma
# `directUrl`); an environment that has not split its URLs yet — one
# unpooled DATABASE_URL — keeps working because the direct URL defaults to it.
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"

cd /app/apps/shopify-app

echo "Applying database migrations (prisma migrate deploy)..."
npx --no-install prisma migrate deploy

echo "Starting server on port ${PORT:-3000}..."
exec npx --no-install react-router-serve ./build/server/index.js
