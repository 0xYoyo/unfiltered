import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Guards the engine-boundary rule from docs/ARCHITECTURE.md: the engine is
// catalog-agnostic and must never depend on or import Shopify libraries.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function listFilesRecursive(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    return statSync(fullPath).isDirectory()
      ? listFilesRecursive(fullPath)
      : [fullPath];
  });
}

describe("engine boundary", () => {
  it("declares no @shopify/* package in any dependency field", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;

    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const deps = (manifest[field] ?? {}) as Record<string, string>;
      const shopifyDeps = Object.keys(deps).filter((name) =>
        name.startsWith("@shopify/"),
      );
      expect(shopifyDeps, `${field} must not contain @shopify/* packages`).toEqual([]);
    }
  });

  it("contains no reference to Shopify packages in source", () => {
    for (const file of listFilesRecursive(join(packageRoot, "src"))) {
      const content = readFileSync(file, "utf8");
      expect(content.includes("@shopify/"), `${file} must not reference @shopify/*`).toBe(
        false,
      );
    }
  });
});
