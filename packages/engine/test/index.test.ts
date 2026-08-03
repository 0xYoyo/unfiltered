import { describe, expect, it } from "vitest";

import { createEngine, version, type SearchResult } from "../src/index.js";

describe("engine public API stub", () => {
  it("exposes the API contract version", () => {
    expect(version).toBe("0.2.0");
    expect(createEngine().version).toBe(version);
  });

  it("returns the typed empty result for any search", async () => {
    const engine = createEngine();
    const result: SearchResult = await engine.search("summer dress", {
      limit: 5,
      offset: 0,
    });

    expect(result).toEqual({
      hits: [],
      totalCount: 0,
      query: "summer dress",
    });
  });
});
