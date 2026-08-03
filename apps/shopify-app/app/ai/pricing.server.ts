import priceTable from "../../../../config/ai-prices.json";

/** USD per 1M tokens for one model, paid-tier rates. */
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

const MODELS: Record<string, ModelPrice> = priceTable.models;

/**
 * Look up a model's price from the committed table at config/ai-prices.json.
 * Unknown model IDs fail loudly: recording a cost of 0 would silently
 * under-meter real spend.
 */
export function getModelPrice(modelId: string): ModelPrice {
  const price = MODELS[modelId];
  if (!price) {
    throw new Error(
      `No price for model "${modelId}" in config/ai-prices.json — add it before calling this model`,
    );
  }
  return price;
}

/** Compute the USD cost of one call from its token counts. */
export function computeCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = getModelPrice(modelId);
  return (
    (inputTokens * price.inputUsdPerMTok +
      outputTokens * price.outputUsdPerMTok) /
    1_000_000
  );
}
