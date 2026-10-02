import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "@unfiltered/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_FIXTURE_PATH, readFixtureFile } from "../score/cli.server";
import { decodeVector, importScoreFixture } from "../score/fixture.server";
import { createTestDb } from "../testing/helpers.server";
import { queryCardIndex } from "./card-retrieval.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import { createFindStep, DEFAULT_FIND_SET_SIZE } from "./find.server";

// Find-step recall on the real seed catalog (YOY-145 AC-12): the find step
// owes recall, not order — "long sleeves" is a description wish the judge
// ranks, never the find step. Every long-sleeve midi dress of the committed
// seed fixture must be among the 150 candidates for "long sleeve midi
// dress". Offline: the query's vector is a committed recording of the live
// embedding model's answer (`data/find-recall-query.json`, base64 Float32).

interface QueryRecording {
  query: string;
  modelId: string;
  dimension: number;
  vector: string;
}

const RECORDING = JSON.parse(
  readFileSync(join(import.meta.dirname, "data", "find-recall-query.json"), "utf8"),
) as QueryRecording;

describe("find-step recall on the seed catalog (AC-12)", () => {
  let db: PrismaClient;
  let storeKey: string;

  beforeAll(async () => {
    const fixture = readFixtureFile(DEFAULT_FIXTURE_PATH);
    storeKey = fixture.storeKey;
    db = await createTestDb();
    await importScoreFixture(db, fixture);
  }, 120_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("holds every long-sleeve midi dress among the 150 candidates for 'long sleeve midi dress'", async () => {
    const vector = decodeVector(RECORDING.vector);
    expect(vector).toHaveLength(RECORDING.dimension);
    const embeddings: EmbeddingClient = {
      dimension: RECORDING.dimension,
      embed: async ({ texts }) => {
        expect(texts).toEqual([RECORDING.query]);
        return [vector];
      },
    };
    // The find step's own vector half, captured as it runs.
    let candidates: string[] = [];
    const find = createFindStep({
      db,
      embeddings,
      classicStore: createPgTrgmClassicStore(db),
      nearest: async (request) => {
        expect(request.limit).toBe(DEFAULT_FIND_SET_SIZE);
        const hits = await queryCardIndex(request);
        candidates = hits.map((hit) => hit.productId);
        return hits;
      },
    });
    const result = await find.find({ shopDomain: storeKey, query: RECORDING.query, searchId: "recall" });
    expect(result.degraded).toBe(false);
    expect(candidates).toHaveLength(DEFAULT_FIND_SET_SIZE);

    const targets = await db.productEnrichment.findMany({
      where: { shopDomain: storeKey, category: "dress", sleeveLength: "long", garmentLength: "midi" },
      select: { productId: true },
    });
    // The seed catalog holds four; a re-export that loses them all must fail here, not pass vacuously.
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const { productId } of targets) {
      expect(candidates).toContain(productId);
      expect(result.productIds).toContain(productId);
    }
  });
});
