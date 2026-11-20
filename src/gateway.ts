import { config } from "./config.js";
import { geminiProvider } from "./providers/gemini.js";
import { mockProvider } from "./providers/mock.js";
import { ChatRequest, ProviderError } from "./providers/types.js";

export class FatalGatewayError extends Error {
  public readonly status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "FatalGatewayError";
    this.status = status;
  }
}

export interface GatewayResult {
  body: unknown;
  tokensIn: number;
  tokensOut: number;
  provider: "gemini" | "mock";
  model: string;
  status: "ok" | "fallback_ok";
}

/**
 * Orchestrates request execution with 1x transient retry and mock provider fallback.
 *
 * Rules:
 * 1. If model is explicitly "mock", call mock provider directly.
 * 2. Primary call to Gemini has ~10s timeout.
 * 3. On retryable error (timeout, network, 429, 5xx), retry once after ~300ms + jitter backoff.
 * 4. If primary still fails after retry, fall back to mock provider with status "fallback_ok".
 * 5. On fatal 4xx (client/request error), do NOT retry and do NOT fall back. Throw FatalGatewayError.
 * 6. If fallback also fails, throw error for 502 handling.
 */
export async function executeWithFallback(
  req: ChatRequest,
  signal?: AbortSignal
): Promise<GatewayResult> {
  // If caller explicitly requested mock model, invoke mock directly
  if (req.model === "mock") {
    const result = await mockProvider.chat(req, signal);
    return {
      ...result,
      status: "ok",
    };
  }

  // Attempt 1: Call primary provider (Gemini)
  try {
    if (config.MOCK_FORCE_PRIMARY_FAIL) {
      throw new ProviderError("Simulated primary failure via MOCK_FORCE_PRIMARY_FAIL", true, 503);
    }

    const result = await geminiProvider.chat(req, signal);
    return {
      ...result,
      status: "ok",
    };
  } catch (err: unknown) {
    // If it's a fatal 4xx error, do NOT retry and do NOT fall back
    if (err instanceof ProviderError && !err.isRetryable) {
      console.warn(`[Gateway] Fatal upstream error (${err.status}): ${err.message}. Not retrying.`);
      throw new FatalGatewayError(err.message, err.status);
    }

    console.warn(`[Gateway] Primary attempt 1 failed with retryable error:`, err instanceof Error ? err.message : err);
  }

  // Backoff: ~300ms + random jitter (0-100ms)
  const backoffMs = 300 + Math.floor(Math.random() * 100);
  await new Promise((resolve) => setTimeout(resolve, backoffMs));

  // Attempt 2: Retry primary provider once
  try {
    if (config.MOCK_FORCE_PRIMARY_FAIL) {
      throw new ProviderError("Simulated primary failure via MOCK_FORCE_PRIMARY_FAIL (retry)", true, 503);
    }

    const result = await geminiProvider.chat(req, signal);
    return {
      ...result,
      status: "ok",
    };
  } catch (err: unknown) {
    // Fatal error on retry also must not fall back
    if (err instanceof ProviderError && !err.isRetryable) {
      console.warn(`[Gateway] Fatal upstream error on retry (${err.status}): ${err.message}. Not falling back.`);
      throw new FatalGatewayError(err.message, err.status);
    }

    console.warn(`[Gateway] Primary attempt 2 failed. Activating mock provider fallback.`);
  }

  // Fallback: Invoke mock provider
  const fallbackResult = await mockProvider.chat(req, signal);
  return {
    ...fallbackResult,
    provider: "mock",
    status: "fallback_ok",
  };
}
