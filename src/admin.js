import { Coordinator } from "./coordinator.js";
import { __name } from "./helpers.js";
import { allGroupsOf, alertsLoadFailed, buildCustomGroup, cfLoadFailed, customGroupKey, encrypt, gatewayKeysLoadFailed, groupStrategy, groupsOf, invalidateCaches, loadCatalog, loadCfConfig, loadCustomGroups, loadGatewayKeys, loadGroupStrategies, loadAlerts, loadProviders, loadRetryPolicy, removeProvider, saveAlerts, saveCfConfig, saveCustomGroups, saveGatewayKeys, saveGroupStrategies, saveProviders, saveRetryPolicy, storeWarning } from "./store.js";
import { applyPreset, validateServiceUrl } from "./config.js";
import { byKey, byModel, byProvider, dailySeries, flushUsageBuffer, recent, totals } from "./usage.js";
import { checkToken } from "./auth.js";
import { coordFetch } from "./coord-client.js";
import { json, localDay, maskKey, openAIError, randomId, truncate, errorSourceFor, upstreamErrorMeta } from "./util.js";
import { decideRetry, normalizeRetryPolicy } from "./retry.js";
import { originAllowed } from "./admin-origin.js";
import { fetchModels, probeModel, syncAll } from "./discovery.js";
import { resolveCandidates } from "./catalog.js";
import { sendPush } from "./alerts.js";
import { fetchCfUsage, listWorkerDomains } from "./cf.js";

