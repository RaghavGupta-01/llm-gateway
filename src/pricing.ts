/**
 * Pricing table for Mock provider.
 *
 * Rates are recorded in micro-rupees per 1,000,000 tokens:
 * - In: 10,000,000 micro-rupees / 1M tokens (10 micro-rupees per token)
 * - Out: 20,000,000 micro-rupees / 1M tokens (20 micro-rupees per token)
 */

export interface ModelPricing {
  inPerM: bigint;
  outPerM: bigint;
}

export const PRICING_TABLE: Record<string, ModelPricing> = {
  "mock": {
    inPerM: 10_000_000n,
    outPerM: 20_000_000n,
  }
};

export function isSupportedModel(model: string): boolean {
  return model === "mock" || Object.prototype.hasOwnProperty.call(PRICING_TABLE, model);
}

export function actualCost(model: string, tokensIn: number, tokensOut: number): bigint {
  const rates = PRICING_TABLE[model] || PRICING_TABLE["mock"];

  const inCost = BigInt(tokensIn) * rates.inPerM;
  const outCost = BigInt(tokensOut) * rates.outPerM;
  const total = inCost + outCost;

  if (total === 0n) return 0n;

  // Ceiling division
  return (total + 999_999n) / 1_000_000n;
}

export function estimateReserve(model: string, promptChars: number, maxTokens: number): bigint {
  const rates = PRICING_TABLE[model] || PRICING_TABLE["mock"];

  const estimatedTokensIn = Math.max(1, Math.ceil(promptChars / 4));
  const inCost = BigInt(estimatedTokensIn) * rates.inPerM;
  const outCost = BigInt(maxTokens) * rates.outPerM;
  const total = inCost + outCost;

  if (total === 0n) return 0n;

  return (total + 999_999n) / 1_000_000n;
}
