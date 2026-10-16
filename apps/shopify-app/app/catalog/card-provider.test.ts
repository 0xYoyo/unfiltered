import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cardProviderFromEnv, createCardWriter } from "./card.server";
import { createIngestEmbeddingClient } from "./embed.server";

// The card run's provider choice (YOY-177 AC-1): the Gemini key unless
// `CARD_PROVIDER=openrouter`; anything else is refused before a call.
// Construction only: no client here makes a call.

const db = {} as PrismaClient;

describe("cardProviderFromEnv (YOY-177 AC-1)", () => {
  it("is gemini when unset, empty or gemini, openrouter only for openrouter, and refuses anything else", () => {
    expect(cardProviderFromEnv({})).toBe("gemini");
    expect(cardProviderFromEnv({ CARD_PROVIDER: "" })).toBe("gemini");
    expect(cardProviderFromEnv({ CARD_PROVIDER: "gemini" })).toBe("gemini");
    expect(cardProviderFromEnv({ CARD_PROVIDER: "openrouter" })).toBe("openrouter");
    expect(() => cardProviderFromEnv({ CARD_PROVIDER: "OpenRouter" })).toThrow(/CARD_PROVIDER/);
  });
});

describe("the card writer and the ingest embeddings under CARD_PROVIDER (YOY-177 AC-1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("openrouter writes cards with the OpenRouter card model and embeds at the Gemini dimension", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const env = { CARD_PROVIDER: "openrouter", GEMINI_EMBEDDING_DIMENSION: "768" };
    expect(createCardWriter(db, env).modelId).toBe("google/gemini-3.5-flash-lite");
    expect(createIngestEmbeddingClient(db, "openrouter", env).dimension).toBe(768);
  });

  it("the default keeps the Gemini card model", () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    expect(createCardWriter(db, {}).modelId).toBe("gemini-3.5-flash-lite");
  });
});
