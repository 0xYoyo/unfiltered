import { fileURLToPath } from "node:url";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Replace the HOST env var with SHOPIFY_APP_URL so that it doesn't break the Vite server.
// The CLI will eventually stop passing in HOST,
// so we can remove this workaround after the next major release.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: 443,
  };
}

// Workspace packages resolve to their TypeScript source, never to compiled
// dist/ (YOY-104, Option A). Each package's package.json `exports` points at
// dist/, which is gitignored and rebuilt only by npm install's prepare hook —
// so the running app used to execute whatever dist happened to be on disk,
// while every test ran the source through the root vitest.config.ts alias.
// PR #74's port rename (shopDomain → storeId) landed in src and in the app
// but not in a dev tree's Aug-9 dist: every AI-routed search returned zero
// rows and every AiCall lost its tenant, and nothing went red because no
// test ran through dist. Aliasing the app to src makes the app, the tests,
// and the eval runs execute one and the same code; dist/ is off every
// execution path in this repo (kept for future package publishing only).
// Keep these two entries identical to the root vitest.config.ts alias
// (app/workspace-resolution.test.ts asserts it); CI's dist-seam job
// (vitest.dist-seam.config.ts, no alias) separately proves the built
// artifact still honours the same port contract. See docs/ARCHITECTURE.md,
// "How the app resolves the workspace packages".
export const workspaceSourceAlias = {
  "@unfiltered/engine": fileURLToPath(
    new URL("../../packages/engine/src/index.ts", import.meta.url),
  ),
  "@unfiltered/provider-gemini": fileURLToPath(
    new URL("../../packages/provider-gemini/src/index.ts", import.meta.url),
  ),
} as const;

export default defineConfig({
  resolve: {
    alias: workspaceSourceAlias,
  },
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig;
