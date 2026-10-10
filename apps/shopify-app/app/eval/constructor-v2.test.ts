import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "../testing/helpers.server";
import {
  formatConstructorV2Report,
  isGuestDressGolden,
  loadConstructorV2Floor,
  runConstructorV2,
  summarizeV2,
  v2Breaches,
  type ConstructorV2Result,
} from "./constructor-v2.server";
import {
  CONSTRUCTOR_GROUPS,
  loadConstructorGoldens,
  type ConstructorGolden,
} from "./harness.server";
import { createReplayDecisionClient, decisionRecordingKey } from "./replay.server";
import { assertEngineSourceExecution } from "./source-guard.server";

// The Constructor-bar set on Engine v2 (YOY-153 AC-2, AC-3): offline and
// deterministic over fixtures/recorded/{card,extract,judge-jev,embeddings-v2}.json,
// recorded by constructor-v2-regen.test.ts.
assertEngineSourceExecution();

const goldens = loadConstructorGoldens();
const golden = (id: string): ConstructorGolden => goldens.find((entry) => entry.id === id)!;

describe("the v2 assertions (AC-2)", () => {
  const entry = (productId: string, verdict: string | null = "exact", overBudget = false) => ({
    productId,
    verdict,
    overBudget,
  });

  it("flags an excluded product anywhere on a negation page", () => {
    expect(v2Breaches(golden("cn01"), [entry("p04"), entry("p05")], null)).toEqual([]);
    expect(v2Breaches(golden("cn01"), [entry("p04"), entry("p05"), entry("p09"), entry("p06")], null)).toEqual([
      "p06: excluded by the query, yet on page 1",
    ]);
  });

  it("flags a price-cap page that leads over budget or puts over-budget ahead of in-budget within a verdict", () => {
    const cp01 = golden("cp01");
    // The engine's order: verdict first, then price tier — an exact
    // over-budget dress may precede a close in-budget one.
    const composed = [entry("p05"), entry("p70", "exact", true), entry("p62", "close"), entry("p01", "close", true)];
    expect(v2Breaches(cp01, composed, "150")).toEqual([]);
    expect(v2Breaches(cp01, [entry("p70", "exact", true), entry("p05")], "150")).toEqual([
      "p70: over budget, yet it leads the page",
      "p70: over budget at rank 1, ahead of in-budget p05 with the same verdict (exact)",
    ]);
    expect(v2Breaches(cp01, [entry("p05"), entry("p70", "close", true), entry("p62", "close")], "150")).toEqual([
      "p70: over budget at rank 2, ahead of in-budget p62 with the same verdict (close)",
    ]);
    // A cap the extraction never read leaves nothing to compose against.
    expect(v2Breaches(cp01, [entry("p05")], null)).toEqual(["no price cap was read from the query"]);
  });

  it("flags a bridal gown leading a guest-dress query, and only a guest-dress query", () => {
    expect(isGuestDressGolden(golden("co01"))).toBe(true);
    expect(isGuestDressGolden(golden("co03"))).toBe(true);
    expect(isGuestDressGolden(golden("co02"))).toBe(false);
    // "dress under 150" forbids the gowns too, but it is a price golden.
    expect(isGuestDressGolden(golden("cp01"))).toBe(false);
    expect(v2Breaches(golden("co01"), [entry("p69"), entry("p67")], null)).toEqual([]);
    expect(v2Breaches(golden("co01"), [entry("p67"), entry("p69")], null)).toEqual([
      "p67: a bridal gown leads a guest-dress query",
    ]);
    // "wedding dress" is the bridal query: a gown leading it is the point.
    expect(v2Breaches(golden("co02"), [entry("p67")], null)).toEqual([]);
  });

  it("summarizes hit rate, top-10 mustNot leak and breaches per group", () => {
    const summary = summarizeV2([
      { golden: golden("cn01"), routeReason: "judged", pageIds: [], page: [], priceCap: null, firstExpectedRank: 1, mustNotInTop10: [], breaches: [] },
      { golden: golden("cn02"), routeReason: "judged", pageIds: [], page: [], priceCap: null, firstExpectedRank: null, mustNotInTop10: ["p06"], breaches: ["x"] },
    ]);
    expect(summary.negation).toEqual({ hits: 1, total: 2, hitRatePercent: 50, mustNotViolations: 1, breaches: 1 });
    expect(summary.priceCap.total).toBe(0);
  });
});

