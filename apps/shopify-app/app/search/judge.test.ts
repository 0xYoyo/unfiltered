import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  buildJudgePrompt,
  createDecisionJudge,
  createJudge,
  createLlmJudge,
  DECISION_JUDGE_QUESTIONS,
  DEFAULT_JUDGE_ROW_CHARS,
  JUDGE_ANSWER_CODES,
  JUDGE_SCHEMA,
  JUDGE_VERDICT_CODES,
  JudgeAnswerError,
  judgeProviderFromEnv,
  judgeRow,
  orderByVerdict,
  parseJudgeAnswer,
  type AiCallUsage,
  type CostRecorder,
  type DecisionAnswer,
  type DecisionClient,
  type DecisionRequest,
  type EmbeddingClient,
  type IntentExtractor,
  type Judge,
  type JudgeCandidate,
  type LlmClient,
  type QueryClassifier,
  type Retriever,
  type StructuredCompletionRequest,
} from "@unfiltered/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aggregateCosts } from "../ai/cost-aggregates.server";
import { createReplayLlmClient, type LlmRecording } from "../eval/replay.server";
import { serializePlaygroundSearchResponse } from "../playground/api.server";
import { createTestDb } from "../testing/helpers.server";
import { createPgTrgmClassicStore } from "./classic-store.server";
import { createFindStep } from "./find.server";
import {
  DEFAULT_JUDGE_DEADLINE_MS,
  judgeDeadlineMsFromEnv,
  judgeRowCharsFromEnv,
  awaitPendingLabels,
  judgeCacheKey,
  judgeGiveUpMsFromEnv,
  loadJudgeCandidates,
  resetPendingLabels,
} from "./judge-step.server";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
  type SearchRequest,
} from "./orchestrator.server";
import { writeClickEvent, writeSearchEvent } from "./events.server";
import { parseLabelsParams, serializeLabels, serializeProxySearchResponse } from "./proxy.server";

// The judge (YOY-147): the engine's prompt, schema and ordering as pure
// units, then the whole v2 path on the embedded PGlite database — the real
// find step, the real card index and keyword store — with the judge's LLM
// port answered from recordings (`createReplayLlmClient`, keyed by the
// prompt's `Query:` line) or a scripted fake where a test needs a sequence
// or a slow answer. Offline and $0.

const SHOP = "judge-shop.myshopify.com";
const DIMENSION = 3;

function candidate(id: string, overrides: Partial<JudgeCandidate> = {}): JudgeCandidate {
  return {
    id,
    title: `Product ${id}`,
    priceMin: 100,
    priceMax: 100,
    currencyCode: "USD",
    options: [],
    facts: `Facts of ${id}`,
    attributes: [],
    description: "",
    ...overrides,
  };
}

/**
 * An answer in the model's wire shape: one three-letter code per candidate
 * (verdict E/V/C/N, missed wishes -/F/D/B, label F/C/X) and the side list of
 * fact-differs values.
 */
function answer(
  codes: string[],
  d: Array<{ n: number; p: string; a: string }> = [],
  x: number[] = [],
) {
  return { c: codes, d, x };
}

/** An LLM port answering a fixed sequence, recording every request. */
function scriptedLlm(
  answers: Array<unknown | (() => Promise<unknown>)>,
): LlmClient & { requests: StructuredCompletionRequest[] } {
  const client = {
    requests: [] as StructuredCompletionRequest[],
    async completeStructured(request: StructuredCompletionRequest) {
      client.requests.push(request);
      const next = answers[Math.min(client.requests.length - 1, answers.length - 1)];
      return typeof next === "function" ? (next as () => Promise<unknown>)() : next;
    },
  };
  return client;
}

/** What a scripted decision model answers for one product. */
interface ScriptedDecision {
  verdict: string;
  fact?: number;
  description?: number;
  excluded?: number;
}

/**
 * A decision port answering per product — found by the `Product <id>` title
 * in the request's row — recording every request. A product scripted as an
 * Error rejects; one missing from the script answers an unknown choice.
 */
function scriptedDecisions(
  script: Record<string, ScriptedDecision | Error>,
): DecisionClient & { requests: DecisionRequest[] } {
  const client = {
    requests: [] as DecisionRequest[],
    async decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>> {
      client.requests.push(request);
      const row = String((request.state as Record<string, unknown>).product);
      const id = /^Product (\S+)/.exec(row)?.[1] ?? "";
      const scripted = script[id];
      if (scripted instanceof Error) {
        throw scripted;
      }
      return {
        verdict: { type: "choice", choice: scripted?.verdict ?? "unknown" },
        fact: { type: "yes-no", yes: scripted?.fact ?? 0.02 },
        description: { type: "yes-no", yes: scripted?.description ?? 0.02 },
        excluded: { type: "yes-no", yes: scripted?.excluded ?? 0.01 },
      };
    },
  };
  return client;
}

describe("the judge's rows and prompt (AC-2, AC-17)", () => {
  it("holds title, price, the card's facts, the vision attributes, then the options, cut to 480 characters", () => {
    const row = judgeRow(
      candidate("a", {
        title: "Aurora Midi Dress",
        priceMin: 80,
        priceMax: 95.5,
        currencyCode: "EUR",
        options: [
          { name: "Color", values: ["Black", "Navy"] },
          { name: "Size", values: ["S", "M"] },
        ],
        facts: "Midi dress   in viscose.\nBack zip.",
        attributes: [
          { name: "sleeve length", value: "long" },
          { name: "neckline", value: "v-neck" },
        ],
      }),
    );
    expect(row).toBe(
      "Aurora Midi Dress | 80–95.5 EUR | Midi dress in viscose. Back zip. | sleeve length: long; neckline: v-neck | Color: Black, Navy; Size: S, M",
    );
    expect(DEFAULT_JUDGE_ROW_CHARS).toBe(480);
    const long = judgeRow(candidate("b", { facts: "x".repeat(1000) }));
    expect(long).toHaveLength(480);
    expect(judgeRow(candidate("b", { facts: "x".repeat(1000) }), 50)).toHaveLength(50);
  });

  it("puts `sleeve length: long` in the row of a product with a long-sleeve attribute (AC-17)", () => {
    const row = judgeRow(
      candidate("d", {
        title: "Taib Dress",
        facts: "Midi dress in crepe.",
        attributes: [
          { name: "sleeve length", value: "long" },
          { name: "garment length", value: "midi" },
        ],
      }),
    );
    expect(row).toContain("sleeve length: long");
    expect(row).toBe("Taib Dress | 100 USD | Midi dress in crepe. | sleeve length: long; garment length: midi");
  });

  it("uses the title and the description's first 200 characters for a product with no card", () => {
    const row = judgeRow(
      candidate("c", { title: "Plain Tee", facts: null, description: "d".repeat(500) }),
      1000,
    );
    expect(row).toBe(`Plain Tee | 100 USD | ${"d".repeat(200)}`);
  });

  it("carries the sentence on a Query line and numbers every row", () => {
    const prompt = buildJudgePrompt("long sleeve  midi dress", [candidate("a"), candidate("b")]);
    expect(prompt).toContain("\nQuery: long sleeve midi dress\n");
    expect(prompt).toContain("\n1. Product a | 100 USD | Facts of a");
    expect(prompt).toContain("\n2. Product b | 100 USD | Facts of b");
  });

  it("asks for exact only when the row meets every stated wish, so a sleeveless dress for long sleeves is close (AC-17)", () => {
    const prompt = buildJudgePrompt("long sleeve midi dress", [
      candidate("a", { attributes: [{ name: "sleeve length", value: "sleeveless" }] }),
    ]);
    // A replay answering `E-X` for this sleeveless dress is not what the
    // prompt asks for: exact needs every stated wish met by the row, and a
    // contradicted or unmentioned wish is close with the description flag.
    expect(prompt).toContain(
      "E = exact: only when every wish the shopper stated is met by the product's row.",
    );
    expect(prompt).toMatch(/C = close: .*a stated wish the row contradicts or does not\nmention/);
    expect(prompt).toContain("Mark it C with the D missed-wish flag");
    expect(prompt).toContain("never E.");
    expect(prompt).toContain("Products with the same verdict keep their search order.");
    expect(prompt).toContain("1. Product a | 100 USD | Facts of a | sleeve length: sleeveless");
  });
});

