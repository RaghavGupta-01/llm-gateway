import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  ADMIN_TOKEN: z.string().min(32, "ADMIN_TOKEN must be at least 32 characters long"),
  PORT: z.coerce.number().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", JSON.stringify(parsed.error.format(), null, 2));
  throw new Error("Invalid environment configuration. Check your .env or .env.local file.");
}

export const config = parsed.data;
