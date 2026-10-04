import type { AiCallUsage, CostRecorder, DecisionRequest } from "@unfiltered/engine";
import { describe, expect, it } from "vitest";

import {
  createOpenRouterDecisionClient,
  DEFAULT_OPENROUTER_JUDGE_MODEL,
  OpenRouterApiError,
  OpenRouterConfigError,
  OpenRouterResponseError,
  openRouterModelsFromEnv,
} from "./openrouter.server";

// The OpenRouter decisions adapter (YOY-152 AC-1, AC-5): the wire request
// and answer shapes of Jev's decisions endpoint, and the ledger row each
// call writes. A fake fetch answers; offline and $0.

function recorder(): CostRecorder & { rows: AiCallUsage[] } {
  const rows: AiCallUsage[] = [];
  return { rows, record: async (usage) => void rows.push(usage) };
}

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const REQUEST: DecisionRequest = {
  state: { search: "linen dress", product: "Aurora Dress | 80 USD" },
  questions: {
    verdict: { type: "choice", instructions: "How well?", criteria: { exact: "All met.", close: "Close." } },
    excluded: { type: "yes-no", instructions: "Ruled out?", criteria: { yes: "Ruled out.", no: "Not ruled out." } },
  },
  operation: "judge",
  storeId: "store-1",
  searchId: "s-1",
};

const ANSWER = {
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    verdict: { type: "choice", choice: "close", confidence: 0.6, probabilities: { exact: 0.2, close: 0.8 } },
    excluded: { type: "noul", noul: 0.04 },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

describe("the OpenRouter decisions adapter (YOY-152)", () => {
  it("posts the model, state and questions in Jev's wire form, yes/no as noul", async () => {
    const fetch = fakeFetch(200, ANSWER);
    const client = createOpenRouterDecisionClient({
      modelId: "typesafe/jev-1.13",
      costRecorder: recorder(),
      apiKey: "key-1",
      fetchImpl: fetch.impl,
    });
    await client.decide(REQUEST);
    expect(fetch.calls[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(fetch.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer key-1" });
    expect(JSON.parse(String(fetch.calls[0]!.init.body))).toEqual({
      model: "typesafe/jev-1.13",
      state: REQUEST.state,
      questions: {
        verdict: { type: "choice", instructions: "How well?", criteria: { exact: "All met.", close: "Close." } },
        excluded: { type: "noul", instructions: "Ruled out?", criteria: { true: "Ruled out.", false: "Not ruled out." } },
      },
    });
  });

  it("returns typed answers and meters the call as the requested model under the caller's operation (AC-5)", async () => {
    const costs = recorder();
    const client = createOpenRouterDecisionClient({
      modelId: "typesafe/jev-1.13",
      costRecorder: costs,
      apiKey: "key-1",
      fetchImpl: fakeFetch(200, ANSWER).impl,
    });
    expect(await client.decide(REQUEST)).toEqual({
      verdict: { type: "choice", choice: "close" },
      excluded: { type: "yes-no", yes: 0.04 },
    });
    expect(costs.rows).toEqual([
      {
        provider: "openrouter",
        modelId: "typesafe/jev-1.13",
        operation: "judge",
        inputTokens: 476,
        outputTokens: 70,
        storeId: "store-1",
        searchId: "s-1",
      },
    ]);
  });

  it("meters a paid call before failing on an answer missing a question", async () => {
    const costs = recorder();
    const client = createOpenRouterDecisionClient({
      modelId: "typesafe/jev-1.13",
      costRecorder: costs,
      apiKey: "key-1",
      fetchImpl: fakeFetch(200, { ...ANSWER, answers: { verdict: ANSWER.answers.verdict } }).impl,
    });
    await expect(client.decide(REQUEST)).rejects.toBeInstanceOf(OpenRouterResponseError);
    expect(costs.rows).toHaveLength(1);
  });

  it("fails with the status on a non-OK answer, and without a key at construction", async () => {
    const client = createOpenRouterDecisionClient({
      modelId: "typesafe/jev-1.13",
      costRecorder: recorder(),
      apiKey: "key-1",
      fetchImpl: fakeFetch(429, "rate limited").impl,
    });
    await expect(client.decide(REQUEST)).rejects.toMatchObject({ name: "OpenRouterApiError", status: 429 });
    await expect(client.decide(REQUEST)).rejects.toBeInstanceOf(OpenRouterApiError);
    expect(() =>
      createOpenRouterDecisionClient({ modelId: "typesafe/jev-1.13", costRecorder: recorder(), apiKey: "" }),
    ).toThrow(OpenRouterConfigError);
  });

  it("reads the judge model from OPENROUTER_JUDGE_MODEL, typesafe/jev-1.13 by default", () => {
    expect(DEFAULT_OPENROUTER_JUDGE_MODEL).toBe("typesafe/jev-1.13");
    expect(openRouterModelsFromEnv({})).toEqual({ judgeModel: "typesafe/jev-1.13" });
    expect(openRouterModelsFromEnv({ OPENROUTER_JUDGE_MODEL: "typesafe/jev-1.14" })).toEqual({
      judgeModel: "typesafe/jev-1.14",
    });
  });
});