describe("the judge's answer (AC-3, AC-4, AC-9)", () => {
  const page = [candidate("a"), candidate("b"), candidate("c")];

  it("is fixed-schema JSON with short codes and no prose field", () => {
    expect(Object.keys(JUDGE_SCHEMA.properties as object).sort()).toEqual(["c", "d", "r", "rn", "x"]);
    const side = (JUDGE_SCHEMA.properties as { d: { items: { properties: object } } }).d.items;
    expect(Object.keys(side.properties).sort()).toEqual(["a", "n", "p"]);
    // 4 verdicts × 4 missed-wish flags × 3 label templates.
    expect(JUDGE_ANSWER_CODES).toHaveLength(48);
    expect(JUDGE_ANSWER_CODES).toEqual(expect.arrayContaining(["E-X", "VFF", "CDC", "NBX"]));
    expect(JUDGE_VERDICT_CODES).toEqual({
      E: "exact",
      V: "other-variant",
      C: "close",
      N: "not-relevant",
    });
  });

  it("maps each code back to its candidate, in candidate order", () => {
    const verdicts = parseJudgeAnswer(
      answer(["E-X", "VFF", "CDC"], [{ n: 2, p: "navy", a: "black" }]),
      page,
    );
    expect(verdicts!.verdicts).toEqual([
      { id: "a", verdict: "exact", missed: [], label: null, excluded: false },
      {
        id: "b",
        verdict: "other-variant",
        missed: ["fact"],
        label: { template: "fact-differs", values: ["navy", "black"] },
        excluded: false,
      },
      {
        id: "c",
        verdict: "close",
        missed: ["description"],
        label: { template: "close-match", values: [] },
        excluded: false,
      },
    ]);
    expect(parseJudgeAnswer(answer(["NBX", "E-X", "E-X"]), page)!.verdicts[0]!.missed).toEqual([
      "fact",
      "description",
    ]);
  });

  it("flags excluded candidates and never labels them; x names each candidate once, in range (YOY-149 AC-11)", () => {
    const { verdicts } = parseJudgeAnswer(answer(["E-X", "CDC", "E-X"], [], [2]), page)!;
    expect(verdicts.map((entry) => [entry.id, entry.excluded, entry.label])).toEqual([
      ["a", false, null],
      ["b", true, null],
      ["c", false, null],
    ]);
    // An answer without x reads as no exclusions.
    expect(
      parseJudgeAnswer({ c: ["E-X", "E-X", "E-X"], d: [] }, page)!.verdicts.every((entry) => !entry.excluded),
    ).toBe(true);
    for (const x of [[0], [4], [2, 2], [1.5]]) {
      expect(parseJudgeAnswer(answer(["E-X", "E-X", "E-X"], [], x), page)).toBeNull();
    }
    expect(buildJudgePrompt("dress, not black", [candidate("a")])).toContain("x: the numbers of every product");
  });

  it("rejects an answer that misses or invents a candidate, or breaks the schema", () => {
    expect(parseJudgeAnswer(answer(["E-X", "E-X", "E-X"]), page)).not.toBeNull();
    for (const invalid of [
      answer(["E-X", "E-X"]),
      answer(["E-X", "E-X", "E-X", "E-X"]),
      answer(["E-X", "Z-X", "E-X"]),
      answer(["E-X", "exact", "E-X"]),
      answer(["E-X", "E-X", "E-X"], [{ n: 4, p: "navy", a: "black" }]),
      answer(["E-X", "EFF", "EFF"], [
        { n: 2, p: "navy", a: "black" },
        { n: 2, p: "red", a: "black" },
      ]),
      { c: ["E-X", "E-X", "E-X"], d: [{ n: 1, p: 4, a: "black" }] },
      { c: ["E-X", "E-X", "E-X"] },
      { v: ["E", "E", "E"], d: [] },
      null,
    ]) {
      expect(parseJudgeAnswer(invalid, page)).toBeNull();
    }
  });

  it("drops a fact-differs label whose value runs past three words, keeping the verdict (AC-9)", () => {
    const [first, second, third] = parseJudgeAnswer(
      answer(
        ["CFF", "CFF", "CFF"],
        [
          { n: 1, p: "dark navy blue wool", a: "black" },
          { n: 2, p: "dark navy blue", a: "pure black" },
        ],
      ),
      page,
    )!.verdicts;
    expect(first).toMatchObject({ verdict: "close", label: null });
    expect(second!.label).toEqual({ template: "fact-differs", values: ["dark navy blue", "pure black"] });
    // No values for a fact-differs label: no label.
    expect(third).toMatchObject({ verdict: "close", label: null });
  });

  it("asks once more after an invalid answer, then fails (AC-4)", async () => {
    const valid = answer(["E-X", "CDC", "E-X"]);
    const recovers = scriptedLlm([answer(["E-X"]), valid]);
    const { verdicts } = await createLlmJudge({ llm: recovers }).judge({ sentence: "dress", candidates: page });
    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(["exact", "close", "exact"]);
    expect(recovers.requests).toHaveLength(2);

    const never = scriptedLlm([answer([])]);
    await expect(
      createLlmJudge({ llm: never }).judge({ sentence: "dress", candidates: page }),
    ).rejects.toBeInstanceOf(JudgeAnswerError);
    expect(never.requests).toHaveLength(2);
  });

  it("calls at temperature 0 under operation judge, with the caller's context and signal", async () => {
    const llm = scriptedLlm([answer(["E-X", "E-X", "E-X"])]);
    const signal = new AbortController().signal;
    await createLlmJudge({ llm }).judge({
      sentence: "dress",
      candidates: page,
      storeId: SHOP,
      searchId: "s-9",
      signal,
    });
    expect(llm.requests[0]).toMatchObject({
      operation: "judge",
      temperature: 0,
      schema: JUDGE_SCHEMA,
      storeId: SHOP,
      searchId: "s-9",
      signal,
    });
  });
});

