import { Router, Request, Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { generateVirtualKey, hashKey, requireAdmin } from "../auth.js";

export const adminRouter = Router();

// Protect all admin routes with requireAdmin middleware
adminRouter.use(requireAdmin);

const createKeySchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  budget_inr: z.number().positive("budget_inr must be positive").optional(),
  budget_micro: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .optional(),
}).refine((data) => data.budget_inr !== undefined || data.budget_micro !== undefined, {
  message: "Either budget_inr or budget_micro must be provided",
});

/**
 * POST /admin/keys
 * Create a new virtual API key with allocated budget
 */
adminRouter.post("/keys", async (req: Request, res: Response) => {
  const parseResult = createKeySchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "invalid_request", details: parseResult.error.format() });
    return;
  }

  const { name, budget_inr, budget_micro } = parseResult.data;

  // Convert budget to micro-rupees (1 INR = 1,000,000 micro-rupees)
  let budgetMicro: bigint;
  if (budget_micro !== undefined) {
    budgetMicro = BigInt(budget_micro);
  } else if (budget_inr !== undefined) {
    budgetMicro = BigInt(Math.round(budget_inr * 1_000_000));
  } else {
    res.status(400).json({ error: "missing_budget" });
    return;
  }

  const rawKey = generateVirtualKey();
  const keyHash = hashKey(rawKey);

  try {
    const result = await pool.query<{ id: string; budget_micro: string }>(
      `INSERT INTO api_keys (name, key_hash, budget_micro)
       VALUES ($1, $2, $3)
       RETURNING id, budget_micro`,
      [name, keyHash, budgetMicro.toString()]
    );

    const created = result.rows[0];

    // Raw key is returned once to caller and never stored in the database
    res.status(201).json({
      id: created.id,
      key: rawKey,
      budget_micro: Number(created.budget_micro),
    });
  } catch (error) {
    console.error("Failed to create API key:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

const keyIdParamSchema = z.object({
  keyId: z.string().uuid("Invalid key ID format"),
});

/**
 * GET /admin/usage/:keyId
 * View budget, spend, remaining balance, and recent usage logs for a key
 */
adminRouter.get("/usage/:keyId", async (req: Request, res: Response) => {
  const parseResult = keyIdParamSchema.safeParse(req.params);
  if (!parseResult.success) {
    res.status(400).json({ error: "invalid_key_id", details: parseResult.error.format() });
    return;
  }

  const { keyId } = parseResult.data;

  try {
    const keyResult = await pool.query<{
      id: string;
      name: string;
      budget_micro: string;
      spent_micro: string;
    }>(
      `SELECT id, name, budget_micro, spent_micro
       FROM api_keys
       WHERE id = $1`,
      [keyId]
    );

    if (keyResult.rows.length === 0) {
      res.status(404).json({ error: "key_not_found" });
      return;
    }

    const key = keyResult.rows[0];
    const budgetMicro = BigInt(key.budget_micro);
    const spentMicro = BigInt(key.spent_micro);
    const remainingMicro = budgetMicro - spentMicro;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM usage_logs WHERE key_id = $1`,
      [keyId]
    );
    const requestCount = Number(countResult.rows[0]?.count ?? 0);

    const logsResult = await pool.query<{
      model: string;
      provider: string;
      tokens_in: number;
      tokens_out: number;
      cost_micro: string;
      status: string;
      latency_ms: number | null;
      created_at: string;
    }>(
      `SELECT model, provider, tokens_in, tokens_out, cost_micro, status, latency_ms, created_at
       FROM usage_logs
       WHERE key_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [keyId]
    );

    const recent = logsResult.rows.map((row) => ({
      model: row.model,
      provider: row.provider,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      cost_micro: Number(row.cost_micro),
      status: row.status,
      latency_ms: row.latency_ms,
      created_at: row.created_at,
    }));

    res.status(200).json({
      key_id: key.id,
      name: key.name,
      budget_micro: Number(budgetMicro),
      spent_micro: Number(spentMicro),
      remaining_micro: Number(remainingMicro),
      request_count: requestCount,
      recent,
    });
  } catch (error) {
    console.error("Failed to fetch usage:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});
