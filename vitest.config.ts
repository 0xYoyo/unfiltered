import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "apps/*/app/**/*.test.{ts,tsx}",
      "packages/*/test/**/*.test.ts",
    ],
  },
});
