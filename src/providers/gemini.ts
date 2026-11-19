import { config } from "../config.js";
import { Provider, ChatRequest, ProviderResult, ProviderError } from "./types.js";

interface GeminiResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class GeminiProvider implements Provider {
  public readonly name = "gemini" as const;

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ProviderResult> {
    const baseUrl = config.GEMINI_BASE_URL.replace(/\/+$/, "");
    const url = `${baseUrl}/chat/completions`;

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort(new Error("Gemini request timed out"));
    }, config.PROVIDER_TIMEOUT_MS);

    if (signal) {
      signal.addEventListener("abort", () => {
        timeoutController.abort(signal.reason);
      });
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.GEMINI_API_KEY}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.max_tokens,
          stream: false,
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        const status = response.status;
        const isRetryable = status === 429 || status >= 500;
        
        throw new ProviderError(
          `Gemini upstream responded with status ${status}`,
          isRetryable,
          status
        );
      }

      const data = (await response.json()) as GeminiResponse;

      const tokensIn = data.usage?.prompt_tokens ?? 0;
      const tokensOut = data.usage?.completion_tokens ?? 0;

      return {
        body: data,
        tokensIn,
        tokensOut,
        provider: "gemini",
        model: req.model,
      };
    } catch (err: unknown) {
      if (err instanceof ProviderError) {
        throw err;
      }

      if (timeoutController.signal.aborted) {
        throw new ProviderError("Gemini request timed out", true, 504);
      }

      const errorMessage = err instanceof Error ? err.message : "Unknown network error";
      throw new ProviderError(`Gemini network error: ${errorMessage}`, true, 502);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const geminiProvider = new GeminiProvider();
