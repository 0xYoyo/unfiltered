import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Mechanical guards on the playground's stylesheets (YOY-92 AC-2, AC-3).
 *
 * Two invariants are cheap to state and easy to break by accident:
 * P-8 (tokens, never literals) and F-5 (logical properties, so the Hebrew
 * chrome mirrors without a second rule). Both are greppable, so they are
 * asserted here rather than left to review.
 */

const PLAYGROUND_DIR = join(import.meta.dirname, ".");
const TOKENS_FILE = "tokens.css";

function playgroundStylesheets(): { name: string; source: string }[] {
  return readdirSync(PLAYGROUND_DIR)
    .filter((name) => name.endsWith(".css"))
    .map((name) => ({
      name,
      source: readFileSync(join(PLAYGROUND_DIR, name), "utf8"),
    }));
}

/**
 * Comments hold prose (and issue IDs like "1px"), and a media query's
 * prelude cannot take a custom property — `@media (max-width: var(--x))` is
 * invalid CSS in every engine. Both are stripped before scanning so the
 * guard fails on real literals only.
 */
function scannableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^{]*\{/g, "{");
}

describe("playground stylesheets", () => {
  it("finds the stylesheets it is meant to guard", () => {
    const names = playgroundStylesheets().map((sheet) => sheet.name);
    expect(names).toContain(TOKENS_FILE);
    expect(names).toContain("playground.css");
  });

  it("uses no raw hex colour outside the token definitions (P-8)", () => {
    for (const { name, source } of playgroundStylesheets()) {
      if (name === TOKENS_FILE) {
        continue;
      }
      const hex = scannableSource(source).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hex, `${name} carries raw hex colours`).toEqual([]);
    }
  });

  it("uses no raw pixel literal outside the token definitions (P-8)", () => {
    for (const { name, source } of playgroundStylesheets()) {
      if (name === TOKENS_FILE) {
        continue;
      }
      const pixels = scannableSource(source).match(/\b\d+(\.\d+)?px\b/g) ?? [];
      expect(pixels, `${name} carries raw pixel literals`).toEqual([]);
    }
  });

  it("uses logical properties only, never left/right (F-5)", () => {
    const physical =
      /(^|[;{\s])(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*(left|right))\s*:/g;
    for (const { name, source } of playgroundStylesheets()) {
      const found = scannableSource(source).match(physical) ?? [];
      expect(found, `${name} carries physical direction properties`).toEqual(
        [],
      );
    }
  });

  it("defines exactly the DESIGN §2 colour roles, and no other chromatic token", () => {
    const tokens = readFileSync(join(PLAYGROUND_DIR, TOKENS_FILE), "utf8");
    const roles = [
      "--bg",
      "--surface",
      "--text",
      "--text-muted",
      "--border",
      "--accent",
      "--accent-contrast",
    ];
    for (const role of roles) {
      // Defined twice: once for light, once under prefers-color-scheme.
      const definitions = tokens.match(
        new RegExp(`${role}:\\s*#[0-9a-fA-F]{3,8}`, "g"),
      );
      expect(definitions, `${role} is missing a theme`).toHaveLength(2);
    }

    // Every hex in the file belongs to one of those roles: a new colour
    // token is a DESIGN change, not a CSS change.
    const assignments =
      tokens.match(/--[a-z-]+:\s*#[0-9a-fA-F]{3,8}/g) ?? [];
    const named = assignments.map((line) => line.split(":")[0].trim());
    expect([...new Set(named)].sort()).toEqual([...roles].sort());
  });

  it("keeps the type scale to the six DESIGN sizes", () => {
    const tokens = readFileSync(join(PLAYGROUND_DIR, TOKENS_FILE), "utf8");
    for (const size of [13, 16, 20, 25, 31, 39]) {
      expect(tokens).toContain(`--type-${size}: ${size}px;`);
    }
  });
});

describe("the guards themselves fail on a violation", () => {
  // A lint test that cannot fail is decoration; these prove the patterns
  // catch what AC-2 and AC-3 name (verify step 9).
  it("catches a raw hex", () => {
    const source = scannableSource(".card { color: #fff; }");
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual(["#fff"]);
  });

  it("catches a raw pixel literal", () => {
    const source = scannableSource(".card { padding: 12px; }");
    expect(source.match(/\b\d+(\.\d+)?px\b/g)).toEqual(["12px"]);
  });

  it("catches a physical direction property", () => {
    const physical =
      /(^|[;{\s])(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*(left|right))\s*:/g;
    expect(".card { left: 0; }".match(physical)).not.toEqual([]);
    expect(".card { margin-left: 0; }".match(physical)).not.toBeNull();
  });

  it("does not flag a media query prelude or a comment", () => {
    const source = scannableSource(
      "/* 1px note */ @media (max-width: 640px) { .card { gap: var(--space-8); } }",
    );
    expect(source.match(/\b\d+(\.\d+)?px\b/g)).toBeNull();
  });
});
