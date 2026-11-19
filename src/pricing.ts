/**
 * Pricing table for models.
 *
 * Rates are recorded in micro-rupees per 1,000,000 tokens (1 INR = 1,000,000 micro-rupees).
 * Assumed exchange rate: 1 USD = 93 INR (as of 2026-11-19).
 *
 * Models:
 * - mock: Default mock/fallback model (₹10 / 1M in, ₹20 / 1M out)
 * - gemini-4-hydrogen:
 *   Input:  $1.50 / 1M tokens = ₹139.50 / 1M = 139,500,000 micro-rupees
 *   Output: $7.50 / 1M tokens = ₹697.50 / 1M = 697,500,000 micro-rupees
 * - gemini-3.8-flash:
 *   Input:  $0.75 / 1M tokens = ₹69.75 / 1M = 69,750,000 micro-rupees
 *   Output: $3.75 / 1M tokens = ₹350.625 / 1M = 350,625,000 micro-rupees
 */

export interface ModelPricing {
  inPerM: bigint;
  outPerM: bigint;
}

export const PRICING_TABLE: Record<string, ModelPricing> = {
  "mock": {
    inPerM: 10_000_000n,
    outPerM: 20_000_000n,
  },
  "gemini-4-hydrogen": {
    inPerM: 139_500_000n,
    outPerM: 697_500_000n,
  },
  "gemini-3.8-flash": {
    inPerM: 69_750_000n,
    outPerM: 350_625_000n,
  },
  "gemini-2.5-flash": {
    inPerM: 27_900_000n,
    outPerM: 232_500_000n,
  },
  "gemini-1.5-flash": {
    inPerM: 6_975_000n,
    outPerM: 27_900_000n,
  },
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
