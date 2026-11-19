import express, { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import { adminRouter } from "./routes/admin.js";
import { requireVirtualKey } from "./auth.js";

export const app = express();

app.use(express.json());

app.get("/health", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Health check database error:", error);
    res.status(503).json({ status: "error", error: "database_unavailable" });
  }
});

app.use("/admin", adminRouter);

app.get("/v1/auth/verify", requireVirtualKey, (req: Request, res: Response) => {
  res.status(200).json({ status: "authenticated", keyId: req.keyId });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled application error:", err);
  res.status(500).json({ error: "internal_server_error" });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(config.PORT, () => {
    console.log(`LLM Gateway listening on port ${config.PORT}`);
  });
}
