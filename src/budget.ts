import { pool } from "./db.js";

export interface SettleLogInput {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costMicro: bigint;
  status: "ok" | "fallback_ok";
  latencyMs: number;
}

export interface ReleaseLogInput {
  provider: string;
  model: string;
  status: "failed";
  latencyMs: number;
}

/**
 * Atomic budget reservation.
 * Increments spent_micro by the estimated worst-case cost IF AND ONLY IF
 * the key is not revoked and the new spent amount does not exceed budget_micro.
 *
 * Returns true if reservation succeeded, false if over budget or revoked.
 */
export async function reserveBudget(keyId: string, reserveMicro: bigint): Promise<boolean> {
  const result = await pool.query(
    `UPDATE api_keys
        SET spent_micro = spent_micro + $2
      WHERE id = $1
        AND revoked_at IS NULL
        AND spent_micro + $2 <= budget_micro`,
    [keyId, reserveMicro.toString()]
  );

  return (result.rowCount ?? 0) === 1;
}

/**
 * Settle spend and write usage log in a single transaction.
 * Adjusts spent_micro by (actual - reserved).
 * (Note: if actual < reserved, (actual - reserved) is negative, refunding the excess).
 */
export async function settleBudget(
  keyId: string,
  reserveMicro: bigint,
  actualMicro: bigint,
  log: SettleLogInput
): Promise<void> {
  const diff = actualMicro - reserveMicro;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Adjust spent_micro
    await client.query(
      `UPDATE api_keys
          SET spent_micro = spent_micro + $2
        WHERE id = $1`,
      [keyId, diff.toString()]
    );

    // Insert usage log row
    await client.query(
      `INSERT INTO usage_logs (key_id, provider, model, tokens_in, tokens_out, cost_micro, status, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        keyId,
        log.provider,
        log.model,
        log.tokensIn,
        log.tokensOut,
        log.costMicro.toString(),
        log.status,
        log.latencyMs,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // Per spec: if settle throws after a successful provider call, log the error server-side
    // and let caller continue (reservation remains, which errs on conservative budget).
    console.error("Failed to settle budget in database:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Release reserved budget on total failure and record a failed usage log row.
 * Only successful calls are charged.
 */
export async function releaseBudget(
  keyId: string,
  reserveMicro: bigint,
  log: ReleaseLogInput
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Refund the reservation
    await client.query(
      `UPDATE api_keys
          SET spent_micro = spent_micro - $2
        WHERE id = $1`,
      [keyId, reserveMicro.toString()]
    );

    // Log the failed request with cost_micro = 0
    await client.query(
      `INSERT INTO usage_logs (key_id, provider, model, tokens_in, tokens_out, cost_micro, status, latency_ms)
       VALUES ($1, $2, $3, 0, 0, 0, $4, $5)`,
      [keyId, log.provider, log.model, log.status, log.latencyMs]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to release budget in database:", error);
  } finally {
    client.release();
  }
}