describe("verdict order (AC-5, AC-8)", () => {
  const verdict = (
    id: string,
    code: "exact" | "other-variant" | "close" | "not-relevant",
    excluded = false,
  ) => ({
    id,
    verdict: code,
    missed: [],
    label: null,
    excluded,
  });

  it("drops a product the judge flagged as excluded (YOY-149 AC-11)", () => {
    const ordered = orderByVerdict(
      ["a", "b", "c"],
      [verdict("a", "exact", true), verdict("b", "close"), verdict("c", "exact")],
    );
    expect(ordered.map((item) => item.item)).toEqual(["c", "b"]);
    // The reject-all rule reads the products left on the page.
    expect(
      orderByVerdict(["a", "b"], [verdict("a", "exact", true), verdict("b", "not-relevant")]),
    ).toEqual([{ item: "b", verdict: "not-relevant", label: { template: "close-match", values: [] } }]);
  });

  it("ranks by verdict, ties in find order, not relevant last and never removed", () => {
    const ordered = orderByVerdict(
      ["a", "b", "c", "d", "e", "f"],
      [
        verdict("a", "not-relevant"),
        verdict("b", "close"),
        verdict("c", "exact"),
        verdict("d", "other-variant"),
        verdict("e", "exact"),
        verdict("f", "close"),
      ],
    );
    expect(ordered.map((item) => item.item)).toEqual(["c", "e", "d", "b", "f", "a"]);
  });

  it("serves find order with close-match on every card when every candidate is not relevant", () => {
    const ordered = orderByVerdict(["a", "b"], [verdict("a", "not-relevant"), verdict("b", "not-relevant")]);
    expect(ordered).toEqual([
      { item: "a", verdict: "not-relevant", label: { template: "close-match", values: [] } },
      { item: "b", verdict: "not-relevant", label: { template: "close-match", values: [] } },
    ]);
  });
});

/** One product's intended answer, written once and spoken in each judge's wire form. */
interface PlannedVerdict {
  id: string;
  verdict: "exact" | "other-variant" | "close" | "not-relevant";
  fact?: boolean;
  description?: boolean;
  excluded?: boolean;
}

const VERDICT_LETTER = { exact: "E", "other-variant": "V", close: "C", "not-relevant": "N" } as const;

/** A judge implementation under the shared suite, with a port that fails or answers a plan. */
interface JudgeImplementation {
  name: string;
  answering(plan: PlannedVerdict[]): { judge: Judge; requests: () => Array<{ operation: string; storeId?: string; searchId?: string; signal?: AbortSignal }> };
  failing(error: Error): Judge;
}

const IMPLEMENTATIONS: JudgeImplementation[] = [
  {
    name: "gemini (one call per page)",
    answering(plan) {
      // A close or other-variant product carries C (close-match), the label
      // both judges can write; an excluded one is listed in x.
      const codes = plan.map((entry) => {
        const missed = entry.fact && entry.description ? "B" : entry.fact ? "F" : entry.description ? "D" : "-";
        const label = entry.verdict === "close" || entry.verdict === "other-variant" ? "C" : "X";
        return `${VERDICT_LETTER[entry.verdict]}${missed}${label}`;
      });
      const x = plan.flatMap((entry, index) => (entry.excluded ? [index + 1] : []));
      const llm = scriptedLlm([{ c: codes, d: [], x, r: "", rn: [] }]);
      return { judge: createLlmJudge({ llm }), requests: () => llm.requests };
    },
    failing(error) {
      return createLlmJudge({ llm: scriptedLlm([() => Promise.reject(error)]) });
    },
  },
  {
    name: "jev (one question set per product, in parallel)",
    answering(plan) {
      const decisions = scriptedDecisions(
        Object.fromEntries(
          plan.map((entry) => [
            entry.id,
            {
              verdict: entry.verdict,
              fact: entry.fact ? 0.9 : 0.1,
              description: entry.description ? 0.8 : 0.2,
              excluded: entry.excluded ? 0.95 : 0.05,
            },
          ]),
        ),
      );
      return { judge: createDecisionJudge({ decisions }), requests: () => decisions.requests };
    },
    failing(error) {
      return createDecisionJudge({
        decisions: { decide: () => Promise.reject(error) },
      });
    },
  },
];

// One shared suite for both judges (YOY-152 AC-4): the same plan, spoken
// in each judge's wire form, must come back as the same answer.
describe.each(IMPLEMENTATIONS)("the shared judge suite: $name (YOY-152 AC-4)", (implementation) => {
  const page = ["a", "b", "c", "d", "e"].map((id) => candidate(id));

  it("answers one verdict per candidate, in candidate order, with its missed wishes", async () => {
    const { judge } = implementation.answering([
      { id: "a", verdict: "not-relevant" },
      { id: "b", verdict: "close", description: true },
      { id: "c", verdict: "exact" },
      { id: "d", verdict: "other-variant", fact: true },
      { id: "e", verdict: "close", fact: true, description: true },
    ]);
    const answered = await judge.judge({ sentence: "long sleeve dress", candidates: page });
    expect(answered.verdicts).toEqual([
      { id: "a", verdict: "not-relevant", missed: [], label: null, excluded: false },
      { id: "b", verdict: "close", missed: ["description"], label: { template: "close-match", values: [] }, excluded: false },
      { id: "c", verdict: "exact", missed: [], label: null, excluded: false },
      { id: "d", verdict: "other-variant", missed: ["fact"], label: { template: "close-match", values: [] }, excluded: false },
      { id: "e", verdict: "close", missed: ["fact", "description"], label: { template: "close-match", values: [] }, excluded: false },
    ]);
    expect(answered.otherReading).toBeNull();
    expect(orderByVerdict(page, answered.verdicts).map((entry) => entry.item.id)).toEqual(["c", "d", "b", "e", "a"]);
  });

  it("flags an excluded candidate and never labels it", async () => {
    const { judge } = implementation.answering([
      { id: "a", verdict: "close", excluded: true },
      { id: "b", verdict: "exact" },
    ]);
    const answered = await judge.judge({ sentence: "dress not in black", candidates: page.slice(0, 2) });
    expect(answered.verdicts[0]).toMatchObject({ id: "a", excluded: true, label: null });
    expect(answered.verdicts[1]).toMatchObject({ id: "b", excluded: false });
    expect(orderByVerdict(page.slice(0, 2), answered.verdicts).map((entry) => entry.item.id)).toEqual(["b"]);
  });

  it("calls under operation judge with the caller's store, search and signal", async () => {
    const { judge, requests } = implementation.answering([{ id: "a", verdict: "exact" }]);
    const signal = new AbortController().signal;
    await judge.judge({ sentence: "dress", candidates: page.slice(0, 1), storeId: SHOP, searchId: "s-1", signal });
    expect(requests().length).toBeGreaterThan(0);
    for (const request of requests()) {
      expect(request).toMatchObject({ operation: "judge", storeId: SHOP, searchId: "s-1", signal });
    }
  });

  it("rejects when the port fails, so the page is served in find order", async () => {
    await expect(
      implementation.failing(new Error("upstream down")).judge({ sentence: "dress", candidates: page }),
    ).rejects.toThrow(/upstream down/);
  });
});

