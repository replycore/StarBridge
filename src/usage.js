import { __name } from "./helpers.js";
import { localDay, periodStart, randomId } from "./util.js";

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
// Per-request routing audit trail (item 10): one JSON event per
// pick attempt, stored as TEXT on the usage row. 16 KB cap: when
// the serialized trail would exceed it, the middle events are
// folded away and replaced by a single {truncated: N} marker
// between the first and last events, so the trail still shows how
// the request started and how it ended.
export var TRAIL_MAX_BYTES = 16 * 1024;
export function capTrail(events) {
  if (!Array.isArray(events) || !events.length)
    return null;
  const indexed = events.map((e, i) => ({ i, ...e }));
  let body = JSON.stringify(indexed);
  if (body.length <= TRAIL_MAX_BYTES)
    return body;
  // Fold the middle away, keeping the first and last events: drop
  // one event at a time from the middle until the folded form
  // fits (or only the two ends remain, in which case the marker
  // carries the count and the oversized ends are kept as-is —
  // a single event cannot exceed the cap on its own in practice).
  let dropped = 0;
  let kept = indexed;
  while (kept.length > 2) {
    const mid = kept.length >> 1;
    kept = [...kept.slice(0, mid), ...kept.slice(mid + 1)];
    dropped += 1;
    const folded = [kept[0], { truncated: dropped }, ...kept.slice(1)];
    body = JSON.stringify(folded);
    if (body.length <= TRAIL_MAX_BYTES)
      return body;
  }
  // Only the two ends remain and the folded form still does not
  // fit (a single event is pathologically large): keep the ends
  // as-is, with the marker only when events were actually folded.
  if (dropped === 0)
    return JSON.stringify(kept);
  return JSON.stringify([kept[0], { truncated: dropped }, ...kept.slice(1)]);
}
__name(capTrail, "capTrail");
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
        prompt_tokens, completion_tokens, total_tokens, latency_ms, attempts, error_kind, stream,
        gateway_key_id, fail_providers, trail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
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
export async function recordUsage(env, r, ctx, trail) {
  if (!env.DB)
    return;
  const trailText = capTrail(trail);
  // Failed requests only (decision 11): one JSON line with the
  // request id and a trail summary for `wrangler tail` triage.
  // The full trail lives on the D1 row (GET /admin/api/usage/trail);
  // no raw error text is logged here or stored in the trail.
  if (r.ok === false && trailText) {
    try {
      const events = JSON.parse(trailText);
      console.log("[trail] " + JSON.stringify({
        request_id: r.requestId ?? null,
        provider: r.provider,
        model: r.model,
        attempts: r.attempts,
        error_kind: r.errorKind ?? null,
        events: events.map((e) => ({
          i: e.i ?? null,
          provider: e.provider,
          model: e.model,
          status: e.status ?? null,
          kind: e.kind ?? null,
          decision: e.decision ?? null,
          decisionReason: e.decisionReason ?? null,
          ...(e.truncated != null ? { truncated: e.truncated } : {})
        }))
      }));
    } catch {
    }
  }
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
    r.stream ? 1 : 0,
    // The CALLER's gateway key id (auth identity), as opposed to
    // key_id above which names the upstream provider key that served
    // the request. Callers that do not know it leave it null.
    r.callerKeyId ?? null,
    // For an aggregate failure row (provider "gateway" spanning
    // several providers): the providers involved, comma-joined, so
    // the per-provider usage table can book the failure against
    // each of them instead of against the gateway itself.
    r.failProviders?.length ? r.failProviders.join(",") : null,
    trailText
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
export async function byProvider(env, resetOffsets = {}) {
  if (!env.DB)
    return [];
  try {
    // Each provider's "today" runs from midnight on its own reset
    // clock (resetOffsets: provider id -> UTC offset minutes,
    // default UTC+8), so rows are windowed by ts against each
    // provider's own period start instead of the single stored
    // day. A period start is always within the last 24 h, so one
    // bounded scan covers every provider's window.
    const now = Date.now();
    const starts = /* @__PURE__ */ new Map();
    const startOf = (name) => {
      if (!starts.has(name))
        starts.set(name, periodStart(now, resetOffsets[name]));
      return starts.get(name);
    };
    const res = await env.DB.prepare(
      `SELECT ts, provider, fail_providers, ok, prompt_tokens, completion_tokens, total_tokens, latency_ms
       FROM usage WHERE ts >= ?`
    ).bind(now - 36e5 * 25).all();
    const byName = /* @__PURE__ */ new Map();
    const entryOf = (name) => {
      let e = byName.get(name);
      if (!e) {
        e = { name, requests: 0, ok: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, avg_latency: 0, _lat: 0, period_start: startOf(name), reset_offset_min: resetOffsets[name] ?? 480 };
        byName.set(name, e);
      }
      return e;
    };
    const book = (name, r) => {
      if (r.ts < startOf(name))
        return;
      const e = entryOf(name);
      e.requests += 1;
      e.ok += r.ok ? 1 : 0;
      e.prompt_tokens += r.prompt_tokens || 0;
      e.completion_tokens += r.completion_tokens || 0;
      e.total_tokens += r.total_tokens || 0;
      e._lat += r.latency_ms || 0;
    };
    for (const r of res.results ?? []) {
      if (r.provider === "gateway") {
        // The gateway is not a provider: it never appears in this
        // table. An aggregate failure row is booked against each
        // provider it names in fail_providers (inside that
        // provider's own window); a gateway row naming nobody is
        // dropped from the table (it still counts in the day
        // totals and the recent list).
        for (const name of String(r.fail_providers ?? "").split(",").filter(Boolean))
          book(name, r);
      } else {
        book(r.provider, r);
      }
    }
    const rows = [...byName.values()].filter((e) => e.requests > 0);
    for (const e of rows) {
      e.avg_latency = e.requests ? e._lat / e.requests : 0;
      delete e._lat;
    }
    rows.sort((a, b) => b.requests - a.requests);
    return rows;
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
      `SELECT id, ts, provider, model, virtual_model, status, ok, total_tokens, latency_ms, attempts, error_kind
       FROM usage ORDER BY ts DESC LIMIT ?`
    ).bind(limit).all();
    return res.results ?? [];
  } catch {
    return [];
  }
}
__name(recent, "recent");
// One request's audit trail by usage-row id (item 10). The list
// endpoint (recent) never carries the trail — it would add ~2 KB
// per row. Returns the parsed event array, or null when the row
// does not exist or predates trails.
export async function usageTrail(env, id) {
  if (!env.DB || typeof id !== "string" || !id)
    return null;
  try {
    const row = await env.DB.prepare(
      `SELECT trail FROM usage WHERE id = ?`
    ).bind(id).first();
    if (!row || !row.trail)
      return null;
    const parsed = JSON.parse(row.trail);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
__name(usageTrail, "usageTrail");
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
