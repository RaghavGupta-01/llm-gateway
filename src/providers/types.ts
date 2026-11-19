export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  stream?: boolean;
}

export interface ProviderResult {
  body: unknown;
  tokensIn: number;
  tokensOut: number;
  provider: "gemini" | "mock";
  model: string;
}

export class ProviderError extends Error {
  public readonly isRetryable: boolean;
  public readonly status: number;

  constructor(message: string, isRetryable: boolean, status: number = 500) {
    super(message);
    this.name = "ProviderError";
    this.isRetryable = isRetryable;
    this.status = status;
  }
}

export interface Provider {
  readonly name: "gemini" | "mock";
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ProviderResult>;
}
