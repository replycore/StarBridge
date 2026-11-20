import { __name } from "./helpers.js";
import { loadAlerts, loadProviders } from "./store.js";
import { coordFetch } from "./coord-client.js";

export var ALERT_STATE_KEY = "alerts:state:v1";
export var REALERT_MS = 30 * 6e4;
export var REASON_LABELS = {
  no_capacity: "聊天请求无可用候选",
  sync: "目录同步后检查"
};

export async function sendPush(env, cfg, title, body) {
  const attempts = [];
  if (cfg.bark) {
    try {
      const base = cfg.bark.replace(/\/+$/, "");
      const res = await fetch(base + "/" + encodeURIComponent(title) + "/" + encodeURIComponent(body) + "?group=free-ai-gateway", { signal: AbortSignal.timeout(1e4) });
      attempts.push({ via: "bark", ok: res.ok });
    } catch (e) {
      attempts.push({ via: "bark", ok: false, error: String(e?.message ?? e) });
    }
  }
  if (cfg.webhook) {
    try {
      const res = await fetch(cfg.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body, text: title + "\n" + body, source: "free-ai-gateway", at: new Date().toISOString() }),
        signal: AbortSignal.timeout(1e4)
      });
      attempts.push({ via: "webhook", ok: res.ok });
    } catch (e) {
      attempts.push({ via: "webhook", ok: false, error: String(e?.message ?? e) });
    }
  }
  return { ok: attempts.some((a) => a.ok), attempts };
}
__name(sendPush, "sendPush");

export async function evaluateAlerts(env, reason) {
  try {
    const cfg = await loadAlerts(env);
    if (!cfg.enabled || (!cfg.bark && !cfg.webhook))
      return;
    const [providers, stats] = await Promise.all([
      loadProviders(env),
      coordFetch(env, "/stats").catch(() => null)
    ]);
    if (!stats)
      return;
    const now = Date.now();
    const health = new Map((stats.keys ?? []).map((k) => [k.key, k]));
    const downNow = {};
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
        downNow[p.id] = now;
    }
    let state = { down: {}, alertedAt: {} };
    try {
      const raw = await env.GW_KV.get(ALERT_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object")
          state = { down: parsed.down ?? {}, alertedAt: parsed.alertedAt ?? {} };
      }
    } catch {
    }
    for (const id of Object.keys(downNow)) {
      if (state.down[id])
        downNow[id] = state.down[id];
    }
    const newlyDown = Object.keys(downNow).filter((id) => !state.down[id] && now - (state.alertedAt[id] ?? 0) > REALERT_MS);
    const recovered = Object.keys(state.down).filter((id) => !downNow[id]);
    const downChanged = JSON.stringify(Object.keys(downNow).sort()) !== JSON.stringify(Object.keys(state.down).sort());
    if (newlyDown.length || recovered.length) {
      const lines = [];
      for (const id of newlyDown)
        lines.push("服务商 " + id + " 的全部 Key 当前不可用（冷却 / 熔断 / 失效 / 额度用尽）");
      for (const id of recovered)
        lines.push("服务商 " + id + " 已恢复可用");
      const label = REASON_LABELS[reason] ?? reason ?? "";
      if (label)
        lines.push("触发：" + label);
      const sent = await sendPush(env, cfg, "free-ai-gateway 告警", lines.join("\n"));
      if (sent.ok) {
        for (const id of newlyDown)
          state.alertedAt[id] = now;
        state.down = downNow;
        await env.GW_KV.put(ALERT_STATE_KEY, JSON.stringify(state)).catch(() => void 0);
      }
    } else if (downChanged) {
      state.down = downNow;
      await env.GW_KV.put(ALERT_STATE_KEY, JSON.stringify(state)).catch(() => void 0);
    }
  } catch (e) {
    console.error("[alerts] evaluate failed", e);
  }
}
__name(evaluateAlerts, "evaluateAlerts");
