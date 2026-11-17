import { __name } from "./helpers.js";

// Auto-create the D1 schema on first deployment / first use.
// Idempotent (IF NOT EXISTS) and memoised per isolate: after the first
// successful run it costs one resolved promise per request. On failure the
// memo is cleared so the next request retries. This removes the manual
// "create the usage table before first deploy" step entirely.
export var SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS usage (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_day ON usage (day)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage (ts)`
];
export var schemaReady = null;
export async function ensureSchema(env) {
  if (!env.DB)
    return;
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)));
        console.log("[schema] usage table ready");
      } catch (e) {
        schemaReady = null;
        console.error("[schema] auto-create failed, will retry on next request", e);
      }
    })();
  }
  return schemaReady;
}
__name(ensureSchema, "ensureSchema");
