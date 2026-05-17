import fs from "fs";
import path from "path";
import { pool } from "./db";

function log(msg: string) {
  console.log(`${new Date().toLocaleTimeString()} [migrate] ${msg}`);
}

/**
 * Auto-applies SQL files in /migrations on startup. Every statement in those
 * files MUST be idempotent (use `IF NOT EXISTS` / `IF EXISTS` / `ON CONFLICT`
 * etc.) — this runner does NOT track which files have already been applied.
 *
 * Files are executed in lexicographic order (e.g. 0001_..., 0002_...).
 * A failed migration is logged and re-thrown so the server fails fast in
 * production rather than booting with a broken schema.
 */
export async function runMigrations(): Promise<void> {
  const migrationsDir = path.resolve(process.cwd(), "migrations");
  if (!fs.existsSync(migrationsDir)) {
    log("no migrations/ directory — skipping");
    return;
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    log("no .sql migrations found");
    return;
  }

  log(`applying ${files.length} migration file(s)...`);
  for (const file of files) {
    const full = path.join(migrationsDir, file);
    const sql = fs.readFileSync(full, "utf8");
    const startedAt = Date.now();
    try {
      await pool.query(sql);
      const ms = Date.now() - startedAt;
      log(`✓ ${file} (${ms}ms)`);
    } catch (err: any) {
      log(`✗ ${file} FAILED: ${err?.message || err}`);
      throw err;
    }
  }
  log("all migrations applied");
}
