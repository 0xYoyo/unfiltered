import { describe, expect, it } from "vitest";

import type {
  ClassicSearchRequest,
  ClassicSearchStore,
} from "../src/index.js";

// The classic-search port (AC-2): the engine owns the contract, consumers
// implement it. An in-memory implementation proves the request/response
// shapes compose — text query, constraint-only, and limit — without the
// engine gaining any runtime dependency.

function createInMemoryStore(
  rows: Array<{ storeId: string; productId: string; text: string }>,
): ClassicSearchStore {
  return {
    async search(request: ClassicSearchRequest) {
      const query = (request.query ?? "").trim().toLowerCase();
      const hits = rows
        .filter((row) => row.storeId === request.storeId)
        .map((row) => ({
          productId: row.productId,
          score: query === "" ? 0 : row.text.toLowerCase().includes(query) ? 1 : 0,
        }))
        .filter((hit) => query === "" || hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, request.limit ?? 10);
      return { hits };
    },
  };
}

const rows = [
  { storeId: "a.example.com", productId: "p1", text: "Nike Air Max 90" },
  { storeId: "a.example.com", productId: "p2", text: "Linen Beach Dress" },
  { storeId: "b.example.com", productId: "p3", text: "Nike Air Max 90" },
];

describe("ClassicSearchStore port contract", () => {
  it("returns ranked hits for a text query, scoped to the storeId", async () => {
    const store = createInMemoryStore(rows);
    const result = await store.search({
      storeId: "a.example.com",
      query: "nike air max 90",
    });
    expect(result.hits).toEqual([{ productId: "p1", score: 1 }]);
  });

  it("accepts constraint-only requests: no query text, zero scores", async () => {
    const store = createInMemoryStore(rows);
    const result = await store.search({
      storeId: "a.example.com",
      constraints: {
        colorsInclude: [],
        colorsExclude: [],
        availableOnly: false,
      },
    });
    expect(result.hits.map((hit) => hit.score)).toEqual([0, 0]);
  });

  it("honors the limit", async () => {
    const store = createInMemoryStore(rows);
    const result = await store.search({
      storeId: "a.example.com",
      limit: 1,
    });
    expect(result.hits).toHaveLength(1);
  });
});