// Admin auth throttle: failed /admin/api/* auth attempts are counted
// per client IP in the Coordinator (see /auth-* routes there). After
// ADMIN_AUTH_MAX_FAILS consecutive failures the client gets 429 +
// Retry-After for ADMIN_AUTH_LOCKOUT_MS — even with the right token —
// and a successful login clears the counter. If the Coordinator is
// unreachable the throttle fails open; the token check itself still
// applies, so a DO outage never locks the admin out.
export async function adminClientId(req) {
  // Only the Cloudflare-injected header keys the throttle: falling
  // back to X-Forwarded-For would let a caller mint a fresh bucket
  // per request by rotating a self-supplied header value.
  const cf = (req.headers.get("cf-connecting-ip") ?? "").trim();
  if (cf)
    return cf.slice(0, 128);
  // No cf-connecting-ip (local dev, non-Cloudflare proxy): keying
  // every such client into one shared "unknown" bucket would let one
  // client's failures lock out all the others. Fall back to a stable
  // fingerprint of the caller's own headers instead — still not a
  // caller-rotatable value per request in practice, and prefixed so
  // it can never collide with a real IP bucket.
  try {
    const fp = (req.headers.get("user-agent") ?? "") + "\n" + (req.headers.get("accept-language") ?? "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fp));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return ("hdr-" + hex.slice(0, 24)).slice(0, 128);
  } catch {
    return "unknown";
  }
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
// Public view of the stored Cloudflare account config: identity
// fields in the clear, the credential only as a mask — the stored
// apiKey/token never leave through the API.
export function cfConfigView(cfg) {
  const secret = cfg.token || cfg.apiKey;
  return {
    configured: Boolean(cfg.accountId) && Boolean(cfg.apiKey || cfg.token),
    accountId: cfg.accountId,
    email: cfg.email,
    authType: cfg.token ? "token" : cfg.apiKey ? "global" : null,
    keyMasked: secret ? maskKey(secret) : ""
  };
}
__name(cfConfigView, "cfConfigView");
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
  const clientId = await adminClientId(req);
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
      const list = await loadProviders(env, true);
      // Partial update: backfill any field the caller omitted from
      // the stored record before building, so a POST that only flips
      // e.g. `enabled` cannot reset baseUrl/kind/limits to preset
      // defaults (or throw for a missing baseUrl).
      const existing = list.find((p) => p.id === String(body.id ?? "").trim());
      if (existing) {
        for (const f of ["label", "kind", "baseUrl", "preset", "freeMode", "freeRules", "allow", "deny", "enabled", "headers", "dropParams", "streamUsage", "weight", "priority", "dailyLimitDefault", "rpmDefault", "resetOffsetMin", "modelsPath", "notes"])
          if (body[f] == null)
            body[f] = existing[f];
      }
      let provider;
      try {
        provider = buildProvider(body);
      } catch (e) {
        // Same 400 the import path already returns for an invalid
        // record (bad id, non-string keys, and now an unacceptable
        // baseUrl/modelsPath) instead of the generic 500.
        return openAIError(400, truncate(String(e?.message ?? e), 200));
      }
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
    if (sub === "providers" && method === "POST" && parts.length === 3 && parts[2] === "preview-models") {
      const body = await req.json();
      // Preview the upstream model list for the provider form's
      // free-rule picker. Two shapes: {providerId} reuses the
      // stored provider's endpoint and its first enabled key;
      // {baseUrl, kind?, modelsPath?, key} previews the values
      // currently typed into the form (baseUrl must pass the same
      // validateServiceUrl gate as a saved provider). Fetch
      // failures and empty lists come back as 200 with an error
      // string so the form can show a hint instead of an exception.
      let p = null;
      let key = null;
      if (body.providerId != null && String(body.providerId).trim()) {
        const list = await loadProviders(env);
        p = list.find((x) => x.id === String(body.providerId).trim()) ?? null;
        if (!p)
          return json({ models: [], error: `服务商 ${body.providerId} 不存在` });
        key = (p.keys ?? []).find((k) => !k.disabled) ?? null;
        if (!key)
          return json({ models: [], error: `服务商 ${p.id} 没有可用 key` });
      } else {
        const baseUrl = validateServiceUrl(typeof body.baseUrl === "string" ? body.baseUrl : "");
        if (!baseUrl)
          return json({ models: [], error: "baseUrl 不合法：须为 https:// 地址（本机回环可用 http://），不能使用 IP 字面量、内嵌凭据或 # 片段" });
        const keyText = typeof body.key === "string" ? body.key.trim() : "";
        if (!keyText)
          return json({ models: [], error: "缺少 key" });
        let modelsPath = typeof body.modelsPath === "string" && body.modelsPath ? body.modelsPath : "/models";
        if (/^https?:\/\//i.test(modelsPath)) {
          const mp = validateServiceUrl(modelsPath);
          if (!mp)
            return json({ models: [], error: "modelsPath 不合法：绝对 URL 须为 https:// 地址（本机回环可用 http://），不能使用 IP 字面量、内嵌凭据或 # 片段" });
          modelsPath = mp;
        }
        p = {
          id: "(preview)",
          kind: typeof body.kind === "string" && body.kind ? body.kind : "openai",
          baseUrl,
          modelsPath
        };
        key = { key: keyText };
      }
      let listed;
      try {
        listed = await fetchModels(p, key);
      } catch (e) {
        return json({ models: [], error: `拉取模型列表失败：${truncate(String(e?.message ?? e), 200)}` });
      }
      if (!listed.length)
        return json({ models: [], error: "上游返回的模型列表为空" });
      return json({ models: listed.slice(0, 500).map((m) => ({ id: m.id, pricing: m.pricing ?? null })) });
    }
    if (sub === "providers" && method === "POST" && parts.length === 4 && parts[3] === "keys") {
      const body = await req.json();
      const list = await loadProviders(env, true);
      const p = list.find((x) => x.id === parts[2]);
      if (!p)
        return openAIError(404, "provider \u4E0D\u5B58\u5728");
      let incoming = [];
      if (Array.isArray(body.keys))
        incoming = body.keys;
      else if (typeof body.key === "string" && body.key)
        incoming = [body.key];
      else if (body.keys != null || body.key != null)
        return openAIError(400, "keys must be a string array");
      if (!incoming.length)
        return openAIError(400, "\u7F3A\u5C11 key");
      let added = 0;
      for (const k of incoming) {
        if (typeof k !== "string")
          return openAIError(400, "key must be a string");
        const v = k.trim();
        if (!v || p.keys.some((e) => e.key === v))
          continue;
        p.keys.push({
          id: nextKeyId(p.keys),
          key: v,
          label: body.label,
          dailyLimit: body.dailyLimit
        });
        added += 1;
      }
      if (!added)
        return openAIError(400, "没有新增任何 key（全部为空白或与已有 key 重复）");
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
      if (body.disabled !== void 0 && typeof body.disabled !== "boolean")
        return openAIError(400, "disabled 必须是布尔值");
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
      if (!p.keys.some((k) => k.id === parts[4]))
        return openAIError(404, "key \u4E0D\u5B58\u5728");
      p.keys = p.keys.filter((k) => k.id !== parts[4]);
      p.updatedAt = Date.now();
      await saveProviders(env, list);
      invalidateCaches();
      // The delete is already persisted; purging the Coordinator's
      // health/quota state for this key id is best-effort so a later
      // key reusing the same id does not inherit the old state.
      ctx.waitUntil(coordFetch(env, "/purge-provider", { provider: parts[2], keyId: parts[4] }).catch(() => void 0));
      return json({ ok: true });
    }
    if (sub === "providers" && method === "DELETE" && parts.length === 3) {
      const existing = await loadProviders(env, true);
      if (!existing.some((p) => p.id === parts[2]))
        return openAIError(404, "provider \u4E0D\u5B58\u5728");
      await removeProvider(env, parts[2]);
      invalidateCaches();
      ctx.waitUntil(coordFetch(env, "/purge-provider", { provider: parts[2] }).catch(() => void 0));
      return json({ ok: true });
    }
    if (sub === "gateway-keys" && method === "GET") {
      const envKeys = (env.GATEWAY_TOKEN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const keys = await loadGatewayKeys(env, true);
      return json({ env: envKeys, keys });
    }
    if (sub === "gateway-keys" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      // Validate types instead of coercing: String({...}) used to mint
      // the literal credential "[object Object]", and Number("abc")
      // silently became a 0 (unlimited) daily limit.
      if (body.key != null && (typeof body.key !== "string" || !body.key.trim()))
        return openAIError(400, "key 必须是非空字符串");
      // A caller-chosen key is a bearer credential with no auth
      // throttling in front of it; require enough entropy. The
      // auto-generated path (no key in the body) is unaffected, and
      // keys already stored are not retroactively rejected.
      if (typeof body.key === "string" && body.key.trim() && body.key.trim().length < 32)
        return openAIError(400, "自定义调用 Key 太短：至少需要 32 个字符（不填 key 则自动生成）");
      if (body.dailyLimit != null && !Number.isFinite(Number(body.dailyLimit)))
        return openAIError(400, "dailyLimit 必须是有效数值");
      const value = typeof body.key === "string" && body.key.trim() ? body.key.trim() : `gw-${randomId("")}${randomId("")}`;
      const list = await loadGatewayKeys(env, true);
      if (gatewayKeysLoadFailed)
        return openAIError(500, "\u8C03\u7528 Key \u8BFB\u53D6\u5931\u8D25\uFF08\u591A\u534A\u662F MASTER_KEY \u4E0D\u5BF9\uFF09\uFF0C\u5DF2\u62D2\u7EDD\u5199\u5165\u4EE5\u514D\u8986\u76D6\u539F\u6709\u914D\u7F6E");
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
      const all = await loadGatewayKeys(env, true);
      if (gatewayKeysLoadFailed)
        return openAIError(500, "\u8C03\u7528 Key \u8BFB\u53D6\u5931\u8D25\uFF08\u591A\u534A\u662F MASTER_KEY \u4E0D\u5BF9\uFF09\uFF0C\u5DF2\u62D2\u7EDD\u5199\u5165\u4EE5\u514D\u8986\u76D6\u539F\u6709\u914D\u7F6E");
      if (!all.some((k) => k.id === parts[2]))
        return openAIError(404, "\u8C03\u7528 Key \u4E0D\u5B58\u5728");
      const list = all.filter((k) => k.id !== parts[2]);
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
      // Validate everything before saving anything: the provider
      // create path validates ids and key types, and an unvalidated
      // import used to write records that path would have rejected
      // (bad ids, object "keys", non-numeric limits), bricking the
      // provider invisibly. A bad bundle now imports nothing. The
      // records saved are the NORMALIZED ones produced here, not
      // the raw bundle: what was validated is what gets stored.
      let normProviders, normKeys, normGroups;
      if (Array.isArray(data.providers)) {
        normProviders = [];
        const seenProviderIds = new Set();
        for (const p of data.providers) {
          try {
            // Bundles store keys as objects; normalize to the
            // string form buildProvider validates before checking.
            // Keys are trimmed here so the value that is validated
            // is the value that gets stored (the gateway-keys import
            // below already trims; provider keys now match).
            const probe = { ...(p ?? {}), keys: Array.isArray(p?.keys) ? p.keys.map((k) => {
              const s = typeof k === "string" ? k : k?.key;
              return typeof s === "string" ? s.trim() : s;
            }) : p?.keys };
            const np = buildProvider(probe);
            if (seenProviderIds.has(np.id))
              return openAIError(400, `导入中止：服务商 id 重复：${np.id}`);
            seenProviderIds.add(np.id);
            // A backup restore keeps the original creation time
            // instead of restamping it with the import time.
            if (Number.isFinite(Number(p?.createdAt)) && Number(p?.createdAt) > 0)
              np.createdAt = Number(p.createdAt);
            // Carry the bundle's per-key metadata (ids, labels,
            // disabled flags, per-key limits) onto the normalized
            // keys, matched by key string — buildProvider itself
            // only produces bare {id, key} entries.
            const rawByKey = new Map();
            for (const rk of Array.isArray(p?.keys) ? p.keys : []) {
              if (rk && typeof rk === "object" && typeof rk.key === "string" && rk.key.trim() && !rawByKey.has(rk.key.trim()))
                rawByKey.set(rk.key.trim(), rk);
            }
            const usedIds = new Set();
            for (const nk of np.keys) {
              const rk = rawByKey.get(nk.key);
              if (rk) {
                if (typeof rk.id === "string" && rk.id && !usedIds.has(rk.id))
                  nk.id = rk.id;
                if (typeof rk.label === "string")
                  nk.label = rk.label.slice(0, 60);
                if (rk.disabled === true)
                  nk.disabled = true;
                if (Number.isFinite(Number(rk.dailyLimit)) && Number(rk.dailyLimit) >= 0)
                  nk.dailyLimit = Math.floor(Number(rk.dailyLimit));
                if (Number.isFinite(Number(rk.rpm)) && Number(rk.rpm) >= 0)
                  nk.rpm = Math.floor(Number(rk.rpm));
              }
              if (usedIds.has(nk.id)) {
                // The bundle id was taken AND the generated id is
                // taken too (e.g. two bundle keys both claiming
                // "k2", one of them generated as "k2"): mint a fresh
                // k<n> so ids stay unique within the provider —
                // duplicate ids make PATCH hit only the first key
                // and DELETE remove both.
                let n = 1;
                while (usedIds.has(`k${n}`))
                  n += 1;
                nk.id = `k${n}`;
              }
              usedIds.add(nk.id);
            }
            normProviders.push(np);
          } catch (e) {
            return openAIError(400, `导入中止：服务商 ${String(p?.id ?? "?")} 无效：${truncate(String(e?.message ?? e), 120)}`);
          }
        }
      }
      if (Array.isArray(data.gatewayKeys)) {
        normKeys = [];
        const seenKeyIds = new Set();
        const seenKeyValues = new Set();
        for (const [i, k] of data.gatewayKeys.entries()) {
          if (!k || typeof k !== "object" || typeof k.key !== "string" || !k.key.trim())
            return openAIError(400, "导入中止：调用 Key 条目缺少 key 字符串");
          if (k.dailyLimit != null && (!Number.isFinite(Number(k.dailyLimit)) || Number(k.dailyLimit) < 0))
            return openAIError(400, "导入中止：调用 Key 的 dailyLimit 不是有效的非负数");
          const kid = typeof k.id === "string" && k.id ? k.id : `g${i + 1}-${randomId("").slice(0, 6)}`;
          if (seenKeyIds.has(kid))
            return openAIError(400, `导入中止：调用 Key id 重复：${kid}`);
          if (seenKeyValues.has(k.key.trim()))
            return openAIError(400, "导入中止：调用 Key 值重复");
          seenKeyIds.add(kid);
          seenKeyValues.add(k.key.trim());
          normKeys.push({
            id: kid,
            key: k.key.trim(),
            label: typeof k.label === "string" ? k.label.slice(0, 60) : void 0,
            dailyLimit: k.dailyLimit != null ? Math.floor(Number(k.dailyLimit)) : void 0,
            createdAt: Number.isFinite(Number(k.createdAt)) ? Number(k.createdAt) : Date.now(),
            revoked: k.revoked === true ? true : void 0
          });
        }
      }
      if (Array.isArray(data.customGroups)) {
        normGroups = [];
        const seenGroupIds = new Set();
        for (const g of data.customGroups) {
          if (!g || typeof g !== "object" || typeof g.id !== "string" || !g.id.trim() || !Array.isArray(g.keywords))
            return openAIError(400, "导入中止：自定义模型条目缺少 id 或 keywords 数组");
          const gid = g.id.trim();
          // Same constraints as the dedicated custom-group route:
          // id shape/length, the reserved auto* prefix, and the
          // keyword count/length limits all apply to imports too.
          if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(gid) || gid.length > 80 || /^auto\b/i.test(gid))
            return openAIError(400, `导入中止：自定义模型 id 不合法：${gid}`);
          if (seenGroupIds.has(gid.toLowerCase()))
            return openAIError(400, `导入中止：自定义模型 id 重复：${gid}`);
          seenGroupIds.add(gid.toLowerCase());
          const keywords = [...new Set(g.keywords.filter((w) => typeof w === "string" && w.trim()).map((w) => w.trim()))];
          if (!keywords.length || keywords.length > 10 || keywords.some((w) => w.length > 40))
            return openAIError(400, "导入中止：自定义模型 keywords 须为 1-10 个、每个不超过 40 字符");
          normGroups.push({ id: gid, keywords });
        }
      }
      // Preflight: trial-encrypt the encrypted sections before any
      // write. A bundle that cannot be persisted at all (e.g. an
      // unusable MASTER_KEY) now aborts before the first section
      // lands instead of halfway through the restore.
      try {
        if (normProviders)
          await encrypt(env, normProviders);
        if (normKeys)
          await encrypt(env, normKeys);
      } catch (e) {
        return openAIError(500, `导入中止：配置加密失败，未写入任何分节：${truncate(String(e?.message ?? e), 120)}`);
      }
      const sections = [];
      if (normProviders)
        sections.push(["providers", () => saveProviders(env, normProviders)]);
      if (normKeys)
        sections.push(["gatewayKeys", () => saveGatewayKeys(env, normKeys)]);
      if (data.groupStrategies && typeof data.groupStrategies === "object" && !Array.isArray(data.groupStrategies))
        sections.push(["groupStrategies", () => saveGroupStrategies(env, data.groupStrategies)]);
      if (normGroups)
        sections.push(["customGroups", () => saveCustomGroups(env, normGroups)]);
      if (!sections.length)
        return openAIError(400, "备份里没有可导入的内容");
      // KV offers no multi-key transaction, so a mid-save failure
      // cannot be rolled back; save section by section and report
      // exactly which sections landed and which failed instead of a
      // bare 500 that hides the partial state.
      const done = [];
      const failed = [];
      for (const [name, save] of sections) {
        try {
          await save();
          done.push(name);
        } catch (e) {
          failed.push({ section: name, error: truncate(String(e?.message ?? e), 200) });
        }
      }
      if (done.length)
        invalidateCaches();
      if (failed.length)
        return json({ ok: false, partial: done.length > 0, imported: done, failed }, { status: 500 });
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
      const cur = await loadAlerts(env, true);
      if (alertsLoadFailed)
        return openAIError(500, "alerts config load failed (likely MASTER_KEY mismatch); refusing to save over the stored config");
      const pick = (v, old) => v === null ? "" : typeof v === "string" && v.trim() ? v.trim() : old;
      const next = {
        // enabled follows the same preserve-on-omission rule as the
        // channels: a partial PUT that only rotates a channel must
        // not silently switch alerting off.
        enabled: body.enabled == null ? cur.enabled : body.enabled === true,
        bark: pick(body.bark, cur.bark),
        webhook: pick(body.webhook, cur.webhook)
      };
      // Validate channel URLs supplied by THIS request before they
      // are written: push targets receive alert content and are
      // fetched server-side, so they get the same treatment as
      // provider URLs. Values merely carried over from the stored
      // config are not re-validated — a legacy stored value must
      // not make every unrelated PUT fail.
      for (const f of ["bark", "webhook"]) {
        if (typeof body[f] === "string" && body[f].trim() && !validateServiceUrl(body[f]))
          return openAIError(400, `alerts ${f} URL invalid: must be an https:// URL (http:// allowed for loopback hosts), with no IP-literal host, embedded credentials or fragment`);
      }
      await saveAlerts(env, next);
      return json({ ok: true });
    }
    if (sub === "alerts" && parts[2] === "test" && method === "POST") {
      const cfg = await loadAlerts(env);
      if (!cfg.bark && !cfg.webhook)
        return openAIError(400, "尚未配置推送地址（Bark 或 Webhook）");
      const r = await sendPush(env, cfg, "星桥 StarBridge 测试推送", "收到这条消息说明告警通道可用。服务商全部 Key 不可用或恢复时会自动推送。");
      if (!r.ok)
        return openAIError(502, "推送发送失败，请检查地址是否正确");
      return json({ ok: true });
    }
    if (sub === "retry-policy" && method === "GET" && parts.length === 2) {
      const p = await loadRetryPolicy(env);
      return json({ ok: true, retryRanges: p.retryRanges, skipRanges: p.skipRanges, skipCodes: p.skipCodes });
    }
    if (sub === "retry-policy" && method === "PUT" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      const cur = await loadRetryPolicy(env, true);
      let next;
      try {
        next = normalizeRetryPolicy(body, cur);
      } catch (e) {
        return json({ ok: false, error: truncate(String(e?.message ?? e), 200) }, { status: 400 });
      }
      await saveRetryPolicy(env, next);
      return json({ ok: true, retryRanges: next.retryRanges, skipRanges: next.skipRanges, skipCodes: next.skipCodes });
    }
    if (sub === "retry-policy" && parts[2] === "test" && method === "GET") {
      // Decision trial: evaluates decideRetry against the STORED
      // policy (defaults when unset) and echoes the effective
      // inputs; kind is echoed as given, source / errorCode /
      // skipRetry are derived when omitted. Invalid query values
      // -> 400 {ok:false, error}, same shape as the PUT.
      const bad = (msg) => json({ ok: false, error: msg }, { status: 400 });
      const q = url.searchParams;
      const parseIntParam = (name, def, min, max) => {
        const raw = q.get(name);
        if (raw === null)
          return { ok: true, value: def };
        if (!/^-?\d+$/.test(raw.trim()))
          return { ok: false, error: `${name} 须为整数` };
        const v = Number(raw.trim());
        if (v < min || v > max)
          return { ok: false, error: `${name} 须在 ${min}-${max} 之间` };
        return { ok: true, value: v };
      };
      const parseBoolParam = (name, def) => {
        const raw = q.get(name);
        if (raw === null)
          return { ok: true, value: def };
        if (raw === "true" || raw === "1")
          return { ok: true, value: true };
        if (raw === "false" || raw === "0")
          return { ok: true, value: false };
        return { ok: false, error: `${name} 须为 true/false` };
      };
      const statusP = parseIntParam("status", 500, 0, 999);
      if (!statusP.ok)
        return bad(statusP.error);
      const attemptsP = parseIntParam("attemptsLeft", 3, 0, 1e9);
      if (!attemptsP.ok)
        return bad(attemptsP.error);
      const pinnedP = parseBoolParam("pinned", false);
      if (!pinnedP.ok)
        return bad(pinnedP.error);
      const strictP = parseBoolParam("strictAffinity", false);
      if (!strictP.ok)
        return bad(strictP.error);
      const skipP = parseBoolParam("skipRetry", null);
      if (!skipP.ok)
        return bad(skipP.error);
      const kind = q.get("kind") ?? "server";
      const status = statusP.value;
      const derived = errorSourceFor(kind, status);
      let source = q.get("source");
      if (source === null) {
        source = derived.source;
      } else if (!["channel", "transport", "local", "upstream"].includes(source)) {
        return bad("source 须为 channel/transport/local/upstream 之一");
      }
      let errorCode = q.get("errorCode");
      if (errorCode === null) {
        errorCode = upstreamErrorMeta(kind).code;
      } else if (!errorCode.trim()) {
        return bad("errorCode 须为非空字符串");
      }
      const skipRetry = skipP.value === null ? derived.skipRetry : skipP.value;
      let policy = null;
      try {
        policy = await loadRetryPolicy(env);
      } catch {
        policy = null;
      }
      const d = decideRetry({
        kind,
        status,
        source,
        skipRetry,
        attemptsLeft: attemptsP.value,
        pinned: pinnedP.value,
        strictAffinity: strictP.value,
        errorCode,
        policy
      });
      return json({
        ok: true,
        retry: d.retry,
        reason: d.reason,
        kind,
        status,
        source,
        errorCode,
        attemptsLeft: attemptsP.value,
        pinned: pinnedP.value,
        strictAffinity: strictP.value
      });
    }
    if (sub === "cf-config" && method === "GET") {
      const cfg = await loadCfConfig(env, true);
      return json(cfConfigView(cfg));
    }
    if (sub === "cf-config" && method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const cur = await loadCfConfig(env, true);
      if (cfLoadFailed)
        return openAIError(500, "cf config load failed (likely MASTER_KEY mismatch); refusing to save over the stored config");
      const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
      if (!/^[0-9a-fA-F]{32}$/.test(accountId))
        return openAIError(400, "accountId 必填且须为 32 位十六进制");
      // Same preserve-on-empty rule as the alert channels: an empty
      // or omitted credential field keeps the stored value, so the
      // form can save identity changes without re-typing secrets.
      const keep = (v, old) => typeof v === "string" && v.trim() ? v.trim() : old;
      const next = {
        accountId,
        email: keep(body.email, cur.email),
        apiKey: keep(body.apiKey, cur.apiKey),
        token: keep(body.token, cur.token)
      };
      await saveCfConfig(env, next);
      return json(cfConfigView(next));
    }
    if (sub === "cf-config" && method === "DELETE") {
      await loadCfConfig(env, true);
      if (cfLoadFailed)
        return openAIError(500, "cf config load failed (likely MASTER_KEY mismatch); refusing to save over the stored config");
      await saveCfConfig(env, { accountId: "", email: "", apiKey: "", token: "" });
      return json({ ok: true });
    }
    if (sub === "cf-usage" && method === "GET") {
      const cfg = await loadCfConfig(env);
      if (!cfg.accountId || !(cfg.apiKey || cfg.token))
        return json({ configured: false });
      try {
        const usage = await fetchCfUsage(cfg);
        return json({ configured: true, fetchedAt: Date.now(), ...usage });
      } catch (e) {
        // A Cloudflare-side failure is shown in the panel, not
        // surfaced as a gateway 500.
        return json({ configured: true, error: truncate(String(e?.message ?? e), 200) });
      }
    }
    if (sub === "domains" && method === "GET") {
      const cfg = await loadCfConfig(env);
      if (!cfg.accountId || !(cfg.apiKey || cfg.token))
        return json({ configured: false, domains: [] });
      try {
        const domains = await listWorkerDomains(cfg);
        return json({ configured: true, domains });
      } catch (e) {
        return json({ configured: true, domains: [], error: truncate(String(e?.message ?? e), 200) });
      }
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
    // Candidate-debug view (item 6): what resolveCandidates() would
    // pick for a model, with each candidate's priority tier, weight
    // parts and live DO health. Pure read — it never calls /order,
    // so inspecting a model costs no caller quota.
    if (sub === "abilities" && method === "GET") {
      const model = (url.searchParams.get("model") ?? "").trim();
      if (!model)
        return openAIError(400, "缺少 model 参数", "invalid_request_error", { code: "invalid_request", retryable: false });
      const [catalog, providers, strategies] = await Promise.all([loadCatalog(env), loadProviders(env), loadGroupStrategies(env)]);
      const enabled = providers.filter((p) => p.enabled && p.keys.some((k) => !k.disabled));
      const byId = new Map(enabled.map((p) => [p.id, p]));
      const knownProviders = new Set(providers.map((p) => p.id.toLowerCase()));
      const resolved = resolveCandidates(catalog?.entries ?? [], model, {
        groups: await allGroupsOf(env, catalog),
        allowed: new Set(byId.keys()),
        knownProviders
      });
      // One DO health snapshot for every candidate below.
      const stats = await coordFetch(env, "/stats").catch(() => null);
      const keyRows = stats?.keys ?? [];
      const healthRows = [...(stats?.models?.dead ?? []), ...(stats?.models?.erroring ?? [])];
      // Distinct priority tiers, highest first; a candidate's
      // tierRank is its tier's 0-based index in that list.
      const tiers = [...new Set(resolved.candidates.map((c) => byId.get(c.provider)?.priority ?? 0))].sort((a, b) => b - a);
      const candidates = resolved.candidates.map((c) => {
        const p = byId.get(c.provider);
        const priority = p?.priority ?? 0;
        const modelHealth = healthRows.find((h) => h.model === `${c.provider}/${c.model}`) ?? null;
        let okRate, latFactor;
        if (!modelHealth) {
          // No health row yet: same defaults order() uses.
          okRate = 0.55;
          latFactor = 1;
        } else if (typeof modelHealth.ok === "number" && typeof modelHealth.fail === "number") {
          okRate = (modelHealth.ok + 1) / (modelHealth.ok + modelHealth.fail + 2);
          latFactor = modelHealth.emaMs > 0 ? 1 / (1 + modelHealth.emaMs / 5e3) : 1;
        } else {
          // Dead row (no ok/fail): order() never picks it, so the
          // weight parts are undefined rather than defaulted.
          okRate = null;
          latFactor = null;
        }
        return {
          provider: c.provider,
          model: c.model,
          priority,
          tier: priority,
          tierRank: tiers.indexOf(priority),
          providerWeight: p?.weight ?? 1,
          candidateWeight: c.weight,
          keys: keyRows.filter((k) => k.key.startsWith(c.provider + ":")),
          modelHealth,
          okRate,
          latFactor
        };
      });
      return json({
        model,
        group: resolved.group ?? null,
        strategy: groupStrategy(strategies, resolved.group?.key),
        candidates,
        ...(candidates.length ? {} : { note: resolved.note ?? `没有可用模型匹配 "${model}"` })
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
      return json(await probeModel(p, key, body.model));
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
    freeRules: body.freeRules,
    allow: body.allow,
    deny: body.deny,
    enabled: body.enabled,
    headers: body.headers,
    dropParams: body.dropParams,
    streamUsage: body.streamUsage,
    weight: body.weight != null ? Number(body.weight) : void 0,
    priority: body.priority != null ? Number(body.priority) : void 0,
    dailyLimitDefault: body.dailyLimitDefault != null ? Number(body.dailyLimitDefault) : void 0,
    rpmDefault: body.rpmDefault != null ? Number(body.rpmDefault) : void 0,
    resetOffsetMin: body.resetOffsetMin != null ? Number(body.resetOffsetMin) : void 0,
    modelsPath: body.modelsPath,
    notes: body.notes
  });
  base.keys = keysRaw.map((k, i) => {
    // Accept plain strings only: an object entry used to be stored
    // verbatim as the "key", permanently breaking that provider's
    // auth with no visible error.
    if (typeof k !== "string" || !k.trim())
      throw new Error("keys 必须是字符串数组");
    return {
      id: `k${i + 1}`,
      key: k,
      dailyLimit: body.dailyLimit != null ? Number(body.dailyLimit) : void 0
    };
  });
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
  const providers = await loadProviders(env);
  // Per-provider usage windows follow each provider's own reset
  // clock, so byProvider needs the offsets before it can run.
  const resetOffsets = {};
  for (const p of providers)
    resetOffsets[p.id] = p.resetOffsetMin;
  const [catalog, health, today, provUsage, modelUsage, keyUsage, series, recentRows, strategies] = await Promise.all([
    loadCatalog(env),
    coordFetch(env, "/stats").catch(
      () => ({ day, keys: [], models: { total: 0, dead: [], erroring: [] }, drops: {} })
    ),
    totals(env, day),
    byProvider(env, resetOffsets),
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
