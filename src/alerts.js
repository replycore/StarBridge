import { __name } from "./helpers.js";
import { loadAlerts, loadProviders } from "./store.js";
import { coordFetch } from "./coord-client.js";

export var REALERT_MS = 30 * 6e4;
export var REASON_LABELS = {
  no_capacity: "聊天请求无可用候选",
  sync: "目录同步后检查"
};

async function sendBark(cfg, title, body) {
  try {
    const base = cfg.bark.replace(/\/+$/, "");
    const res = await fetch(base + "/" + encodeURIComponent(title) + "/" + encodeURIComponent(body) + "?group=free-ai-gateway", { signal: AbortSignal.timeout(1e4) });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
__name(sendBark, "sendBark");
async function sendWebhook(cfg, title, body) {
  try {
    const res = await fetch(cfg.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body, text: title + "\n" + body, source: "free-ai-gateway", at: new Date().toISOString() }),
      signal: AbortSignal.timeout(1e4)
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
__name(sendWebhook, "sendWebhook");
export async function sendPush(env, cfg, title, body) {
  const attempts = [];
  if (cfg.bark)
    attempts.push({ via: "bark", ...await sendBark(cfg, title, body) });
  if (cfg.webhook)
    attempts.push({ via: "webhook", ...await sendWebhook(cfg, title, body) });
  return { ok: attempts.some((a) => a.ok), attempts };
}
__name(sendPush, "sendPush");
// Send on the named channels only; returns the channels that
// accepted the push. Alert delivery is tracked per channel inside
// the Coordinator, so a channel that missed an alert is retried on
// the next evaluation without re-pushing the channels that got it.
async function sendOnChannels(env, cfg, title, body, channels) {
  const ok = [];
  for (const c of channels) {
    const r = c === "bark" ? await sendBark(cfg, title, body) : await sendWebhook(cfg, title, body);
    if (r.ok)
      ok.push(c);
  }
  return ok;
}
__name(sendOnChannels, "sendOnChannels");

export async function evaluateAlerts(env, reason) {
  try {
    const cfg = await loadAlerts(env);
    if (!cfg.enabled || (!cfg.bark && !cfg.webhook))
      return;
    const channels = [...cfg.bark ? ["bark"] : [], ...cfg.webhook ? ["webhook"] : []];
    const [providers, stats] = await Promise.all([
      loadProviders(env),
      coordFetch(env, "/stats").catch(() => null)
    ]);
    if (!stats)
      return;
    const health = new Map((stats.keys ?? []).map((k) => [k.key, k]));
    const down = [];
    for (const p of providers) {
      if (!p.enabled)
        continue;
      const keys = (p.keys ?? []).filter((k) => !k.disabled);
      if (!keys.length)
        continue;
      const allDown = keys.every((k) => {
        const h = health.get(p.id + ":" + k.id);
        if (!h)
          return false;
        return Boolean(h.invalid || h.cooling || h.breakerTripped || (h.dayLimit > 0 && h.dayCount >= h.dayLimit));
      });
      if (allDown)
        down.push(p.id);
    }
    // Which transitions to announce is decided inside the
    // Coordinator: its single-threaded state replaces the old
    // read-modify-write KV record, whose races could duplicate a
    // push, announce a recovery for an outage that was never
    // announced, or count a partially delivered alert as sent.
    const trans = await coordFetch(env, "/alerts", { down, channels, realertMs: REALERT_MS }).catch(() => null);
    if (!trans)
      return;
    const label = REASON_LABELS[reason] ?? reason ?? "";
    const deliver = async (items, lineFor, withLabel) => {
      const byChannel = new Map();
      for (const it of items ?? []) {
        for (const c of it.channels ?? []) {
          if (!byChannel.has(c))
            byChannel.set(c, []);
          byChannel.get(c).push(it.id);
        }
      }
      const acked = new Map();
      for (const [c, ids] of byChannel) {
        const lines = ids.map(lineFor);
        if (withLabel && label)
          lines.push("触发：" + label);
        const okChannels = await sendOnChannels(env, cfg, "星桥 StarBridge 告警", lines.join("\n"), [c]);
        if (okChannels.length)
          for (const id of ids) {
            if (!acked.has(id))
              acked.set(id, []);
            acked.get(id).push(c);
          }
      }
      return [...acked.entries()].map(([id, chs]) => ({ id, channels: chs }));
    };
    const ack = { down: [], recovered: [] };
    if (trans.downAnnounce?.length)
      ack.down = await deliver(trans.downAnnounce, (id) => "服务商 " + id + " 的全部 Key 当前不可用（冷却 / 熔断 / 失效 / 额度用尽）", true);
    if (trans.recoveredAnnounce?.length)
      ack.recovered = await deliver(trans.recoveredAnnounce, (id) => "服务商 " + id + " 已恢复可用", false);
    if (ack.down.length || ack.recovered.length)
      await coordFetch(env, "/alerts-ack", ack).catch(() => void 0);
  } catch (e) {
    console.error("[alerts] evaluate failed", e);
  }
}
__name(evaluateAlerts, "evaluateAlerts");
