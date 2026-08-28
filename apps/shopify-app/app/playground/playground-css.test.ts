import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Mechanical guards on the playground's stylesheets (YOY-92 AC-2, AC-3;
 * YOY-123 AC-1).
 *
 * Three invariants are cheap to state and easy to break by accident: P-8
 * (tokens, never literals), F-5 (logical properties, so the Hebrew chrome
 * mirrors without a second rule), and P-10 (one theme). All three are
 * greppable, so they are asserted here rather than left to review.
 *
 * The fourth guard is AC-1 itself: `tokens.css` must be byte-identical to
 * the CSS block in docs/DESIGN.md §2, so a token cannot drift from the
 * direction that authorised it.
 */

const PLAYGROUND_DIR = join(import.meta.dirname, ".");
const TOKENS_FILE = "tokens.css";
const DESIGN_DOC = join(import.meta.dirname, "../../../../docs/DESIGN.md");

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

/** The token declarations of tokens.css: the file minus its header comment. */
function tokenBlock(): string {
  const tokens = readFileSync(join(PLAYGROUND_DIR, TOKENS_FILE), "utf8");
  // The header comment only — `split` would drop everything after the
  // SECOND `*/`, which is where half the token declarations live.
  const end = tokens.indexOf("*/\n");
  return tokens.slice(end + 3).trim();
}

/** The one ```css block in docs/DESIGN.md §2. */
function designTokenBlock(): string {
  const design = readFileSync(DESIGN_DOC, "utf8");
  const section = design.slice(design.indexOf("\n## 2. Direction system"));
  const blocks = [...section.matchAll(/```css\n([\s\S]*?)```/g)];
  expect(blocks, "docs/DESIGN.md §2 holds exactly one css block").toHaveLength(
    1,
  );
  return blocks[0][1].trim();
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

  it("declares one theme and no colour-scheme switch (P-10)", () => {
    for (const { name, source } of playgroundStylesheets()) {
      expect(source, `${name} declares a second theme`).not.toContain(
        "prefers-color-scheme",
      );
    }
  });

  it("holds exactly the tokens docs/DESIGN.md §2 authorises (AC-1)", () => {
    expect(tokenBlock()).toBe(designTokenBlock());
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
      "/* 1px note */ @media (max-width: 640px) { .card { gap: var(--space-2); } }",
    );
    expect(source.match(/\b\d+(\.\d+)?px\b/g)).toBeNull();
  });

  it("would notice a token that drifted from DESIGN §2", () => {
    // The comparison is exact string equality, so a single changed value on
    // either side fails. Proven here rather than asserted about.
    expect(tokenBlock().replace("--space-1:4px", "--space-1:5px")).not.toBe(
      designTokenBlock(),
    );
  });
});
