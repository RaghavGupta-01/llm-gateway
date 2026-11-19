import { Router, Request, Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireVirtualKey } from "../auth.js";
import { isSupportedModel, actualCost } from "../pricing.js";
import { mockProvider } from "../providers/mock.js";

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

  const startTime = Date.now();

  try {
    // Send request to mock provider
    const result = await mockProvider.chat({
      model,
      messages,
      max_tokens: effectiveMaxTokens,
    });

    const latencyMs = Date.now() - startTime;

    // Calculate actual cost in micro-rupees
    const costMicro = actualCost(model, result.tokensIn, result.tokensOut);

    // Insert usage log
    await pool.query(
      `INSERT INTO usage_logs (key_id, provider, model, tokens_in, tokens_out, cost_micro, status, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.keyId,
        result.provider,
        result.model,
        result.tokensIn,
        result.tokensOut,
        costMicro.toString(),
        "ok",
        latencyMs,
      ]
    );

    // Response header and JSON body
    res.setHeader("x-gateway-provider", result.provider);
    res.status(200).json(result.body);
  } catch (error) {
    console.error("Chat completion error:", error);
    res.status(502).json({ error: "upstream_unavailable" });
  }
});
