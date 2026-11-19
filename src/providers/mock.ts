import crypto from "node:crypto";
import { Provider, ChatRequest, ProviderResult, ProviderError } from "./types.js";

export class MockProvider implements Provider {
  public readonly name = "mock" as const;
  public shouldFail: boolean = false;

  async chat(req: ChatRequest, _signal?: AbortSignal): Promise<ProviderResult> {
    if (this.shouldFail) {
      throw new ProviderError("Mock provider simulated upstream failure", true, 502);
    }

    const promptChars = req.messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
    const tokensIn = Math.max(1, Math.ceil(promptChars / 4));
    const tokensOut = Math.min(req.max_tokens ?? 50, 15);

    const body = {
      id: "chatcmpl-mock-" + crypto.randomBytes(8).toString("hex"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Mock response from LLM Gateway.",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        total_tokens: tokensIn + tokensOut,
      },
    };

    return {
      body,
      tokensIn,
      tokensOut,
      provider: "mock",
      model: req.model,
    };
  }
}

export const mockProvider = new MockProvider();
