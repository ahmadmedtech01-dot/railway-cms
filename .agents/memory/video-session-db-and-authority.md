---
name: video_sessions DB target, sticky breaker, single-player authority
description: Non-obvious env/runtime facts for debugging video_sessions persistence and the LMS duplicate-player authority layer.
---

## The running server's DB is Supabase (= prod), not Replit's built-in DB
`server/db.ts` uses `SUPABASE_DATABASE_URL` when set, falling back to `DATABASE_URL`. When the secret is present, **dev and prod share the same Supabase DB** — schema changes made from the dev environment hit production.
**Why it matters:** Replit's `executeSql` tool and the built-in `DATABASE_URL` point at a *different* (built-in) database, so they will mislead you. To inspect/modify the real DB, use a node `pg` Pool with `SUPABASE_DATABASE_URL` + `ssl: { rejectUnauthorized: false }` (run the script from the project root so `pg` resolves; never print the connection string).
**Drizzle gotcha:** `npm run db:push` can offer a DANGEROUS interactive prompt to RENAME `user_sessions`→`video_sessions`. Decline / avoid it; prefer targeted DDL when the diff is ambiguous.

## The video_sessions write-through circuit breaker is process-sticky
`isMissingTableError` (SQLSTATE `42P01` table-missing **and** `42703` column-missing) trips `videoSessionsTableMissing`, which disables DB write-through for the **whole process** and never re-arms.
**Why it matters:** After you fix the schema, the already-running process stays in degraded in-memory mode and keeps logging the breaker message — you MUST restart the workflow to clear it. A breaker log line alone does not mean the table is still broken; check the table directly, then restart.

## Single-active-player authority is in-memory + per-process by design
`latestSidByIntegration` (Map integrationSessionId→latest sid) + `isStalePlayerSession` drop progress/position updates from a superseded player instance so a duplicate/backgrounded LMS iframe can't fight the live player. Stale updates are **dropped (return ok), never revoked** — revoking would trigger the client refresh loop.
**Why it deliberately isn't cluster-wide:** the check lives in the synchronous progress hot path; making it authoritative across Railway instances would need an async DB lookup or a persisted authoritative-sid column. The in-memory version covers the dominant same-instance duplicate-iframe case; cross-instance races fall back safely to per-SID windows + the `GREATEST()` monotonic resume-position guard (no downward clobber).
**Critical edge case (liveness gate):** never treat the newest-bound sid as authoritative unless it is still *alive* (recent createdAt/tick/heartbeat within ~max(30s, 2×heartbeatIntervalSec)). Without this, a created-then-abandoned sid (iframe minted a session but never played) would suppress the only genuinely-playing older sid and freeze it.
