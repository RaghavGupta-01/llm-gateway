import express, { Request, Response } from "express";
import { config } from "./config.js";
import { pool } from "./db.js";

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

app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal_server_error" });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(config.PORT, () => {
    console.log(`LLM Gateway listening on port ${config.PORT}`);
  });
}
