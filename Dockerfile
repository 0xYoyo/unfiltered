# Production image for the whole monorepo (YOY-91).
#
# The app is not a standalone package: apps/shopify-app's Vite build aliases
# @unfiltered/engine and @unfiltered/provider-gemini to their TypeScript
# SOURCE (see apps/shopify-app/vite.config.ts), and the root `postinstall`
# compiles the packages' dist/ (`npm run build:packages`) during install. So
# the build needs the whole workspace tree and the full dependency set — the
# template's app-only Dockerfile could never have built it.
#
# Stage 1 installs everything and builds; stage 2 carries the built tree with
# dev dependencies pruned away.

FROM node:22-alpine AS builder

# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

WORKDIR /app

# NODE_ENV stays unset (development) here: the build needs the dev
# dependencies npm would skip under production.

# The whole tree is copied before installing rather than manifests-first: the
# root `postinstall` compiles the workspace packages' src/ during install, so
# a manifest-only layer cannot work here.
COPY . .

# One install. The packages carry no `prepare` hooks any more (YOY-96 AC-12):
# npm used to run them concurrently, so provider-gemini's `tsc` raced
# engine's while typing against engine's dist/, and losing that race failed
# the install — this file worked around it with a two-phase install. The root
# `postinstall` now runs `build:packages`, which compiles engine and then
# provider-gemini in that order, so the build order is explicit and the same
# on every install.
RUN npm ci

# The app's React Router server and client build. `npm ci` above already ran
# the root postinstall (packages' dist/) and the app's postinstall (prisma
# generate).
RUN npm run build --workspace app

# Drop dev dependencies from the tree the runtime stage copies. `npm prune`
# does not re-run lifecycle scripts, so the generated Prisma client and the
# compiled package dist/ survive it.
RUN npm prune --omit=dev

FROM node:22-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# The built server bundle externalises node_modules and resolves the
# workspace packages through symlinks into packages/, so the runtime needs
# the pruned tree as a whole, not just apps/shopify-app/build.
COPY --from=builder /app /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