describe("the decision judge (YOY-152 AC-2, AC-3)", () => {
  it("asks one question set per product, all 24 in parallel: the verdict as pick-one, each flag and the exclusion as yes/no", async () => {
    const page = Array.from({ length: 24 }, (_, index) => candidate(`p${index}`));
    let inFlight = 0;
    let peak = 0;
    const requests: DecisionRequest[] = [];
    const decisions: DecisionClient = {
      async decide(request) {
        requests.push(request);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          verdict: { type: "choice", choice: "close" },
          fact: { type: "yes-no", yes: 0.1 },
          description: { type: "yes-no", yes: 0.7 },
          excluded: { type: "yes-no", yes: 0.1 },
        };
      },
    };
    const answered = await createDecisionJudge({ decisions }).judge({ sentence: "  long   sleeve dress ", candidates: page });
    expect(requests).toHaveLength(24);
    expect(peak).toBe(24);
    expect(answered.verdicts).toHaveLength(24);
    expect(requests[3]!.state).toEqual({ search: "long sleeve dress", product: judgeRow(page[3]!) });
    expect(requests[0]!.questions).toEqual(DECISION_JUDGE_QUESTIONS);
    expect(Object.fromEntries(Object.entries(DECISION_JUDGE_QUESTIONS).map(([key, question]) => [key, question.type]))).toEqual({
      verdict: "choice",
      fact: "yes-no",
      description: "yes-no",
      excluded: "yes-no",
    });
    expect(Object.keys((DECISION_JUDGE_QUESTIONS.verdict as { criteria: Record<string, string> }).criteria)).toEqual([
      "exact",
      "other-variant",
      "close",
      "not-relevant",
    ]);
  });

  it("fails only the candidate whose question failed, into not relevant", async () => {
    const decisions = scriptedDecisions({
      a: { verdict: "exact" },
      b: new Error("one question failed"),
      c: { verdict: "close", description: 0.9 },
    });
    const page = ["a", "b", "c", "d"].map((id) => candidate(id));
    const answered = await createDecisionJudge({ decisions }).judge({ sentence: "dress", candidates: page });
    expect(answered.verdicts.map((entry) => entry.verdict)).toEqual(["exact", "not-relevant", "close", "not-relevant"]);
    // "d" answered an unknown choice: invalid, read as not relevant too.
    expect(answered.verdicts[1]).toEqual({ id: "b", verdict: "not-relevant", missed: [], label: null, excluded: false });
  });

  it("returns close-match where Flash-Lite writes fact-differs, which Jev cannot write (AC-3)", async () => {
    const page = [candidate("a")];
    const gemini = await createLlmJudge({
      llm: scriptedLlm([answer(["VFF"], [{ n: 1, p: "grey", a: "black" }])]),
    }).judge({ sentence: "black dress", candidates: page });
    const jev = await createDecisionJudge({
      decisions: scriptedDecisions({ a: { verdict: "other-variant", fact: 0.9 } }),
    }).judge({ sentence: "black dress", candidates: page });
    expect(gemini.verdicts[0]!.label).toEqual({ template: "fact-differs", values: ["grey", "black"] });
    expect(jev.verdicts[0]).toEqual({ ...gemini.verdicts[0], label: { template: "close-match", values: [] } });
  });

  it("sends the previous search with the refine-or-replace note, and never a second reading", async () => {
    const decisions = scriptedDecisions({ a: { verdict: "exact" } });
    const answered = await createDecisionJudge({ decisions }).judge({
      sentence: "in red",
      previousSentence: "linen dress",
      candidates: [candidate("a")],
    });
    expect(decisions.requests[0]!.state).toMatchObject({ previous_search: "linen dress", search: "in red" });
    for (const question of Object.values(decisions.requests[0]!.questions)) {
      expect(question.instructions).toMatch(/^The search may refine the previous search/);
    }
    expect(answered.otherReading).toBeNull();
  });

  it("rejects with JudgeAnswerError when no product's answer is valid, and with the caller's reason when aborted", async () => {
    await expect(
      createDecisionJudge({ decisions: scriptedDecisions({}) }).judge({ sentence: "dress", candidates: [candidate("a")] }),
    ).rejects.toBeInstanceOf(JudgeAnswerError);
    const controller = new AbortController();
    const reason = new Error("deadline");
    const pending = createDecisionJudge({
      decisions: { decide: (request) => new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")))) },
    }).judge({ sentence: "dress", candidates: [candidate("a")], signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("the one factory and its configuration (AC-1, AC-2, AC-6)", () => {
  it("selects the provider from JUDGE_PROVIDER, gemini by default, and builds only that client", async () => {
    expect(judgeProviderFromEnv({})).toBe("gemini");
    expect(judgeProviderFromEnv({ JUDGE_PROVIDER: "gemini" })).toBe("gemini");
    expect(judgeProviderFromEnv({ JUDGE_PROVIDER: "jev" })).toBe("jev");
    expect(() => judgeProviderFromEnv({ JUDGE_PROVIDER: "gpt" })).toThrow(/JUDGE_PROVIDER/);

    let built = 0;
    const llm = scriptedLlm([answer(["E-X"])]);
    const judge = createJudge({
      provider: judgeProviderFromEnv({}),
      clients: {
        gemini: () => {
          built += 1;
          return llm;
        },
        jev: () => {
          throw new Error("the jev client is built only when selected");
        },
      },
    });
    await judge.judge({ sentence: "dress", candidates: [candidate("a")] });
    expect(built).toBe(1);
    expect(llm.requests[0]!.operation).toBe("judge");
  });

  it("selects the decision judge with JUDGE_PROVIDER=jev and builds only its client (YOY-152 AC-1)", async () => {
    const decisions = scriptedDecisions({ a: { verdict: "exact" } });
    const judge = createJudge({
      provider: judgeProviderFromEnv({ JUDGE_PROVIDER: "jev" }),
      clients: {
        gemini: () => {
          throw new Error("the gemini client is built only when selected");
        },
        jev: () => decisions,
      },
      modelIds: { gemini: "flash-lite-x", jev: "typesafe/jev-1.13" },
    });
    expect(judge.identity).toBe("jev:typesafe/jev-1.13");
    const answered = await judge.judge({ sentence: "dress", candidates: [candidate("a")] });
    expect(answered.verdicts[0]!.verdict).toBe("exact");
    expect(decisions.requests).toHaveLength(1);
  });

  it("reads the deadline and the row length from the environment", () => {
    expect(judgeDeadlineMsFromEnv({})).toBe(DEFAULT_JUDGE_DEADLINE_MS);
    expect(DEFAULT_JUDGE_DEADLINE_MS).toBe(1_500);
    expect(judgeDeadlineMsFromEnv({ JUDGE_DEADLINE_MS: "1" })).toBe(1);
    expect(() => judgeDeadlineMsFromEnv({ JUDGE_DEADLINE_MS: "0" })).toThrow(/JUDGE_DEADLINE_MS/);
    expect(judgeRowCharsFromEnv({})).toBe(480);
    expect(judgeRowCharsFromEnv({ JUDGE_ROW_CHARS: "200" })).toBe(200);
    expect(() => judgeRowCharsFromEnv({ JUDGE_ROW_CHARS: "x" })).toThrow(/JUDGE_ROW_CHARS/);
    expect(judgeGiveUpMsFromEnv({})).toBe(6_000);
    expect(judgeGiveUpMsFromEnv({ JUDGE_GIVE_UP_MS: "4000" })).toBe(4_000);
    expect(() => judgeGiveUpMsFromEnv({ JUDGE_GIVE_UP_MS: "-1" })).toThrow(/JUDGE_GIVE_UP_MS/);
  });

  it("names the provider and model the factory built, for the cache key (YOY-148 AC-1)", () => {
    const judge = createJudge({
      provider: "gemini",
      clients: { gemini: () => scriptedLlm([]), jev: () => scriptedDecisions({}) },
      modelIds: { gemini: "flash-lite-x" },
    });
    expect(judge.identity).toBe("gemini:flash-lite-x");
    expect(
      createJudge({
        provider: "gemini",
        clients: { gemini: () => scriptedLlm([]), jev: () => scriptedDecisions({}) },
      }).identity,
    ).toBe("gemini:unknown");
  });

  it("parses a labels request: a searchId and a whole page of 1 or more (YOY-148 AC-8)", () => {
    expect(parseLabelsParams(new URLSearchParams("searchId=s1&page=2"))).toEqual({ searchId: "s1", page: 2 });
    for (const bad of ["page=1", "searchId=s1", "searchId=&page=1", "searchId=s1&page=0", "searchId=s1&page=1.5", `searchId=${"x".repeat(201)}&page=1`]) {
      expect(parseLabelsParams(new URLSearchParams(bad))).toBeNull();
    }
  });
});

interface Product {
  productId: string;
  title: string;
  /** Card-vector distance knob; no card vector when absent. */
  y?: number;
  facts?: string;
  /** Writes an enrichment row with this vision sleeve length when present. */
  sleeveLength?: string | null;
  description?: string;
  options?: Array<Array<{ name: string; value: string }>>;
}

async function seed(db: PrismaClient, products: Product[]): Promise<void> {
  for (const product of products) {
    await db.catalogProduct.create({
      data: {
        shopDomain: SHOP,
        productId: product.productId,
        title: product.title,
        description: product.description ?? "",
        tags: [],
        vendor: "fixture",
        productType: "",
        priceMin: 100,
        priceMax: 100,
        currencyCode: "USD",
        available: true,
        imageAltTexts: [],
        sourceUpdatedAt: new Date(),
        contentHash: `hash-${product.productId}`,
      },
    });
    if (product.y !== undefined) {
      await db.$executeRawUnsafe(
        `INSERT INTO "CardEmbedding" ("id", "shopDomain", "productId", "section", "textHash", "embedding", "updatedAt")
         VALUES ($1, $2, $3, 'prose', 'h', $4::vector(${DIMENSION}), CURRENT_TIMESTAMP)`,
        randomUUID(),
        SHOP,
        product.productId,
        `[1,${product.y},0]`,
      );
    }
    if (product.facts !== undefined) {
      await db.productCard.create({
        data: {
          shopDomain: SHOP,
          productId: product.productId,
          status: "written",
          facts: product.facts,
          asks: {},
          inputHash: "i",
          cardVersion: 1,
          modelId: "m",
          writtenAt: new Date(),
        },
      });
    }
    if (product.sleeveLength !== undefined) {
      await db.productEnrichment.create({
        data: {
          shopDomain: SHOP,
          productId: product.productId,
          contentHash: `hash-${product.productId}`,
          status: "enriched",
          colors: [],
          occasions: [],
          styleTags: [],
          seasons: [],
          sleeveLength: product.sleeveLength,
          neckline: "not-applicable",
          garmentLength: "midi",
        },
      });
    }
    for (const [index, options] of (product.options ?? []).entries()) {
      await db.productVariant.create({
        data: {
          shopDomain: SHOP,
          productId: product.productId,
          variantId: `${product.productId}-v${index + 1}`,
          position: index + 1,
          options,
          price: 100,
          available: true,
        },
      });
    }
  }
}

const embeddings: EmbeddingClient = {
  dimension: DIMENSION,
  embed: async ({ texts }) => texts.map(() => [1, 0, 0]),
};

/** Ports the old engine must never touch on the v2 path. */
const untouchable = {
  classifier: { classify: () => Promise.reject(new Error("unexpected classification")) } as QueryClassifier,
  extractor: { extract: () => Promise.reject(new Error("unexpected intent")) } as IntentExtractor,
  retriever: { retrieve: () => Promise.reject(new Error("unexpected retrieval")) } as Retriever,
};

function ledger(): CostRecorder & { rows: AiCallUsage[] } {
  const recorder = {
    rows: [] as AiCallUsage[],
    async record(usage: AiCallUsage) {
      recorder.rows.push(usage);
    },
  };
  return recorder;
}

/** A recording answering the judge for one query, keyed like every replay. */
function recording(query: string, output: unknown): Record<string, LlmRecording> {
  return {
    judge: {
      modelId: "gemini-3.5-flash-lite",
      provenance: "synthesized",
      entries: { [query]: { output, inputTokens: 900, outputTokens: 60 } },
    },
  };
}

describe("the judge on Engine v2 (on the database)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "CardEmbedding"`);
    await db.productCard.deleteMany();
    await db.productEnrichment.deleteMany();
    await db.judgeAnswer.deleteMany();
    await db.judgeVerdict.deleteMany();
    resetPendingLabels();
    await db.productVariant.deleteMany();
    await db.catalogProduct.deleteMany();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  function orchestrator(
    llm: LlmClient | undefined,
    options: { deadlineMs?: number; giveUpMs?: number; findSetSize?: number } = {},
  ): SearchOrchestrator {
    return createSearchOrchestrator({
      db,
      ...untouchable,
      classicStore: createPgTrgmClassicStore(db),
      find: createFindStep({
        db,
        embeddings,
        classicStore: createPgTrgmClassicStore(db),
        ...(options.findSetSize !== undefined ? { findSetSize: options.findSetSize } : {}),
      }),
      engineV2: true,
      ...(llm !== undefined ? { judge: createLlmJudge({ llm }) } : {}),
      ...(options.deadlineMs !== undefined ? { judgeDeadlineMs: options.deadlineMs } : {}),
      ...(options.giveUpMs !== undefined ? { judgeGiveUpMs: options.giveUpMs } : {}),
    });
  }

  const search = (engine: SearchOrchestrator, request: Partial<SearchRequest> = {}) =>
    engine.runSearch({ query: "an outfit for tonight", shopDomain: SHOP, ...request });

  const FOUR = [
    { productId: "p1", title: "Navy Midi Dress", y: 0.1 },
    { productId: "p2", title: "Beach Sandal", y: 0.2 },
    { productId: "p3", title: "Black Midi Dress", y: 0.3 },
    { productId: "p4", title: "Black Maxi Dress", y: 0.4 },
  ];

  it("orders the page by verdict, ties in find order, with labels on the wire and verdicts only in details (AC-5, AC-9, AC-12)", async () => {
    await seed(db, FOUR);
    const costs = ledger();
    const llm = createReplayLlmClient({
      recordings: recording(
        "an outfit for tonight",
        answer(["VFF", "N-X", "E-X", "CDC"], [{ n: 1, p: "navy", a: "black" }]),
      ),
      costRecorder: costs,
    });
    const response = await search(orchestrator(llm));

    expect(response.hits.map((hit) => hit.productId)).toEqual(["p3", "p1", "p4", "p2"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judged", engine: "v2" });
    expect(response.stages.judge).toBeGreaterThanOrEqual(0);
    expect(costs.rows.map((row) => row.operation)).toEqual(["judge"]);

    const wire = serializeProxySearchResponse(response);
    expect(wire.results.map((result) => result.label)).toEqual([
      null,
      { template: "fact-differs", values: ["navy", "black"] },
      { template: "close-match", values: [] },
      null,
    ]);
    // The storefront wire carries no verdict (AC-12).
    expect(JSON.stringify(wire)).not.toContain("verdict");
    expect(JSON.stringify(wire)).not.toContain("not-relevant");

    const playground = serializePlaygroundSearchResponse(response, {
      routeReason: response.routeReason,
      latencyMs: 5,
      limited: null,
      stages: response.stages,
      intentTier: response.intentTier,
      engine: response.engine,
    });
    expect(playground.details.judge).toEqual({
      outcome: "judged",
      verdicts: [
        { productId: "p3", verdict: "exact" },
        { productId: "p1", verdict: "other-variant" },
        { productId: "p4", verdict: "close" },
        { productId: "p2", verdict: "not-relevant" },
      ],
    });
    expect(Object.keys(playground.details.stages)).toContain("judge");
  });

  it("sends one compact row per candidate, from the card's facts, the enrichment, the variants and the catalog row (AC-2, AC-17)", async () => {
    await seed(db, [
      {
        productId: "p1",
        title: "Navy Midi Dress",
        y: 0.1,
        facts: "Navy midi dress in viscose.",
        sleeveLength: "long",
        options: [
          [
            { name: "Color", value: "Navy" },
            { name: "Size", value: "S" },
          ],
          [
            { name: "Color", value: "Navy" },
            { name: "Size", value: "M" },
          ],
        ],
      },
      { productId: "p2", title: "Plain Tee", y: 0.2, description: "Soft cotton tee." },
    ]);
    const candidates = await loadJudgeCandidates(db, SHOP, ["p2", "p1"]);
    expect(candidates.map((entry) => entry.id)).toEqual(["p2", "p1"]);
    expect(candidates[1]).toMatchObject({
      facts: "Navy midi dress in viscose.",
      attributes: [
        { name: "sleeve length", value: "long" },
        { name: "garment length", value: "midi" },
      ],
      options: [
        { name: "Color", values: ["Navy"] },
        { name: "Size", values: ["S", "M"] },
      ],
    });
    expect(candidates[0]).toMatchObject({
      facts: null,
      attributes: [],
      description: "Soft cotton tee.",
      options: [],
    });

    const llm = scriptedLlm([answer(["E-X", "E-X"])]);
    await search(orchestrator(llm), { query: "navy dress" });
    expect(llm.requests).toHaveLength(1);
    const prompt = llm.requests[0]!.prompt;
    expect(prompt).toContain(
      "1. Navy Midi Dress | 100 USD | Navy midi dress in viscose. | sleeve length: long; garment length: midi | Color: Navy; Size: S, M",
    );
    expect(prompt).toContain("2. Plain Tee | 100 USD | Soft cotton tee.");
  });

  it("retries an invalid answer once, then serves find order as judge-error (AC-4, AC-7)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([answer(["E-X"])]);
    const response = await search(orchestrator(llm));
    expect(llm.requests).toHaveLength(2);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judge-error", degraded: false });
    expect(response.hits.every((hit) => hit.label === null && hit.verdict === undefined)).toBe(true);
  });

  it("serves find order when the judge call fails, with no error reaching the shopper (AC-7)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([() => Promise.reject(new Error("upstream 503"))]);
    const response = await search(orchestrator(llm));
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judge-error" });
  });

  it("serves find order when the judge misses its deadline, and gives the call up at the give-up time (AC-6; YOY-148 AC-6)", async () => {
    await seed(db, FOUR);
    let aborted = false;
    const slow: LlmClient = {
      completeStructured: (request) =>
        new Promise((resolve, reject) => {
          // Like the provider adapter: an abort rejects the call.
          request.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
          // Answers, but long after the deadline.
          setTimeout(
            () => resolve(answer(["N-X", "C-C", "V-X", "E-X"])),
            500,
          );
        }),
    };
    const startedAt = Date.now();
    const response = await search(orchestrator(slow, { deadlineMs: 30, giveUpMs: 100 }));
    expect(Date.now() - startedAt).toBeLessThan(450);
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "ai", routeReason: "judge-timeout", labelsPending: true });
    // Not aborted at the deadline: the call runs on to the give-up time.
    expect(aborted).toBe(false);
    expect(await awaitPendingLabels(SHOP, response.searchId, 1)).toEqual({});
    expect(aborted).toBe(true);
  });

  it("serves find order with close-match on every card when the judge rejects every candidate (AC-8)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([
      answer(["N-X", "NDX", "N-X", "NBX"]),
    ]);
    const response = await search(orchestrator(llm));
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response.routeReason).toBe("judged");
    expect(serializeProxySearchResponse(response).results.map((result) => result.label)).toEqual(
      Array(4).fill({ template: "close-match", values: [] }),
    );
  });

  it("makes no judge call under a throttle or a playground cap: find order, capped, classic route (AC-7, AC-11)", async () => {
    await seed(db, FOUR);
    const costs = ledger();
    const llm = createReplayLlmClient({ recordings: recording("an outfit for tonight", answer([])), costRecorder: costs });
    // The proxy's throttle and the playground's caps both force classic.
    const response = await search(orchestrator(llm), { forceClassic: true });
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(response).toMatchObject({ route: "classic", routeReason: "capped", engine: "v2" });
    expect(costs.rows).toEqual([]);
    expect(response.stages.judge).toBeUndefined();
    expect(serializeProxySearchResponse(response).results.every((result) => result.label === null)).toBe(true);
  });

  it("keeps the client-timeout rescue on the keyword path, with no judge call", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([answer([])]);
    const response = await search(orchestrator(llm), {
      query: "dress",
      forceClassic: true,
      forceClassicReason: "client-timeout-rescue",
    });
    expect(response.routeReason).toBe("client-timeout-rescue");
    expect(llm.requests).toHaveLength(0);
  });

  it("serves pages beyond the find set in keyword order with no judge call (AC-10)", async () => {
    await seed(db, [
      { productId: "v1", title: "Silk Gown", y: 0.1 },
      { productId: "v2", title: "Chiffon Maxi", y: 0.2 },
      { productId: "k1", title: "Evening Party Clutch" },
      { productId: "k2", title: "Party Evening Shoes" },
    ]);
    const query = "something for an evening party";
    const llm = scriptedLlm([answer(["CDC", "E-X"])]);
    // A two-product find set; pages of two.
    const engine = orchestrator(llm, { findSetSize: 2 });

    const page1 = await search(engine, { query, paging: { page: 1, pageSize: 2 } });
    expect(page1.hits.map((hit) => hit.productId)).toEqual(["v2", "v1"]);
    expect(page1).toMatchObject({ route: "ai", routeReason: "judged" });
    expect(llm.requests).toHaveLength(1);

    const page2 = await search(engine, { query, paging: { page: 2, pageSize: 2 } });
    expect(page2).toMatchObject({ route: "classic", routeReason: "find-only", totalCount: 4 });
    expect(page2.hits.every((hit) => hit.label === null)).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it("judges only the find-set part of a page straddling the boundary, the keyword tail after it (AC-10)", async () => {
    await seed(db, [
      { productId: "v1", title: "Silk Gown", y: 0.1 },
      { productId: "v2", title: "Chiffon Maxi", y: 0.2 },
      { productId: "k1", title: "Evening Party Clutch" },
    ]);
    const llm = scriptedLlm([answer(["CDC", "E-X"])]);
    const response = await search(orchestrator(llm, { findSetSize: 2 }), { query: "something for an evening party" });
    expect(response.hits.map((hit) => hit.productId)).toEqual(["v2", "v1", "k1"]);
    expect(llm.requests[0]!.prompt).not.toContain("Clutch");
  });

  it("answers find-only, classic route, when no judge is wired", async () => {
    await seed(db, FOUR);
    const response = await search(orchestrator(undefined));
    expect(response).toMatchObject({ route: "classic", routeReason: "find-only" });
    expect(response.hits.map((hit) => hit.label)).toEqual([null, null, null, null]);
  });

  it("leaves the old engine's wire without a label key", async () => {
    await seed(db, FOUR);
    const v1 = await createSearchOrchestrator({
      db,
      ...untouchable,
      classifier: {
        classify: () => Promise.resolve({ route: "classic", reason: "short-query" }),
      },
      classicStore: createPgTrgmClassicStore(db),
    }).runSearch({ query: "dress", shopDomain: SHOP });
    expect(v1.engine).toBe("v1");
    for (const result of serializeProxySearchResponse(v1).results) {
      expect(result).not.toHaveProperty("label");
    }
  });
  // YOY-148: the answer cache, the verdict log and late labels.

  it("serves a repeat of the same page from the cache: no call, judge-cached, classic route, same order (YOY-148 AC-1, AC-2)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([answer(["VFF", "N-X", "E-X", "CDC"], [{ n: 1, p: "navy", a: "black" }])]);
    const engine = orchestrator(llm);
    const first = await search(engine);
    const second = await search(engine, { query: "  An Outfit   for tonight " });
    expect(llm.requests).toHaveLength(1);
    expect(first).toMatchObject({ route: "ai", routeReason: "judged" });
    expect(second).toMatchObject({ route: "classic", routeReason: "judge-cached" });
    expect(second.hits.map((hit) => hit.productId)).toEqual(first.hits.map((hit) => hit.productId));
    expect(second.hits.map((hit) => hit.label)).toEqual(first.hits.map((hit) => hit.label));
    expect(second.hits.map((hit) => hit.verdict)).toEqual(["exact", "other-variant", "close", "not-relevant"]);
    const playground = serializePlaygroundSearchResponse(second, {
      routeReason: second.routeReason,
      latencyMs: 1,
      limited: null,
      stages: second.stages,
      intentTier: null,
      engine: "v2",
    });
    expect(playground.details.judge?.outcome).toBe("judge-cached");
  });

  it("keys the cache on the sentence, the ids in order, card text hashes, the judge and the prompt version (YOY-148 AC-1)", () => {
    const base = {
      sentence: "Black Dress",
      candidates: [
        { id: "a", cardTextHash: "h1" },
        { id: "b", cardTextHash: "" },
      ],
      identity: "gemini:flash-lite",
      promptVersion: 1,
    };
    const key = judgeCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(judgeCacheKey({ ...base, sentence: " black   dress " })).toBe(key);
    expect(judgeCacheKey({ ...base, sentence: "black dresses" })).not.toBe(key);
    expect(judgeCacheKey({ ...base, candidates: [...base.candidates].reverse() })).not.toBe(key);
    expect(
      judgeCacheKey({ ...base, candidates: [{ id: "a", cardTextHash: "h2" }, base.candidates[1]!] }),
    ).not.toBe(key);
    expect(judgeCacheKey({ ...base, identity: "gemini:other" })).not.toBe(key);
    expect(judgeCacheKey({ ...base, promptVersion: 2 })).not.toBe(key);
  });

  it("still hits after a price or stock change, and misses after a card text change (YOY-148 AC-3)", async () => {
    await seed(db, FOUR.map((product) => ({ ...product, facts: `Facts of ${product.productId}` })));
    await db.productCard.updateMany({ data: { cardTextHash: "card-v1" } });
    const llm = scriptedLlm([answer(["E-X", "E-X", "E-X", "E-X"])]);
    const engine = orchestrator(llm);
    await search(engine);

    await db.catalogProduct.updateMany({
      where: { shopDomain: SHOP, productId: "p2" },
      data: { priceMin: 5, priceMax: 9, available: false },
    });
    expect(await search(engine)).toMatchObject({ routeReason: "judge-cached" });
    expect(llm.requests).toHaveLength(1);

    await db.productCard.updateMany({
      where: { shopDomain: SHOP, productId: "p2" },
      data: { cardTextHash: "card-v2" },
    });
    expect(await search(engine)).toMatchObject({ routeReason: "judged", route: "ai" });
    expect(llm.requests).toHaveLength(2);
  });

  it("logs one verdict row per product for judged and cached pages, and a click marks its row (YOY-148 AC-4, AC-5)", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([answer(["VFF", "N-X", "E-X", "CDC"], [{ n: 1, p: "navy", a: "black" }])]);
    const engine = orchestrator(llm);
    const judged = await search(engine, { paging: { page: 1, pageSize: 24 } });
    const cached = await search(engine, { paging: { page: 1, pageSize: 24 } });

    const rows = await db.judgeVerdict.findMany({ orderBy: [{ cached: "asc" }, { position: "asc" }] });
    expect(rows).toHaveLength(8);
    expect(
      rows
        .filter((row) => !row.cached)
        .map(({ searchId, shopDomain, productId, page, position, verdict, missed, labelTemplate }) => ({
          searchId,
          shopDomain,
          productId,
          page,
          position,
          verdict,
          missed,
          labelTemplate,
        })),
    ).toEqual([
      { searchId: judged.searchId, shopDomain: SHOP, productId: "p3", page: 1, position: 0, verdict: "exact", missed: [], labelTemplate: null },
      { searchId: judged.searchId, shopDomain: SHOP, productId: "p1", page: 1, position: 1, verdict: "other-variant", missed: ["fact"], labelTemplate: "fact-differs" },
      { searchId: judged.searchId, shopDomain: SHOP, productId: "p4", page: 1, position: 2, verdict: "close", missed: ["description"], labelTemplate: "close-match" },
      { searchId: judged.searchId, shopDomain: SHOP, productId: "p2", page: 1, position: 3, verdict: "not-relevant", missed: [], labelTemplate: null },
    ]);
    expect(rows.filter((row) => row.cached).map((row) => [row.searchId, row.productId])).toEqual([
      [cached.searchId, "p3"],
      [cached.searchId, "p1"],
      [cached.searchId, "p4"],
      [cached.searchId, "p2"],
    ]);
    expect(rows.every((row) => row.clickedAt === null)).toBe(true);

    await writeSearchEvent(db, {
      searchId: judged.searchId,
      shopDomain: SHOP,
      sessionId: "s",
      query: "an outfit for tonight",
      route: judged.route,
      routeReason: judged.routeReason,
      degraded: false,
      latencyMs: 1,
      resultCount: 4,
    });
    expect(
      await writeClickEvent(db, {
        searchId: judged.searchId,
        shopDomain: SHOP,
        sessionId: "s",
        productId: "p4",
        position: 2,
      }),
    ).toBe(true);
    const clicked = await db.judgeVerdict.findMany({ where: { clickedAt: { not: null } } });
    expect(clicked.map((row) => [row.searchId, row.productId])).toEqual([[judged.searchId, "p4"]]);
  });

  it("writes page 2's rows at whole-order positions", async () => {
    await seed(db, FOUR);
    const llm = scriptedLlm([answer(["C-X", "E-X"])]);
    const response = await search(orchestrator(llm), { paging: { page: 2, pageSize: 2 } });
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p4", "p3"]);
    const rows = await db.judgeVerdict.findMany({ orderBy: { position: "asc" } });
    expect(rows.map((row) => [row.productId, row.page, row.position])).toEqual([
      ["p4", 2, 2],
      ["p3", 2, 3],
    ]);
  });

  it("serves a deadline miss with labelsPending, hands the late labels to the labels endpoint, and caches the answer (YOY-148 AC-6 – AC-9)", async () => {
    await seed(db, FOUR);
    let calls = 0;
    const slow: LlmClient = {
      completeStructured: () => {
        calls += 1;
        return new Promise((resolve) =>
          setTimeout(
            () => resolve(answer(["VFF", "N-X", "E-X", "CDC"], [{ n: 1, p: "navy", a: "black" }])),
            80,
          ),
        );
      },
    };
    const engine = orchestrator(slow, { deadlineMs: 20, giveUpMs: 2_000 });
    const response = await search(engine);
    expect(response).toMatchObject({ route: "ai", routeReason: "judge-timeout", labelsPending: true });
    expect(response.hits.map((hit) => hit.productId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(serializeProxySearchResponse(response).labelsPending).toBe(true);

    // Another shop's request for the same search gets nothing.
    expect(await awaitPendingLabels("other-shop.myshopify.com", response.searchId, 1)).toEqual({});
    const labels = await awaitPendingLabels(SHOP, response.searchId, 1);
    expect(labels).toEqual({
      p1: { template: "fact-differs", values: ["navy", "black"] },
      p2: null,
      p3: null,
      p4: { template: "close-match", values: [] },
    });
    // Labels only, never an order (AC-9).
    expect(serializeLabels(labels)).toEqual({ labels });
    expect(JSON.stringify(serializeLabels(labels))).not.toMatch(/position|order|verdict/);

    const again = await search(engine);
    expect(again).toMatchObject({ routeReason: "judge-cached", route: "classic" });
    expect(again).not.toHaveProperty("labelsPending");
    expect(calls).toBe(1);
  });

  it("answers an empty set for a page with nothing pending, and when the judge fails late", async () => {
    await seed(db, FOUR);
    expect(await awaitPendingLabels(SHOP, "never-ran", 1)).toEqual({});
    const failing: LlmClient = {
      completeStructured: () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("upstream 503")), 50)),
    };
    const response = await search(orchestrator(failing, { deadlineMs: 10 }));
    expect(response.labelsPending).toBe(true);
    expect(await awaitPendingLabels(SHOP, response.searchId, 1)).toEqual({});
    expect(await db.judgeAnswer.count()).toBe(0);
  });

  it("leaves labelsPending off the wire when the judge answered in time", async () => {
    await seed(db, FOUR);
    const response = await search(orchestrator(scriptedLlm([answer(["E-X", "E-X", "E-X", "E-X"])])));
    expect(response).not.toHaveProperty("labelsPending");
    expect(serializeProxySearchResponse(response)).not.toHaveProperty("labelsPending");
  });

  it("shows judge calls, cache hits and the hit rate on the cost admin (YOY-148 AC-10)", async () => {
    await db.aiCall.deleteMany();
    await db.searchEvent.deleteMany();
    expect((await aggregateCosts(db)).judge).toEqual({ calls: 0, cacheHits: 0, hitRate: null });
    for (const operation of ["judge", "judge", "judge", "embedding"]) {
      await db.aiCall.create({
        data: { provider: "google", modelId: "m", operation, inputTokens: 1, outputTokens: 1, costUsd: 0 },
      });
    }
    await writeSearchEvent(db, {
      searchId: "cached-1",
      shopDomain: SHOP,
      sessionId: "s",
      query: "q",
      route: "classic",
      routeReason: "judge-cached",
      degraded: false,
      latencyMs: 1,
      resultCount: 4,
    });
    expect((await aggregateCosts(db)).judge).toEqual({ calls: 3, cacheHits: 1, hitRate: 0.25 });
  });
});
