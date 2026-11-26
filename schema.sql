-- D1 schema for free-ai-gateway.
-- Kept in sync with SCHEMA_STATEMENTS in src/schema.js: the Worker
-- creates the table automatically on the first request (idempotent),
-- so this file is only for manual initialisation or a local rebuild:
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
  stream INTEGER NOT NULL DEFAULT 0,
  gateway_key_id TEXT,
  fail_providers TEXT,
  trail TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage (day);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage (ts);
