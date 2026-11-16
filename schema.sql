-- D1 schema for free-ai-gateway.
-- The deployed Worker code contains no CREATE TABLE: it only reads/writes
-- the `usage` table and tolerates it missing (writes fail silently, stats
-- return zeros). This file was reconstructed on 2026-11-16 from the queries
-- in src/usage.ts so a fresh D1 (local or remote) can be initialised:
--   wrangler d1 execute free-ai-gateway --local  --file schema.sql
--   wrangler d1 execute free-ai-gateway --remote --file schema.sql
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  key_id TEXT,
  virtual_model TEXT,
  status INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT,
  stream INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage (day);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage (ts);
