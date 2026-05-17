-- Migration: add missing columns to video_client_security
-- Safe to run multiple times: every ADD COLUMN uses IF NOT EXISTS, and the
-- defaults mirror api/_lib/schema.ts + server/security/securityTypes.ts so
-- existing rows are backfilled with values that match current runtime
-- behavior (admin-saved values are never overwritten).

ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS media_source_guard_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS velocity_scoring_enabled    boolean NOT NULL DEFAULT true;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS key_binding_enabled         boolean NOT NULL DEFAULT true;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS heartbeat_v2_enabled        boolean NOT NULL DEFAULT true;

ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS server_gated_window_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS short_token_ttl_enabled     boolean NOT NULL DEFAULT false;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS stealth_mode_enabled        boolean NOT NULL DEFAULT false;

ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS token_ttl_playlist_sec integer NOT NULL DEFAULT 60;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS token_ttl_segment_sec  integer NOT NULL DEFAULT 30;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS token_ttl_key_sec      integer NOT NULL DEFAULT 30;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS heartbeat_interval_sec integer NOT NULL DEFAULT 15;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS download_ahead_limit   integer NOT NULL DEFAULT 30;

ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS security_profile        text    NOT NULL DEFAULT 'balanced';
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS max_prebuffer_sec       integer NOT NULL DEFAULT 45;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS max_download_ahead_sec  integer NOT NULL DEFAULT 60;
ALTER TABLE video_client_security ADD COLUMN IF NOT EXISTS window_overlap_grace_sec integer NOT NULL DEFAULT 30;
