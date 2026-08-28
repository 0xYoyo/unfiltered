import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * AC-2's own guard: every `F-*` floor and every `P-*` playground invariant
 * stated in docs/DESIGN.md must be named by a test in
 * `test-ui/design-invariants.spec.ts`.
 *
 * Without this, the mapping is a claim made once in a PR description and
 * never checked again — a new invariant would land with no assertion behind
 * it and nothing would go red. The Playwright specs cannot assert this
 * about themselves, so it lives in the unit suite, which reads both files as
 * text.
 *
 * W-* and A-* are deliberately out of scope: the widget's project has its
 * own lane and the admin is Polaris.
 */

const DESIGN_DOC = join(import.meta.dirname, "../../../../docs/DESIGN.md");
const INVARIANT_SPEC = join(
  import.meta.dirname,
  "test-ui/design-invariants.spec.ts",
);

/** Every invariant ID docs/DESIGN.md §1 states, in document order. */
function statedInvariants(): string[] {
  const design = readFileSync(DESIGN_DOC, "utf8");
  return [...design.matchAll(/^- \*\*([FP]-\d+)/gm)].map((match) => match[1]);
}

/** Every invariant ID a test in the spec names, in file order. */
function assertedInvariants(): string[] {
  const spec = readFileSync(INVARIANT_SPEC, "utf8");
  return [...spec.matchAll(/^\s*test\("([FP]-\d+)/gm)].map((match) => match[1]);
}

describe("design invariant coverage (YOY-123 AC-2)", () => {
  it("reads a plausible number of invariants from docs/DESIGN.md", () => {
    // A regex that silently stopped matching would make every assertion
    // below vacuously true.
    expect(statedInvariants().length).toBeGreaterThanOrEqual(15);
    expect(assertedInvariants().length).toBeGreaterThanOrEqual(15);
  });

  it("names every F-* and P-* invariant in a Playwright test title", () => {
    const asserted = new Set(assertedInvariants());
    const missing = statedInvariants().filter((id) => !asserted.has(id));
    expect(missing, "invariants with no named assertion").toEqual([]);
  });

  it("asserts nothing docs/DESIGN.md does not state", () => {
    const stated = new Set(statedInvariants());
    const orphaned = assertedInvariants().filter((id) => !stated.has(id));
    expect(orphaned, "tests for invariants that no longer exist").toEqual([]);
  });

  it("names each invariant exactly once", () => {
    const seen = new Map<string, number>();
    for (const id of assertedInvariants()) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  });
});
