import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { app } from "../src/index.js";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { estimateReserve, actualCost } from "../src/pricing.js";

describe("Concurrency: Near-Exhausted Key Parallelism", () => {
  let virtualKey: string;
  let keyId: string;

  // We will configure a budget that allows exactly 2 requests to succeed
  // Prompt ~12 chars -> 3 tokens in -> 30 micro-rupees
  // Max tokens 15 -> 300 micro-rupees
  // Reservation estimate per request: ~330 micro-rupees
  // Actual cost per mock request: (4 in * 10) + (15 out * 20) = 340 micro-rupees
  // Budget of 700 micro-rupees allows 2 requests (2 * 330 = 660 <= 700), but rejects the 3rd (3 * 330 = 990 > 700)
  const budgetMicro = 700n;

  beforeAll(async () => {
    const adminRes = await request(app)
      .post("/admin/keys")
      .set("Authorization", `Bearer ${config.ADMIN_TOKEN}`)
      .send({
        name: "concurrency-user",
        budget_micro: budgetMicro.toString(),
      });

    expect(adminRes.status).toBe(201);
    virtualKey = adminRes.body.key;
    keyId = adminRes.body.id;
  });

  afterAll(async () => {
    if (keyId) {
      await pool.query("DELETE FROM usage_logs WHERE key_id = $1", [keyId]);
      await pool.query("DELETE FROM api_keys WHERE id = $1", [keyId]);
    }
    await pool.end();
  });

  it("should handle 10 concurrent requests without race conditions or budget overshooting", async () => {
    const parallelCount = 10;

    // Fire 10 simultaneous requests against the near-exhausted key
    const promises = Array.from({ length: parallelCount }).map(() =>
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", `Bearer ${virtualKey}`)
        .send({
          model: "mock",
          messages: [{ role: "user", content: "Concurrency!" }],
          max_tokens: 15,
        })
    );

    const responses = await Promise.all(promises);

    // Group responses by status code
    const successes = responses.filter((r) => r.status === 200);
    const budgetRejections = responses.filter((r) => r.status === 402);

    console.log(`[Concurrency Test] ${successes.length} succeeded (200), ${budgetRejections.length} rejected (402)`);

    // Every single request must be either a 200 success or a 402 budget exceeded
    expect(successes.length + budgetRejections.length).toBe(parallelCount);

    for (const r of budgetRejections) {
      expect(r.body).toEqual({ error: "budget_exceeded" });
    }

    // Inspect final state in database
    const keyRes = await pool.query<{ budget_micro: string; spent_micro: string }>(
      "SELECT budget_micro, spent_micro FROM api_keys WHERE id = $1",
      [keyId]
    );

    const keyRow = keyRes.rows[0];
    const finalBudget = BigInt(keyRow.budget_micro);
    const finalSpent = BigInt(keyRow.spent_micro);

    console.log(`[Concurrency DB State] spent_micro: ${finalSpent}, budget_micro: ${finalBudget}`);

    // CRITICAL INVARIANT: spent_micro must NEVER exceed budget_micro
    expect(finalSpent <= finalBudget).toBe(true);

    // Number of successful requests must match database logs
    const logRes = await pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM usage_logs WHERE key_id = $1 AND status = 'ok'",
      [keyId]
    );
    const loggedCount = Number(logRes.rows[0].count);
    expect(loggedCount).toBe(successes.length);
  });
});
