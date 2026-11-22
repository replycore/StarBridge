import { __name } from "./helpers.js";
import { localDay, randomId } from "./util.js";

export var USAGE_FLUSH_MAX = 20;
export var USAGE_FLUSH_MS = 4e3;
// Safety cap for the retry buffer only: failed rows are retained in
// full below this size. If a sustained D1 outage pushes the combined
// buffer past the cap, the oldest rows are dropped — never silently:
// every drop increments usageDroppedTotal, is logged, and is reported
// in the flush result.
export var USAGE_RETAIN_CAP = 5e3;
export var usageBuffer = [];
export var usageFlushTimer = null;
export var usageFlushing = null;
export var usageDroppedTotal = 0;
export async function flushUsageBuffer(env) {
  if (!env.DB)
    return { flushed: 0, dropped: 0 };
  if (usageFlushing) {
    // A flush is in flight. Wait for it, then drain whatever arrived
    // while it ran — previously such rows were left buffered until an
    // unrelated future record happened to trigger another flush.
    await usageFlushing.catch(() => void 0);
    if (!usageBuffer.length)
      return { flushed: 0, dropped: 0 };
    return flushUsageBuffer(env);
  }
  if (!usageBuffer.length)
    return { flushed: 0, dropped: 0 };
  const rows = usageBuffer.splice(0, usageBuffer.length);
  const sql = `INSERT INTO usage
       (id, ts, day, provider, model, key_id, virtual_model, status, ok,
        prompt_tokens, completion_tokens, total_tokens, latency_ms, attempts, error_kind, stream)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const run = (async () => {
    try {
      await env.DB.batch(rows.map((v) => env.DB.prepare(sql).bind(...v)));
      return { flushed: rows.length, dropped: 0, failed: false };
    } catch (e) {
      console.error("[usage] \u6279\u91CF\u5199\u5165\u5931\u8D25", e);
      // Retain ALL failed rows ahead of newer arrivals; only the
      // safety cap may drop, and drops are counted and logged.
      usageBuffer = rows.concat(usageBuffer);
      let dropped = 0;
      if (usageBuffer.length > USAGE_RETAIN_CAP) {
        dropped = usageBuffer.length - USAGE_RETAIN_CAP;
        usageBuffer = usageBuffer.slice(dropped);
        usageDroppedTotal += dropped;
        console.error(`[usage] retry buffer over cap ${USAGE_RETAIN_CAP}: dropped ${dropped} oldest rows (total dropped: ${usageDroppedTotal})`);
      }
      return { flushed: 0, dropped, failed: true };
    }
  })();
  usageFlushing = run;
  let result;
  try {
    result = await run;
  } finally {
    if (usageFlushing === run)
      usageFlushing = null;
  }
  // Trailing drain: rows recorded while this batch was in flight are
  // flushed now, in this same call, instead of lingering indefinitely.
  // (Skipped after a failure: the retained rows wait for the next
  // trigger rather than spinning against a down D1.)
  if (!result.failed && usageBuffer.length) {
    const tail = await flushUsageBuffer(env);
    return { flushed: result.flushed + tail.flushed, dropped: result.dropped + tail.dropped };
  }
  return { flushed: result.flushed, dropped: result.dropped };
}
__name(flushUsageBuffer, "flushUsageBuffer");
export async function recordUsage(env, r, ctx) {
  if (!env.DB)
    return;
  usageBuffer.push([
    randomId("u_"),
    Date.now(),
    localDay(),
    r.provider,
    r.model,
    r.keyId,
    r.virtualModel,
    r.status,
    r.ok ? 1 : 0,
    r.usage?.prompt_tokens ?? 0,
    r.usage?.completion_tokens ?? 0,
    r.usage?.total_tokens ?? 0,
    Math.round(r.latencyMs),
    r.attempts,
    r.errorKind ?? null,
    r.stream ? 1 : 0
  ]);
  if (usageBuffer.length >= USAGE_FLUSH_MAX) {
    const p = flushUsageBuffer(env);
    if (ctx)
      ctx.waitUntil(p);
    else
      await p;
    return;
  }
  if (ctx && !usageFlushTimer) {
    usageFlushTimer = (async () => {
      await new Promise((res) => setTimeout(res, USAGE_FLUSH_MS));
      usageFlushTimer = null;
      await flushUsageBuffer(env);
    })();
    ctx.waitUntil(usageFlushTimer);
  }
}
__name(recordUsage, "recordUsage");
export var EMPTY = {
  requests: 0,
  ok: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  avg_latency: 0
};
export async function totals(env, day = localDay()) {
  if (!env.DB)
    return EMPTY;
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(ok),0) AS ok,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(AVG(latency_ms),0) AS avg_latency
       FROM usage WHERE day = ?`
    ).bind(day).first();
    return row ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
