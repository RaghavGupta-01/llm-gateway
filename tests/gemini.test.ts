import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { geminiProvider } from "../src/providers/gemini.js";
import { ProviderError } from "../src/providers/types.js";

describe("Gemini Provider Adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should successfully format and return OpenAI-compatible result", async () => {
    const fakeResponse = {
      id: "chatcmpl-test-123",
      object: "chat.completion",
      created: 123456789,
      model: "gemini-3.8-flash",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Pong from Gemini" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeResponse,
    });

    const result = await geminiProvider.chat({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Say pong" }],
      max_tokens: 50,
    });

    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-3.8-flash");
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(8);
    expect(result.body).toEqual(fakeResponse);

    // Verify fetch arguments
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["Authorization"]).toMatch(/^Bearer /);
  });

  it("should classify 429 rate limit as retryable ProviderError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: "Resource exhausted" } }),
      json: async () => ({ error: { message: "Resource exhausted" } }),
    });

    try {
      await geminiProvider.chat({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Say hi" }],
      });
      expect.fail("Should have thrown ProviderError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const provErr = err as ProviderError;
      expect(provErr.isRetryable).toBe(true);
      expect(provErr.status).toBe(429);
    }
  });

  it("should classify 5xx server error as retryable ProviderError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { message: "Service unavailable" } }),
      json: async () => ({ error: { message: "Service unavailable" } }),
    });

    try {
      await geminiProvider.chat({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Say hi" }],
      });
      expect.fail("Should have thrown ProviderError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const provErr = err as ProviderError;
      expect(provErr.isRetryable).toBe(true);
      expect(provErr.status).toBe(503);
    }
  });

  it("should classify 400 client error as non-retryable fatal ProviderError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Invalid argument" } }),
      json: async () => ({ error: { message: "Invalid argument" } }),
    });

    try {
      await geminiProvider.chat({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Say hi" }],
      });
      expect.fail("Should have thrown ProviderError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const provErr = err as ProviderError;
      expect(provErr.isRetryable).toBe(false);
      expect(provErr.status).toBe(400);
    }
  });
});
