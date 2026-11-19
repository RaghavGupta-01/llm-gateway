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
