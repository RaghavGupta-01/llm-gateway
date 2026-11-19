import crypto from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { pool } from "./db.js";

declare global {
  namespace Express {
    interface Request {
      keyId?: string;
    }
  }
}

/**
 * Generates a high-entropy virtual API key prefixed with gw_
 */
export function generateVirtualKey(): string {
  return "gw_" + crypto.randomBytes(24).toString("base64url");
}

/**
 * Computes SHA-256 hash of a raw key for storage and lookup
 */
export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Timing-safe string comparison that hashes both inputs first to prevent length leaks
 */
export function timingSafeCompare(provided: string, expected: string): boolean {
  const hashProvided = crypto.createHash("sha256").update(provided).digest();
  const hashExpected = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

/**
 * Middleware: Enforces admin bearer token authentication
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!timingSafeCompare(token, config.ADMIN_TOKEN)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

/**
 * Middleware: Enforces virtual API key authentication
 * Extracts Bearer gw_..., hashes with SHA-256, checks database
 */
export async function requireVirtualKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const rawKey = authHeader.slice(7).trim();
  const keyHash = hashKey(rawKey);

  try {
    const result = await pool.query<{ id: string; revoked_at: Date | null }>(
      `SELECT id, revoked_at FROM api_keys WHERE key_hash = $1`,
      [keyHash]
    );

    const apiKey = result.rows[0];
    if (!apiKey || apiKey.revoked_at !== null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    req.keyId = apiKey.id;
    next();
  } catch (error) {
    console.error("Authentication query error:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
}
