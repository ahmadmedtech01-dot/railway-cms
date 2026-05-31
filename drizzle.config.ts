import { defineConfig } from "drizzle-kit";

const url = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL or SUPABASE_DATABASE_URL must be set");
}

export default defineConfig({
  out: "./migrations",
  schema: "./api/_lib/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
});
