import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { app } from "../src/index.js";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";

describe("Admin Key Creation & Auth Middleware", () => {
  let createdKey: string;
  let createdKeyId: string;

  afterAll(async () => {
    if (createdKeyId) {
      await pool.query("DELETE FROM api_keys WHERE id = $1", [createdKeyId]);
    }
    await pool.end();
  });

  describe("Admin Authentication", () => {
    it("should reject requests without authorization header with 401", async () => {
      const res = await request(app)
        .post("/admin/keys")
        .send({ name: "test-user", budget_inr: 5 });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized" });
    });

    it("should reject requests with invalid admin token with 401", async () => {
      const res = await request(app)
        .post("/admin/keys")
        .set("Authorization", "Bearer invalid-admin-token-wrong")
        .send({ name: "test-user", budget_inr: 5 });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized" });
    });

    it("should successfully create a key with valid admin token", async () => {
      const res = await request(app)
        .post("/admin/keys")
        .set("Authorization", `Bearer ${config.ADMIN_TOKEN}`)
        .send({ name: "test-admin-key", budget_inr: 5 });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("key");
      expect(res.body).toHaveProperty("budget_micro", 5000000);

      createdKey = res.body.key;
      createdKeyId = res.body.id;

      // Virtual key format check: starts with gw_
      expect(createdKey).toMatch(/^gw_[A-Za-z0-9_-]+/);

      // Verify database contains ONLY the SHA-256 hash and not the raw key
      const dbRow = await pool.query(
        "SELECT id, name, key_hash, budget_micro FROM api_keys WHERE id = $1",
        [createdKeyId]
      );
      expect(dbRow.rows.length).toBe(1);

      const expectedHash = crypto.createHash("sha256").update(createdKey).digest("hex");
      expect(dbRow.rows[0].key_hash).toBe(expectedHash);
      expect(dbRow.rows[0].key_hash).not.toContain(createdKey);
    });
  });

  describe("Virtual Key Authentication", () => {
    it("should reject request without Bearer token with 401", async () => {
      const res = await request(app).get("/v1/auth/verify");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized" });
    });

    it("should reject request with an unknown virtual key with 401", async () => {
      const res = await request(app)
        .get("/v1/auth/verify")
        .set("Authorization", "Bearer gw_nonexistent_fake_key_123");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized" });
    });

    it("should authenticate successfully with the valid virtual key", async () => {
      const res = await request(app)
        .get("/v1/auth/verify")
        .set("Authorization", `Bearer ${createdKey}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "authenticated",
        keyId: createdKeyId,
      });
    });

    it("should reject a revoked virtual key with 401", async () => {
      // Revoke the key in the database
      await pool.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [createdKeyId]);

      const res = await request(app)
        .get("/v1/auth/verify")
        .set("Authorization", `Bearer ${createdKey}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized" });
    });
  });
});
