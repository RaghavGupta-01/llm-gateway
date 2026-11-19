import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../src/config.js";

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const connectionString = config.DATABASE_URL_UNPOOLED || config.DATABASE_URL;
  console.log("Running migrations on Neon Postgres...");

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    console.log("Connected to database successfully.");

    const migrationFile = path.resolve(__dirname, "../migrations/001_init.sql");
    const sql = fs.readFileSync(migrationFile, "utf-8");

    console.log("Applying migrations from 001_init.sql...");
    await client.query(sql);

    // Verify tables were created
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('api_keys', 'usage_logs')
      ORDER BY table_name;
    `);

    console.log("Verified database tables:", res.rows.map(r => r.table_name).join(", "));
    console.log("Migrations applied successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