describe("the Jev replay client", () => {
  it("answers and meters a recorded decision, and throws on a missing one", async () => {
    const request = {
      state: { search: "dress", product: "Red Dress | 100 ILS" },
      questions: { verdict: { type: "yes-no" as const, instructions: "?", criteria: { yes: "y", no: "n" } } },
      operation: "judge",
    };
    const metered: string[] = [];
    const client = createReplayDecisionClient({
      recording: {
        modelId: "typesafe/jev-1.13",
        provider: "openrouter",
        entries: {
          [decisionRecordingKey(request)]: {
            answers: { verdict: { type: "yes-no", yes: 0.9 } },
            inputTokens: 700,
            outputTokens: 0,
          },
        },
      },
      costRecorder: {
        async record(usage) {
          metered.push(`${usage.provider}:${usage.modelId}:${usage.operation}:${usage.inputTokens}`);
        },
      },
    });
    expect(decisionRecordingKey(request)).toMatch(/^dress#[0-9a-f]{16}$/);
    await expect(client.decide(request)).resolves.toEqual({ verdict: { type: "yes-no", yes: 0.9 } });
    expect(metered).toEqual(["openrouter:typesafe/jev-1.13:judge:700"]);
    const changed = { ...request, state: { ...request.state, product: "Red Dress | 120 ILS" } };
    await expect(client.decide(changed)).rejects.toThrow(/no recorded judge decision/);
  });
});

describe("the Constructor bar on Engine v2 (AC-2, AC-3)", () => {
  let result: ConstructorV2Result;
  beforeAll(async () => {
    result = await runConstructorV2(await createTestDb());
    console.log(formatConstructorV2Report(result, loadConstructorV2Floor()));
  }, 300_000);

  it("runs all 30 goldens through Engine v2 with the jev judge, every page judged", () => {
    expect(result.scores).toHaveLength(30);
    expect(result.cardsWritten).toBe(result.catalogSize);
    expect(result.scores.every((score) => score.routeReason === "judged")).toBe(true);
    expect(loadConstructorV2Floor().judge).toMatch(/^jev:/);
  });

  it("never shows an excluded product on a negation page", () => {
    const breaches = result.scores
      .filter((score) => score.golden.group === "negation")
      .flatMap((score) => score.breaches.map((breach) => `${score.golden.id} ${breach}`));
    expect(breaches).toEqual([]);
  });

  it("leads every price-cap page in budget and puts in-budget before over-budget within each verdict", () => {
    const breaches = result.scores
      .filter((score) => score.golden.group === "priceCap")
      .flatMap((score) => score.breaches.map((breach) => `${score.golden.id} ${breach}`));
    expect(breaches).toEqual([]);
  });

  it("never leads a guest-dress query with a bridal gown", () => {
    const guest = result.scores.filter((score) => isGuestDressGolden(score.golden));
    expect(guest.map((score) => score.golden.id).sort()).toEqual(["co01", "co03"]);
    for (const score of guest) {
      expect(score.breaches, score.golden.id).toEqual([]);
    }
  });

  it("holds the recorded v2 floor in every group (AC-3)", () => {
    const floor = loadConstructorV2Floor();
    for (const group of CONSTRUCTOR_GROUPS) {
      const measured = result.byGroup[group];
      const misses = result.scores
        .filter((score) => score.golden.group === group && score.firstExpectedRank === null)
        .map((score) => score.golden.id);
      expect(
        measured.hitRatePercent,
        `${group}: hit rate ${measured.hitRatePercent} % below the floor ${floor.byGroup[group].hitRatePercent} %; misses ${misses.join(", ")}`,
      ).toBeGreaterThanOrEqual(floor.byGroup[group].hitRatePercent);
      expect(measured.mustNotViolations, `${group}: mustNot leak in the top 10`).toBeLessThanOrEqual(
        floor.byGroup[group].mustNotViolationsMax,
      );
    }
  });

  it("records the v2 floor as whole numbers", () => {
    const floor = loadConstructorV2Floor();
    for (const group of CONSTRUCTOR_GROUPS) {
      expect(Number.isInteger(floor.byGroup[group].hitRatePercent)).toBe(true);
      expect(Number.isInteger(floor.byGroup[group].mustNotViolationsMax)).toBe(true);
    }
  });

  it("meters every judge decision under the Jev model on the ledger", () => {
    expect(result.judgeLedger).toHaveLength(1);
    expect(result.judgeLedger[0]).toMatchObject({ provider: "openrouter", modelId: "typesafe/jev-1.13" });
    // One decision per judged product: at most a page of 24 per golden.
    expect(result.judgeLedger[0]!.calls).toBeGreaterThan(30);
    expect(result.judgeLedger[0]!.calls).toBeLessThanOrEqual(30 * 24);
  });
});
