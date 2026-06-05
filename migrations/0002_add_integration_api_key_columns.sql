-- Migration: add api_key_prefix and api_key_hash to integration_api_keys
-- The table previously used 'key_hash' only; the Simple API needs a prefix
-- for O(1) lookup + a separate hash for timing-safe verification.
-- Safe to run multiple times: all statements use IF NOT EXISTS.

ALTER TABLE integration_api_keys ADD COLUMN IF NOT EXISTS api_key_prefix TEXT;
ALTER TABLE integration_api_keys ADD COLUMN IF NOT EXISTS api_key_hash    TEXT;

-- key_hash was the old column; new rows use api_key_hash + api_key_prefix.
-- Drop the NOT NULL so old rows coexist with new ones.
ALTER TABLE integration_api_keys ALTER COLUMN key_hash DROP NOT NULL;
