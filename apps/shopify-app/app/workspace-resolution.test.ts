import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import { engineSourceResolutionFailure } from "./eval/source-guard.server";
import appViteConfig, { workspaceSourceAlias } from "../vite.config";

// YOY-104 AC-2: the app executes the workspace source it was tested against.
// The root vitest.config.ts already aliases @unfiltered/* to src for tests,
// so a bare `import { ENGINE_SOURCE_URL } from "@unfiltered/engine"` here
// would prove nothing about the APP's resolution — vitest's own alias would
// satisfy it. This test therefore goes through the app's vite.config.ts:
// the resolution the dev server and `react-router build` actually use.

const ENGINE_SRC_DIR = fileURLToPath(
  new URL("../../../packages/engine/src/", import.meta.url),
);
const PROVIDER_SRC_DIR = fileURLToPath(
  new URL("../../../packages/provider-gemini/src/", import.meta.url),
);

describe("app workspace-package resolution (YOY-104 AC-2)", () => {
  it("vite.config.ts aliases both workspace packages to their src entrypoints", () => {
    const resolved = appViteConfig as { resolve?: { alias?: unknown } };
    expect(resolved.resolve?.alias).toBe(workspaceSourceAlias);

    expect(workspaceSourceAlias["@unfiltered/engine"]).toBe(
      `${ENGINE_SRC_DIR}index.ts`,
    );
    expect(workspaceSourceAlias["@unfiltered/provider-gemini"]).toBe(
      `${PROVIDER_SRC_DIR}index.ts`,
    );
    for (const target of Object.values(workspaceSourceAlias)) {
      expect(existsSync(target), `${target} exists`).toBe(true);
      expect(target).not.toContain("/dist/");
    }
  });

  it("ENGINE_SOURCE_URL resolves under packages/engine/src when loaded through the app's Vite resolution", async () => {
    // A real Vite dev server built from the app's own vite.config.ts — the
    // same resolution `shopify app dev` / `react-router dev` use — loading
    // the bare specifiers exactly as app/search/orchestrator.server.ts does.
    const appRoot = fileURLToPath(new URL("../", import.meta.url));
    const server = await createServer({
      configFile: `${appRoot}vite.config.ts`,
      root: appRoot,
      // No HMR/websocket: the config derives an HMR host from SHOPIFY_APP_URL,
      // which is a placeholder under test.
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
      logLevel: "error",
    });
    try {
      const engine = (await server.ssrLoadModule("@unfiltered/engine")) as {
        ENGINE_SOURCE_URL?: unknown;
      };
      expect(typeof engine.ENGINE_SOURCE_URL).toBe("string");
      expect(engine.ENGINE_SOURCE_URL).toContain("/packages/engine/src/");
      // Same predicate the live-eval source guard enforces: null means "source".
      expect(
        engineSourceResolutionFailure(engine.ENGINE_SOURCE_URL),
      ).toBeNull();

      const provider = await server.pluginContainer.resolveId(
        "@unfiltered/provider-gemini",
        `${appRoot}app/search/orchestrator.server.ts`,
      );
      expect(provider?.id).toBe(
        workspaceSourceAlias["@unfiltered/provider-gemini"],
      );
    } finally {
      await server.close();
    }
  }, 30_000);

  it("mirrors the root vitest.config.ts alias exactly", async () => {
    const rootConfig = (await import("../../../vitest.config")).default as {
      resolve?: { alias?: Record<string, string> };
    };
    expect(rootConfig.resolve?.alias).toEqual(workspaceSourceAlias);
  });
});
