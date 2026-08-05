import { describe, expect, it } from "vitest";

import {
  appliedConstraints,
  composeQueryText,
  constraintsFromIntent,
  createRetriever,
  EmptyQueryTextError,
  type EmbeddingClient,
  type EmbeddingRequest,
  type Intent,
  type RetrievalStore,
  type StoreQueryRequest,
} from "../src/index.js";

// Retrieval orchestration runs on stubs only — no embedding or database
// call anywhere in the default run (AC-6). The real pgvector store port is
// exercised in the app's retrieval-store tests.

const intent: Intent = {
  category: "dress",
  priceMin: undefined,
  priceMax: 400,
  currency: undefined,
  colorsInclude: [],
  colorsExclude: ["black"],
  occasion: "wedding",
  size: undefined,
  availabilityRequired: true,
  softAttributes: ["elegant", "summer"],
};

/** Embedding stub returning a fixed vector and counting calls. */
function embeddingStub(vector = [1, 0, 0]) {
  const calls: EmbeddingRequest[] = [];
  const embeddings: EmbeddingClient = {
    dimension: vector.length,
    async embed(request) {
      calls.push(request);
      return request.texts.map(() => vector);
    },
  };
  return { embeddings, calls };
}

/** Store stub answering every query with the given hits and recording it. */
function storeStub(
  hits: Array<{ productId: string; distance: number }> = [],
) {
  const queries: StoreQueryRequest[] = [];
  const store: RetrievalStore = {
    async query(request) {
      queries.push(request);
      return hits;
    },
  };
  return { store, queries };
}

describe("constraintsFromIntent (AC-1, AC-2)", () => {
  it("maps every hard constraint and never the soft attributes", () => {
    expect(constraintsFromIntent(intent)).toEqual({
      category: "dress",
      priceMin: undefined,
      priceMax: 400,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: "wedding",
      availableOnly: true,
    });
  });

  it("does not map size: it cannot be enforced as a store filter", () => {
    const withSize = { ...intent, size: "M" };
    expect(constraintsFromIntent(withSize)).not.toHaveProperty("size");
  });
});

describe("composeQueryText", () => {
  it("is deterministic with fixed part order and dropped empties", () => {
    expect(composeQueryText(intent)).toBe(
      ["dress", "wedding", "elegant", "summer"].join("\n"),
    );
  });

  it("uses soft attributes alone when no hard descriptors exist", () => {
    const soft: Intent = {
      ...intent,
      category: undefined,
      occasion: undefined,
      colorsExclude: [],
      softAttributes: ["cozy", "warm"],
    };
    expect(composeQueryText(soft)).toBe("cozy\nwarm");
  });
});

