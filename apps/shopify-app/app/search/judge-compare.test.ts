import { describe, expect, it } from "vitest";

import { judgeCompareCommand, medianOf, stabilityCounts } from "./judge-compare.server";

// The judge comparison's local measures (YOY-152 AC-7) as pure units; the
// command itself is live and paid, so only its usage refusal runs here.
describe("the judge comparison measures (YOY-152 AC-7)", () => {
  it("takes the median of odd and even lists, null when empty", () => {
    expect(medianOf([900, 300, 500])).toBe(500);
    expect(medianOf([400, 100, 300, 200])).toBe(250);
    expect(medianOf([])).toBeNull();
  });

  it("counts a product identical only when every run gave it the same verdict", () => {
    const run = (entries: Array<[string, string]>) => new Map(entries);
    expect(
      stabilityCounts([
        run([["a", "exact"], ["b", "close"], ["c", "close"]]),
        run([["a", "exact"], ["b", "exact"], ["c", "close"]]),
        run([["a", "exact"], ["b", "close"]]),
      ]),
    ).toEqual({ identical: 1, products: 3 });
    expect(stabilityCounts([])).toEqual({ identical: 0, products: 0 });
  });

  it("refuses to start without a known judge", async () => {
    const lines: string[] = [];
    expect(await judgeCompareCommand([], (line) => lines.push(line))).toBe(2);
    expect(await judgeCompareCommand(["--judge", "gpt"], (line) => lines.push(line))).toBe(2);
    expect(lines[0]).toBe("usage: judge-compare.mts --judge gemini|jev");
  });
});
