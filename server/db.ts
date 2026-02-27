import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";

const connectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

if (process.env.SUPABASE_DATABASE_URL) {
  console.log("[db] Using Supabase database");
} else {
  console.log("[db] Using Replit database (SUPABASE_DATABASE_URL not set)");
}

const isVercel = !!process.env.VERCEL;
const isSupabase = !!process.env.SUPABASE_DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
  // Serverless (Vercel) uses 1 connection per function instance to avoid
  // exhausting Supabase's PgBouncer limits. Long-running servers use 3.
  max: isVercel ? 1 : isSupabase ? 3 : 10,
  // Short idle timeout on Vercel (functions are short-lived anyway).
  // Long timeout on Replit to keep SSL connections alive.
  idleTimeoutMillis: isVercel ? 10000 : 600000,
  connectionTimeoutMillis: 10000,
});

// Supabase's connection pooler (PgBouncer) ignores ALTER ROLE search_path,
// so we explicitly set it on every new connection.
pool.on("connect", (client) => {
  client.query("SET search_path TO public").catch(() => {});
});

// Prevent idle client errors from becoming uncaught exceptions.
pool.on("error", (err) => {
  console.error("[db] Pool idle client error (non-fatal):", err.message);
});

export const db = drizzle(pool, { schema });
export { pool };