describe("retrieve (AC-1, AC-3)", () => {
  it("filters through the store port and returns ranked scored hits", async () => {
    const { embeddings } = embeddingStub([0.5, 0.5, 0]);
    const { store, queries } = storeStub([
      { productId: "p1", distance: 0.1 },
      { productId: "p2", distance: 0.4 },
    ]);
    const retriever = createRetriever({ embeddings, store });

    const result = await retriever.retrieve({
      intent,
      shopDomain: "shop-a.myshopify.com",
      limit: 5,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.shopDomain).toBe("shop-a.myshopify.com");
    expect(queries[0]!.constraints).toEqual(constraintsFromIntent(intent));
    expect(queries[0]!.vector).toEqual([0.5, 0.5, 0]);
    expect(queries[0]!.limit).toBe(5);
    expect(result.hits).toEqual([
      { productId: "p1", score: expect.closeTo(0.9) },
      { productId: "p2", score: expect.closeTo(0.6) },
    ]);
  });

  it("echoes the applied hard constraints with the results (NG-2)", async () => {
    const { embeddings } = embeddingStub();
    const { store } = storeStub();
    const retriever = createRetriever({ embeddings, store });

    const result = await retriever.retrieve({
      intent,
      shopDomain: "shop-a.myshopify.com",
    });

    expect(result.appliedConstraints).toEqual([
      { field: "category", value: "dress" },
      { field: "priceMax", value: "400" },
      { field: "colorsExclude", value: "black" },
      { field: "occasion", value: "wedding" },
      { field: "availability", value: "in stock" },
    ]);
  });

  it("defaults the store limit to 10", async () => {
    const { embeddings } = embeddingStub();
    const { store, queries } = storeStub();
    await createRetriever({ embeddings, store }).retrieve({
      intent,
      shopDomain: "shop-a.myshopify.com",
    });
    expect(queries[0]!.limit).toBe(10);
  });

  it('meters the query embedding as operation "embedding" with context (AC-3)', async () => {
    const { embeddings, calls } = embeddingStub();
    const { store } = storeStub();
    const retriever = createRetriever({ embeddings, store });

    await retriever.retrieve({
      intent,
      shopDomain: "shop-a.myshopify.com",
      searchId: "search-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.operation).toBe("embedding");
    expect(calls[0]!.shopDomain).toBe("shop-a.myshopify.com");
    expect(calls[0]!.searchId).toBe("search-1");
    expect(calls[0]!.texts).toEqual([composeQueryText(intent)]);
  });

  it("caches the query embedding for identical inputs (AC-3)", async () => {
    const { embeddings, calls } = embeddingStub();
    const { store } = storeStub();
    const retriever = createRetriever({ embeddings, store });

    await retriever.retrieve({ intent, shopDomain: "shop-a.myshopify.com" });
    await retriever.retrieve({ intent, shopDomain: "shop-a.myshopify.com" });

    expect(calls).toHaveLength(1);
  });

  it("re-embeds when the intent's descriptive signal differs", async () => {
    const { embeddings, calls } = embeddingStub();
    const { store } = storeStub();
    const retriever = createRetriever({ embeddings, store });

    await retriever.retrieve({ intent, shopDomain: "shop-a.myshopify.com" });
    await retriever.retrieve({
      intent: { ...intent, softAttributes: ["boho"] },
      shopDomain: "shop-a.myshopify.com",
    });

    expect(calls).toHaveLength(2);
  });

  it("evicts the oldest cached embedding once the cache is full", async () => {
    const { embeddings, calls } = embeddingStub();
    const { store } = storeStub();
    const retriever = createRetriever({ embeddings, store, cacheSize: 1 });
    const other: Intent = { ...intent, softAttributes: ["boho"] };

    await retriever.retrieve({ intent, shopDomain: "shop-a.myshopify.com" });
    await retriever.retrieve({ intent: other, shopDomain: "shop-a.myshopify.com" });
    await retriever.retrieve({ intent, shopDomain: "shop-a.myshopify.com" });

    expect(calls).toHaveLength(3);
  });
});

describe("empty query text (YOY-29 AC-9)", () => {
  it("rejects a constraints-only intent with EmptyQueryTextError and zero embedding calls", async () => {
    const { embeddings, calls } = embeddingStub();
    const { store, queries } = storeStub();
    const retriever = createRetriever({ embeddings, store });
    const constraintsOnly: Intent = {
      category: undefined,
      priceMin: undefined,
      priceMax: 400,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: ["black"],
      occasion: undefined,
      size: undefined,
      availabilityRequired: true,
      softAttributes: [],
    };

    await expect(
      retriever.retrieve({
        intent: constraintsOnly,
        shopDomain: "shop-a.myshopify.com",
      }),
    ).rejects.toBeInstanceOf(EmptyQueryTextError);
    expect(calls).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });
});

describe("score range (YOY-29 AC-10)", () => {
  it("returns negative scores for distances above 1, per the documented [-1, 1] contract", async () => {
    const { embeddings } = embeddingStub();
    const { store } = storeStub([{ productId: "p1", distance: 1.75 }]);
    const retriever = createRetriever({ embeddings, store });

    const result = await retriever.retrieve({
      intent,
      shopDomain: "shop-a.myshopify.com",
    });

    expect(result.hits).toEqual([
      { productId: "p1", score: expect.closeTo(-0.75) },
    ]);
  });
});

describe("appliedConstraints", () => {
  it("lists nothing for an unconstrained intent", () => {
    const soft: Intent = {
      category: undefined,
      priceMin: undefined,
      priceMax: undefined,
      currency: undefined,
      colorsInclude: [],
      colorsExclude: [],
      occasion: undefined,
      size: undefined,
      availabilityRequired: false,
      softAttributes: ["cozy"],
    };
    expect(appliedConstraints(constraintsFromIntent(soft))).toEqual([]);
  });
});
