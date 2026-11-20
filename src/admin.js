import { Coordinator } from "./coordinator.js";
import { __name } from "./helpers.js";
import { allGroupsOf, buildCustomGroup, customGroupKey, groupStrategy, groupsOf, invalidateCaches, loadCatalog, loadCustomGroups, loadGatewayKeys, loadGroupStrategies, loadAlerts, loadProviders, removeProvider, saveAlerts, saveCustomGroups, saveGatewayKeys, saveGroupStrategies, saveProviders, storeWarning } from "./store.js";
import { applyPreset } from "./config.js";
import { byKey, byModel, byProvider, dailySeries, flushUsageBuffer, recent, totals } from "./usage.js";
import { checkToken } from "./auth.js";
import { coordFetch } from "./coord-client.js";
import { json, localDay, maskKey, openAIError, randomId, truncate } from "./util.js";
import { originAllowed } from "./admin-origin.js";
import { probeModel, syncAll } from "./discovery.js";
import { sendPush } from "./alerts.js";

// Admin auth throttle: failed /admin/api/* auth attempts are counted
// per client IP in the Coordinator (see /auth-* routes there). After
// ADMIN_AUTH_MAX_FAILS consecutive failures the client gets 429 +
// Retry-After for ADMIN_AUTH_LOCKOUT_MS — even with the right token —
// and a successful login clears the counter. If the Coordinator is
// unreachable the throttle fails open; the token check itself still
// applies, so a DO outage never locks the admin out.
export function adminClientId(req) {
  const cf = req.headers.get("cf-connecting-ip") ?? "";
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0] ?? "";
  return (cf.trim() || xff.trim() || "unknown").slice(0, 128);
}
__name(adminClientId, "adminClientId");
export function adminLockedResponse(st) {
  const retryAfterMs = Math.max(1e3, st?.retryAfterMs ?? 0);
  const retrySec = Math.ceil(retryAfterMs / 1e3);
  return json(
    { error: { message: `管理接口失败次数过多，已临时锁定，请 ${retrySec} 秒后再试`, type: "rate_limited", code: 429, retryAfterMs } },
    { status: 429, headers: { "retry-after": String(retrySec) } }
  );
}
__name(adminLockedResponse, "adminLockedResponse");
export async function handleAdmin(req, env, ctx, url) {
  const parts = url.pathname.replace(/^\/admin\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();
  // Backend-only: there is no admin UI on the Worker. The dashboard lives
  // on Pages (https://ai.reply.kdns.fr) and talks to /admin/api/* with a
  // Bearer token. Everything else under /admin is a plain JSON 404.
  if (parts[0] !== "api")
    return openAIError(404, "not found");
  if (!originAllowed(env, req))
    return openAIError(403, "origin not allowed", "forbidden");
  const clientId = adminClientId(req);
  let throttle = null;
  try {
    throttle = await coordFetch(env, "/auth-check", { client: clientId });
  } catch {
    throttle = null;
  }
  if (throttle?.locked)
    return adminLockedResponse(throttle);
  const auth = checkToken(req, env, "admin");
  if (!auth.ok) {
    if (auth.reason === "unconfigured") {
      return openAIError(500, "\u672A\u914D\u7F6E ADMIN_TOKEN\uFF0C\u8BF7\u5148 wrangler secret put ADMIN_TOKEN", "configuration_error");
    }
    let after = null;
    try {
      after = await coordFetch(env, "/auth-fail", { client: clientId });
    } catch {
      after = null;
    }
    if (after?.locked)
      return adminLockedResponse(after);
    return openAIError(401, "admin token \u65E0\u6548", "authentication_error");
  }
  if (throttle && throttle.fails > 0) {
    try {
      await coordFetch(env, "/auth-ok", { client: clientId });
    } catch {
    }
  }
  const sub = parts[1] ?? "";
  try {
    if (sub === "overview" && method === "GET") {
      await flushUsageBuffer(env);
      return json(await overview(env));
    }
    if (sub === "providers" && method === "GET")
      return json({ providers: await listProviders(env) });
    if (sub === "providers" && method === "POST" && parts.length === 2) {
      const body = await req.json();
      const provider = buildProvider(body);
      const list = await loadProviders(env, true);
      const idx = list.findIndex((p) => p.id === provider.id);
      if (idx >= 0) {
        provider.createdAt = list[idx].createdAt;
        const old = list[idx];
        if (body.enabled == null)
          provider.enabled = old.enabled;
        if (body.headers == null)
          provider.headers = old.headers;
        if (body.dropParams == null)
          provider.dropParams = old.dropParams;
        if (body.streamUsage == null)
          provider.streamUsage = old.streamUsage;
        if (body.label == null)
          provider.label = old.label;
        if (body.notes == null)
          provider.notes = old.notes;
        if (body.weight == null)
          provider.weight = old.weight;
        const merged = [...list[idx].keys ?? []];
        for (const k of provider.keys) {
          if (!merged.some((e) => e.key === k.key))
            merged.push({ ...k, id: nextKeyId(merged) });
        }
        provider.keys = merged;
        list[idx] = provider;
      } else {
        const assigned = [];
        for (const k of provider.keys)
          assigned.push({ ...k, id: nextKeyId(assigned) });
        provider.keys = assigned;
        list.push(provider);
      }
      await saveProviders(env, list);
      invalidateCaches();
      return json({ ok: true, provider: redactProvider(provider) });
    }
    if (sub === "providers" && method === "POST" && parts.length === 4 && parts[3] === "keys") {
      const body = await req.json();
      const list = await loadProviders(env, true);
      const p = list.find((x) => x.id === parts[2]);
      if (!p)
        return openAIError(404, "provider \u4E0D\u5B58\u5728");
      const incoming = body.keys?.length ? body.keys : body.key ? [body.key] : [];
      if (!incoming.length)
        return openAIError(400, "\u7F3A\u5C11 key");
      for (const k of incoming) {
        const v = k.trim();
        if (!v || p.keys.some((e) => e.key === v))
          continue;
        p.keys.push({
          id: nextKeyId(p.keys),
          key: v,
          label: body.label,
          dailyLimit: body.dailyLimit
        });
      }
      p.updatedAt = Date.now();
      await saveProviders(env, list);
      invalidateCaches();
      return json({ ok: true, keys: p.keys.map((k) => ({ id: k.id, masked: maskKey(k.key) })) });
    }
    if (sub === "providers" && method === "PATCH" && parts.length === 5 && parts[3] === "keys") {
      const body = await req.json().catch(() => ({}));
      const list = await loadProviders(env, true);
      const p = list.find((x) => x.id === parts[2]);
      if (!p)
        return openAIError(404, "provider 不存在");
      const key = p.keys.find((k) => k.id === parts[4]);
      if (!key)
        return openAIError(404, "key 不存在");
      if (typeof body.disabled === "boolean")
        key.disabled = body.disabled;
      p.updatedAt = Date.now();
      await saveProviders(env, list);
      invalidateCaches();
      return json({ ok: true, key: { id: key.id, disabled: !!key.disabled } });
    }
    if (sub === "providers" && method === "DELETE" && parts.length === 5 && parts[3] === "keys") {
      const list = await loadProviders(env, true);
      const p = list.find((x) => x.id === parts[2]);
      if (!p)
        return openAIError(404, "provider \u4E0D\u5B58\u5728");
      p.keys = p.keys.filter((k) => k.id !== parts[4]);
      p.updatedAt = Date.now();
      await saveProviders(env, list);
      invalidateCaches();
      return json({ ok: true });
    }
    if (sub === "providers" && method === "DELETE" && parts.length === 3) {
      await removeProvider(env, parts[2]);
      invalidateCaches();
      return json({ ok: true });
    }
    if (sub === "gateway-keys" && method === "GET") {
      const envKeys = (env.GATEWAY_TOKEN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const keys = await loadGatewayKeys(env, true);
      return json({ env: envKeys, keys });
    }
    if (sub === "gateway-keys" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const value = String(body.key ?? "").trim() || `gw-${randomId("")}${randomId("")}`;
      const list = await loadGatewayKeys(env, true);
      if (list.some((k) => k.key === value))
        return openAIError(400, "\u8FD9\u628A\u8C03\u7528 Key \u5DF2\u5B58\u5728");
      const entry = {
        id: `g${list.length + 1}-${randomId("").slice(0, 6)}`,
        key: value,
        label: body.label ? String(body.label).slice(0, 60) : void 0,
        dailyLimit: body.dailyLimit != null ? Math.max(0, Math.floor(Number(body.dailyLimit)) || 0) : void 0,
        createdAt: Date.now()
      };
      list.push(entry);
      await saveGatewayKeys(env, list);
      invalidateCaches();
      return json({ ok: true, entry });
    }
    if (sub === "gateway-keys" && method === "DELETE" && parts.length === 3) {
      const list = (await loadGatewayKeys(env, true)).filter((k) => k.id !== parts[2]);
      await saveGatewayKeys(env, list);
      invalidateCaches();
      return json({ ok: true });
    }
    if (sub === "export" && method === "GET") {
      const [providers, gatewayKeys, groupStrategies, customGroups] = await Promise.all([
        loadProviders(env),
        loadGatewayKeys(env),
        loadGroupStrategies(env),
        loadCustomGroups(env)
      ]);
      return json({
        app: "free-ai-gateway",
        kind: "config-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        data: { providers, gatewayKeys, groupStrategies, customGroups }
      });
    }
    if (sub === "import" && method === "POST") {
      const body = await req.json().catch(() => null);
      const data = body?.data;
      if (!body || body.kind !== "config-backup" || !data || typeof data !== "object")
        return openAIError(400, "备份文件格式不对：缺少 config-backup 标记或 data 段");
      const done = [];
      if (Array.isArray(data.providers)) {
        await saveProviders(env, data.providers);
        done.push("providers");
      }
      if (Array.isArray(data.gatewayKeys)) {
        await saveGatewayKeys(env, data.gatewayKeys);
        done.push("gatewayKeys");
      }
      if (data.groupStrategies && typeof data.groupStrategies === "object" && !Array.isArray(data.groupStrategies)) {
        await saveGroupStrategies(env, data.groupStrategies);
        done.push("groupStrategies");
      }
      if (Array.isArray(data.customGroups)) {
        await saveCustomGroups(env, data.customGroups);
        done.push("customGroups");
      }
      if (!done.length)
        return openAIError(400, "备份里没有可导入的内容");
      invalidateCaches();
      return json({ ok: true, imported: done });
    }
    if (sub === "alerts" && method === "GET") {
      const cfg = await loadAlerts(env);
      const hostOf = (u) => {
        try {
          return u ? new URL(u).host : "";
        } catch {
          return "";
        }
      };
      return json({ enabled: cfg.enabled, barkSet: Boolean(cfg.bark), webhookSet: Boolean(cfg.webhook), barkHost: hostOf(cfg.bark), webhookHost: hostOf(cfg.webhook) });
    }
    if (sub === "alerts" && method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const cur = await loadAlerts(env);
      const pick = (v, old) => v === null ? "" : typeof v === "string" && v.trim() ? v.trim() : old;
      const next = {
        enabled: body.enabled === true,
        bark: pick(body.bark, cur.bark),
        webhook: pick(body.webhook, cur.webhook)
      };
      await saveAlerts(env, next);
      return json({ ok: true });
    }
    if (sub === "alerts" && parts[2] === "test" && method === "POST") {
      const cfg = await loadAlerts(env);
      if (!cfg.bark && !cfg.webhook)
        return openAIError(400, "尚未配置推送地址（Bark 或 Webhook）");
      const r = await sendPush(env, cfg, "free-ai-gateway 测试推送", "收到这条消息说明告警通道可用。服务商全部 Key 不可用或恢复时会自动推送。");
      if (!r.ok)
        return openAIError(502, "推送发送失败，请检查地址是否正确");
      return json({ ok: true });
    }
    if (sub === "sync" && method === "POST") {
      const probe = url.searchParams.get("probe") === "1";
      const only = url.searchParams.get("provider") ?? void 0;
      const report = await syncAll(env, { probe, only });
      invalidateCaches();
      return json(report);
    }
    if (sub === "groups" && parts[2] === "custom" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = String(body.id ?? "").trim();
      const keywords = Array.isArray(body.keywords) ? [...new Set(body.keywords.map((k) => String(k).trim()).filter(Boolean))] : [];
      if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(id) || id.length > 80 || /^auto\b/i.test(id))
        return json({ error: "invalid model id" }, { status: 400 });
      if (!keywords.length || keywords.length > 10 || keywords.some((k) => k.length > 40))
        return json({ error: "keywords must be 1-10 non-empty strings of up to 40 chars" }, { status: 400 });
      const catalog2 = await loadCatalog(env, true);
      const derived2 = groupsOf(catalog2);
      const clash = derived2.some((g) => g.id.toLowerCase() === id.toLowerCase() || g.aliases.some((a) => a.toLowerCase() === id.toLowerCase()));
      if (clash)
        return json({ error: "model id collides with an existing catalog model" }, { status: 409 });
      const defs2 = await loadCustomGroups(env, true);
      const next2 = defs2.filter((d) => d.id.toLowerCase() !== id.toLowerCase());
      next2.push({ id, keywords });
      await saveCustomGroups(env, next2);
      const built2 = buildCustomGroup({ id, keywords }, catalog2?.entries ?? []);
      return json({ ok: true, id, keywords, matched: built2 ? built2.endpoints.length : 0, providers: built2 ? built2.providers : [] });
    }
    if (sub === "groups" && parts[2] === "custom" && method === "DELETE") {
      const id = String(url.searchParams.get("id") ?? "").trim();
      if (!id)
        return json({ error: "id is required" }, { status: 400 });
      const defs3 = await loadCustomGroups(env, true);
      const next3 = defs3.filter((d) => d.id.toLowerCase() !== id.toLowerCase());
      if (next3.length === defs3.length)
        return json({ error: "custom model not found" }, { status: 404 });
      await saveCustomGroups(env, next3);
      const strategies3 = await loadGroupStrategies(env, true);
      if (strategies3[customGroupKey(id)]) {
        delete strategies3[customGroupKey(id)];
        await saveGroupStrategies(env, strategies3);
      }
      return json({ ok: true, id });
    }
    if (sub === "groups" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const key = String(body.key ?? "").trim();
      if (!key)
        return json({ error: "key is required" }, { status: 400 });
      if (body.strategy != null && body.strategy !== "failover" && body.strategy !== "balance")
        return json({ error: "strategy must be failover or balance" }, { status: 400 });
      const map = await loadGroupStrategies(env, true);
      if (body.strategy == null)
        delete map[key];
      else
        map[key] = body.strategy;
      await saveGroupStrategies(env, map);
      return json({ ok: true, key, strategy: groupStrategy(map, key) });
    }
    if (sub === "groups" && method === "GET") {
      const catalog = await loadCatalog(env, true);
      const strategies = await loadGroupStrategies(env);
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const minRaw = Number(url.searchParams.get("min") ?? 1);
      const min = Number.isFinite(minRaw) ? minRaw : 1;
      let groups = await allGroupsOf(env, catalog);
      const customDefs = await loadCustomGroups(env);
      const builtIds = new Set(groups.map((g) => g.id.toLowerCase()));
      for (const def of customDefs) {
        if (!builtIds.has(def.id.toLowerCase())) {
          groups.push({
            id: def.id, key: customGroupKey(def.id), providers: [], endpoints: [], aliases: [],
            family: "", tags: [], toolsAll: false, created: 0, custom: true, keywords: def.keywords
          });
        }
      }
      groups = groups.filter((g) => g.custom || g.providers.length >= min);
      if (q) {
        groups = groups.filter(
          (g) => g.id.toLowerCase().includes(q) || g.key.includes(q) || g.aliases.some((a) => a.toLowerCase().includes(q)) || (g.keywords ?? []).some((k) => k.toLowerCase().includes(q))
        );
      }
      const limit = limitParam(url);
      const list = groups.slice(0, limit).map((g) => ({
        id: g.id,
        key: g.key,
        providers: g.providers,
        endpoints: g.endpoints.map((e) => ({
          provider: e.provider,
          model: e.model,
          contextLength: e.contextLength,
          tags: e.tags
        })),
        aliases: g.aliases,
        contextLength: g.contextLength,
        family: g.family,
        tags: g.tags,
        toolsAll: g.toolsAll,
        strategy: groupStrategy(strategies, g.key),
        custom: g.custom === true,
        keywords: g.keywords ?? []
      }));
      return json({
        syncedAt: catalog?.syncedAt ?? 0,
        total: groups.length,
        shared: groups.filter((g) => g.providers.length > 1).length,
        defaultStrategy: "balance",
        groups: list
      });
    }
    if (sub === "catalog" && method === "GET") {
      const catalog = await loadCatalog(env, true);
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      let entries = catalog?.entries ?? [];
      if (q)
        entries = entries.filter((e) => e.model.toLowerCase().includes(q) || e.family.includes(q));
      const limit = limitParam(url);
      return json({
        syncedAt: catalog?.syncedAt ?? 0,
        stats: catalog?.stats ?? { total: 0, providers: 0, families: 0 },
        providers: catalog?.providers ?? [],
        entries: entries.slice(0, limit)
      });
    }
    if (sub === "stats" && method === "GET") {
      await flushUsageBuffer(env);
      const stats = await coordFetch(env, "/stats");
      return json(stats);
    }
    if (sub === "reset" && method === "POST") {
      await coordFetch(env, "/reset", {});
      return json({ ok: true });
    }
    if (sub === "probe" && method === "POST") {
      const body = await req.json();
      const list = await loadProviders(env);
      const p = list.find((x) => x.id === body.provider);
      if (!p || !body.model)
        return openAIError(400, "\u7F3A\u5C11 provider \u6216 model");
      const key = body.keyId ? p.keys.find((k) => k.id === body.keyId && !k.disabled) : p.keys.find((k) => !k.disabled);
      if (!key)
        return openAIError(400, "\u8BE5 provider \u6CA1\u6709\u53EF\u7528 key");
      const ok = await probeModel(p, key, body.model);
      return json({ ok });
    }
    return openAIError(404, "unknown admin route");
  } catch (e) {
    console.error("[admin]", e);
    return openAIError(500, truncate(String(e?.message ?? e), 300));
  }
}
__name(handleAdmin, "handleAdmin");
export function limitParam(url) {
  const n = Number(url.searchParams.get("limit") ?? 500);
  if (!Number.isFinite(n))
    return 500;
  return Math.min(Math.max(Math.floor(n), 0), 2e3);
}
__name(limitParam, "limitParam");
export function nextKeyId(keys) {
  let n = keys.length + 1;
  while (keys.some((k) => k.id === `k${n}`))
    n += 1;
  return `k${n}`;
}
__name(nextKeyId, "nextKeyId");
export function buildProvider(body) {
  const id = String(body.id ?? "").trim();
  if (!id)
    throw new Error("\u7F3A\u5C11 provider id");
  // The id is joined into Coordinator health keys (provider:keyId),
  // catalog keys (provider/model) and provider/model model ids; a
  // ":" or "/" in it would silently cross-wire those namespaces.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id))
    throw new Error("provider id \u53EA\u80FD\u7528\u5B57\u6BCD\u6570\u5B57\u548C . _ -\uFF08\u226440 \u5B57\u7B26\uFF09");
  const keysRaw = Array.isArray(body.keys) ? body.keys : typeof body.apiKey === "string" ? String(body.apiKey).split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : [];
  const base = applyPreset({
    id,
    preset: body.preset,
    label: body.label,
    kind: body.kind,
    baseUrl: body.baseUrl,
    freeMode: body.freeMode,
    allow: body.allow,
    deny: body.deny,
    enabled: body.enabled,
    headers: body.headers,
    dropParams: body.dropParams,
    streamUsage: body.streamUsage,
    weight: body.weight != null ? Number(body.weight) : void 0,
    dailyLimitDefault: body.dailyLimitDefault != null ? Number(body.dailyLimitDefault) : void 0,
    rpmDefault: body.rpmDefault != null ? Number(body.rpmDefault) : void 0,
    modelsPath: body.modelsPath,
    notes: body.notes
  });
  base.keys = keysRaw.map((k, i) => ({
    id: `k${i + 1}`,
    key: k,
    dailyLimit: body.dailyLimit != null ? Number(body.dailyLimit) : void 0
  }));
  return base;
}
__name(buildProvider, "buildProvider");
export function redactProvider(p) {
  return {
    ...p,
    keys: p.keys.map((k) => ({ id: k.id, label: k.label, masked: maskKey(k.key), dailyLimit: k.dailyLimit, disabled: k.disabled }))
  };
}
__name(redactProvider, "redactProvider");
export async function listProviders(env) {
  const list = await loadProviders(env);
  return list.map(redactProvider);
}
__name(listProviders, "listProviders");
export async function overview(env) {
  const day = localDay();
  const [providers, catalog, health, today, provUsage, modelUsage, keyUsage, series, recentRows, strategies] = await Promise.all([
    loadProviders(env),
    loadCatalog(env),
    coordFetch(env, "/stats").catch(
      () => ({ day, keys: [], models: { total: 0, dead: [], erroring: [] }, drops: {} })
    ),
    totals(env, day),
    byProvider(env, day),
    byModel(env, day, 50),
    byKey(env, day),
    dailySeries(env, 14),
    recent(env, 40),
    loadGroupStrategies(env)
  ]);
  const healthByKey = new Map(health.keys.map((k) => [k.key, k]));
  const usageByKey = new Map(keyUsage.map((k) => [k.name, k]));
  const usageByProvider = new Map(provUsage.map((p) => [p.name, p]));
  const provOut = providers.map((p) => {
    const u = usageByProvider.get(p.id);
    return {
      ...redactProvider(p),
      usage: u ? { requests: u.requests, tokens: u.total_tokens, ok: u.ok } : { requests: 0, tokens: 0, ok: 0 },
      keys: p.keys.map((k) => {
        const h = healthByKey.get(`${p.id}:${k.id}`);
        const ku = usageByKey.get(`${p.id}:${k.id}`);
        return {
          id: k.id,
          label: k.label,
          masked: maskKey(k.key),
          disabled: k.disabled,
          dailyLimit: k.dailyLimit ?? p.dailyLimitDefault ?? 0,
          dayCount: h?.dayCount ?? 0,
          cooling: h?.cooling ?? false,
          invalid: h?.invalid ?? false,
          fails: h?.fails ?? 0,
          requests: ku?.requests ?? 0,
          tokens: ku?.total_tokens ?? 0
        };
      })
    };
  });
  const groupList = await allGroupsOf(env, catalog);
  return {
    now: Date.now(),
    warning: storeWarning(),
    catalog: {
      syncedAt: catalog?.syncedAt ?? 0,
      stats: catalog?.stats ?? { total: 0, providers: 0, families: 0 },
      providers: catalog?.providers ?? [],
      groups: {
        total: groupList.length,
        shared: groupList.filter((g) => g.providers.length > 1).length,
        // 冗余度最高的几个，直接展示在首页
        top: groupList.filter((g) => g.providers.length > 1).slice(0, 8).map((g) => ({
          id: g.id,
          key: g.key,
          providers: g.providers,
          endpoints: g.endpoints.length,
          contextLength: g.contextLength,
          strategy: groupStrategy(strategies, g.key)
        }))
      }
    },
    providers: provOut,
    health: { models: health.models, drops: health.drops },
    usage: {
      today,
      totals: today,
      byProvider: provUsage,
      byModel: modelUsage,
      series,
      recent: recentRows
    }
  };
}
__name(overview, "overview");
