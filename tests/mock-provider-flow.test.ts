import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { app } from "../src/index.js";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";

describe("Log Only (Mock Provider Flow)", () => {
  let virtualKey: string;
  let keyId: string;

  beforeAll(async () => {
    // Create an API key for testing
    const adminRes = await request(app)
      .post("/admin/keys")
      .set("Authorization", `Bearer ${config.ADMIN_TOKEN}`)
      .send({ name: "mock-user", budget_inr: 10 });

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

  it("should reject stream: true with 400", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${virtualKey}`)
      .send({
        model: "mock",
        messages: [{ role: "user", content: "Say hi" }],
        stream: true,
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "streaming_not_supported" });
  });

  it("should reject an unsupported model with 400", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${virtualKey}`)
      .send({
        model: "unknown-model-xyz",
        messages: [{ role: "user", content: "Say hi" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_model");
  });

  it("should pass request through mock provider and log a row with sensible cost", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${virtualKey}`)
      .send({
        model: "mock",
        messages: [{ role: "user", content: "Hello gateway!" }],
        max_tokens: 50,
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-gateway-provider"]).toBe("mock");
    expect(res.body).toHaveProperty("choices");
    expect(res.body.choices[0].message.content).toBeTruthy();
    expect(res.body).toHaveProperty("usage");

    // Check usage_logs table in database
    const logRes = await pool.query(
      `SELECT key_id, provider, model, tokens_in, tokens_out, cost_micro, status, latency_ms
       FROM usage_logs
       WHERE key_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [keyId]
    );
    expect(logRes.rows.length).toBe(1);
    const logRow = logRes.rows[0];
    console.log(logRow);

    expect(logRow.key_id).toBe(keyId);
    expect(logRow.provider).toBe("mock");
    expect(logRow.model).toBe("mock");
    expect(logRow.tokens_in).toBeGreaterThan(0);
    expect(logRow.tokens_out).toBeGreaterThan(0);
    expect(logRow.status).toBe("ok");

    // Cost must be a positive integer BigInt (micro-rupees)
    const cost = BigInt(logRow.cost_micro);
    expect(cost).toBeGreaterThan(0n);
    console.log(`Verified sensible cost for tokens in=${logRow.tokens_in}, out=${logRow.tokens_out}: ${cost} micro-rupees`);
  });
});
