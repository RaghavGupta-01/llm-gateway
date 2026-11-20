import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeWithFallback, FatalGatewayError } from "../src/gateway.js";
import { geminiProvider } from "../src/providers/gemini.js";
import { mockProvider } from "../src/providers/mock.js";
import { ProviderError } from "../src/providers/types.js";
import { config } from "../src/config.js";

describe("Gateway Retry & Fallback Orchestration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.MOCK_FORCE_PRIMARY_FAIL = false;
  });

  afterEach(() => {
    config.MOCK_FORCE_PRIMARY_FAIL = false;
  });

  it("should return primary gemini result directly on first success", async () => {
    const fakeResult = {
      body: { choices: [{ message: { content: "Direct success" } }] },
      tokensIn: 10,
      tokensOut: 20,
      provider: "gemini" as const,
      model: "gemini-3.8-flash",
    };

    const geminiSpy = vi.spyOn(geminiProvider, "chat").mockResolvedValue(fakeResult);

    const result = await executeWithFallback({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.provider).toBe("gemini");
    expect(result.status).toBe("ok");
    expect(result.tokensIn).toBe(10);
    expect(geminiSpy).toHaveBeenCalledTimes(1);
  });

  it("should retry once on transient error and succeed if second attempt passes", async () => {
    const fakeResult = {
      body: { choices: [{ message: { content: "Success on retry" } }] },
      tokensIn: 10,
      tokensOut: 20,
      provider: "gemini" as const,
      model: "gemini-3.8-flash",
    };

    const geminiSpy = vi
      .spyOn(geminiProvider, "chat")
      .mockRejectedValueOnce(new ProviderError("Transient 503 error", true, 503))
      .mockResolvedValueOnce(fakeResult);

    const result = await executeWithFallback({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(geminiSpy).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("gemini");
    expect(result.status).toBe("ok");
    expect((result.body as any).choices[0].message.content).toBe("Success on retry");
  });

  it("should fall back to mock provider if primary fails twice with retryable error", async () => {
    const geminiSpy = vi
      .spyOn(geminiProvider, "chat")
      .mockRejectedValue(new ProviderError("Gateway Timeout 504", true, 504));

    const mockSpy = vi.spyOn(mockProvider, "chat");

    const result = await executeWithFallback({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(geminiSpy).toHaveBeenCalledTimes(2);
    expect(mockSpy).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("mock");
    expect(result.status).toBe("fallback_ok");
    expect(result.body).toHaveProperty("choices");
  });

  it("should NOT retry and NOT fall back on fatal 4xx error", async () => {
    const geminiSpy = vi
      .spyOn(geminiProvider, "chat")
      .mockRejectedValue(new ProviderError("Invalid argument 400", false, 400));

    const mockSpy = vi.spyOn(mockProvider, "chat");

    try {
      await executeWithFallback({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Bad Request" }],
      });
      expect.fail("Should have thrown FatalGatewayError");
    } catch (err) {
      expect(err).toBeInstanceOf(FatalGatewayError);
      const fatal = err as FatalGatewayError;
      expect(fatal.status).toBe(400);
      expect(geminiSpy).toHaveBeenCalledTimes(1); // Never retried
      expect(mockSpy).not.toHaveBeenCalled(); // Never called fallback
    }
  });

  it("should honor MOCK_FORCE_PRIMARY_FAIL=true by triggering fallback to mock", async () => {
    config.MOCK_FORCE_PRIMARY_FAIL = true;
    const geminiSpy = vi.spyOn(geminiProvider, "chat");
    const mockSpy = vi.spyOn(mockProvider, "chat");

    const result = await executeWithFallback({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Demo fallback" }],
    });

    expect(geminiSpy).not.toHaveBeenCalled(); // Primary was bypassed/failed by flag
    expect(mockSpy).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("mock");
    expect(result.status).toBe("fallback_ok");
  });
});
