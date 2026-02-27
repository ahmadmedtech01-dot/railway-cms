import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const connectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

const isVercel = !!process.env.VERCEL;

// Re-use pool across serverless invocations
let pool: Pool;
const globalPool = global as unknown as { pool: Pool };

if (globalPool.pool) {
  pool = globalPool.pool;
} else {
  pool = new Pool({
    connectionString,
    ssl: connectionString?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
    max: 1, // Vercel best practice for serverless
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });

  pool.on("connect", (client) => {
    client.query("SET search_path TO public").catch(() => {});
  });

  if (isVercel) {
    globalPool.pool = pool;
  }
}

export const db = drizzle(pool, { schema });
export { pool };
