import { Router, Request, Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireVirtualKey } from "../auth.js";
import { isSupportedModel, actualCost, estimateReserve } from "../pricing.js";
import { reserveBudget, settleBudget, releaseBudget } from "../budget.js";
import { executeWithFallback, FatalGatewayError } from "../gateway.js";

export const chatRouter = Router();

// Protect chat completions with virtual key auth
chatRouter.use(requireVirtualKey);

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1, "Message content cannot be empty"),
});

const chatCompletionSchema = z.object({
  model: z.string().min(1, "Model is required"),
  messages: z.array(messageSchema).min(1, "Messages must be a non-empty array"),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
});

const MAX_TOKENS_CAP = 1024;

/**
 * POST /v1/chat/completions
 */
chatRouter.post("/chat/completions", async (req: Request, res: Response) => {
  if (!req.keyId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const keyId = req.keyId;

  const parseResult = chatCompletionSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "invalid_request", details: parseResult.error.format() });
    return;
  }

  const { model, messages, max_tokens, stream } = parseResult.data;

  // Rule: stream: true is rejected with 400 (streaming is not supported)
  if (stream === true) {
    res.status(400).json({ error: "streaming_not_supported" });
    return;
  }

  // Rule: model must exist in price table
  if (!isSupportedModel(model)) {
    res.status(400).json({ error: "unsupported_model", message: `Model '${model}' is not supported.` });
    return;
  }

  // Clamp max_tokens to MAX_TOKENS_CAP
  const effectiveMaxTokens = Math.min(max_tokens ?? MAX_TOKENS_CAP, MAX_TOKENS_CAP);

  // Estimate worst-case cost for budget reservation
  const promptChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
  const reserveMicro = estimateReserve(model, promptChars, effectiveMaxTokens);

  // 1. Atomic budget reservation (402 if over budget or revoked)
  const reserved = await reserveBudget(keyId, reserveMicro);
  if (!reserved) {
    res.status(402).json({ error: "budget_exceeded" });
    return;
  }

  const startTime = Date.now();

  try {
    // 2. Call gateway with 1x retry and mock provider fallback
    const result = await executeWithFallback({
      model,
      messages,
      max_tokens: effectiveMaxTokens,
    });

    const latencyMs = Date.now() - startTime;

    // 3. Settle transaction: mock fallback is priced at 0 per spec
    const actualMicro =
      result.status === "fallback_ok"
        ? 0n
        : actualCost(model, result.tokensIn, result.tokensOut);

    await settleBudget(keyId, reserveMicro, actualMicro, {
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costMicro: actualMicro,
      status: result.status,
      latencyMs,
    });

    // 4. Respond with provider JSON and gateway provider header
    res.setHeader("x-gateway-provider", result.provider);
    res.status(200).json(result.body);
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    console.error("Chat completion error:", error);

    // Release budget on failure (cost_micro = 0)
    await releaseBudget(keyId, reserveMicro, {
      provider: model === "mock" ? "mock" : "gemini",
      model,
      status: "failed",
      latencyMs,
    });

    // If fatal 4xx (bad request upstream), return clear 400-class error
    if (error instanceof FatalGatewayError) {
      res.status(error.status).json({
        error: "upstream_client_error",
        message: error.message,
      });
      return;
    }

    res.status(502).json({ error: "upstream_unavailable" });
  }
});
