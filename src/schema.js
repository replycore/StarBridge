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
    stream INTEGER NOT NULL DEFAULT 0,
    gateway_key_id TEXT,
    fail_providers TEXT,
    trail TEXT
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
        // Column migration for databases created before the column
        // existed: CREATE TABLE IF NOT EXISTS is a no-op on an
        // existing table, so check the live shape and add the column
        // only when missing (idempotent on old and new databases).
        const cols = await env.DB.prepare("PRAGMA table_info(usage)").all();
        if (!(cols.results ?? []).some((c) => c.name === "gateway_key_id"))
          await env.DB.prepare("ALTER TABLE usage ADD COLUMN gateway_key_id TEXT").run();
        if (!(cols.results ?? []).some((c) => c.name === "fail_providers"))
          await env.DB.prepare("ALTER TABLE usage ADD COLUMN fail_providers TEXT").run();
        if (!(cols.results ?? []).some((c) => c.name === "trail"))
          await env.DB.prepare("ALTER TABLE usage ADD COLUMN trail TEXT").run();
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
