import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import type { LlmClient } from "@unfiltered/engine";
import { describe, expect, it, vi } from "vitest";

import type { ScoreSetEntry } from "./set.server";

/**
 * A score run reports what it spent (YOY-157 AC-1). The run's ledger lives in
 * its throwaway database, so the command must read the total before that
 * database goes away and print it under the table. Here the synthetic
 * grader is wrapped in a replay client that writes a fixed cost per call to
 * the run's own ledger, and the printed cost line must carry that total.
 */

const COST_PER_CALL = 0.0025;
const spend = { db: undefined as PrismaClient | undefined, calls: 0 };

vi.mock("./synthetic.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("./synthetic.server")>();
  return {
    ...original,
    createSyntheticOrchestrator: (db: PrismaClient) => {
      spend.db = db;
      return original.createSyntheticOrchestrator(db);
    },
    createSyntheticGrader: async (
      ...args: Parameters<typeof original.createSyntheticGrader>
    ): Promise<LlmClient> => {
      const grader = await original.createSyntheticGrader(...args);
      return {
        async completeStructured(request) {
          const answer = await grader.completeStructured(request);
          await spend.db!.aiCall.create({
            data: {
              provider: "replay",
              modelId: "fixed-cost",
              operation: "score-grade",
              inputTokens: 1,
              outputTokens: 1,
              costUsd: COST_PER_CALL,
            },
          });
          spend.calls += 1;
          return answer;
        },
      };
    },
  };
});

const { runScoreCommand } = await import("./cli.server");

describe("the score run's cost line (YOY-157 AC-1)", () => {
  it("prints the total a fixed-cost replay client spent, under the table, with no query text", async () => {
    const set: ScoreSetEntry[] = [
      { query: "linen shirt", language: "en", source: "log", modelWritten: false },
      { query: "shirt", language: "he", source: "model", modelWritten: false },
      { query: "linen", language: "fr", source: "model", modelWritten: true },
    ];
    const setPath = join(mkdtempSync(join(tmpdir(), "score-cost-")), "set.json");
    writeFileSync(setPath, JSON.stringify(set));

    const out: string[] = [];
    const code = await runScoreCommand(["--synthetic", "--set", setPath], {
      out: (text) => void out.push(text),
      err: () => undefined,
    });

    expect(code).toBe(0);
    expect(spend.calls).toBeGreaterThan(0);
    const lines = out.join("\n").split("\n");
    const costLine = `cost $${(spend.calls * COST_PER_CALL).toFixed(4)} over ${spend.calls} model calls`;
    expect(lines).toContain(costLine);
    // Under the table: after the header and every language row.
    expect(lines.indexOf(costLine)).toBeGreaterThan(lines.findIndex((line) => line.startsWith("language")) + set.length);
    for (const { query } of set) expect(costLine).not.toContain(query);
  });
});