__name(totals, "totals");
export async function byProvider(env, day = localDay()) {
  if (!env.DB)
    return [];
  try {
    const res = await env.DB.prepare(
      `SELECT provider AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(ok),0) AS ok,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(AVG(latency_ms),0) AS avg_latency
       FROM usage WHERE day = ? GROUP BY provider ORDER BY requests DESC`
    ).bind(day).all();
    return res.results ?? [];
  } catch {
    return [];
  }
}
__name(byProvider, "byProvider");
export async function byModel(env, day = localDay(), limit = 50) {
  if (!env.DB)
    return [];
  try {
    const res = await env.DB.prepare(
      `SELECT model AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(ok),0) AS ok,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(AVG(latency_ms),0) AS avg_latency
       FROM usage WHERE day = ? GROUP BY model ORDER BY requests DESC LIMIT ?`
    ).bind(day, limit).all();
    return res.results ?? [];
  } catch {
    return [];
  }
}
__name(byModel, "byModel");
export async function byKey(env, day = localDay()) {
  if (!env.DB)
    return [];
  try {
    const res = await env.DB.prepare(
      `SELECT provider || ':' || key_id AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(ok),0) AS ok,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(AVG(latency_ms),0) AS avg_latency
       FROM usage WHERE day = ? GROUP BY provider, key_id ORDER BY requests DESC`
    ).bind(day).all();
    return res.results ?? [];
  } catch {
    return [];
  }
}
__name(byKey, "byKey");
export async function dailySeries(env, days = 14) {
  if (!env.DB)
    return [];
  try {
    const res = await env.DB.prepare(
      `SELECT day,
              COUNT(*) AS requests,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS errors
       FROM usage GROUP BY day ORDER BY day DESC LIMIT ?`
    ).bind(days).all();
    return (res.results ?? []).reverse();
  } catch {
    return [];
  }
}
__name(dailySeries, "dailySeries");
export async function recent(env, limit = 50) {
  if (!env.DB)
    return [];
  try {
    const res = await env.DB.prepare(
      `SELECT ts, provider, model, virtual_model, status, ok, total_tokens, latency_ms, attempts, error_kind
       FROM usage ORDER BY ts DESC LIMIT ?`
    ).bind(limit).all();
    return res.results ?? [];
  } catch {
    return [];
  }
}
__name(recent, "recent");
export async function cleanup(env, retentionDays = 90) {
  if (!env.DB)
    return;
  try {
    const cutoff = Date.now() - retentionDays * 864e5;
    // One unbounded DELETE scans the whole table and can hit D1's
    // per-statement time limit once months of rows accumulate (after
    // which cleanup fails every cycle and the table grows forever).
    // Delete in indexed batches of 5000, at most 200 batches a run.
    for (let i = 0; i < 200; i++) {
      const r = await env.DB.prepare(
        `DELETE FROM usage WHERE rowid IN (SELECT rowid FROM usage WHERE ts < ? LIMIT 5000)`
      ).bind(cutoff).run();
      if ((r?.meta?.changes ?? 0) < 5000)
        break;
    }
  } catch (e) {
    console.error("[usage] \u6E05\u7406\u5931\u8D25", e);
  }
}
__name(cleanup, "cleanup");
