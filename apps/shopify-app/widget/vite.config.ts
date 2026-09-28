import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

/**
 * Widget bundle build + dev harness server (YOY-43).
 *
 * `vite build --config widget/vite.config.ts` emits the self-contained IIFE
 * bundle and stylesheet into the theme app extension's assets/ directory
 * (the output the extension serves — built in CI and by predeploy, not
 * committed). `vite --config ...`
 * serves this directory as the local dev harness: index.html (theme-like
 * search form + stubbed search endpoint) and no-search-form.html, importing
 * the widget source directly — no Shopify and no network.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: fileURLToPath(
      new URL("../extensions/unfiltered-widget/assets", import.meta.url),
    ),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
      name: "UnfilteredWidget",
      formats: ["iife"],
      fileName: () => "unfiltered-widget.js",
      cssFileName: "unfiltered-widget",
    },
  },
});
