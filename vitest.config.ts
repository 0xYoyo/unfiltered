import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/app/**/*.test.{ts,tsx}",
      "packages/*/test/**/*.test.ts",
    ],
  },
});
