var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/groups.ts
var NOISE = /* @__PURE__ */ new Set(["instruct", "chat", "it", "versatile", "instant", "latest", "hf"]);
var QUANT = /* @__PURE__ */ new Set(["fp8", "fp16", "bf16", "int8", "int4", "awq", "gptq", "gguf", "mlx", "exl2", "4bit", "8bit"]);
function groupKeyOf(raw) {
  let s = (raw || "").trim().toLowerCase();
  if (!s)
    return "";
  s = s.replace(/:[a-z0-9_.-]+$/g, "").replace(/@[a-z0-9_.-]+$/g, "");
  const slash = s.lastIndexOf("/");
  if (slash >= 0)
    s = s.slice(slash + 1);
  s = s.replace(/v(\d+)p(\d+)/g, "$1-$2");
  s = s.replace(/[-_.](20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])$/g, "").replace(/[-_.](20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/g, "").replace(/[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])$/g, "").replace(/[-_.](0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/g, "");
  s = s.replace(/(\d)\.(\d)/g, "$1-$2");
  const parts = s.split(/[-_.]+/).filter(Boolean);
  const kept = parts.filter((p) => !NOISE.has(p) && !QUANT.has(p));
  return (kept.length ? kept : parts).join("-") || s;
}
__name(groupKeyOf, "groupKeyOf");
function canonicalScore(name) {
  const s = name.toLowerCase();
  let n = s.length * 0.4;
  if (s.includes("/"))
    n += 60;
  if (s.includes(":"))
    n += 30;
  if (/20\d{2}[-_.]?\d{2}/.test(s))
    n += 15;
  if (/(preview|exp|beta|rc\d)/.test(s))
    n += 8;
  if (/(instruct|versatile|instant|chat|hf)$/.test(s))
    n += 6;
  return n;
}
__name(canonicalScore, "canonicalScore");
function buildGroups(entries, previous) {
  const buckets = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const k = e.groupKey || groupKeyOf(e.model);
    if (!k)
      continue;
    const arr = buckets.get(k);
    if (arr)
      arr.push(e);
    else
      buckets.set(k, [e]);
  }
  const prevByKey = /* @__PURE__ */ new Map();
  for (const g of previous ?? [])
    prevByKey.set(g.key, g);
  const out = [];
  for (const [key, eps] of buckets) {
    eps.sort((a, b) => {
      if (b.versionScore !== a.versionScore)
        return b.versionScore - a.versionScore;
      return (b.releasedAt ?? (b.created ?? 0) * 1e3) - (a.releasedAt ?? (a.created ?? 0) * 1e3);
    });
    const names = [...new Set(eps.map((e) => e.model))];
    const id = prevByKey.get(key)?.id || names.slice().sort((a, b) => canonicalScore(a) - canonicalScore(b) || a.length - b.length)[0];
    const providers = [...new Set(eps.map((e) => e.provider))].sort();
    const tags = /* @__PURE__ */ new Set();
    for (const e of eps)
      for (const t of e.tags)
        tags.add(t);
    const ctx = Math.max(0, ...eps.map((e) => e.contextLength ?? 0));
    const maxOut = Math.max(0, ...eps.map((e) => e.maxOutput ?? 0));
    const MOD_ORDER2 = ["text", "image", "pdf", "audio", "video"];
    const inSet = /* @__PURE__ */ new Set();
    const outSet = /* @__PURE__ */ new Set();
    for (const e of eps) {
      for (const m of e.inputModalities ?? [])
        inSet.add(m);
      for (const m of e.outputModalities ?? [])
        outSet.add(m);
    }
    const inMods = MOD_ORDER2.filter((m) => inSet.has(m));
    const outMods = MOD_ORDER2.filter((m) => outSet.has(m));
    const created = Math.min(...eps.map((e) => e.created ?? 0).filter((n) => n > 0), Number.MAX_SAFE_INTEGER);
    out.push({
      id,
      key,
      aliases: names,
      endpoints: eps,
      providers,
      family: eps[0].family,
      versionScore: eps[0].versionScore,
      contextLength: ctx || void 0,
      maxOutput: maxOut || void 0,
      inputModalities: inMods.length ? inMods : void 0,
      outputModalities: outMods.length ? outMods : void 0,
      tags: [...tags],
      // 所有端点都支持 tools 才算「全支持」，单家支持时只能靠调度兜底
      toolsAll: eps.every((e) => e.tags.includes("tools")),
      created: created === Number.MAX_SAFE_INTEGER ? 0 : created
    });
  }
  out.sort((a, b) => {
    if (b.providers.length !== a.providers.length)
      return b.providers.length - a.providers.length;
    if (b.versionScore !== a.versionScore)
      return b.versionScore - a.versionScore;
    return (b.contextLength ?? 0) - (a.contextLength ?? 0);
  });
  return out;
}
__name(buildGroups, "buildGroups");
function matchGroup(groups, requested) {
  const q = (requested || "").trim().toLowerCase();
  if (!q)
    return null;
  for (const g of groups)
    if (g.id.toLowerCase() === q)
      return g;
  const qk = groupKeyOf(q);
  if (qk) {
    for (const g of groups)
      if (g.key === qk)
        return g;
  }
  for (const g of groups)
    if (g.aliases.some((a) => a.toLowerCase() === q))
      return g;
  return null;
}
__name(matchGroup, "matchGroup");

// src/util.ts
var CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-version,x-gw-session,x-request-id",
  "access-control-max-age": "86400"
};
function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  for (const [k, v] of Object.entries(CORS))
    headers.set(k, v);
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}
__name(json, "json");
function openAIError(status, message, type = "gateway_error", extra = {}) {
  return json(
    { error: { message, type, code: status, ...extra } },
    { status }
  );
}
__name(openAIError, "openAIError");
function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}
__name(preflight, "preflight");
function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
__name(utcDay, "utcDay");
function localDay(ts = Date.now()) {
  return new Date(ts + 8 * 36e5).toISOString().slice(0, 10);
}
__name(localDay, "localDay");
function nextUtcMidnight(ts = Date.now()) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}
__name(nextUtcMidnight, "nextUtcMidnight");
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
__name(clamp, "clamp");
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
__name(sleep, "sleep");
function withTimeout(p, ms, fallback) {
  return Promise.race([p.catch(() => fallback), sleep(ms).then(() => fallback)]);
}
__name(withTimeout, "withTimeout");
function parseRetryAfter(h) {
  if (!h)
    return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0)
    return Math.min(secs * 1e3, 6 * 36e5);
  const date = Date.parse(h);
  if (Number.isFinite(date))
    return clamp(date - Date.now(), 0, 6 * 36e5);
  return null;
}
__name(parseRetryAfter, "parseRetryAfter");
function timingSafeEqual(a, b) {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  if (ae.length !== be.length) {
    let diff2 = 1;
    for (let i = 0; i < ae.length; i++)
      diff2 |= ae[i] ^ be[i % (be.length || 1)];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ae.length; i++)
    diff |= ae[i] ^ be[i];
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function maskKey(k) {
  if (!k)
    return "";
  if (k.length <= 12)
    return k.slice(0, 3) + "***";
  return `${k.slice(0, 6)}\u2026${k.slice(-4)}`;
}
__name(maskKey, "maskKey");
function truncate(s, n) {
  if (!s)
    return "";
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}
__name(truncate, "truncate");
function randomId(prefix = "") {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + hex;
}
__name(randomId, "randomId");
function extractParam(text) {
  if (!text)
    return void 0;
  const patterns = [
    /(?:unsupported|unknown|unrecognized|unexpected|invalid|extra)\s+(?:parameter|field|argument|property|key)s?\s*[:=]?\s*["'`]?([a-zA-Z0-9_.]+)/i,
    /(?:argument|parameter|field|property)s?\s+(?:supplied|provided|given)\s*[:=]?\s*["'`]?([a-zA-Z0-9_.]+)/i,
    /["'`]([a-zA-Z0-9_.]+)["'`]\s+(?:is not supported|not supported|is not allowed|isn't supported)/i,
    /additional propert(?:y|ies)\s+["'`]([a-zA-Z0-9_.]+)["'`]/i,
    /(?:parameter|param)\s+["'`]([a-zA-Z0-9_.]+)["'`]/i,
    /(?:does not support|not support)\s+["'`]([a-zA-Z0-9_.]+)["'`]/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const p = m[1].replace(/^["'`]|["'`]$/g, "");
      if (["model", "messages", "input", "contents", "prompt"].includes(p))
        continue;
      if (p.length > 64)
        continue;
      return p;
    }
  }
  return void 0;
}
__name(extractParam, "extractParam");
function classify(status, body) {
  const t = (body || "").toLowerCase();
  if (status === 402)
    return "quota";
  if (status === 429) {
    if (/(rate_limit|too many requests|retry (in|after)|per[ -]?minute|requests per|nothing is used up)/.test(t)) {
      return "rate_limit";
    }
    if (/(quota|insufficient|exceeded your current quota|billing|credit|daily limit|free tier)/.test(t))
      return "quota";
    return "rate_limit";
  }
  if (status === 401 || status === 403)
    return "auth";
  if (status === 404)
    return "model_gone";
  if (status === 400 || status === 422) {
    if (/(model.*(not found|does not exist|doesn't exist|not exist|unsupported|decommission|deprecat|retired|no longer|shut down|unavailable))/.test(
      t
    ) || /(no such model|unknown model|invalid model)/.test(t) || // 聚合站常见：模型在列表里但没有可用渠道（如 aihubmix 的 no_available_channel）
    /(no_available_channel|cannot be served|no channel available)/.test(t)) {
      return "model_gone";
    }
    if (/(context|token limit|too long|maximum context|prompt is too long)/.test(t))
      return "bad_param";
    if (/(param|field|argument|propert|unsupported|unknown|not supported|invalid)/.test(t))
      return "bad_param";
    return "bad_param";
  }
  if (status === 408 || status === 504)
    return "timeout";
  if (status >= 500)
    return "server";
  return "unknown";
}
__name(classify, "classify");
function classifyThrown(e) {
  const msg = String(e?.message ?? e ?? "").toLowerCase();
  if (msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out"))
    return "timeout";
  if (msg.includes("blocked") || msg.includes("content_filter") || msg.includes("safety"))
    return "content";
  if (msg.includes("network") || msg.includes("fetch") || msg.includes("connect"))
    return "network";
  return "network";
}
__name(classifyThrown, "classifyThrown");
function parseSSE(input) {
  const decoder = new TextDecoder();
  let buffer = "";
  return input.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseSSEBlock(raw);
          if (ev)
            controller.enqueue(ev);
        }
        if (buffer.length > 512e3) {
          const ev = parseSSEBlock(buffer);
          if (ev)
            controller.enqueue(ev);
          buffer = "";
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const ev = parseSSEBlock(buffer);
          if (ev)
            controller.enqueue(ev);
        }
      }
    })
  );
}
__name(parseSSE, "parseSSE");
function parseSSEBlock(raw) {
  let event;
  const data = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":"))
      continue;
    if (line.startsWith("event:"))
      event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length && !event)
    return null;
  return { event, data: data.join("\n") };
}
__name(parseSSEBlock, "parseSSEBlock");
function sseEncode(payload, event) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const text = (event ? `event: ${event}
` : "") + `data: ${body}

`;
  return new TextEncoder().encode(text);
}
__name(sseEncode, "sseEncode");
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
__name(deferred, "deferred");
function base64Encode(bytes) {
  let bin = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
__name(base64Encode, "base64Encode");
function base64Decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
__name(base64Decode, "base64Decode");
function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
__name(safeJsonParse, "safeJsonParse");

// src/store.ts
var PROVIDERS_KEY = "cfg:providers:v1";
var CATALOG_KEY = "catalog:v1";
var CACHE_TTL = 3e4;
var providerCache = null;
var providersLoadFailed = false;
var catalogCache = null;
var groupCache = null;
var lastStoreWarning = null;
function storeWarning() {
  return lastStoreWarning;
}
__name(storeWarning, "storeWarning");
async function masterKey(env) {
  if (!env.MASTER_KEY)
    return null;
  try {
    const raw = base64Decode(env.MASTER_KEY.trim());
    if (raw.length !== 32) {
      console.warn("[store] MASTER_KEY \u5FC5\u987B\u662F 32 \u5B57\u8282\u7684 base64\uFF08openssl rand -base64 32\uFF09");
      return null;
    }
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch (e) {
    console.warn("[store] MASTER_KEY \u89E3\u6790\u5931\u8D25", e);
    return null;
  }
}
__name(masterKey, "masterKey");
async function encrypt(env, value) {
  const plain = JSON.stringify(value);
  const key = await masterKey(env);
  if (!key)
    throw new Error("MASTER_KEY \u672A\u914D\u7F6E\u6216\u4E0D\u662F 32 \u5B57\u8282 base64\uFF0C\u62D2\u7EDD\u4FDD\u5B58\u670D\u52A1\u5546\u914D\u7F6E");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { enc: 1, iv: base64Encode(iv), data: base64Encode(new Uint8Array(ct)) };
}
__name(encrypt, "encrypt");
async function decrypt(env, env_) {
  if (env_.enc === 0)
    return JSON.parse(env_.data);
  const key = await masterKey(env);
  if (!key || !env_.iv)
    throw new Error("\u7F3A\u5C11 MASTER_KEY\uFF0C\u65E0\u6CD5\u89E3\u5BC6\u5DF2\u5B58\u50A8\u7684\u670D\u52A1\u5546\u914D\u7F6E");
  const iv = base64Decode(env_.iv);
  const ct = base64Decode(env_.data);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}
__name(decrypt, "decrypt");
async function loadProviders(env, force = false) {
  if (!force && providerCache && Date.now() - providerCache.at < CACHE_TTL) {
    return providerCache.data;
  }
  let list = [];
  const raw = await env.GW_KV.get(PROVIDERS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed))
        list = parsed;
      else
        list = await decrypt(env, parsed);
      lastStoreWarning = null;
      providersLoadFailed = false;
    } catch (e) {
      providersLoadFailed = true;
      lastStoreWarning = "\u8BFB\u53D6\u670D\u52A1\u5546\u914D\u7F6E\u5931\u8D25\uFF1A" + String(e?.message ?? e) + "\uFF08\u5E38\u89C1\u539F\u56E0\uFF1AMASTER_KEY \u88AB\u6539\u52A8\uFF0C\u9700\u8981\u91CD\u65B0\u5F55\u5165\u6240\u6709 Key\uFF09";
      console.error("[store] \u8BFB\u53D6\u670D\u52A1\u5546\u914D\u7F6E\u5931\u8D25", e);
    }
  } else if (env.PROVIDERS_JSON) {
    try {
      list = JSON.parse(env.PROVIDERS_JSON);
      await saveProviders(env, list);
    } catch (e) {
      console.error("[store] PROVIDERS_JSON \u89E3\u6790\u5931\u8D25", e);
    }
  }
  list = list.map((p) => ({
    ...p,
    keys: (p.keys ?? []).map((k, i) => ({ ...k, id: k.id || `k${i + 1}` })),
    weight: p.weight ?? 1,
    enabled: p.enabled ?? true
  }));
  providerCache = { at: Date.now(), data: list };
  return list;
}
__name(loadProviders, "loadProviders");
async function saveProviders(env, list) {
  if (providersLoadFailed) {
    throw new Error("\u670D\u52A1\u5546\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF08\u591A\u534A\u662F MASTER_KEY \u4E0D\u5BF9\uFF09\uFF0C\u62D2\u7EDD\u5199\u5165\u4EE5\u514D\u8986\u76D6\u539F\u6709\u914D\u7F6E");
  }
  const envelope = await encrypt(env, list);
  await env.GW_KV.put(PROVIDERS_KEY, JSON.stringify(envelope));
  providerCache = { at: Date.now(), data: list };
}
__name(saveProviders, "saveProviders");
async function removeProvider(env, id) {
  const list = (await loadProviders(env, true)).filter((p) => p.id !== id);
  await saveProviders(env, list);
  return list;
}
__name(removeProvider, "removeProvider");
// Per-mapping-group routing strategy, stored as plain JSON in KV:
// { "<groupKey>": "failover" | "balance" }. Groups without an entry use
// the default ("balance"). No secrets involved, so no encryption envelope.
var GROUP_STRATEGIES_KEY = "cfg:group-strategies:v1";
var groupStrategiesCache = null;
async function loadGroupStrategies(env, force = false) {
  if (!force && groupStrategiesCache && Date.now() - groupStrategiesCache.at < CACHE_TTL) {
    return groupStrategiesCache.data;
  }
  let map = {};
  const raw = await env.GW_KV.get(GROUP_STRATEGIES_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (v === "failover" || v === "balance")
            map[k] = v;
        }
      }
    } catch (e) {
      console.error("[store] group strategies parse failed", e);
    }
  }
  groupStrategiesCache = { at: Date.now(), data: map };
  return map;
}
__name(loadGroupStrategies, "loadGroupStrategies");
async function saveGroupStrategies(env, map) {
  await env.GW_KV.put(GROUP_STRATEGIES_KEY, JSON.stringify(map));
  groupStrategiesCache = { at: Date.now(), data: map };
}
__name(saveGroupStrategies, "saveGroupStrategies");
function groupStrategy(map, groupKey) {
  return map && groupKey && map[groupKey] === "failover" ? "failover" : "balance";
}
__name(groupStrategy, "groupStrategy");
var GATEWAY_KEYS_KEY = "cfg:gateway-keys:v1";
var gatewayKeysCache = null;
async function loadGatewayKeys(env, force = false) {
  if (!force && gatewayKeysCache && Date.now() - gatewayKeysCache.at < CACHE_TTL) {
    return gatewayKeysCache.data;
  }
  let list = [];
  const raw = await env.GW_KV.get(GATEWAY_KEYS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed : await decrypt(env, parsed);
    } catch (e) {
      console.error("[store] \u8BFB\u53D6\u8C03\u7528 Key \u5931\u8D25", e);
    }
  }
  gatewayKeysCache = { at: Date.now(), data: list };
  return list;
}
__name(loadGatewayKeys, "loadGatewayKeys");
async function saveGatewayKeys(env, list) {
  const envelope = await encrypt(env, list);
  await env.GW_KV.put(GATEWAY_KEYS_KEY, JSON.stringify(envelope));
  gatewayKeysCache = { at: Date.now(), data: list };
}
__name(saveGatewayKeys, "saveGatewayKeys");
async function loadCatalog(env, force = false) {
  if (!force && catalogCache && Date.now() - catalogCache.at < CACHE_TTL) {
    return catalogCache.data;
  }
  const raw = await env.GW_KV.get(CATALOG_KEY);
  let snap = null;
  if (raw) {
    try {
      snap = JSON.parse(raw);
    } catch (e) {
      console.error("[store] \u76EE\u5F55\u89E3\u6790\u5931\u8D25", e);
    }
  }
  catalogCache = { at: Date.now(), data: snap };
  return snap;
}
__name(loadCatalog, "loadCatalog");
async function saveCatalog(env, snap) {
  await env.GW_KV.put(CATALOG_KEY, JSON.stringify(snap));
  catalogCache = { at: Date.now(), data: snap };
}
__name(saveCatalog, "saveCatalog");
function invalidateCaches() {
  providerCache = null;
  catalogCache = null;
  groupCache = null;
  gatewayKeysCache = null;
  groupStrategiesCache = null;
}
__name(invalidateCaches, "invalidateCaches");
function groupsOf(snap) {
  if (!snap || !snap.entries.length)
    return [];
  if (groupCache && groupCache.version === snap.version)
    return groupCache.data;
  const data = buildGroups(snap.entries, groupCache?.data);
  groupCache = { version: snap.version, data };
  return data;
}
__name(groupsOf, "groupsOf");

// src/auth.ts
function extractToken(req) {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer "))
    return auth.slice(7).trim();
  return req.headers.get("x-api-key") ?? req.headers.get("x-goog-api-key") ?? "";
}
__name(extractToken, "extractToken");
function checkToken(req, env, kind) {
  const configured = (kind === "gateway" ? env.GATEWAY_TOKEN : env.ADMIN_TOKEN) ?? "";
  const allowed = configured.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length)
    return { ok: false, reason: "unconfigured" };
  // Header-only auth (Bearer / x-api-key). The backend serves no
  // pages, so credentials never travel in a URL or a cookie.
  const token = extractToken(req);
  if (!token)
    return { ok: false, reason: "missing" };
  const ok = allowed.some((a) => timingSafeEqual(a, token));
  return ok ? { ok: true } : { ok: false, reason: "invalid" };
}
__name(checkToken, "checkToken");
async function checkGatewayToken(req, env) {
  const base = checkToken(req, env, "gateway");
  if (base.ok)
    return base;
  const token = extractToken(req);
  if (!token)
    return base;
  const kvKeys = await loadGatewayKeys(env).catch(() => []);
  if (kvKeys.some((k) => timingSafeEqual(k.key, token)))
    return { ok: true };
  if (base.reason === "unconfigured" && kvKeys.length)
    return { ok: false, reason: "invalid" };
  return base;
}
__name(checkGatewayToken, "checkGatewayToken");

// src/config.ts
function settings(env) {
  const num = /* @__PURE__ */ __name((v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n))
      return d;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }, "num");
  return {
    maxAttempts: num(env.MAX_ATTEMPTS, 6, 1, 20),
    timeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 9e4, 3e3, 6e5),
    probePerSync: num(env.PROBE_PER_SYNC, 0, 0, 50),
    keepPerFamily: num(env.KEEP_PER_FAMILY, 4, 1, 50),
    defaultAlias: env.DEFAULT_ALIAS || "auto",
    syncEnabled: env.SYNC_ENABLED !== "false",
    grouping: env.MODEL_GROUPING !== "off"
  };
}
__name(settings, "settings");
var PRESETS = {
  openrouter: {
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    freeMode: "zero-price",
    dailyLimitDefault: 50,
    headers: {
      "HTTP-Referer": "https://github.com/local/cf-free-ai-gateway",
      "X-Title": "cf-free-ai-gateway"
    }
  },
  groq: {
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    freeMode: "all-free",
    dailyLimitDefault: 1e3
  },
  cerebras: {
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    freeMode: "all-free",
    dailyLimitDefault: 1e3
  },
  // Gemini 官方 OpenAI 兼容端点，推荐用这个，省掉协议转换
  gemini: {
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    freeMode: "all-free",
    dailyLimitDefault: 200
  },
  // 原生协议，仅在兼容端点不可用时使用
  "gemini-native": {
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    freeMode: "all-free",
    dailyLimitDefault: 200
  },
  anthropic: {
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    freeMode: "allowlist",
    // Anthropic 没有免费层：只放最便宜的 haiku 且必须有有限日上限兜底，
    // 绝不能把付费模型判成「免费 + 不限量」（sonnet 已剔除）
    allow: ["claude-3-5-haiku", "claude-3-haiku"],
    dailyLimitDefault: 100
  },
  mistral: {
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    // Mistral 的 /models 含付费旗舰（mistral-large 等），不能 all-free 全判免费；
    // 只放开放权重/低价系列
    freeMode: "allowlist",
    allow: ["mistral-small", "open-mistral", "ministral", "codestral", "magistral-small", "mistral-nemo"],
    dailyLimitDefault: 500
  },
  together: {
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    freeMode: "allowlist",
    allow: [":free$"],
    dailyLimitDefault: 0
  },
  github: {
    kind: "openai",
    baseUrl: "https://models.github.ai/inference",
    freeMode: "all-free",
    dailyLimitDefault: 150,
    modelsPath: "https://models.github.ai/catalog/models"
  },
  nvidia: {
    kind: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    freeMode: "all-free",
    dailyLimitDefault: 1e3
  },
  sambanova: {
    kind: "openai",
    baseUrl: "https://api.sambanova.ai/v1",
    freeMode: "all-free",
    dailyLimitDefault: 1e3
  },
  scaleway: {
    kind: "openai",
    baseUrl: "https://api.scaleway.ai/v1",
    freeMode: "all-free",
    dailyLimitDefault: 1e3
  }
};
function applyPreset(input) {
  const preset = input.preset ? PRESETS[input.preset] : void 0;
  const base = preset ?? {};
  const now = Date.now();
  const merged = {
    id: input.id,
    label: input.label ?? base.label ?? input.id,
    kind: input.kind ?? base.kind ?? "openai",
    baseUrl: (input.baseUrl ?? base.baseUrl ?? "").replace(/\/+$/, ""),
    keys: input.keys ?? [],
    enabled: input.enabled ?? true,
    weight: input.weight ?? 1,
    freeMode: input.freeMode ?? base.freeMode ?? "all-free",
    allow: input.allow ?? base.allow,
    deny: input.deny ?? base.deny,
    headers: input.headers ?? base.headers,
    dailyLimitDefault: input.dailyLimitDefault ?? base.dailyLimitDefault ?? 0,
    rpmDefault: input.rpmDefault ?? base.rpmDefault ?? 0,
    modelsPath: input.modelsPath ?? base.modelsPath ?? "/models",
    streamUsage: input.streamUsage ?? base.streamUsage ?? true,
    dropParams: input.dropParams ?? base.dropParams,
    notes: input.notes,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  };
  if (!merged.baseUrl)
    throw new Error(`provider ${input.id} \u7F3A\u5C11 baseUrl\uFF08\u4E14\u6CA1\u6709\u5339\u914D\u7684\u9884\u8BBE\uFF09`);
  return merged;
}
__name(applyPreset, "applyPreset");

// src/coord-client.ts
async function coordFetch(env, path, body) {
  const stub = env.COORD.get(env.COORD.idFromName("global"));
  const res = await stub.fetch(`https://coordinator${path}`, {
    method: body === void 0 ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok)
    throw new Error(`coordinator ${path} -> HTTP ${res.status}`);
  return await res.json();
}
__name(coordFetch, "coordFetch");

// src/adapters/openai.ts
function normalizeUsage(u) {
  if (!u || typeof u !== "object")
    return null;
  const o = u;
  const prompt = Number(o.prompt_tokens ?? o.input_tokens ?? o.promptTokenCount ?? 0) + Number(o.cache_read_input_tokens ?? 0) + Number(o.cache_creation_input_tokens ?? 0);
  const completion = Number(o.completion_tokens ?? o.output_tokens ?? o.candidatesTokenCount ?? 0) + Number(o.thoughtsTokenCount ?? 0);
  const upstreamTotal = Number(o.total_tokens ?? o.totalTokenCount ?? 0);
  const total = Math.max(upstreamTotal, prompt + completion);
  if (!prompt && !completion && !total)
    return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion
  };
}
__name(normalizeUsage, "normalizeUsage");
var openaiAdapter = {
  build(ctx) {
    const body = { ...ctx.req, model: ctx.model };
    delete body.session_id;
    delete body.gw_provider;
    for (const p of ctx.drops)
      delete body[p];
    for (const p of ctx.provider.dropParams ?? [])
      delete body[p];
    if (body.stream) {
      if (ctx.provider.streamUsage === false) {
        delete body.stream_options;
      } else if (!body.stream_options) {
        body.stream_options = { include_usage: true };
      } else if (typeof body.stream_options === "object" && body.stream_options.include_usage !== true) {
        body.stream_options = {
          ...body.stream_options,
          include_usage: true
        };
      }
    } else {
      delete body.stream_options;
    }
    const headers = {
      ...ctx.provider.headers ?? {},
      "content-type": "application/json",
      authorization: `Bearer ${ctx.key.key}`
    };
    return {
      url: `${ctx.provider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      init: { method: "POST", headers, body: JSON.stringify(body) }
    };
  },
  parseJson(data) {
    const obj = data ?? {};
    return { json: obj, usage: normalizeUsage(obj.usage) };
  },
  parseStream(body) {
    const decoder = new TextDecoder();
    const usage = deferred();
    let tail = "";
    const stream = body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-16384);
        },
        flush() {
          let found = null;
          let idx = 0;
          while ((idx = tail.indexOf('"usage"', idx)) !== -1) {
            const brace = tail.indexOf("{", idx);
            if (brace === -1)
              break;
            let depth = 0;
            let end = -1;
            for (let i = brace; i < tail.length; i++) {
              if (tail[i] === "{")
                depth += 1;
              else if (tail[i] === "}") {
                depth -= 1;
                if (depth === 0) {
                  end = i;
                  break;
                }
              }
            }
            if (end === -1)
              break;
            try {
              const u = normalizeUsage(JSON.parse(tail.slice(brace, end + 1)));
              if (u)
                found = u;
            } catch {
            }
            idx = end + 1;
          }
          usage.resolve(found);
        }
      })
    );
    return { stream, usage: usage.promise };
  }
};

// src/adapters/anthropic.ts
var STOP_REASON = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
  pause_turn: "stop"
};
function argsObject(raw) {
  const v = safeJsonParse(raw ?? "{}", null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
__name(argsObject, "argsObject");
function textOf(content) {
  if (content == null)
    return "";
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((p) => p && typeof p === "object" && typeof p.text === "string" ? p.text : "").join("");
  }
  return String(content);
}
__name(textOf, "textOf");
function imageBlock(url) {
  if (!url)
    return null;
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) {
      return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    }
    return null;
  }
  return { type: "image", source: { type: "url", url } };
}
__name(imageBlock, "imageBlock");
function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  const push = /* @__PURE__ */ __name((role, blocks) => {
    if (!blocks.length)
      return;
    const last = out[out.length - 1];
    if (last && last.role === role)
      last.content.push(...blocks);
    else
      out.push({ role, content: blocks });
  }, "push");
  for (const m of messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (t)
        systemParts.push(t);
      continue;
    }
    if (m.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id ?? "unknown",
          content: textOf(m.content) || "(no output)"
        }
      ]);
      continue;
    }
    if (m.role === "assistant") {
      const blocks2 = [];
      const text = textOf(m.content);
      if (text)
        blocks2.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        blocks2.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name ?? "tool",
          input: argsObject(tc.function?.arguments)
        });
      }
      push("assistant", blocks2);
      continue;
    }
    const blocks = [];
    if (typeof m.content === "string") {
      if (m.content)
        blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p)
          continue;
        if (p.type === "text" && p.text)
          blocks.push({ type: "text", text: p.text });
        else if (p.type === "image_url") {
          const b = imageBlock(p.image_url?.url ?? "");
          if (b)
            blocks.push(b);
        }
      }
    }
    if (!blocks.length)
      blocks.push({ type: "text", text: "(empty)" });
    push("user", blocks);
  }
  if (out.length && out[0].role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "\u7EE7\u7EED" }] });
  }
  if (!out.length)
    out.push({ role: "user", content: [{ type: "text", text: "(empty)" }] });
  return { system: systemParts.length ? systemParts.join("\n\n") : void 0, messages: out };
}
__name(toAnthropicMessages, "toAnthropicMessages");
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length)
    return void 0;
  return tools.filter((t) => t && typeof t === "object" && t.function).map((t) => {
    const f = t.function;
    return {
      name: f.name,
      description: f.description ?? "",
      input_schema: f.parameters ?? { type: "object", properties: {} }
    };
  });
}
__name(toAnthropicTools, "toAnthropicTools");
function toAnthropicToolChoice(choice) {
  if (choice == null)
    return void 0;
  if (choice === "auto")
    return { type: "auto" };
  if (choice === "required")
    return { type: "any" };
  if (choice === "none")
    return { type: "none" };
  if (typeof choice === "object") {
    const c = choice;
    const name = c.function?.name ?? (c.type === "function" ? c.name : void 0);
    if (c.type === "function" && name)
      return { type: "tool", name };
  }
  return void 0;
}
__name(toAnthropicToolChoice, "toAnthropicToolChoice");
function toAnthropicRequest(req, model) {
  const { system, messages } = toAnthropicMessages(req.messages);
  const body = {
    model,
    max_tokens: Math.max(1, Number(req.max_tokens ?? req.max_completion_tokens ?? 4096)),
    messages
  };
  if (system)
    body.system = system;
  if (req.stream)
    body.stream = true;
  if (typeof req.temperature === "number")
    body.temperature = Math.min(1, Math.max(0, req.temperature));
  if (typeof req.top_p === "number" && typeof req.temperature !== "number")
    body.top_p = req.top_p;
  if (req.parallel_tool_calls === false)
    body.disable_parallel_tool_use = true;
  if (req.stop)
    body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  const tools = toAnthropicTools(req.tools);
  if (tools?.length) {
    body.tools = tools;
    const tc = toAnthropicToolChoice(req.tool_choice);
    if (tc)
      body.tool_choice = tc;
  }
  return body;
}
__name(toAnthropicRequest, "toAnthropicRequest");
function fromAnthropicResponse(data, model) {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
    id: b.id,
    type: "function",
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
  }));
  const usage = normalizeUsage(data.usage) ?? {
    prompt_tokens: Number(data.usage?.input_tokens ?? 0),
    completion_tokens: Number(data.usage?.output_tokens ?? 0),
    total_tokens: Number(data.usage?.input_tokens ?? 0) + Number(data.usage?.output_tokens ?? 0)
  };
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length)
    message.tool_calls = toolCalls;
  return {
    id: data.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON[data.stop_reason] ?? "stop"
      }
    ],
    usage
  };
}
__name(fromAnthropicResponse, "fromAnthropicResponse");
function anthropicStream(body, model) {
  const usage = deferred();
  let promptTokens = 0;
  let completionTokens = 0;
  let toolIndex = -1;
  const blockToTool = /* @__PURE__ */ new Map();
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  let finished = false;
  let finalReason = null;
  const chunk = /* @__PURE__ */ __name((delta, finish = null, withUsage = false) => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1e3),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }]
    };
    if (withUsage) {
      payload.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      };
    }
    return payload;
  }, "chunk");
  const resolveUsage = /* @__PURE__ */ __name(() => {
    usage.resolve({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    });
  }, "resolveUsage");
  const stream = parseSSE(body).pipeThrough(
    new TransformStream({
      transform(ev, controller) {
        if (!ev.data)
          return;
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        const type = data.type ?? ev.event;
        switch (type) {
          case "message_start": {
            promptTokens = Number(data.message?.usage?.input_tokens ?? 0);
            controller.enqueue(
              sseEncode(chunk({ role: "assistant", content: "" }))
            );
            break;
          }
          case "content_block_start": {
            const block = data.content_block;
            if (block?.type === "tool_use") {
              toolIndex += 1;
              blockToTool.set(Number(data.index ?? 0), toolIndex);
              controller.enqueue(
                sseEncode(
                  chunk({
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: block.id,
                        type: "function",
                        function: { name: block.name, arguments: "" }
                      }
                    ]
                  })
                )
              );
            }
            break;
          }
          case "content_block_delta": {
            const d = data.delta;
            if (d?.type === "text_delta" && d.text) {
              controller.enqueue(sseEncode(chunk({ content: d.text })));
            } else if (d?.type === "input_json_delta") {
              const idx = blockToTool.get(Number(data.index ?? 0)) ?? 0;
              controller.enqueue(
                sseEncode(
                  chunk({
                    tool_calls: [
                      { index: idx, function: { arguments: d.partial_json ?? "" } }
                    ]
                  })
                )
              );
            }
            break;
          }
          case "message_delta": {
            if (data.usage?.output_tokens != null) {
              completionTokens = Number(data.usage.output_tokens);
            }
            const fr = STOP_REASON[data.delta?.stop_reason];
            if (fr)
              finalReason = fr;
            break;
          }
          case "message_stop": {
            if (!finished) {
              finished = true;
              controller.enqueue(sseEncode(chunk({}, finalReason ?? "stop", true)));
              controller.enqueue(sseEncode("[DONE]"));
              resolveUsage();
            }
            break;
          }
          case "error": {
            controller.enqueue(
              sseEncode({
                error: {
                  message: data.error?.message ?? "anthropic upstream error",
                  type: "upstream_error"
                }
              })
            );
            if (!finished) {
              finished = true;
              controller.enqueue(sseEncode("[DONE]"));
              resolveUsage();
            }
            break;
          }
        }
      },
      flush(controller) {
        if (!finished) {
          finished = true;
          controller.enqueue(sseEncode(chunk({}, finalReason ?? "stop", true)));
          controller.enqueue(sseEncode("[DONE]"));
          resolveUsage();
        }
      }
    })
  );
  return { stream, usage: usage.promise };
}
__name(anthropicStream, "anthropicStream");
var anthropicAdapter = {
  build(ctx) {
    const body = toAnthropicRequest(ctx.req, ctx.model);
    for (const p of [...ctx.drops, ...ctx.provider.dropParams ?? []])
      delete body[p];
    if (ctx.req.parallel_tool_calls === false && body.disable_parallel_tool_use) {
      body.tool_choice = { ...body.tool_choice ?? { type: "auto" }, disable_parallel_tool_use: true };
      delete body.disable_parallel_tool_use;
    }
    return {
      url: `${ctx.provider.baseUrl.replace(/\/+$/, "")}/v1/messages`,
      init: {
        method: "POST",
        headers: {
          ...ctx.provider.headers ?? {},
          "content-type": "application/json",
          "x-api-key": ctx.key.key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      }
    };
  },
  parseJson(data, ctx) {
    const obj = data ?? {};
    const out = fromAnthropicResponse(obj, ctx.model);
    return { json: out, usage: out.usage };
  },
  parseStream(body, ctx) {
    return anthropicStream(body, ctx.model);
  }
};

// src/adapters/gemini.ts
var FINISH_REASON = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  MALFORMED_FUNCTION_CALL: "stop",
  OTHER: "stop"
};
var SCHEMA_DROP = /* @__PURE__ */ new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "strict",
  "default",
  "examples",
  "const",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "patternProperties",
  "if",
  "then",
  "else",
  "not",
  "dependentRequired",
  "nullable",
  "discriminator",
  "readOnly",
  "writeOnly",
  "deprecated"
]);
function cleanSchema(node) {
  if (Array.isArray(node))
    return node.map(cleanSchema);
  if (!node || typeof node !== "object")
    return node;
  const src = node;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (SCHEMA_DROP.has(k))
      continue;
    out[k] = cleanSchema(v);
  }
  if (Array.isArray(out.type)) {
    const nonNull = out.type.filter((t) => t !== "null");
    if (out.type.length !== nonNull.length)
      out.nullable = true;
    if (nonNull.length === 1)
      out.type = nonNull[0];
    else if (nonNull.length === 0)
      delete out.type;
    else
      out.type = nonNull[0];
  }
  if (Array.isArray(out.anyOf)) {
    const branches = out.anyOf;
    const nonNull = branches.filter((b) => b?.type !== "null");
    if (nonNull.length !== branches.length)
      out.nullable = true;
    if (nonNull.length === 1) {
      Object.assign(out, nonNull[0]);
      delete out.anyOf;
    } else {
      out.anyOf = nonNull;
    }
  }
  if (out.properties && !out.type)
    out.type = "object";
  if (out.items && !out.type)
    out.type = "array";
  return out;
}
__name(cleanSchema, "cleanSchema");
function argsObject2(raw) {
  const v = safeJsonParse(raw ?? "{}", null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
__name(argsObject2, "argsObject");
function dataUrlToInline(url) {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m)
    return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}
__name(dataUrlToInline, "dataUrlToInline");
function textOf2(content) {
  if (content == null)
    return "";
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((p) => p && typeof p === "object" && typeof p.text === "string" ? p.text : "").join("");
  }
  return String(content);
}
__name(textOf2, "textOf");
function toGeminiRequest(req) {
  const contents = [];
  const systemParts = [];
  const toolNameById = /* @__PURE__ */ new Map();
  const push = /* @__PURE__ */ __name((role, parts) => {
    if (!parts.length)
      return;
    const last = contents[contents.length - 1];
    if (last && last.role === role)
      last.parts.push(...parts);
    else
      contents.push({ role, parts });
  }, "push");
  for (const m of req.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const t = textOf2(m.content);
      if (t)
        systemParts.push(t);
      continue;
    }
    if (m.role === "tool") {
      const name = toolNameById.get(m.tool_call_id ?? "") ?? "tool";
      const raw = textOf2(m.content);
      const parsed = safeJsonParse(raw, null);
      const response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { content: raw || "(no output)" };
      push("user", [{ functionResponse: { name, response } }]);
      continue;
    }
    if (m.role === "assistant") {
      const parts2 = [];
      const text = textOf2(m.content);
      if (text)
        parts2.push({ text });
      for (const tc of m.tool_calls ?? []) {
        toolNameById.set(tc.id, tc.function?.name ?? "tool");
        parts2.push({
          functionCall: {
            name: tc.function?.name ?? "tool",
            args: argsObject2(tc.function?.arguments)
          }
        });
      }
      push("model", parts2);
      continue;
    }
    const parts = [];
    if (typeof m.content === "string") {
      if (m.content)
        parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p)
          continue;
        if (p.type === "text" && p.text)
          parts.push({ text: p.text });
        else if (p.type === "image_url" && p.image_url?.url) {
          const inline = dataUrlToInline(p.image_url.url);
          if (inline)
            parts.push(inline);
          else
            parts.push({ fileData: { fileUri: p.image_url.url } });
        }
      }
    }
    if (!parts.length)
      parts.push({ text: "(empty)" });
    push("user", parts);
  }
  if (!contents.length)
    contents.push({ role: "user", parts: [{ text: "(empty)" }] });
  if (contents[0].role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "\u7EE7\u7EED" }] });
  }
  const body = { contents };
  if (systemParts.length)
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  const gen = {};
  if (typeof req.temperature === "number")
    gen.temperature = Math.max(0, Math.min(2, req.temperature));
  if (typeof req.top_p === "number")
    gen.topP = req.top_p;
  const maxOut = req.max_tokens ?? req.max_completion_tokens;
  if (typeof maxOut === "number")
    gen.maxOutputTokens = Math.max(1, maxOut);
  if (req.stop)
    gen.stopSequences = Array.isArray(req.stop) ? req.stop.slice(0, 5) : [req.stop];
  if (req.response_format && req.response_format.type === "json_object") {
    gen.responseMimeType = "application/json";
  }
  if (Object.keys(gen).length)
    body.generationConfig = gen;
  if (Array.isArray(req.tools) && req.tools.length) {
    const decls = req.tools.filter((t) => t && typeof t === "object" && t.function).map((t) => {
      const f = t.function;
      return {
        name: f.name,
        description: f.description ?? "",
        parameters: cleanSchema(f.parameters ?? { type: "object", properties: {} })
      };
    });
    if (decls.length) {
      body.tools = [{ functionDeclarations: decls }];
      const choice = req.tool_choice;
      let mode;
      let allowedFunctionNames;
      if (choice === "auto")
        mode = "AUTO";
      else if (choice === "required")
        mode = "ANY";
      else if (choice === "none")
        mode = "NONE";
      else if (choice && typeof choice === "object") {
        const c = choice;
        const name = c.function?.name ?? (c.type === "function" ? c.name : void 0);
        if (c.type === "function" && name) {
          mode = "ANY";
          allowedFunctionNames = [String(name)];
        }
      }
      if (mode) {
        body.toolConfig = {
          functionCallingConfig: {
            mode,
            ...allowedFunctionNames ? { allowedFunctionNames } : {}
          }
        };
      }
    }
  }
  return body;
}
__name(toGeminiRequest, "toGeminiRequest");
function extractParts(data) {
  const cand = data.candidates?.[0] ?? {};
  const parts = cand.content?.parts ?? [];
  let text = "";
  const toolCalls = [];
  for (const p of parts) {
    if (typeof p.text === "string" && !p.thought)
      text += p.text;
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function",
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {})
        }
      });
    }
  }
  return { text, toolCalls, finishReason: cand.finishReason, parts };
}
__name(extractParts, "extractParts");
function fromGeminiResponse(data, model) {
  if (data.promptFeedback?.blockReason) {
    throw new Error(`gemini blocked: ${data.promptFeedback.blockReason}`);
  }
  const { text, toolCalls, finishReason } = extractParts(data);
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length)
    message.tool_calls = toolCalls;
  const usage = normalizeUsage(data.usageMetadata) ?? {
    prompt_tokens: Number(data.usageMetadata?.promptTokenCount ?? 0),
    completion_tokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0),
    total_tokens: Number(data.usageMetadata?.totalTokenCount ?? 0)
  };
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [
      {
        index: 0,
        message,
        // Gemini 函数调用完成时 finishReason 仍是 STOP，必须按有没有 tool call 判定
        finish_reason: toolCalls.length ? "tool_calls" : FINISH_REASON[finishReason ?? "STOP"] ?? "stop"
      }
    ],
    usage
  };
}
__name(fromGeminiResponse, "fromGeminiResponse");
function geminiStream(body, model) {
  const usage = deferred();
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  let toolIndex = -1;
  let lastUsage = null;
  let finished = false;
  let doneSent = false;
  const chunk = /* @__PURE__ */ __name((delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  }), "chunk");
  const stream = parseSSE(body).pipeThrough(
    new TransformStream({
      transform(ev, controller) {
        if (finished)
          return;
        if (!ev.data || ev.data === "[DONE]")
          return;
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (data.promptFeedback?.blockReason) {
          controller.enqueue(
            sseEncode({
              error: {
                message: `gemini blocked: ${data.promptFeedback.blockReason}`,
                type: "content_filter"
              }
            })
          );
          controller.enqueue(sseEncode(chunk({}, "content_filter")));
          controller.enqueue(sseEncode("[DONE]"));
          finished = true;
          doneSent = true;
          usage.resolve(lastUsage);
          return;
        }
        const u = normalizeUsage(data.usageMetadata);
        if (u)
          lastUsage = u;
        const { text, toolCalls, finishReason } = extractParts(data);
        if (text)
          controller.enqueue(sseEncode(chunk({ content: text })));
        for (const tc of toolCalls) {
          toolIndex += 1;
          controller.enqueue(
            sseEncode(
              chunk({
                tool_calls: [
                  {
                    index: toolIndex,
                    id: tc.id,
                    type: "function",
                    function: tc.function
                  }
                ]
              })
            )
          );
        }
        if (finishReason) {
          const reason = toolIndex >= 0 ? "tool_calls" : FINISH_REASON[finishReason] ?? "stop";
          const finalChunk = chunk({}, reason);
          if (lastUsage)
            finalChunk.usage = lastUsage;
          controller.enqueue(sseEncode(finalChunk));
          finished = true;
        }
      },
      flush(controller) {
        finished = true;
        if (!doneSent)
          controller.enqueue(sseEncode("[DONE]"));
        usage.resolve(lastUsage);
      }
    })
  );
  return { stream, usage: usage.promise };
}
__name(geminiStream, "geminiStream");
var geminiAdapter = {
  build(ctx) {
    const body = toGeminiRequest(ctx.req);
    const GEN_MAP = {
      temperature: "temperature",
      top_p: "topP",
      max_tokens: "maxOutputTokens",
      max_completion_tokens: "maxOutputTokens",
      stop: "stopSequences"
    };
    for (const p of [...ctx.drops, ...ctx.provider.dropParams ?? []]) {
      delete body[p];
      const mapped = GEN_MAP[p];
      if (mapped && body.generationConfig)
        delete body.generationConfig[mapped];
    }
    if (body.generationConfig && !Object.keys(body.generationConfig).length) {
      delete body.generationConfig;
    }
    const verb = ctx.req.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return {
      url: `${ctx.provider.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(ctx.model)}:${verb}`,
      init: {
        method: "POST",
        headers: {
          ...ctx.provider.headers ?? {},
          "content-type": "application/json",
          "x-goog-api-key": ctx.key.key
        },
        body: JSON.stringify(body)
      }
    };
  },
  parseJson(data, ctx) {
    const obj = data ?? {};
    const out = fromGeminiResponse(obj, ctx.model);
    return { json: out, usage: out.usage };
  },
  parseStream(body, ctx) {
    return geminiStream(body, ctx.model);
  }
};

// src/adapters/index.ts
function adapterFor(kind) {
  switch (kind) {
    case "anthropic":
      return anthropicAdapter;
    case "gemini":
      return geminiAdapter;
    case "openai":
      return openaiAdapter;
    default:
      throw new Error(`unknown provider kind: ${String(kind)}`);
  }
}
__name(adapterFor, "adapterFor");

// src/catalog.ts
function parseModelName(raw) {
  let id = (raw || "").toLowerCase().trim();
  const slash = id.lastIndexOf("/");
  if (slash >= 0)
    id = id.slice(slash + 1);
  id = id.replace(/:(free|nitro|extended|online|thinking|floor)$/g, "");
  let releasedAt;
  const iso = id.match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/);
  if (iso) {
    releasedAt = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  } else {
    const short = id.match(/(?:^|[-_.])(\d{2})(0[1-9]|1[0-2])(?:$|[-_.])/);
    if (short) {
      const year = 2e3 + Number(short[1]);
      if (year >= 2020 && year <= 2035)
        releasedAt = Date.UTC(year, Number(short[2]) - 1, 1);
    }
  }
  let sizeB;
  const size = id.match(/(\d{1,3}(?:\.\d+)?)\s*b(?![a-z0-9])/);
  if (size)
    sizeB = Number(size[1]);
  const moe = id.match(/(\d{1,2})x(\d{1,3}(?:\.\d+)?)b/);
  if (moe)
    sizeB = Number(moe[1]) * Number(moe[2]);
  const work = id.replace(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/g, " ").replace(/(?:^|[-_.])\d{2}(0[1-9]|1[0-2])(?:$|[-_.])/g, " ").replace(/\d{1,2}x\d{1,3}(?:\.\d+)?b/g, " ").replace(/\d{1,3}(?:\.\d+)?\s*b(?![a-z0-9])/g, " ");
  let major = 0;
  let minor = 0;
  const vPrefix = work.match(/(?:^|[-_.])v(\d{1,2})(?:[.-](\d{1,2}))?/);
  if (vPrefix) {
    major = Number(vPrefix[1]);
    minor = vPrefix[2] ? Number(vPrefix[2]) : 0;
  } else {
    const pair = work.match(/(?:^|[^\d])(\d{1,2})[.-](\d{1,2})(?!\d)/);
    if (pair && Number(pair[1]) <= 30 && Number(pair[2]) <= 30) {
      major = Number(pair[1]);
      minor = Number(pair[2]);
    } else {
      const singles = [...work.matchAll(/(?:^|[^\d.])(\d{1,2})(?![\d.b])/g)].map((m) => Number(m[1])).filter((n) => n <= 30);
      if (singles.length)
        major = singles[0];
    }
  }
  const family = id.split(/[^a-z0-9.]+/).filter((t) => t && !/^\d+(\.\d+)?$/.test(t) && !/^\d+[bx]\d*$/.test(t)).map(
    (t) => /[a-z]/.test(t) && /\d/.test(t) ? t : t.replace(/\d+(\.\d+)?[bx]?/g, (m) => /^\d/.test(m) ? "" : m)
  ).filter(Boolean).join("-") || id;
  const versionScore = major * 1e6 + minor * 1e4 + clamp(sizeB ?? 0, 0, 999) * 10;
  return { family, major, minor, sizeB, releasedAt, versionScore };
}
__name(parseModelName, "parseModelName");
function isChatModel(id) {
  const s = (id || "").toLowerCase();
  if (/(embedding|embed-|whisper|tts-|transcribe|speech|moderation|rerank|reranker|bge-|gte-|e5-|clip-|guard-|safety-|ocr-|upscal|dall-e|stable-diffusion|sdxl|flux-|midjourney|imagen-|veo-|sora-|kling|seedance|aqa)/.test(
    s
  )) {
    return false;
  }
  if (/(^|[-_/])(audio|image|video)([-_/]|$)/.test(s))
    return false;
  return true;
}
__name(isChatModel, "isChatModel");
function isFreeModel(id, pricing, freeMode, allow) {
  if (freeMode === "zero-price") {
    if (!pricing)
      return false;
    const isZero = /* @__PURE__ */ __name((v) => v !== void 0 && v !== null && Number(v) === 0, "isZero");
    const promptFree = isZero(pricing.prompt);
    const completionFree = isZero(pricing.completion);
    const requestFree = pricing.request === void 0 || pricing.request === null || Number(pricing.request) === 0;
    return promptFree && completionFree && requestFree;
  }
  if (freeMode === "allowlist") {
    if (!allow?.length)
      return /:free$/.test(id);
    return allow.some((re) => {
      try {
        return new RegExp(re, "i").test(id);
      } catch {
        return false;
      }
    });
  }
  return true;
}
__name(isFreeModel, "isFreeModel");
function inferTags(id, supported) {
  const s = id.toLowerCase();
  const tags = /* @__PURE__ */ new Set();
  if (supported?.includes("tools") || supported?.includes("tool_choice"))
    tags.add("tools");
  if (supported?.includes("response_format"))
    tags.add("json");
  if (/(vision|[-_]vl[-_]|llava|pixtral|4o|omni|gemini|claude-3|claude-4|qwen2\.5-vl)/.test(s))
    tags.add("vision");
  if (/(think|reason|o1|o3|o4|r1|qwq|deepseek-reasoner)/.test(s))
    tags.add("reasoning");
  if (/(preview|exp|beta|rc\d|experimental)/.test(s))
    tags.add("preview");
  if (/:free$/.test(s))
    tags.add("free");
  return [...tags];
}
__name(inferTags, "inferTags");
function buildCatalog(entries, opts) {
  const byKey2 = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (!e.groupKey)
      e.groupKey = groupKeyOf(e.model);
    const prev = byKey2.get(e.key);
    if (!prev || e.versionScore > prev.versionScore)
      byKey2.set(e.key, e);
  }
  const groups = /* @__PURE__ */ new Map();
  for (const e of byKey2.values()) {
    const gk = `${e.provider}::${e.family}`;
    const arr = groups.get(gk) ?? [];
    arr.push(e);
    groups.set(gk, arr);
  }
  const kept = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      if (b.versionScore !== a.versionScore)
        return b.versionScore - a.versionScore;
      return (b.releasedAt ?? b.created ?? 0) - (a.releasedAt ?? a.created ?? 0);
    });
    kept.push(...arr.slice(0, opts.keepPerFamily));
  }
  kept.sort((a, b) => {
    if (b.versionScore !== a.versionScore)
      return b.versionScore - a.versionScore;
    return (b.releasedAt ?? b.created ?? 0) - (a.releasedAt ?? a.created ?? 0);
  });
  const families = new Set(kept.map((e) => `${e.provider}::${e.family}`));
  return {
    version: (opts.previous?.version ?? 0) + 1,
    syncedAt: Date.now(),
    entries: kept,
    providers: opts.providers,
    stats: { total: kept.length, providers: opts.providers.filter((p) => p.ok).length, families: families.size }
  };
}
__name(buildCatalog, "buildCatalog");
var ALIAS_MODES = /* @__PURE__ */ new Set(["new", "fast", "smart", "long", "cheap"]);
function rankScore(e, mode) {
  const recency = e.releasedAt ?? (e.created ? e.created * 1e3 : 0);
  const ageDays = recency ? (Date.now() - recency) / 864e5 : 400;
  const freshness = clamp(1 - ageDays / 365, 0, 1);
  switch (mode) {
    case "new":
      return recency || e.versionScore;
    case "fast":
      return (e.sizeB ? 1 / e.sizeB : 0.02) * 1e3 + e.versionScore / 1e3;
    case "smart":
      return (e.sizeB ?? 0) * 10 + e.versionScore / 1e3;
    case "long":
      return e.contextLength ?? 0;
    case "cheap":
      return -(e.pricing ? e.pricing.prompt + e.pricing.completion : 0);
    default:
      return e.versionScore / 1e6 + freshness * 0.8 + clamp(e.sizeB ?? 0, 0, 200) / 200 * 0.2;
  }
}
__name(rankScore, "rankScore");
function resolveCandidates(entries, requested, opts = {}) {
  const raw = (requested || "auto").trim();
  const normalized = raw.replace(/^auto[-_](new|fast|smart|long|cheap)$/i, "auto:$1");
  const limit = opts.limit ?? 24;
  const allow = /* @__PURE__ */ __name((e) => !opts.allowed || opts.allowed.has(e.provider), "allow");
  let pool = [];
  let matched = "none";
  let note;
  let hit;
  const pinned = (() => {
    if (!normalized.includes("/"))
      return null;
    const pid = normalized.split("/")[0].toLowerCase();
    return opts.knownProviders?.has(pid) ? pid : null;
  })();
  if (/^auto\b/i.test(normalized)) {
    matched = "alias";
    const sub = normalized.split(":").slice(1).join(":").trim().toLowerCase();
    pool = entries.slice();
    if (sub && !ALIAS_MODES.has(sub)) {
      pool = pool.filter(
        (e) => e.family.includes(sub) || e.model.toLowerCase().includes(sub)
      );
      if (!pool.length)
        note = `\u6CA1\u6709\u5339\u914D "${sub}" \u7684\u514D\u8D39\u6A21\u578B`;
    }
    const mode = ALIAS_MODES.has(sub) ? sub : "auto";
    pool.sort((a, b) => rankScore(b, mode) - rankScore(a, mode));
  } else if (pinned) {
    const [pid, ...rest] = normalized.split("/");
    const mid = rest.join("/");
    pool = entries.filter((e) => e.provider === pid && e.model.toLowerCase().endsWith(mid.toLowerCase()));
    if (pool.length)
      matched = "exact";
    else
      note = `\u670D\u52A1\u5546 ${pid} \u6CA1\u6709\u5339\u914D "${mid}" \u7684\u6A21\u578B`;
  } else {
    let groupBlocked = false;
    hit = opts.groups?.length ? matchGroup(opts.groups, normalized) ?? void 0 : void 0;
    if (hit) {
      pool = hit.endpoints.filter(allow);
      matched = "group";
      if (pool.length) {
        note = hit.providers.length > 1 ? `\u6620\u5C04\u7EC4 ${hit.id}\uFF08${hit.providers.join(" / ")}\uFF0C\u5171 ${pool.length} \u4E2A\u7AEF\u70B9\uFF09` : `\u6620\u5C04\u7EC4 ${hit.id}\uFF08\u4EC5 ${hit.providers[0]} \u63D0\u4F9B\uFF09`;
      } else {
        note = `\u6620\u5C04\u7EC4 ${hit.id} \u7684\u7AEF\u70B9\u6240\u5728\u670D\u52A1\u5546\u5F53\u524D\u90FD\u4E0D\u53EF\u7528`;
        groupBlocked = true;
      }
    }
    if (!pool.length && !groupBlocked) {
      const exactKey = entries.filter((e) => e.key === normalized);
      const exactModel = entries.filter((e) => e.model.toLowerCase() === normalized.toLowerCase());
      if (exactKey.length) {
        pool = exactKey;
        matched = "exact";
      } else if (exactModel.length) {
        pool = exactModel;
        matched = "exact";
      }
    }
    if (!pool.length && !groupBlocked) {
      const needle = normalized.toLowerCase();
      pool = entries.filter((e) => e.model.toLowerCase().includes(needle));
      if (pool.length) {
        matched = "fuzzy";
        note = `\u672A\u7CBE\u786E\u5339\u914D\uFF0C\u4F7F\u7528\u5305\u542B "${needle}" \u7684\u6A21\u578B`;
      }
    }
  }
  pool = pool.filter(allow);
  if (!pool.length && !note)
    note = `\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B\u5339\u914D "${normalized}"`;
  if (matched !== "group")
    pool.sort((a, b) => rankScore(b, "auto") - rankScore(a, "auto"));
  const prefer = /* @__PURE__ */ __name((list, tag) => {
    const withTag = list.filter((e) => e.tags.includes(tag));
    return withTag.length ? [...withTag, ...list.filter((e) => !e.tags.includes(tag))] : list;
  }, "prefer");
  if (opts.needsTools)
    pool = prefer(pool, "tools");
  if (opts.needsVision)
    pool = prefer(pool, "vision");
  pool = pool.slice().sort((a, b) => {
    const pa = a.tags.includes("preview") ? 1 : 0;
    const pb = b.tags.includes("preview") ? 1 : 0;
    return pa - pb;
  });
  const picked = pool.slice(0, limit);
  return {
    matched,
    note,
    group: hit ? { id: hit.id, key: hit.key, providers: hit.providers, endpoints: hit.endpoints.length } : void 0,
    candidates: picked.map((e) => ({
      provider: e.provider,
      model: e.model,
      weight: e.tags.includes("preview") ? 0.6 : 1,
      entry: e
    }))
  };
}
__name(resolveCandidates, "resolveCandidates");
var VIRTUAL_MODELS = [
  { id: "auto", description: "\u81EA\u52A8\u9009\u62E9\u5F53\u524D\u6700\u4F18\u7684\u514D\u8D39\u6A21\u578B" },
  { id: "auto:new", description: "\u4F18\u5148\u6700\u65B0\u53D1\u5E03\u7684\u6A21\u578B" },
  { id: "auto:fast", description: "\u4F18\u5148\u5C0F\u53C2\u6570\u6A21\u578B\uFF08\u66F4\u5FEB\u3001\u66F4\u7701\u989D\u5EA6\uFF09" },
  { id: "auto:smart", description: "\u4F18\u5148\u5927\u53C2\u6570\u6A21\u578B\uFF08\u8D28\u91CF\u66F4\u9AD8\uFF09" },
  { id: "auto:long", description: "\u4F18\u5148\u957F\u4E0A\u4E0B\u6587\u6A21\u578B" },
  { id: "auto:cheap", description: "\u4F18\u5148\u4EF7\u683C\u6700\u4F4E\u7684\u6A21\u578B" }
];

// src/enrich.ts
var MOD_ORDER = ["text", "image", "pdf", "audio", "video"];
function normModality(raw) {
  let s = raw.toLowerCase().trim();
  s = s.replace(/_(input|output)$/, "").replace(/-(input|output)$/, "");
  if (s === "file")
    s = "pdf";
  if (s === "speech")
    s = "audio";
  if (s === "transcription")
    s = "text";
  return MOD_ORDER.includes(s) ? s : null;
}
__name(normModality, "normModality");
function normModalities(list) {
  if (!Array.isArray(list))
    return void 0;
  const set = /* @__PURE__ */ new Set();
  for (const v of list) {
    if (typeof v !== "string")
      continue;
    const m = normModality(v);
    if (m)
      set.add(m);
  }
  if (!set.size)
    return void 0;
  return MOD_ORDER.filter((m) => set.has(m));
}
__name(normModalities, "normModalities");
var indexCache = null;
var indexInflight = null;
var INDEX_TTL = 6 * 36e5;
function infoOf(m) {
  return {
    context: typeof m.limit?.context === "number" && m.limit.context > 0 ? m.limit.context : void 0,
    output: typeof m.limit?.output === "number" && m.limit.output > 0 ? m.limit.output : void 0,
    inputs: normModalities(m.modalities?.input),
    outputs: normModalities(m.modalities?.output)
  };
}
__name(infoOf, "infoOf");
async function buildIndex() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), 25e3);
  try {
    const res = await fetch("https://models.dev/api.json", { signal: ctrl.signal });
    if (!res.ok)
      throw new Error(`models.dev HTTP ${res.status}`);
    const data = await res.json();
    const index = /* @__PURE__ */ new Map();
    const put = /* @__PURE__ */ __name((key, info) => {
      if (key && !index.has(key))
        index.set(key, info);
    }, "put");
    for (const [prov, pdata] of Object.entries(data)) {
      for (const [mid, m] of Object.entries(pdata?.models ?? {})) {
        const info = infoOf(m);
        const low = mid.toLowerCase();
        const base = low.split("/").pop();
        put(low, info);
        put(base, info);
        put(`${prov.toLowerCase()}::${base}`, info);
        put(squash(base), info);
      }
    }
    return index;
  } finally {
    clearTimeout(timer);
  }
}
__name(buildIndex, "buildIndex");
async function loadIndex() {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL)
    return indexCache.index;
  if (!indexInflight) {
    indexInflight = buildIndex().then((index) => {
      indexCache = { at: Date.now(), index };
      return index;
    }).finally(() => {
      indexInflight = null;
    });
  }
  try {
    return await indexInflight;
  } catch (e) {
    console.error("[enrich] models.dev \u62C9\u53D6\u5931\u8D25\uFF0C\u8DF3\u8FC7\u5BCC\u5316", e);
    return null;
  }
}
__name(loadIndex, "loadIndex");
function squash(s) {
  return s.replace(/[-_.\s]/g, "");
}
__name(squash, "squash");
var COLON_SUFFIX = /:(free|beta|latest|preview|stable|experimental)$/;
var VARIANT_SUFFIX = /[-_](thinking|reasoning|uncensored|fast|turbo|instruct|chat|preview|beta|latest|exp|it|\d{4}|\d{2}-\d{2}|\d{8})$/;
function candidateKeys(model) {
  const low = model.toLowerCase();
  const base = low.split("/").pop();
  const vendor = low.includes("/") ? low.split("/")[0] : "";
  const keys = [];
  const push = /* @__PURE__ */ __name((k) => {
    if (k && !keys.includes(k))
      keys.push(k);
  }, "push");
  if (vendor)
    push(`${vendor}::${base}`);
  push(low);
  push(base);
  let cur = base.replace(COLON_SUFFIX, "");
  push(cur);
  for (let i = 0; i < 3; i++) {
    const next = cur.replace(VARIANT_SUFFIX, "");
    if (next === cur)
      break;
    cur = next;
    push(cur);
  }
  push(squash(base));
  push(squash(cur));
  return keys;
}
__name(candidateKeys, "candidateKeys");
function lookupDev(index, model) {
  for (const k of candidateKeys(model)) {
    const hit = index.get(k);
    if (hit)
      return hit;
  }
  return void 0;
}
__name(lookupDev, "lookupDev");
function heuristicModalities(model) {
  const n = model.toLowerCase().split("/").pop();
  const T = ["text"];
  if (/whisper|transcri|speech-to-text|(^|[-_])stt([-_]|$)/.test(n)) {
    return { inputs: ["audio"], outputs: T };
  }
  if (/tts|text-to-speech|omnivoice|(^|[-_])speech-\d/.test(n)) {
    return { inputs: T, outputs: ["audio"] };
  }
  if (/flux|stable-diffusion|sdxl|(^|[-_])sd3|dall[-_]?e|imagen|gpt-image|seedream|seededit|kolors|ideogram|recraft|midjourney/.test(n)) {
    return { inputs: ["text", "image"], outputs: ["image"] };
  }
  if (/gemini/.test(n))
    return { inputs: ["text", "image", "pdf", "audio", "video"], outputs: T };
  if (/claude/.test(n))
    return { inputs: ["text", "image", "pdf"], outputs: T };
  if (/^(gpt-4o|gpt-5|chatgpt-4o)/.test(n))
    return { inputs: ["text", "image", "pdf"], outputs: T };
  if (/minicpm-v|[-_]vl([-_.:]|$)|[-_]vl\d|vision|llava|internvl|pixtral|glm-4\w*v|qwen\w*-?omni|omni|gemma-[34]|llama-4|kimi-vl|deepseek-vl|qvq/.test(n)) {
    return { inputs: ["text", "image"], outputs: T };
  }
  return null;
}
__name(heuristicModalities, "heuristicModalities");
async function enrichEntries(entries) {
  const index = await loadIndex();
  for (const e of entries) {
    if (index) {
      const dev = lookupDev(index, e.model);
      if (dev) {
        if (e.contextLength === void 0 && dev.context)
          e.contextLength = dev.context;
        if (e.maxOutput === void 0 && dev.output)
          e.maxOutput = dev.output;
        if (!e.inputModalities && dev.inputs)
          e.inputModalities = dev.inputs;
        if (!e.outputModalities && dev.outputs)
          e.outputModalities = dev.outputs;
      }
    }
    if (!e.inputModalities || !e.outputModalities) {
      const h = heuristicModalities(e.model);
      if (h) {
        if (!e.inputModalities)
          e.inputModalities = h.inputs;
        if (!e.outputModalities)
          e.outputModalities = h.outputs;
      }
    }
  }
}
__name(enrichEntries, "enrichEntries");

// src/discovery.ts
function modelsUrl(p) {
  const path = p.modelsPath || "/models";
  if (path.startsWith("http"))
    return path;
  return `${p.baseUrl}${path}`;
}
__name(modelsUrl, "modelsUrl");
function parseCreated(o) {
  if (typeof o.created === "number")
    return o.created > 1e12 ? o.created / 1e3 : o.created;
  const ca = o.created_at;
  if (typeof ca === "number")
    return ca > 1e12 ? ca / 1e3 : ca;
  if (typeof ca === "string") {
    const t = Date.parse(ca);
    return Number.isFinite(t) ? t / 1e3 : void 0;
  }
  return void 0;
}
__name(parseCreated, "parseCreated");
function normalizeModel(raw) {
  const o = raw;
  return {
    id: String(o.id ?? o.name ?? "").replace(/^models\//, ""),
    name: o.name ?? o.display_name ?? o.displayName,
    created: parseCreated(o),
    context_length: o.context_length ?? o.inputTokenLimit ?? o.context_window,
    max_completion_tokens: o.max_completion_tokens ?? o.outputTokenLimit,
    pricing: o.pricing,
    supported_parameters: o.supported_parameters,
    architecture: o.architecture,
    top_provider: o.top_provider
  };
}
__name(normalizeModel, "normalizeModel");
async function fetchModels(p, key) {
  const url = modelsUrl(p);
  const headers = { ...p.headers ?? {} };
  if (p.kind === "anthropic") {
    headers["x-api-key"] = key.key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (p.kind === "gemini") {
    headers["x-goog-api-key"] = key.key;
  } else {
    headers["authorization"] = `Bearer ${key.key}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), 2e4);
  let data;
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const text = truncate(await res.text().catch(() => ""), 300);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const raw = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object")
      continue;
    if (p.kind === "gemini") {
      const methods = item.supportedGenerationMethods ?? [];
      if (Array.isArray(methods) && methods.length && !methods.includes("generateContent"))
        continue;
    }
    const m = normalizeModel(item);
    if (m.id)
      out.push(m);
  }
  return out;
}
__name(fetchModels, "fetchModels");
function toEntry(p, m, prev) {
  const parsed = parseModelName(m.id);
  const pricing = m.pricing ? {
    prompt: Number(m.pricing.prompt ?? 0),
    completion: Number(m.pricing.completion ?? 0)
  } : void 0;
  return {
    key: `${p.id}/${m.id}`,
    provider: p.id,
    model: m.id,
    displayName: m.name,
    family: parsed.family,
    versionScore: parsed.versionScore,
    sizeB: parsed.sizeB,
    releasedAt: parsed.releasedAt ?? (m.created ? m.created * 1e3 : void 0),
    contextLength: m.context_length ?? m.top_provider?.context_length,
    maxOutput: m.max_completion_tokens ?? m.top_provider?.max_completion_tokens,
    inputModalities: normModalities(m.architecture?.input_modalities),
    outputModalities: normModalities(m.architecture?.output_modalities),
    created: m.created,
    pricing,
    tags: inferTags(m.id, m.supported_parameters),
    firstSeen: prev?.firstSeen ?? Date.now(),
    lastSeen: Date.now(),
    seenCount: (prev?.seenCount ?? 0) + 1,
    misses: 0,
    verifiedAt: prev?.verifiedAt
  };
}
__name(toEntry, "toEntry");
async function probeModel(p, key, model) {
  const adapter = adapterFor(p.kind);
  const req = {
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 8,
    stream: false
  };
  const built = adapter.build({ provider: p, key, model, req, drops: [] });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), 2e4);
  try {
    const res = await fetch(built.url, { ...built.init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, kind: classify(res.status, text) };
    }
    const data = await res.json();
    const parsed = adapter.parseJson(data, { provider: p, key, model, req, drops: [] });
    const choices = parsed.json?.choices;
    return Array.isArray(choices) && choices.length > 0 ? { ok: true } : { ok: false, kind: "unknown" };
  } catch {
    return { ok: false, kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}
__name(probeModel, "probeModel");
async function syncAll(env, opts = {}) {
  const started = Date.now();
  const cfg = settings(env);
  const all = await loadProviders(env, true);
  const enabled = all.filter((p) => p.enabled);
  const targets = enabled.filter((p) => !opts.only || p.id === opts.only);
  const prev = await loadCatalog(env, true);
  const keepIds = new Set(enabled.map((p) => p.id));
  if (opts.only && !targets.length) {
    return {
      ok: false,
      syncedAt: prev?.syncedAt ?? 0,
      durationMs: Date.now() - started,
      total: prev?.entries.length ?? 0,
      added: 0,
      removed: 0,
      providers: prev?.providers ?? [],
      probed: []
    };
  }
  const fresh = /* @__PURE__ */ new Map();
  for (const e of prev?.entries ?? []) {
    if (keepIds.has(e.provider))
      fresh.set(e.key, { ...e });
  }
  const beforeKeys = new Set(fresh.keys());
  const states = [];
  for (const p of targets) {
    const t0 = Date.now();
    const key = p.keys.find((k) => !k.disabled);
    if (!key) {
      states.push({ id: p.id, ok: false, listed: 0, kept: 0, error: "\u6CA1\u6709\u53EF\u7528 key", syncedAt: Date.now(), latencyMs: 0 });
      continue;
    }
    try {
      const listed = await fetchModels(p, key);
      const seen = /* @__PURE__ */ new Set();
      let kept = 0;
      const denyRes = (p.deny ?? []).map((re) => {
        try {
          return new RegExp(re, "i");
        } catch {
          return null;
        }
      }).filter((r) => r !== null);
      for (const m of listed) {
        if (!isChatModel(m.id))
          continue;
        if (!isFreeModel(m.id, m.pricing, p.freeMode, p.allow))
          continue;
        if (denyRes.some((re) => re.test(m.id)))
          continue;
        const key2 = `${p.id}/${m.id}`;
        fresh.set(key2, toEntry(p, m, fresh.get(key2)));
        seen.add(key2);
        kept += 1;
      }
      for (const [k, e] of [...fresh]) {
        if (e.provider !== p.id || seen.has(k))
          continue;
        const misses = (e.misses ?? 0) + 1;
        if (misses >= 2)
          fresh.delete(k);
        else
          fresh.set(k, { ...e, misses });
      }
      states.push({
        id: p.id,
        ok: true,
        listed: listed.length,
        kept,
        syncedAt: Date.now(),
        latencyMs: Date.now() - t0
      });
    } catch (e) {
      states.push({
        id: p.id,
        ok: false,
        listed: 0,
        kept: [...fresh.values()].filter((x) => x.provider === p.id).length,
        error: truncate(String(e?.message ?? e), 300),
        syncedAt: Date.now(),
        latencyMs: Date.now() - t0
      });
    }
  }
  const statesOut = opts.only ? [
    ...(prev?.providers ?? []).filter(
      (s) => keepIds.has(s.id) && !targets.some((t) => t.id === s.id)
    ),
    ...states
  ] : states;
  await enrichEntries([...fresh.values()]);
  const snapshot = buildCatalog([...fresh.values()], {
    keepPerFamily: cfg.keepPerFamily,
    previous: prev,
    providers: statesOut
  });
  await saveCatalog(env, snapshot);
  const probed = [];
  const probeBudget = opts.probe ? Math.max(cfg.probePerSync, 5) : cfg.probePerSync;
  if (probeBudget > 0) {
    let dirty = false;
    const removeKeys = /* @__PURE__ */ new Set();
    const staleBefore = Date.now() - 7 * 24 * 36e5;
    for (const p of targets) {
      const key = p.keys.find((k) => !k.disabled);
      if (!key)
        continue;
      const all2 = snapshot.entries.filter(
        (e) => e.provider === p.id && (!e.verifiedAt || e.verifiedAt < staleBefore)
      );
      const off = all2.length ? (prev?.version ?? 0) % all2.length : 0;
      const candidates = [...all2.slice(off), ...all2.slice(0, off)].slice(0, probeBudget);
      for (const e of candidates) {
        const r = await probeModel(p, key, e.model);
        probed.push({ model: e.key, ok: r.ok });
        if (r.ok) {
          e.verifiedAt = Date.now();
          dirty = true;
        } else if (r.kind === "model_gone") {
          removeKeys.add(e.key);
          dirty = true;
          await coordFetch(env, "/report", {
            provider: p.id,
            model: e.model,
            keyId: key.id,
            ok: false,
            kind: "model_gone",
            error: "probe: model unavailable"
          }).catch(() => void 0);
        }
      }
    }
    if (removeKeys.size) {
      snapshot.entries = snapshot.entries.filter((e) => !removeKeys.has(e.key));
      snapshot.stats.total = snapshot.entries.length;
    }
    if (dirty)
      await saveCatalog(env, snapshot);
  }
  const afterKeys = new Set(snapshot.entries.map((e) => e.key));
  return {
    ok: states.every((s) => s.ok) || states.length === 0,
    syncedAt: snapshot.syncedAt,
    durationMs: Date.now() - started,
    total: snapshot.entries.length,
    added: [...afterKeys].filter((k) => !beforeKeys.has(k)).length,
    removed: [...beforeKeys].filter((k) => !afterKeys.has(k)).length,
    providers: states,
    probed
  };
}
__name(syncAll, "syncAll");

// src/usage.ts
var USAGE_FLUSH_MAX = 20;
var USAGE_FLUSH_MS = 4e3;
var usageBuffer = [];
var usageFlushTimer = null;
var usageFlushing = null;
async function flushUsageBuffer(env) {
  if (!env.DB || usageBuffer.length === 0)
    return;
  if (usageFlushing)
    return usageFlushing;
  const rows = usageBuffer.splice(0, usageBuffer.length);
  const sql = `INSERT INTO usage
       (id, ts, day, provider, model, key_id, virtual_model, status, ok,
        prompt_tokens, completion_tokens, total_tokens, latency_ms, attempts, error_kind, stream)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  usageFlushing = (async () => {
    try {
      await env.DB.batch(rows.map((v) => env.DB.prepare(sql).bind(...v)));
    } catch (e) {
      console.error("[usage] \u6279\u91CF\u5199\u5165\u5931\u8D25", e);
      usageBuffer = rows.concat(usageBuffer).slice(0, 500);
    } finally {
      usageFlushing = null;
    }
  })();
  return usageFlushing;
}
__name(flushUsageBuffer, "flushUsageBuffer");
async function recordUsage(env, r, ctx) {
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
var EMPTY = {
  requests: 0,
  ok: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  avg_latency: 0
};
async function totals(env, day = localDay()) {
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
async function byProvider(env, day = localDay()) {
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
async function byModel(env, day = localDay(), limit = 50) {
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
async function byKey(env, day = localDay()) {
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
async function dailySeries(env, days = 14) {
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
async function recent(env, limit = 50) {
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
async function cleanup(env, retentionDays = 90) {
  if (!env.DB)
    return;
  try {
    const cutoff = Date.now() - retentionDays * 864e5;
    await env.DB.prepare(`DELETE FROM usage WHERE ts < ?`).bind(cutoff).run();
  } catch (e) {
    console.error("[usage] \u6E05\u7406\u5931\u8D25", e);
  }
}
__name(cleanup, "cleanup");

// src/admin.ts
// Admin auth throttle: failed /admin/api/* auth attempts are counted
// per client IP in the Coordinator (see /auth-* routes there). After
// ADMIN_AUTH_MAX_FAILS consecutive failures the client gets 429 +
// Retry-After for ADMIN_AUTH_LOCKOUT_MS — even with the right token —
// and a successful login clears the counter. If the Coordinator is
// unreachable the throttle fails open; the token check itself still
// applies, so a DO outage never locks the admin out.
function adminClientId(req) {
  const cf = req.headers.get("cf-connecting-ip") ?? "";
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0] ?? "";
  return (cf.trim() || xff.trim() || "unknown").slice(0, 128);
}
__name(adminClientId, "adminClientId");
function adminLockedResponse(st) {
  const retryAfterMs = Math.max(1e3, st?.retryAfterMs ?? 0);
  const retrySec = Math.ceil(retryAfterMs / 1e3);
  return json(
    { error: { message: `管理接口失败次数过多，已临时锁定，请 ${retrySec} 秒后再试`, type: "rate_limited", code: 429, retryAfterMs } },
    { status: 429, headers: { "retry-after": String(retrySec) } }
  );
}
__name(adminLockedResponse, "adminLockedResponse");
async function handleAdmin(req, env, ctx, url) {
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
    if (sub === "sync" && method === "POST") {
      const probe = url.searchParams.get("probe") === "1";
      const only = url.searchParams.get("provider") ?? void 0;
      const report = await syncAll(env, { probe, only });
      invalidateCaches();
      return json(report);
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
      let groups = groupsOf(catalog).filter((g) => g.providers.length >= min);
      if (q) {
        groups = groups.filter(
          (g) => g.id.toLowerCase().includes(q) || g.key.includes(q) || g.aliases.some((a) => a.toLowerCase().includes(q))
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
        strategy: groupStrategy(strategies, g.key)
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
      const key = p.keys.find((k) => !k.disabled);
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
function limitParam(url) {
  const n = Number(url.searchParams.get("limit") ?? 500);
  if (!Number.isFinite(n))
    return 500;
  return Math.min(Math.max(Math.floor(n), 0), 2e3);
}
__name(limitParam, "limitParam");
function nextKeyId(keys) {
  let n = keys.length + 1;
  while (keys.some((k) => k.id === `k${n}`))
    n += 1;
  return `k${n}`;
}
__name(nextKeyId, "nextKeyId");
function buildProvider(body) {
  const id = String(body.id ?? "").trim();
  if (!id)
    throw new Error("\u7F3A\u5C11 provider id");
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
function redactProvider(p) {
  return {
    ...p,
    keys: p.keys.map((k) => ({ id: k.id, label: k.label, masked: maskKey(k.key), dailyLimit: k.dailyLimit, disabled: k.disabled }))
  };
}
__name(redactProvider, "redactProvider");
async function listProviders(env) {
  const list = await loadProviders(env);
  return list.map(redactProvider);
}
__name(listProviders, "listProviders");
async function overview(env) {
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
  const groupList = groupsOf(catalog);
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

// src/router.ts
function hasImage(messages) {
  for (const m of messages ?? []) {
    if (Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url"))
      return true;
  }
  return false;
}
__name(hasImage, "hasImage");
async function invoke(provider, key, model, body, drops, timeoutMs) {
  const adapter = adapterFor(provider.kind);
  const built = adapter.build({ provider, key, model, req: body, drops });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let res;
  try {
    res = await fetch(built.url, { ...built.init, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, text: truncate(String(e?.message ?? e), 300), kind: classifyThrown(e) };
  }
  if (!res.ok) {
    const text = truncate(await res.text().catch(() => ""), 1200);
    clearTimeout(timer);
    const kind = classify(res.status, text);
    return {
      ok: false,
      status: res.status,
      text,
      kind,
      param: kind === "bad_param" ? extractParam(text) : void 0,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? void 0
    };
  }
  if (body.stream) {
    if (!res.body) {
      clearTimeout(timer);
      return { ok: false, status: 502, text: "upstream \u8FD4\u56DE\u7A7A\u54CD\u5E94\u4F53", kind: "server" };
    }
    clearTimeout(timer);
    const sr = adapter.parseStream(res.body, { provider, key, model, req: body, drops });
    let idle;
    const armIdle = /* @__PURE__ */ __name(() => {
      if (idle)
        clearTimeout(idle);
      idle = setTimeout(() => controller.abort("stream idle timeout"), timeoutMs);
    }, "armIdle");
    armIdle();
    const stream = sr.stream.pipeThrough(
      new TransformStream({
        transform(chunk, c) {
          armIdle();
          c.enqueue(chunk);
        },
        flush() {
          if (idle)
            clearTimeout(idle);
        }
      })
    );
    return { ok: true, type: "stream", stream, usage: sr.usage };
  }
  try {
    const data = await res.json();
    clearTimeout(timer);
    const parsed = adapter.parseJson(data, { provider, key, model, req: body, drops });
    const out = parsed.json;
    const choices = out?.choices;
    if (!Array.isArray(choices) || !choices.length) {
      return { ok: false, status: 502, text: "upstream \u8FD4\u56DE\u7A7A choices", kind: "server" };
    }
    return { ok: true, type: "json", json: out, usage: parsed.usage };
  } catch (e) {
    clearTimeout(timer);
    const kind = classifyThrown(e);
    return {
      ok: false,
      status: kind === "content" ? 400 : 502,
      text: `\u89E3\u6790\u4E0A\u6E38\u54CD\u5E94\u5931\u8D25: ${truncate(String(e), 200)}`,
      kind: kind === "content" ? "content" : "server"
    };
  }
}
__name(invoke, "invoke");
function corsHeaders(extra = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(CORS))
    h.set(k, v);
  for (const [k, v] of Object.entries(extra))
    h.set(k, v);
  return h;
}
__name(corsHeaders, "corsHeaders");
async function handleChat(req, env, ctx) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") {
      return openAIError(500, "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN\uFF0C\u8BF7\u5148 wrangler secret put GATEWAY_TOKEN", "configuration_error");
    }
    return openAIError(401, "invalid gateway token", "authentication_error");
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return openAIError(400, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON", "invalid_request_error");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return openAIError(400, "messages \u4E0D\u80FD\u4E3A\u7A7A", "invalid_request_error");
  }
  const cfg = settings(env);
  const requested = String(body.model || cfg.defaultAlias).trim();
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const [catalog, providers] = await Promise.all([loadCatalog(env), loadProviders(env)]);
  if (!catalog || !catalog.entries.length) {
    return openAIError(503, "\u6A21\u578B\u76EE\u5F55\u4E3A\u7A7A\uFF0C\u8BF7\u5148\u6267\u884C POST /admin/api/sync \u540C\u6B65\u6A21\u578B\u5217\u8868", "gateway_unavailable");
  }
  const enabled = providers.filter((p) => p.enabled && p.keys.some((k) => !k.disabled));
  const byId = new Map(enabled.map((p) => [p.id, p]));
  const resolved = resolveCandidates(catalog.entries, requested, {
    needsTools: Array.isArray(body.tools) && body.tools.length > 0,
    needsVision: hasImage(body.messages),
    groups: cfg.grouping ? groupsOf(catalog) : void 0,
    allowed: new Set(byId.keys()),
    knownProviders: new Set(providers.map((p) => p.id.toLowerCase()))
  });
  if (!resolved.candidates.length) {
    return openAIError(
      404,
      resolved.note ?? `\u6CA1\u6709\u53EF\u7528\u6A21\u578B\u5339\u914D "${requested}"\uFF08\u53EF\u80FD\u662F\u989D\u5EA6\u8017\u5C3D\u6216\u6A21\u578B\u5DF2\u4E0B\u7EBF\uFF09`,
      "model_not_found",
      { available_virtual_models: VIRTUAL_MODELS.map((v) => v.id) }
    );
  }
  const groupStrategies = await loadGroupStrategies(env);
  const strategy = groupStrategy(groupStrategies, resolved.group?.key);
  let order;
  try {
    order = await coordFetch(env, "/order", {
      strategy,
      candidates: resolved.candidates.map((c) => ({
        provider: c.provider,
        model: c.model,
        weight: c.weight
      })),
      providers: enabled.map((p) => ({
        id: p.id,
        weight: p.weight,
        keys: p.keys.filter((k) => !k.disabled).map((k) => ({
          id: k.id,
          dailyLimit: k.dailyLimit ?? p.dailyLimitDefault ?? 0,
          rpm: k.rpm ?? p.rpmDefault ?? 0
        }))
      })),
      limit: cfg.maxAttempts
    });
  } catch (e) {
    return openAIError(503, `\u8C03\u5EA6\u5668\u4E0D\u53EF\u7528: ${truncate(String(e), 200)}`, "gateway_unavailable");
  }
  if (!order.picks.length) {
    return openAIError(
      503,
      "\u6240\u6709\u5019\u9009\u6A21\u578B / Key \u5F53\u524D\u90FD\u4E0D\u53EF\u7528\uFF08\u989D\u5EA6\u8017\u5C3D\u6216\u5904\u4E8E\u51B7\u5374\u671F\uFF09",
      "no_capacity",
      {
        candidates: resolved.candidates.slice(0, 10).map((c) => `${c.provider}/${c.model}`),
        hint: "\u53EF\u4EE5\u7B49 UTC \u6B21\u65E5\u989D\u5EA6\u91CD\u7F6E\uFF0C\u6216\u901A\u8FC7 POST /admin/api/reset \u6E05\u7A7A\u5065\u5EB7\u72B6\u6001"
      }
    );
  }
  const deadModels = /* @__PURE__ */ new Set();
  const localDrops = new Map(
    Object.entries(order.drops).map(([k, v]) => [k, [...v]])
  );
  let attempts = 0;
  let last = null;
  for (const pick of order.picks) {
    if (attempts >= cfg.maxAttempts)
      break;
    const provider = byId.get(pick.provider);
    if (!provider)
      continue;
    const key = provider.keys.find((k) => k.id === pick.keyId && !k.disabled);
    if (!key)
      continue;
    const mkey = `${pick.provider}/${pick.model}`;
    if (deadModels.has(mkey))
      continue;
    const t0 = Date.now();
    let result;
    let tries = 0;
    for (; ; ) {
      tries += 1;
      result = await invoke(
        provider,
        key,
        pick.model,
        body,
        localDrops.get(pick.provider) ?? [],
        cfg.timeoutMs
      );
      if (result.ok)
        break;
      const concurrencyLimited = result.kind === "rate_limit" && /concurren/i.test(result.text);
      if (!concurrencyLimited || tries >= 3)
        break;
      await sleep(1500 * tries);
    }
    attempts += tries;
    const latency = Date.now() - t0;
    if (result.ok) {
      if (result.type === "stream") {
        ctx.waitUntil(
          withTimeout(result.usage, 15 * 6e4, null).then(async (u) => {
            const fullLatency = Date.now() - t0;
            await coordFetch(env, "/report", {
              provider: pick.provider,
              model: pick.model,
              keyId: key.id,
              ok: true,
              status: 200,
              latencyMs: fullLatency,
              day: order.day
            }).catch(() => void 0);
            await recordUsage(env, {
              provider: pick.provider,
              model: pick.model,
              keyId: key.id,
              virtualModel: requested,
              status: 200,
              ok: true,
              usage: u,
              latencyMs: fullLatency,
              attempts,
              stream: true
            }, ctx);
          }).catch(() => void 0)
        );
        const headers = corsHeaders({
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId,
          ...resolved.group ? { "x-gw-group": resolved.group.id, "x-gw-strategy": strategy } : {}
        });
        return new Response(result.stream, { status: 200, headers });
      }
      const out = { ...result.json };
      if (typeof out === "object" && out !== null)
        out.model = requested;
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: true,
          status: 200,
          latencyMs: latency,
          day: order.day
        }).catch(() => void 0)
      );
      ctx.waitUntil(
        recordUsage(env, {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          virtualModel: requested,
          status: 200,
          ok: true,
          usage: result.usage,
          latencyMs: latency,
          attempts,
          stream: false
        }, ctx)
      );
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: corsHeaders({
          "content-type": "application/json; charset=utf-8",
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId,
          ...resolved.group ? { "x-gw-group": resolved.group.id, "x-gw-strategy": strategy } : {}
        })
      });
    }
    if (result.kind === "model_gone")
      deadModels.add(mkey);
    last = { status: result.status, message: result.text, kind: result.kind };
    ctx.waitUntil(
      coordFetch(env, "/report", {
        provider: pick.provider,
        model: pick.model,
        keyId: key.id,
        ok: false,
        status: result.status,
        kind: result.kind,
        latencyMs: latency,
        retryAfterMs: result.retryAfterMs,
        error: result.text,
        param: result.param,
        day: order.day
      }).catch(() => void 0)
    );
    if (result.kind === "bad_param") {
      if (result.param) {
        const arr = localDrops.get(pick.provider) ?? [];
        if (!arr.includes(result.param))
          arr.push(result.param);
        localDrops.set(pick.provider, arr);
      } else {
        ctx.waitUntil(
          recordUsage(env, {
            provider: pick.provider,
            model: pick.model,
            keyId: key.id,
            virtualModel: requested,
            status: result.status || 400,
            ok: false,
            usage: null,
            latencyMs: Date.now() - startedAt,
            attempts,
            errorKind: "bad_param",
            stream: Boolean(body.stream)
          }, ctx)
        );
        return openAIError(
          result.status >= 400 && result.status < 500 ? result.status : 400,
          truncate(result.text, 500),
          "invalid_request_error",
          { request_id: requestId }
        );
      }
    }
    if (result.kind === "content") {
      return openAIError(400, truncate(result.text, 500), "content_filter", { request_id: requestId });
    }
  }
  const finalStatus = last && (last.status === 400 || last.status === 422) ? last.status : 503;
  ctx.waitUntil(
    recordUsage(env, {
      provider: "gateway",
      model: requested,
      keyId: "-",
      virtualModel: requested,
      status: finalStatus,
      ok: false,
      usage: null,
      latencyMs: Date.now() - startedAt,
      attempts,
      errorKind: last?.kind ?? "no_capacity",
      stream: Boolean(body.stream)
    }, ctx)
  );
  return openAIError(
    finalStatus,
    `\u6240\u6709\u5019\u9009\u90FD\u5931\u8D25\u4E86\uFF08\u5C1D\u8BD5 ${attempts} \u6B21\uFF09\u3002\u6700\u540E\u4E00\u6B21: ${truncate(last?.message ?? "\u672A\u77E5\u9519\u8BEF", 300)}`,
    finalStatus === 503 ? "upstream_unavailable" : "invalid_request_error",
    { attempts, last_error: last, request_id: requestId }
  );
}
__name(handleChat, "handleChat");
function capabilityFields(x) {
  const inputs = x.inputModalities ?? ["text"];
  const outputs = x.outputModalities ?? ["text"];
  const out = {
    architecture: {
      modality: inputs.join("+") + "->" + outputs.join("+"),
      input_modalities: inputs,
      output_modalities: outputs
    },
    input_modalities: inputs,
    output_modalities: outputs
  };
  if (x.contextLength || x.maxOutput) {
    out.top_provider = {
      context_length: x.contextLength,
      max_completion_tokens: x.maxOutput
    };
  }
  return out;
}
__name(capabilityFields, "capabilityFields");
async function handleModels(env, url) {
  const cfg = settings(env);
  const catalog = await loadCatalog(env);
  const providers = await loadProviders(env);
  const allowed = new Set(
    providers.filter((p) => p.enabled && p.keys.some((k) => !k.disabled)).map((p) => p.id)
  );
  let dead = /* @__PURE__ */ new Set();
  try {
    const d = await coordFetch(env, "/dead");
    dead = new Set(d.dead ?? []);
  } catch {
  }
  const entries = (catalog?.entries ?? []).filter(
    (e) => allowed.has(e.provider) && !dead.has(e.key)
  );
  const mode = (url?.searchParams.get("group") ?? "").toLowerCase();
  const grouped = mode === "off" ? false : mode === "on" ? true : cfg.grouping;
  const verbose = url?.searchParams.get("verbose") === "1";
  const data = VIRTUAL_MODELS.map((v) => ({
    id: v.id,
    object: "model",
    created: 0,
    owned_by: "gateway",
    description: v.description
  }));
  const seen = new Set(data.map((d) => d.id));
  if (grouped) {
    for (const g of groupsOf(catalog)) {
      if (data.length >= 800)
        break;
      if (!g.endpoints.some((e) => allowed.has(e.provider) && !dead.has(e.key)))
        continue;
      if (seen.has(g.id))
        continue;
      seen.add(g.id);
      const row = {
        id: g.id,
        object: "model",
        created: g.created,
        owned_by: g.providers.length > 1 ? "gateway" : g.providers[0],
        context_length: g.contextLength,
        max_output_tokens: g.maxOutput,
        ...capabilityFields(g),
        providers: g.providers,
        endpoints: g.endpoints.length,
        family: g.family,
        tags: g.tags
      };
      if (verbose)
        row.aliases = g.aliases;
      data.push(row);
    }
    return json({ object: "list", data });
  }
  const counts = /* @__PURE__ */ new Map();
  for (const e of entries)
    counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
  for (const e of entries) {
    if (data.length >= 800)
      break;
    if (seen.has(e.key))
      continue;
    seen.add(e.key);
    data.push({
      id: e.key,
      object: "model",
      created: e.created ?? 0,
      owned_by: e.provider,
      context_length: e.contextLength,
      max_output_tokens: e.maxOutput,
      ...capabilityFields(e),
      family: e.family,
      tags: e.tags
    });
    if ((counts.get(e.model) ?? 0) === 1 && !seen.has(e.model)) {
      seen.add(e.model);
      data.push({
        id: e.model,
        object: "model",
        created: e.created ?? 0,
        owned_by: e.provider,
        context_length: e.contextLength,
        max_output_tokens: e.maxOutput,
        ...capabilityFields(e)
      });
    }
  }
  return json({ object: "list", data });
}
__name(handleModels, "handleModels");

// src/anthropic-in.ts
function anthropicError(status, type, message) {
  return json({ type: "error", error: { type, message } }, { status });
}
__name(anthropicError, "anthropicError");
function errorTypeFor(status, innerType) {
  if (status === 401)
    return "authentication_error";
  if (status === 404 || innerType === "model_not_found")
    return "not_found_error";
  if (status === 429 || innerType === "no_capacity")
    return "rate_limit_error";
  if (status === 400)
    return "invalid_request_error";
  if (status >= 500)
    return "api_error";
  return "api_error";
}
__name(errorTypeFor, "errorTypeFor");
function stopReasonFor(finish) {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}
__name(stopReasonFor, "stopReasonFor");
function textOfBlocks(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.filter((b) => !!b && typeof b === "object" && b.type === "text").map((b) => String(b.text ?? "")).join("");
}
__name(textOfBlocks, "textOfBlocks");
function anthropicToOpenAI(body) {
  const messages = [];
  const sysText = textOfBlocks(body.system);
  if (sysText)
    messages.push({ role: "system", content: sysText });
  for (const m of body.messages ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content))
      continue;
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const b of content) {
      if (!b || typeof b !== "object")
        continue;
      switch (b.type) {
        case "text":
          parts.push({ type: "text", text: String(b.text ?? "") });
          break;
        case "image": {
          const src = b.source ?? {};
          if (src.type === "base64") {
            parts.push({
              type: "image_url",
              image_url: { url: "data:" + String(src.media_type ?? "image/png") + ";base64," + String(src.data ?? "") }
            });
          } else if (src.type === "url") {
            parts.push({ type: "image_url", image_url: { url: String(src.url ?? "") } });
          }
          break;
        }
        case "tool_use":
          toolCalls.push({
            id: String(b.id ?? ""),
            type: "function",
            function: {
              name: String(b.name ?? ""),
              arguments: JSON.stringify(b.input ?? {})
            }
          });
          break;
        case "tool_result":
          toolResults.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id ?? ""),
            content: textOfBlocks(b.content) || (typeof b.content === "string" ? b.content : "")
          });
          break;
      }
    }
    messages.push(...toolResults);
    if (parts.length || toolCalls.length) {
      const msg = { role, content: parts.length ? parts : "" };
      if (toolCalls.length)
        msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }
  const out = {
    model: String(body.model ?? ""),
    messages,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1024,
    stream: body.stream === true
  };
  if (typeof body.temperature === "number")
    out.temperature = body.temperature;
  if (typeof body.top_p === "number")
    out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences))
    out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: String(t.name ?? ""),
        description: String(t.description ?? ""),
        parameters: t.input_schema ?? { type: "object", properties: {} }
      }
    }));
  }
  const tc = body.tool_choice;
  if (tc && typeof tc === "object") {
    if (tc.type === "auto")
      out.tool_choice = "auto";
    else if (tc.type === "any")
      out.tool_choice = "required";
    else if (tc.type === "tool" && tc.name) {
      out.tool_choice = { type: "function", function: { name: String(tc.name) } };
    }
  }
  return out;
}
__name(anthropicToOpenAI, "anthropicToOpenAI");
function openAIToAnthropic(data, requestedModel) {
  const choice = (data.choices ?? [])[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  for (const call of msg.tool_calls ?? []) {
    const fn = call.function ?? {};
    let input = {};
    try {
      input = JSON.parse(String(fn.arguments ?? "{}"));
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: String(call.id ?? ""), name: String(fn.name ?? ""), input });
  }
  if (!content.length)
    content.push({ type: "text", text: "" });
  const usage = data.usage ?? {};
  return {
    id: "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReasonFor(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0)
    }
  };
}
__name(openAIToAnthropic, "openAIToAnthropic");
function openAIStreamToAnthropic(body, requestedModel) {
  const reader = parseSSE(body).getReader();
  const enc = new TextEncoder();
  const msgId = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  let started = false;
  let finished = false;
  let nextIdx = 0;
  let openBlock = null;
  const closedBlocks = /* @__PURE__ */ new Set();
  let textIdx = null;
  const toolIdx = /* @__PURE__ */ new Map();
  let stopReason = "end_turn";
  let inTokens = 0;
  let outTokens = 0;
  const ev = /* @__PURE__ */ __name((event, data) => `event: ${event}
data: ${JSON.stringify(data)}

`, "ev");
  function startBlock(idx, block, out) {
    if (openBlock !== null && openBlock !== idx) {
      out.push(ev("content_block_stop", { type: "content_block_stop", index: openBlock }));
      closedBlocks.add(openBlock);
    }
    openBlock = idx;
    out.push(ev("content_block_start", { type: "content_block_start", index: idx, content_block: block }));
  }
  __name(startBlock, "startBlock");
  function handleChunk(chunk, out) {
    if (!started) {
      started = true;
      out.push(ev("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }));
    }
    const usage = chunk.usage;
    if (usage) {
      inTokens = Number(usage.prompt_tokens ?? inTokens);
      outTokens = Number(usage.completion_tokens ?? outTokens);
    }
    const choice = (chunk.choices ?? [])[0];
    if (!choice)
      return;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      stopReason = stopReasonFor(choice.finish_reason);
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (textIdx === null || openBlock !== textIdx) {
        textIdx = nextIdx++;
        startBlock(textIdx, { type: "text", text: "" }, out);
      }
      out.push(ev("content_block_delta", {
        type: "content_block_delta",
        index: textIdx,
        delta: { type: "text_delta", text: delta.content }
      }));
    }
    for (const call of delta.tool_calls ?? []) {
      const ti = Number(call.index ?? 0);
      let bi = toolIdx.get(ti);
      const fn = call.function ?? {};
      if (bi === void 0 || closedBlocks.has(bi)) {
        bi = nextIdx++;
        toolIdx.set(ti, bi);
        startBlock(bi, {
          type: "tool_use",
          id: String(call.id ?? "toolu_" + ti),
          name: String(fn.name ?? ""),
          input: {}
        }, out);
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        out.push(ev("content_block_delta", {
          type: "content_block_delta",
          index: bi,
          delta: { type: "input_json_delta", partial_json: fn.arguments }
        }));
      }
    }
  }
  __name(handleChunk, "handleChunk");
  function finalize(out) {
    if (finished)
      return;
    finished = true;
    if (!started) {
      started = true;
      out.push(ev("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }));
    }
    if (openBlock !== null) {
      out.push(ev("content_block_stop", { type: "content_block_stop", index: openBlock }));
      openBlock = null;
    }
    if (nextIdx === 0) {
      out.push(ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }));
      out.push(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
    }
    out.push(ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inTokens, output_tokens: outTokens }
    }));
    out.push(ev("message_stop", { type: "message_stop" }));
  }
  __name(finalize, "finalize");
  return new ReadableStream({
    async pull(controller) {
      const out = [];
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) {
            finalize(out);
            for (const s of out)
              controller.enqueue(enc.encode(s));
            controller.close();
            return;
          }
          if (!value || value.data === "[DONE]") {
            if (value?.data === "[DONE]")
              continue;
            continue;
          }
          let chunk;
          try {
            chunk = JSON.parse(value.data);
          } catch {
            continue;
          }
          handleChunk(chunk, out);
          if (out.length) {
            for (const s of out)
              controller.enqueue(enc.encode(s));
            return;
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      reader.cancel().catch(() => void 0);
    }
  });
}
__name(openAIStreamToAnthropic, "openAIStreamToAnthropic");
function estimateTextTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 11904 && cp <= 40959 || // 中日韩表意 + 假名
    cp >= 40960 && cp <= 45055 || // 彝/谚文等
    cp >= 63744 && cp <= 64255 || // 兼容表意
    cp >= 131072 && cp <= 195103) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 4);
}
__name(estimateTextTokens, "estimateTextTokens");
async function handleCountTokens(req, env) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    return anthropicError(
      auth.reason === "unconfigured" ? 500 : 401,
      "authentication_error",
      auth.reason === "unconfigured" ? "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN" : "invalid gateway token"
    );
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return anthropicError(400, "invalid_request_error", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return anthropicError(400, "invalid_request_error", "messages \u4E0D\u80FD\u4E3A\u7A7A");
  }
  if (!String(body.model ?? "")) {
    return anthropicError(400, "invalid_request_error", "model \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const oai = anthropicToOpenAI(body);
  let total = 0;
  for (const m of oai.messages ?? []) {
    total += 4;
    const content = m.content;
    if (typeof content === "string") {
      total += estimateTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (p?.type === "text")
          total += estimateTextTokens(String(p.text ?? ""));
        else if (p?.type === "image_url")
          total += 1024;
        else
          total += estimateTextTokens(JSON.stringify(p ?? {}));
      }
    }
    if (Array.isArray(m.tool_calls)) {
      total += estimateTextTokens(JSON.stringify(m.tool_calls));
    }
  }
  if (Array.isArray(oai.tools) && oai.tools.length) {
    total += estimateTextTokens(JSON.stringify(oai.tools)) + 8 * oai.tools.length;
  }
  return json({ input_tokens: Math.max(1, total) });
}
__name(handleCountTokens, "handleCountTokens");
async function handleMessages(req, env, ctx) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    return anthropicError(
      auth.reason === "unconfigured" ? 500 : 401,
      "authentication_error",
      auth.reason === "unconfigured" ? "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN" : "invalid gateway token"
    );
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return anthropicError(400, "invalid_request_error", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return anthropicError(400, "invalid_request_error", "messages \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const requestedModel = String(body.model ?? "");
  if (!requestedModel) {
    return anthropicError(400, "invalid_request_error", "model \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const oai = anthropicToOpenAI(body);
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const token = extractToken(req);
  if (token)
    headers.set("authorization", "Bearer " + token);
  const inner = new Request("https://gateway.internal/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(oai)
  });
  const res = await handleChat(inner, env, ctx);
  if (res.status !== 200) {
    let message = `\u4E0A\u6E38\u9519\u8BEF (${res.status})`;
    let innerType;
    try {
      const ej = await res.json();
      const err = ej.error ?? {};
      if (err.message)
        message = String(err.message);
      if (err.type)
        innerType = String(err.type);
    } catch {
    }
    return anthropicError(res.status, errorTypeFor(res.status, innerType), message);
  }
  const gwHeaders = { ...CORS };
  for (const h of ["x-gw-provider", "x-gw-model", "x-gw-attempts", "x-gw-request-id"]) {
    const v = res.headers.get(h);
    if (v)
      gwHeaders[h] = v;
  }
  if (oai.stream) {
    if (!res.body)
      return anthropicError(502, "api_error", "\u4E0A\u6E38\u8FD4\u56DE\u7A7A\u54CD\u5E94\u4F53");
    return new Response(openAIStreamToAnthropic(res.body, requestedModel), {
      status: 200,
      headers: { ...gwHeaders, "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return anthropicError(502, "api_error", "\u4E0A\u6E38\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94");
  }
  return json(openAIToAnthropic(data, requestedModel), { headers: gwHeaders });
}
__name(handleMessages, "handleMessages");

// src/gemini-in.ts
function geminiError(status, statusText, message) {
  return json({ error: { code: status, message, status: statusText } }, { status });
}
__name(geminiError, "geminiError");
function statusTextFor(status) {
  if (status === 400)
    return "INVALID_ARGUMENT";
  if (status === 401)
    return "UNAUTHENTICATED";
  if (status === 404)
    return "NOT_FOUND";
  if (status === 429 || status === 503)
    return "RESOURCE_EXHAUSTED";
  return "INTERNAL";
}
__name(statusTextFor, "statusTextFor");
async function geminiAuth(req, env, url) {
  const base = await checkGatewayToken(req, env);
  if (base.ok)
    return base;
  const key = url.searchParams.get("key");
  if (key) {
    const headers = new Headers(req.headers);
    headers.set("x-goog-api-key", key);
    const cloned = new Request(req.url, { headers });
    return checkGatewayToken(cloned, env);
  }
  return base;
}
__name(geminiAuth, "geminiAuth");
function finishReasonFor(finish) {
  switch (finish) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return "STOP";
  }
}
__name(finishReasonFor, "finishReasonFor");
function partsToOpenAI(parts, role, out, toolCalls) {
  if (!Array.isArray(parts))
    return;
  for (const p of parts) {
    if (!p || typeof p !== "object")
      continue;
    if (typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
    } else if (p.inlineData && typeof p.inlineData === "object") {
      const d = p.inlineData;
      out.push({
        type: "image_url",
        image_url: { url: "data:" + String(d.mimeType ?? "image/png") + ";base64," + String(d.data ?? "") }
      });
    } else if (p.fileData && typeof p.fileData === "object") {
      const d = p.fileData;
      if (d.fileUri)
        out.push({ type: "image_url", image_url: { url: String(d.fileUri) } });
    } else if (p.functionCall && typeof p.functionCall === "object" && role === "assistant") {
      const fc = p.functionCall;
      toolCalls.push({
        id: "call_" + String(fc.name ?? "fn"),
        type: "function",
        function: { name: String(fc.name ?? ""), arguments: JSON.stringify(fc.args ?? {}) }
      });
    }
  }
}
__name(partsToOpenAI, "partsToOpenAI");
function geminiToOpenAI(body, model) {
  const messages = [];
  const sysParts = [];
  const si = body.systemInstruction;
  if (si)
    partsToOpenAI(si.parts, "user", sysParts, []);
  const sysText = sysParts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("");
  if (sysText)
    messages.push({ role: "system", content: sysText });
  for (const c of body.contents ?? []) {
    const role = c.role === "model" ? "assistant" : "user";
    const parts = [];
    const toolCalls = [];
    const toolMsgs = [];
    if (Array.isArray(c.parts)) {
      for (const p of c.parts) {
        if (p?.functionResponse && typeof p.functionResponse === "object") {
          const fr = p.functionResponse;
          const resp = fr.response;
          toolMsgs.push({
            role: "tool",
            tool_call_id: "call_" + String(fr.name ?? "fn"),
            content: typeof resp === "string" ? resp : JSON.stringify(resp ?? {})
          });
        }
      }
    }
    partsToOpenAI(c.parts, role, parts, toolCalls);
    messages.push(...toolMsgs);
    if (parts.length || toolCalls.length) {
      const msg = { role, content: parts.length ? parts : "" };
      if (toolCalls.length)
        msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }
  const out = { model, messages, stream: false };
  const gc = body.generationConfig ?? {};
  if (typeof gc.maxOutputTokens === "number")
    out.max_tokens = gc.maxOutputTokens;
  if (typeof gc.temperature === "number")
    out.temperature = gc.temperature;
  if (typeof gc.topP === "number")
    out.top_p = gc.topP;
  if (Array.isArray(gc.stopSequences))
    out.stop = gc.stopSequences;
  const tools = [];
  for (const t of body.tools ?? []) {
    for (const fd of t?.functionDeclarations ?? []) {
      tools.push({
        type: "function",
        function: {
          name: String(fd.name ?? ""),
          description: String(fd.description ?? ""),
          parameters: fd.parameters ?? { type: "object", properties: {} }
        }
      });
    }
  }
  if (tools.length)
    out.tools = tools;
  const tc = body.toolConfig?.functionCallingConfig;
  if (tc) {
    if (tc.mode === "NONE")
      out.tool_choice = "none";
    else if (tc.mode === "ANY") {
      const allowed = tc.allowedFunctionNames ?? [];
      out.tool_choice = allowed.length === 1 ? { type: "function", function: { name: allowed[0] } } : "required";
    }
  }
  return out;
}
__name(geminiToOpenAI, "geminiToOpenAI");
function partsFromMessage(msg) {
  const parts = [];
  if (typeof msg.content === "string" && msg.content)
    parts.push({ text: msg.content });
  if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p?.type === "text" && typeof p.text === "string")
        parts.push({ text: p.text });
    }
  }
  for (const call of msg.tool_calls ?? []) {
    const fn = call.function ?? {};
    let args = {};
    try {
      args = JSON.parse(String(fn.arguments ?? "{}"));
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: String(fn.name ?? ""), args } });
  }
  return parts;
}
__name(partsFromMessage, "partsFromMessage");
function usageMeta(usage) {
  const u = usage ?? {};
  const prompt = Number(u.prompt_tokens ?? 0);
  const cand = Number(u.completion_tokens ?? 0);
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: cand,
    totalTokenCount: Number(u.total_tokens ?? prompt + cand)
  };
}
__name(usageMeta, "usageMeta");
function openAIToGemini(data, model) {
  const choice = (data.choices ?? [])[0] ?? {};
  const parts = partsFromMessage(choice.message ?? {});
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: finishReasonFor(choice.finish_reason),
        index: 0
      }
    ],
    usageMetadata: usageMeta(data.usage),
    modelVersion: model
  };
}
__name(openAIToGemini, "openAIToGemini");
async function* geminiChunks(body, model) {
  const reader = parseSSE(body).getReader();
  let usage;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done)
      return;
    if (!value || value.data === "[DONE]")
      continue;
    let chunk;
    try {
      chunk = JSON.parse(value.data);
    } catch {
      continue;
    }
    if (chunk.usage)
      usage = chunk.usage;
    const choice = (chunk.choices ?? [])[0];
    if (!choice)
      continue;
    const delta = choice.delta ?? {};
    const parts = partsFromMessage({ content: delta.content, tool_calls: delta.tool_calls });
    const isLast = typeof choice.finish_reason === "string" && !!choice.finish_reason;
    if (!parts.length && !isLast)
      continue;
    const out = {
      candidates: [
        {
          content: { role: "model", parts },
          index: 0,
          ...isLast ? { finishReason: finishReasonFor(choice.finish_reason) } : {}
        }
      ],
      modelVersion: model
    };
    if (isLast && usage)
      out.usageMetadata = usageMeta(usage);
    yield out;
  }
}
__name(geminiChunks, "geminiChunks");
async function handleGeminiModels(req, env, url) {
  const auth = await geminiAuth(req, env, url);
  if (!auth.ok)
    return geminiError(401, "UNAUTHENTICATED", "invalid gateway token");
  const catalog = await loadCatalog(env);
  if (!catalog)
    return json({ models: [] });
  const cfg = settings(env);
  const groups = cfg.grouping ? groupsOf(catalog) : [];
  const models = groups.length ? groups.map((g) => ({
    name: "models/" + g.id,
    displayName: g.id,
    ...g.contextLength ? { inputTokenLimit: g.contextLength } : {},
    ...g.maxOutput ? { outputTokenLimit: g.maxOutput } : {},
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
  })) : [...new Set(catalog.entries.map((e) => e.model))].map((id) => ({
    name: "models/" + id,
    displayName: id,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
  }));
  return json({ models });
}
__name(handleGeminiModels, "handleGeminiModels");
async function handleGemini(req, env, ctx, pathname, url) {
  const rest = decodeURIComponent(pathname.slice("/v1beta/models/".length));
  let stream = false;
  let model = rest;
  if (rest.endsWith(":streamGenerateContent")) {
    stream = true;
    model = rest.slice(0, -":streamGenerateContent".length);
  } else if (rest.endsWith(":generateContent")) {
    model = rest.slice(0, -":generateContent".length);
  } else {
    return geminiError(404, "NOT_FOUND", `\u672A\u77E5\u52A8\u4F5C: ${rest}`);
  }
  if (!model)
    return geminiError(400, "INVALID_ARGUMENT", "model \u4E0D\u80FD\u4E3A\u7A7A");
  const auth = await geminiAuth(req, env, url);
  if (!auth.ok)
    return geminiError(401, "UNAUTHENTICATED", "invalid gateway token");
  let body;
  try {
    body = await req.json();
  } catch {
    return geminiError(400, "INVALID_ARGUMENT", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  const oai = geminiToOpenAI(body, model);
  oai.stream = stream;
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const token = extractToken(req) || url.searchParams.get("key") || "";
  if (token)
    headers.set("authorization", "Bearer " + token);
  const inner = new Request("https://gateway.internal/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(oai)
  });
  const res = await handleChat(inner, env, ctx);
  if (res.status !== 200) {
    let message = `\u4E0A\u6E38\u9519\u8BEF (${res.status})`;
    try {
      const ej = await res.json();
      const err = ej.error ?? {};
      if (err.message)
        message = String(err.message);
    } catch {
    }
    return geminiError(res.status, statusTextFor(res.status), message);
  }
  if (!stream) {
    let data;
    try {
      data = await res.json();
    } catch {
      return geminiError(502, "INTERNAL", "\u4E0A\u6E38\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94");
    }
    return json(openAIToGemini(data, model));
  }
  if (!res.body)
    return geminiError(502, "INTERNAL", "\u4E0A\u6E38\u8FD4\u56DE\u7A7A\u54CD\u5E94\u4F53");
  if (url.searchParams.get("alt") === "sse") {
    const enc = new TextEncoder();
    const sse = new ReadableStream({
      async start(controller) {
        try {
          for await (const c of geminiChunks(res.body, model)) {
            controller.enqueue(enc.encode("data: " + JSON.stringify(c) + "\n\n"));
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      }
    });
    return new Response(sse, {
      status: 200,
      headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }
  const chunks = [];
  for await (const c of geminiChunks(res.body, model))
    chunks.push(JSON.stringify(c));
  return new Response("[" + chunks.join(",") + "]", {
    status: 200,
    headers: { ...CORS, "content-type": "application/json" }
  });
}
__name(handleGemini, "handleGemini");

// src/coordinator.ts
var DAY_MS = 864e5;
function defaultKeyState(day, dayLimit = 0, rpm = 0) {
  return {
    cooldownUntil: 0,
    day,
    dayCount: 0,
    dayLimit,
    rpm,
    invalid: false,
    fails: 0,
    transientFails: 0,
    breakerUntil: 0,
    lastUsed: 0
  };
}
// Failure kinds that mean "this upstream endpoint is unhealthy" (as
// opposed to a problem with the request or the account). Only these
// count towards the circuit breaker.
var TRANSIENT_KINDS = ["server", "network", "timeout", "unknown"];
__name(defaultKeyState, "defaultKeyState");
var Coordinator = class {
  state;
  env;
  keys = /* @__PURE__ */ new Map();
  models = /* @__PURE__ */ new Map();
  authClients = /* @__PURE__ */ new Map();
  drops = /* @__PURE__ */ new Map();
  rpmWindow = /* @__PURE__ */ new Map();
  dirty = /* @__PURE__ */ new Set();
  loaded = false;
  alarmChecked = false;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    state.blockConcurrencyWhile(async () => {
      await this.ensureLoaded();
    });
  }
  async ensureLoaded() {
    if (this.loaded)
      return;
    const entries = await this.state.storage.list({ limit: 2e4 });
    for (const [k, v] of entries) {
      if (k.startsWith("k:"))
        this.keys.set(k.slice(2), v);
      else if (k.startsWith("m:"))
        this.models.set(k.slice(2), v);
      else if (k.startsWith("a:"))
        this.authClients.set(k.slice(2), v);
      else if (k.startsWith("d:"))
        this.drops.set(k.slice(2), new Set(v));
    }
    this.loaded = true;
  }
  async fetch(request) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/order":
          return this.json(await this.order(await request.json()));
        case "/report":
          await this.report(await request.json());
          return this.json({ ok: true });
        case "/stats":
          return this.json(this.stats());
        case "/dead":
          return this.json({ dead: this.deadKeys() });
        case "/reset":
          await this.reset();
          return this.json({ ok: true });
        case "/auth-check":
          return this.json(await this.authCheck(await request.json()));
        case "/auth-fail":
          return this.json(await this.authFail(await request.json()));
        case "/auth-ok":
          return this.json(await this.authOk(await request.json()));
        default:
          return this.json({ error: "unknown route" }, 404);
      }
    } catch (e) {
      console.error("[coordinator]", e);
      return this.json({ error: String(e) }, 500);
    }
  }
  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" }
    });
  }
  // ------------------------------ 配置 -----------------------------------
  breakerCfg() {
    const t = Math.floor(Number(this.env.BREAKER_THRESHOLD));
    const c = Math.floor(Number(this.env.BREAKER_COOLDOWN_MS));
    return {
      threshold: Number.isFinite(t) ? Math.min(20, Math.max(2, t)) : 3,
      cooldownMs: Number.isFinite(c) ? Math.min(36e5, Math.max(1e3, c)) : 3e5
    };
  }
  authCfg() {
    const m = Math.floor(Number(this.env.ADMIN_AUTH_MAX_FAILS));
    const l = Math.floor(Number(this.env.ADMIN_AUTH_LOCKOUT_MS));
    return {
      maxFails: Number.isFinite(m) ? Math.min(100, Math.max(3, m)) : 10,
      lockoutMs: Number.isFinite(l) ? Math.min(864e5, Math.max(1e3, l)) : 9e5
    };
  }
  // --------------------- 管理接口鉴权限速 ---------------------
  // Per-client-IP state, persisted in DO storage ("a:" prefix). A
  // successful admin login clears the counter; reaching maxFails
  // consecutive failures locks the client out for lockoutMs. An
  // expired lock resets the counter lazily on the next check.
  authStateFor(client, now) {
    let st = this.authClients.get(client);
    if (!st) {
      st = { fails: 0, lockedUntil: 0, lastFailAt: 0 };
      this.authClients.set(client, st);
    }
    if (st.lockedUntil && st.lockedUntil <= now) {
      st.fails = 0;
      st.lockedUntil = 0;
      this.dirty.add(`a:${client}`);
    }
    return st;
  }
  authView(st, now) {
    const locked = (st.lockedUntil ?? 0) > now;
    return {
      locked,
      fails: st.fails ?? 0,
      retryAfterMs: locked ? st.lockedUntil - now : 0
    };
  }
  async authCheck(body) {
    await this.ensureLoaded();
    const now = Date.now();
    const st = this.authStateFor(String(body.client ?? "unknown"), now);
    if (this.dirty.size)
      await this.flush();
    return this.authView(st, now);
  }
  async authFail(body) {
    await this.ensureLoaded();
    const now = Date.now();
    const client = String(body.client ?? "unknown");
    const st = this.authStateFor(client, now);
    if (st.lockedUntil > now)
      return this.authView(st, now);
    st.fails = (st.fails ?? 0) + 1;
    st.lastFailAt = now;
    if (st.fails >= this.authCfg().maxFails)
      st.lockedUntil = now + this.authCfg().lockoutMs;
    this.dirty.add(`a:${client}`);
    await this.flush();
    return this.authView(st, now);
  }
  async authOk(body) {
    await this.ensureLoaded();
    const client = String(body.client ?? "unknown");
    if (this.authClients.has(client)) {
      this.authClients.delete(client);
      this.dirty.delete(`a:${client}`);
      await this.state.storage.delete(`a:${client}`);
    }
    return { locked: false, fails: 0, retryAfterMs: 0 };
  }
  // ------------------------------ 排序 -----------------------------------
  async order(input) {
    await this.ensureLoaded();
    const now = Date.now();
    const day = input.day ?? utcDay(now);
    const drops = {};
    for (const p of input.providers) {
      const s = this.drops.get(p.id);
      if (s?.size)
        drops[p.id] = [...s];
    }
    const pool = [];
    const seen = /* @__PURE__ */ new Set();
    for (const c of input.candidates) {
      const provider = input.providers.find((p) => p.id === c.provider);
      if (!provider)
        continue;
      const mkey = `${c.provider}/${c.model}`;
      const ms = this.models.get(mkey);
      if (ms && (ms.deadUntil > now || (ms.pauseUntil ?? 0) > now))
        continue;
      const ranked = this.rankKeys(provider, day, now);
      if (!ranked.length)
        continue;
      const okRate = ms ? (ms.ok + 1) / (ms.ok + ms.fail + 2) : 0.55;
      const latFactor = ms && ms.emaMs > 0 ? 1 / (1 + ms.emaMs / 5e3) : 1;
      for (const k of ranked) {
        const id = `${c.provider}|${c.model}|${k.id}`;
        if (seen.has(id))
          continue;
        seen.add(id);
        const w = Math.max(
          1e-3,
          c.weight * (provider.weight || 1) * okRate * latFactor * (0.3 + 0.7 * k.quotaRatio) / (1 + k.state.fails * 0.4)
        );
        pool.push({ pick: { provider: c.provider, model: c.model, keyId: k.id }, w });
      }
    }
    // Per-group routing strategy (set via /admin/api/groups):
    // - "failover": deterministic priority order — highest weight first
    //   (weight already folds in provider weight, health, latency, quota),
    //   stable tie-break, no randomness and no interleaving, so traffic
    //   sticks to the best endpoint until it actually fails.
    // - "balance" (default): weighted random sampling without replacement
    //   + interleave by model, spreading traffic across endpoints.
    const strategy = input.strategy === "failover" ? "failover" : "balance";
    let picks;
    if (strategy === "failover") {
      picks = pool.slice().sort((a, b) => {
        if (b.w !== a.w)
          return b.w - a.w;
        if (a.pick.provider !== b.pick.provider)
          return a.pick.provider < b.pick.provider ? -1 : 1;
        if (a.pick.model !== b.pick.model)
          return a.pick.model < b.pick.model ? -1 : 1;
        return a.pick.keyId < b.pick.keyId ? -1 : 1;
      }).slice(0, input.limit).map((x) => x.pick);
    } else {
      picks = interleaveByModel(weightedSample(pool, input.limit));
    }
    if (this.dirty.size) {
      try {
        await this.flush();
      } catch (e) {
        console.error("[coordinator] order flush failed", e);
      }
    }
    return { picks, drops, day, strategy };
  }
  rankKeys(provider, day, now) {
    const out = [];
    for (const meta of provider.keys) {
      const sk = `${provider.id}:${meta.id}`;
      let st = this.keys.get(sk);
      if (!st) {
        st = defaultKeyState(day, meta.dailyLimit, meta.rpm);
        this.keys.set(sk, st);
        this.dirty.add(`k:${sk}`);
      } else {
        if (st.dayLimit !== meta.dailyLimit) {
          st.dayLimit = meta.dailyLimit;
          this.dirty.add(`k:${sk}`);
        }
        if (st.rpm !== meta.rpm) {
          st.rpm = meta.rpm;
          this.dirty.add(`k:${sk}`);
        }
      }
      if (st.invalid)
        continue;
      if (st.cooldownUntil > now)
        continue;
      if ((st.breakerUntil ?? 0) > now)
        continue;
      if (st.day !== day) {
        st.day = day;
        st.dayCount = 0;
        this.dirty.add(`k:${sk}`);
      }
      if (st.dayLimit > 0 && st.dayCount >= st.dayLimit)
        continue;
      if (st.rpm > 0) {
        const win = (this.rpmWindow.get(sk) ?? []).filter((t) => now - t < 6e4);
        this.rpmWindow.set(sk, win);
        if (win.length >= st.rpm)
          continue;
      }
      const quotaRatio = st.dayLimit > 0 ? Math.max(0, (st.dayLimit - st.dayCount) / st.dayLimit) : 1;
      out.push({ id: meta.id, state: st, quotaRatio });
    }
    out.sort((a, b) => b.quotaRatio - a.quotaRatio);
    return out;
  }
  // ------------------------------ 回报 -----------------------------------
  async report(r) {
    await this.ensureLoaded();
    const now = Date.now();
    const day = r.day ?? utcDay(now);
    const sk = `${r.provider}:${r.keyId}`;
    let ks = this.keys.get(sk);
    if (!ks) {
      ks = defaultKeyState(day);
      this.keys.set(sk, ks);
    }
    if (ks.day < day) {
      ks.day = day;
      ks.dayCount = 0;
    }
    ks.lastUsed = now;
    ks.dayCount += 1;
    {
      const win = this.rpmWindow.get(sk) ?? [];
      win.push(now);
      this.rpmWindow.set(sk, win);
    }
    if (r.ok) {
      ks.fails = 0;
      ks.transientFails = 0;
      ks.breakerUntil = 0;
      ks.cooldownUntil = 0;
    } else {
      ks.fails += 1;
      switch (r.kind) {
        case "rate_limit":
          if (/concurren/i.test(r.error ?? "")) {
            ks.cooldownUntil = Math.max(ks.cooldownUntil, now + 2e3);
          } else {
            ks.cooldownUntil = now + Math.min(r.retryAfterMs ?? 3e4, 6e4);
          }
          break;
        case "quota":
          if (ks.dayLimit > 0)
            ks.dayCount = Math.max(ks.dayCount, ks.dayLimit);
          ks.cooldownUntil = Math.max(ks.cooldownUntil, nextUtcMidnight(now));
          break;
        case "auth":
          if (r.status === 403)
            ks.cooldownUntil = now + 36e5;
          else
            ks.invalid = true;
          break;
        case "server":
        case "network":
        case "timeout":
          ks.cooldownUntil = now + 5e3;
          break;
        default:
          break;
      }
      // Circuit breaker (key level): enough consecutive transient
      // failures trip a long cooldown for the whole key, across all
      // models, instead of the short per-failure pause above.
      if (TRANSIENT_KINDS.includes(r.kind ?? "")) {
        ks.transientFails = (ks.transientFails ?? 0) + 1;
        const bcfg = this.breakerCfg();
        if (ks.transientFails >= bcfg.threshold) {
          ks.breakerUntil = now + bcfg.cooldownMs;
          ks.cooldownUntil = Math.max(ks.cooldownUntil, ks.breakerUntil);
        }
      }
    }
    this.dirty.add(`k:${sk}`);
    const mkey = `${r.provider}/${r.model}`;
    const ms = this.models.get(mkey) ?? {
      ok: 0,
      fail: 0,
      consecFails: 0,
      deadUntil: 0,
      emaMs: 0,
      lastOkAt: 0,
      lastErr: "",
      lastErrKind: ""
    };
    if (r.ok) {
      ms.ok += 1;
      ms.consecFails = 0;
      ms.deadUntil = 0;
      ms.pauseUntil = 0;
      ms.lastOkAt = now;
      ms.emaMs = ms.emaMs > 0 ? ms.emaMs * 0.7 + (r.latencyMs ?? 0) * 0.3 : r.latencyMs ?? 0;
      ms.lastErr = "";
      ms.lastErrKind = "";
    } else {
      ms.fail += 1;
      ms.lastErr = truncate(r.error ?? "", 300);
      ms.lastErrKind = r.kind ?? "unknown";
      switch (r.kind) {
        case "model_gone":
          ms.deadUntil = now + 6 * 36e5;
          break;
        case "rate_limit":
          ms.pauseUntil = now + (r.retryAfterMs ?? 6e4);
          break;
        case "quota":
          break;
        case "server":
        case "network":
        case "timeout":
        case "unknown": {
          // Circuit breaker (endpoint level): the usual pause is
          // 30 s, but once consecutive transient failures reach the
          // threshold this endpoint stays dead for the full breaker
          // cooldown instead of being retried every 30 s.
          ms.consecFails = (ms.consecFails ?? 0) + 1;
          const bcfg2 = this.breakerCfg();
          ms.deadUntil = now + (ms.consecFails >= bcfg2.threshold ? Math.max(3e4, bcfg2.cooldownMs) : 3e4);
          break;
        }
        default:
          break;
      }
    }
    this.models.set(mkey, ms);
    this.dirty.add(`m:${mkey}`);
    if (r.param) {
      const set = this.drops.get(r.provider) ?? /* @__PURE__ */ new Set();
      set.add(r.param);
      this.drops.set(r.provider, set);
      this.dirty.add(`d:${r.provider}`);
    }
    await this.flush();
    await this.ensureAlarm();
  }
  async flush() {
    if (!this.dirty.size)
      return;
    const batch = {};
    for (const k of this.dirty) {
      if (k.startsWith("k:")) {
        const v = this.keys.get(k.slice(2));
        if (v)
          batch[k] = v;
      } else if (k.startsWith("m:")) {
        const v = this.models.get(k.slice(2));
        if (v)
          batch[k] = v;
      } else if (k.startsWith("d:")) {
        const v = this.drops.get(k.slice(2));
        if (v)
          batch[k] = [...v];
      } else if (k.startsWith("a:")) {
        const v = this.authClients.get(k.slice(2));
        if (v)
          batch[k] = v;
      }
    }
    if (Object.keys(batch).length)
      await this.state.storage.put(batch);
    this.dirty.clear();
  }
  async ensureAlarm() {
    if (this.alarmChecked)
      return;
    this.alarmChecked = true;
    const existing = await this.state.storage.getAlarm();
    if (existing == null)
      await this.state.storage.setAlarm(Date.now() + DAY_MS);
  }
  async alarm() {
    await this.ensureLoaded();
    const now = Date.now();
    const remove = [];
    for (const [k, v] of this.models) {
      if (v.deadUntil > 0 && v.deadUntil < now - 7 * DAY_MS)
        remove.push(`m:${k}`);
      else if (!v.deadUntil && v.lastOkAt && v.lastOkAt < now - 90 * DAY_MS)
        remove.push(`m:${k}`);
    }
    if (remove.length)
      await this.state.storage.delete(remove);
    for (const k of remove)
      this.models.delete(k.slice(2));
    const day = utcDay(now);
    for (const [k, v] of this.keys) {
      if (v.day !== day) {
        v.day = day;
        v.dayCount = 0;
        this.dirty.add(`k:${k}`);
      }
      if (v.invalid) {
        v.cooldownUntil = 0;
        v.breakerUntil = 0;
      }
    }
    const removeAuth = [];
    for (const [k, v] of this.authClients) {
      if (!(v.lockedUntil > now) && v.lastFailAt && v.lastFailAt < now - DAY_MS)
        removeAuth.push(`a:${k}`);
    }
    if (removeAuth.length)
      await this.state.storage.delete(removeAuth);
    for (const k of removeAuth) {
      this.authClients.delete(k.slice(2));
      this.dirty.delete(k);
    }
    await this.flush();
    this.alarmChecked = false;
    await this.state.storage.setAlarm(Date.now() + DAY_MS);
  }
  // ------------------------------ 运维 -----------------------------------
  /** 当前被拉黑（deadUntil 未到期）的模型键列表，供 /v1/models 过滤 */
  deadKeys() {
    const now = Date.now();
    const out = [];
    for (const [k, v] of this.models) {
      if (v.deadUntil > now)
        out.push(k);
    }
    return out;
  }
  stats() {
    const now = Date.now();
    const day = utcDay(now);
    const keys = [...this.keys.entries()].map(([k, v]) => ({
      key: k,
      day: v.day,
      dayCount: v.day === day ? v.dayCount : 0,
      dayLimit: v.dayLimit,
      cooldownUntil: v.cooldownUntil,
      cooling: v.cooldownUntil > now,
      invalid: v.invalid,
      fails: v.fails,
      transientFails: v.transientFails ?? 0,
      breakerUntil: v.breakerUntil ?? 0,
      breakerTripped: (v.breakerUntil ?? 0) > now,
      lastUsed: v.lastUsed
    }));
    const dead = [];
    const erroring = [];
    for (const [k, v] of this.models) {
      if (v.deadUntil > now) {
        dead.push({ model: k, deadUntil: v.deadUntil, kind: v.lastErrKind, error: v.lastErr, consecFails: v.consecFails ?? 0 });
      } else if (v.fail > 0) {
        erroring.push({ model: k, ok: v.ok, fail: v.fail, consecFails: v.consecFails ?? 0, emaMs: Math.round(v.emaMs) });
      }
    }
    erroring.sort((a, b) => b.fail - a.fail);
    const drops = {};
    for (const [k, v] of this.drops)
      drops[k] = [...v];
    const authLocked = [...this.authClients.entries()].filter(([, v]) => (v.lockedUntil ?? 0) > now).map(([k, v]) => ({ client: k, lockedUntil: v.lockedUntil, fails: v.fails ?? 0 }));
    return {
      day,
      keys,
      models: { total: this.models.size, dead: dead.slice(0, 50), erroring: erroring.slice(0, 30) },
      drops,
      auth: { locked: authLocked },
      now
    };
  }
  async reset() {
    await this.state.storage.deleteAll();
    this.keys.clear();
    this.models.clear();
    this.authClients.clear();
    this.drops.clear();
    this.rpmWindow.clear();
    this.dirty.clear();
    this.loaded = true;
  }
};
__name(Coordinator, "Coordinator");
function weightedSample(pool, limit) {
  const out = [];
  const tmp = pool.slice();
  while (out.length < limit && tmp.length) {
    let total = 0;
    for (const t of tmp)
      total += t.w;
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < tmp.length; idx++) {
      r -= tmp[idx].w;
      if (r <= 0)
        break;
    }
    idx = Math.min(idx, tmp.length - 1);
    out.push(tmp[idx].pick);
    tmp.splice(idx, 1);
  }
  return out;
}
__name(weightedSample, "weightedSample");
function interleaveByModel(picks) {
  const groups = /* @__PURE__ */ new Map();
  const order = [];
  for (const p of picks) {
    const k = `${p.provider}/${p.model}`;
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k).push(p);
  }
  const out = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const k of order) {
      const g = groups.get(k);
      if (g[i]) {
        out.push(g[i]);
        added = true;
      }
    }
    if (!added)
      break;
  }
  return out;
}
__name(interleaveByModel, "interleaveByModel");

// src/passthrough.ts
var PASSTHROUGH_PATHS = /* @__PURE__ */ new Set([
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/embeddings",
  "/v1/completions",
  "/v1/responses",
  "/v1/moderations",
  // AMD 系（TokenLab / 中国站）专属端点：OCR 与决策模型
  "/v1/ocr",
  "/v1/systemone"
]);
var RETRYABLE = /* @__PURE__ */ new Set([
  "rate_limit",
  "quota",
  "auth",
  "model_gone",
  "server",
  "network",
  "timeout",
  "unknown"
]);
var TIMEOUT_MS = 12e4;
async function handlePassthrough(req, env, ctx, pathname) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") {
      return openAIError(500, "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN\uFF0C\u8BF7\u5148 wrangler secret put GATEWAY_TOKEN", "configuration_error");
    }
    return openAIError(401, "invalid gateway token", "authentication_error");
  }
  const suffix = pathname.replace(/^\/v1\//, "");
  const isForm = (req.headers.get("content-type") || "").includes("multipart/form-data");
  let wantsStream = false;
  let jsonBody = null;
  let formEntries = null;
  let requested = "";
  if (isForm) {
    let fd;
    try {
      fd = await req.formData();
    } catch {
      return openAIError(400, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 multipart \u8868\u5355", "invalid_request_error");
    }
    formEntries = [...fd.entries()];
    const m = fd.get("model");
    requested = typeof m === "string" ? m.trim() : "";
  } else {
    try {
      jsonBody = await req.json();
    } catch {
      return openAIError(400, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON", "invalid_request_error");
    }
    requested = String(jsonBody?.model ?? "").trim();
    wantsStream = jsonBody?.stream === true;
  }
  if (!requested) {
    return openAIError(400, "model \u4E0D\u80FD\u4E3A\u7A7A", "invalid_request_error");
  }
  const cfg = settings(env);
  const requestId = crypto.randomUUID().slice(0, 8);
  const [catalog, providers] = await Promise.all([loadCatalog(env), loadProviders(env)]);
  const enabled = providers.filter((p) => p.enabled && p.keys.some((k) => !k.disabled));
  const byId = new Map(enabled.map((p) => [p.id, p]));
  const knownProviders = new Set(providers.map((p) => p.id.toLowerCase()));
  let candidates = [];
  let note;
  let strategy = "balance";
  const slash = requested.indexOf("/");
  const pinnedId = slash > 0 ? requested.slice(0, slash).toLowerCase() : null;
  if (pinnedId && knownProviders.has(pinnedId)) {
    const p = enabled.find((x) => x.id.toLowerCase() === pinnedId);
    if (!p) {
      return openAIError(404, `\u670D\u52A1\u5546 ${pinnedId} \u672A\u542F\u7528\u6216\u6CA1\u6709\u53EF\u7528 key`, "model_not_found");
    }
    if (p.kind !== "openai") {
      return openAIError(400, `\u670D\u52A1\u5546 ${pinnedId} \u4E0D\u662F OpenAI \u517C\u5BB9\u63A5\u53E3\uFF0C\u4E0D\u652F\u6301 /v1/${suffix}`, "invalid_request_error");
    }
    candidates = [{ provider: p.id, model: requested.slice(slash + 1), weight: p.weight ?? 1 }];
  } else {
    if (!catalog || !catalog.entries.length) {
      return openAIError(503, "\u6A21\u578B\u76EE\u5F55\u4E3A\u7A7A\uFF0C\u8BF7\u5148\u6267\u884C POST /admin/api/sync \u540C\u6B65\u6A21\u578B\u5217\u8868", "gateway_unavailable");
    }
    const resolved = resolveCandidates(catalog.entries, requested, {
      groups: cfg.grouping ? groupsOf(catalog) : void 0,
      allowed: new Set(byId.keys()),
      knownProviders
    });
    note = resolved.note;
    strategy = groupStrategy(await loadGroupStrategies(env), resolved.group?.key);
    candidates = resolved.candidates.filter((c) => byId.get(c.provider)?.kind === "openai").map((c) => ({ provider: c.provider, model: c.model, weight: c.weight }));
  }
  if (!candidates.length) {
    return openAIError(404, note ?? `\u6CA1\u6709\u53EF\u7528\u6A21\u578B\u5339\u914D "${requested}"`, "model_not_found");
  }
  let order;
  try {
    order = await coordFetch(env, "/order", {
      strategy,
      candidates,
      providers: enabled.map((p) => ({
        id: p.id,
        weight: p.weight,
        keys: p.keys.filter((k) => !k.disabled).map((k) => ({
          id: k.id,
          dailyLimit: k.dailyLimit ?? p.dailyLimitDefault ?? 0,
          rpm: k.rpm ?? p.rpmDefault ?? 0
        }))
      })),
      limit: cfg.maxAttempts
    });
  } catch (e) {
    return openAIError(503, `\u8C03\u5EA6\u5668\u4E0D\u53EF\u7528: ${truncate(String(e), 200)}`, "gateway_unavailable");
  }
  if (!order.picks.length) {
    return openAIError(503, "\u6240\u6709\u5019\u9009\u6A21\u578B / Key \u5F53\u524D\u90FD\u4E0D\u53EF\u7528\uFF08\u989D\u5EA6\u8017\u5C3D\u6216\u5904\u4E8E\u51B7\u5374\u671F\uFF09", "no_capacity");
  }
  let attempts = 0;
  let lastBuf = null;
  let lastStatus = 0;
  let lastCt = "application/json";
  let lastProvider = "";
  let lastModel = "";
  for (const pick of order.picks) {
    if (attempts >= cfg.maxAttempts)
      break;
    const provider = byId.get(pick.provider);
    if (!provider)
      continue;
    const key = provider.keys.find((k) => k.id === pick.keyId && !k.disabled);
    if (!key)
      continue;
    attempts++;
    lastProvider = pick.provider;
    lastModel = pick.model;
    const headers = {
      ...provider.headers ?? {},
      authorization: "Bearer " + key.key
    };
    let payload;
    if (formEntries) {
      const fd = new FormData();
      for (const [k, v] of formEntries)
        fd.append(k, v);
      fd.set("model", pick.model);
      payload = fd;
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify({ ...jsonBody, model: pick.model });
    }
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), TIMEOUT_MS);
    let res;
    let buf;
    try {
      res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/${suffix}`, {
        method: "POST",
        headers,
        body: payload,
        signal: ctrl.signal
      });
      if (res.ok && wantsStream && res.body) {
        clearTimeout(timer);
        const latencyMs2 = Date.now() - t0;
        ctx.waitUntil(
          coordFetch(env, "/report", {
            provider: pick.provider,
            model: pick.model,
            keyId: key.id,
            ok: true,
            status: res.status,
            latencyMs: latencyMs2,
            day: order.day
          }).catch(() => void 0)
        );
        ctx.waitUntil(
          recordUsage(env, {
            provider: pick.provider,
            model: pick.model,
            keyId: key.id,
            virtualModel: requested,
            status: res.status,
            ok: true,
            usage: null,
            latencyMs: latencyMs2,
            attempts,
            stream: true
          }, ctx)
        );
        return new Response(res.body, {
          status: res.status,
          headers: {
            ...CORS,
            "content-type": res.headers.get("content-type") || "text/event-stream",
            "x-gw-provider": pick.provider,
            "x-gw-model": pick.model,
            "x-gw-attempts": String(attempts),
            "x-gw-request-id": requestId
          }
        });
      }
      buf = await res.arrayBuffer();
    } catch (e) {
      clearTimeout(timer);
      const kind2 = classifyThrown(e);
      const latencyMs2 = Date.now() - t0;
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: false,
          status: 0,
          kind: kind2,
          latencyMs: latencyMs2,
          day: order.day
        }).catch(() => void 0)
      );
      ctx.waitUntil(
        recordUsage(env, {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          virtualModel: requested,
          status: 0,
          ok: false,
          usage: null,
          latencyMs: latencyMs2,
          attempts,
          errorKind: kind2,
          stream: false
        }, ctx)
      );
      lastStatus = 0;
      lastBuf = null;
      continue;
    }
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    const ct = res.headers.get("content-type") || "application/json";
    if (res.ok) {
      let usage = null;
      if (ct.includes("json")) {
        try {
          usage = normalizeUsage(JSON.parse(new TextDecoder().decode(buf)).usage);
        } catch {
        }
      }
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: true,
          status: res.status,
          latencyMs,
          day: order.day
        }).catch(() => void 0)
      );
      ctx.waitUntil(
        recordUsage(env, {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          virtualModel: requested,
          status: res.status,
          ok: true,
          usage,
          latencyMs,
          attempts,
          stream: false
        }, ctx)
      );
      return new Response(buf, {
        status: res.status,
        headers: {
          ...CORS,
          "content-type": ct,
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId
        }
      });
    }
    const text = truncate(new TextDecoder().decode(buf), 1200);
    let kind = classify(res.status, text);
    if (res.status === 404 && !/no_available_channel|cannot be served|no channel available/i.test(text)) {
      kind = "bad_param";
      return new Response(buf, {
        status: res.status,
        headers: {
          ...CORS,
          "content-type": ct,
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId
        }
      });
    }
    if (kind !== "model_gone") {
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: false,
          status: res.status,
          kind,
          latencyMs,
          error: truncate(text, 300),
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? void 0,
          param: kind === "bad_param" ? extractParam(text) : void 0,
          day: order.day
        }).catch(() => void 0)
      );
    }
    ctx.waitUntil(
      recordUsage(env, {
        provider: pick.provider,
        model: pick.model,
        keyId: key.id,
        virtualModel: requested,
        status: res.status,
        ok: false,
        usage: null,
        latencyMs,
        attempts,
        errorKind: kind,
        stream: false
      }, ctx)
    );
    lastBuf = buf;
    lastStatus = res.status;
    lastCt = ct;
    if (!RETRYABLE.has(kind))
      break;
  }
  if (lastBuf) {
    return new Response(lastBuf, {
      status: lastStatus,
      headers: {
        ...CORS,
        "content-type": lastCt,
        "x-gw-provider": lastProvider,
        "x-gw-model": lastModel,
        "x-gw-attempts": String(attempts),
        "x-gw-request-id": requestId
      }
    });
  }
  return openAIError(503, "\u6240\u6709\u5019\u9009\u4E0A\u6E38\u5747\u65E0\u54CD\u5E94\uFF08\u7F51\u7EDC/\u8D85\u65F6\uFF09", "gateway_unavailable");
}
__name(handlePassthrough, "handlePassthrough");
async function handleModelOne(req, env, id) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    return openAIError(auth.reason === "unconfigured" ? 500 : 401, "invalid gateway token", "authentication_error");
  }
  const catalog = await loadCatalog(env);
  if (!catalog)
    return openAIError(404, `\u6A21\u578B "${id}" \u4E0D\u5B58\u5728`, "model_not_found");
  const group = groupsOf(catalog).find((g) => g.id === id);
  if (group) {
    return json({
      id: group.id,
      object: "model",
      created: group.created && group.created < 1e12 ? group.created : Math.floor((group.created ?? 0) / 1e3),
      owned_by: group.providers.join(","),
      providers: group.providers,
      endpoints: group.endpoints.length,
      context_length: group.contextLength || void 0
    });
  }
  const entry = catalog.entries.find((e) => e.key === id) ?? catalog.entries.find((e) => e.model === id);
  if (entry) {
    return json({
      id: entry.model,
      object: "model",
      created: entry.created ?? 0,
      owned_by: entry.provider,
      context_length: entry.contextLength || void 0
    });
  }
  return openAIError(404, `\u6A21\u578B "${id}" \u4E0D\u5B58\u5728`, "model_not_found");
}
__name(handleModelOne, "handleModelOne");

// src/schema.ts
// Auto-create the D1 schema on first deployment / first use.
// Idempotent (IF NOT EXISTS) and memoised per isolate: after the first
// successful run it costs one resolved promise per request. On failure the
// memo is cleared so the next request retries. This removes the manual
// "create the usage table before first deploy" step entirely.
var SCHEMA_STATEMENTS = [
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
var schemaReady = null;
async function ensureSchema(env) {
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

// src/admin-origin.ts
// ADMIN_ORIGIN (comma-separated allowlist, e.g.
// "https://ai.reply.kdns.fr,https://free-ai-gateway-admin.pages.dev")
// verifies that browser calls to /admin/api/* really come from the
// deployed frontend. Requests without an Origin header (curl, scripts)
// are not origin-checked; the Bearer ADMIN_TOKEN is still required.
function adminOrigins(env) {
  return (env.ADMIN_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}
__name(adminOrigins, "adminOrigins");
function originAllowed(env, req) {
  const list = adminOrigins(env);
  if (!list.length)
    return true;
  const origin = req.headers.get("origin");
  if (!origin)
    return true;
  return list.includes(origin.replace(/\/+$/, ""));
}
__name(originAllowed, "originAllowed");
function adminPreflight(env, req) {
  if (!originAllowed(env, req))
    return openAIError(403, "origin not allowed", "forbidden");
  const headers = { ...CORS };
  const origin = req.headers.get("origin");
  if (origin && adminOrigins(env).length)
    headers["access-control-allow-origin"] = origin;
  return new Response(null, { status: 204, headers });
}
__name(adminPreflight, "adminPreflight");

// src/index.ts
var src_default = {
  async fetch(req, env, ctx) {
    await ensureSchema(env);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
        return adminPreflight(env, req);
      return preflight();
    }
    let routeReq = req;
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.replace(/\/+$/, "");
      const u2 = new URL(url.toString());
      u2.pathname = pathname;
      routeReq = new Request(u2, req);
    }
    try {
      if (pathname === "/" || pathname === "/healthz") {
        return json({
          ok: true,
          service: "free-ai-gateway",
          time: (/* @__PURE__ */ new Date()).toISOString(),
          endpoints: {
            chat: "POST /v1/chat/completions",
            models: "GET /v1/models",
            anthropic: "POST /v1/messages, POST /v1/messages/count_tokens",
            gemini: "GET /v1beta/models, POST /v1beta/models/{model}:generateContent",
            passthrough: "POST /v1/audio/*, /v1/images/*, /v1/embeddings, /v1/completions, /v1/responses, /v1/moderations, /v1/ocr, /v1/systemone",
            admin_api: "/admin/api/* (Authorization: Bearer <ADMIN_TOKEN>)",
            admin_ui: "https://ai.reply.kdns.fr"
          }
        });
      }
      if (pathname === "/v1/models") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return openAIError(405, "\u8BF7\u4F7F\u7528 GET");
        }
        const auth = await checkGatewayToken(routeReq, env);
        if (!auth.ok) {
          return openAIError(
            auth.reason === "unconfigured" ? 500 : 401,
            auth.reason === "unconfigured" ? "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN" : "invalid gateway token",
            "authentication_error"
          );
        }
        return handleModels(env, url);
      }
      if (pathname.startsWith("/v1/models/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return openAIError(405, "\u8BF7\u4F7F\u7528 GET");
        }
        return handleModelOne(routeReq, env, decodeURIComponent(pathname.slice("/v1/models/".length)));
      }
      if (pathname === "/v1/chat/completions") {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleChat(routeReq, env, ctx);
      }
      if (pathname === "/v1/messages") {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleMessages(routeReq, env, ctx);
      }
      if (pathname === "/v1/messages/count_tokens") {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleCountTokens(routeReq, env);
      }
      if (pathname === "/v1beta/models") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return openAIError(405, "\u8BF7\u4F7F\u7528 GET");
        }
        return handleGeminiModels(routeReq, env, url);
      }
      if (pathname.startsWith("/v1beta/models/")) {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleGemini(routeReq, env, ctx, pathname, url);
      }
      if (PASSTHROUGH_PATHS.has(pathname)) {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handlePassthrough(routeReq, env, ctx, pathname);
      }
      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        return handleAdmin(routeReq, env, ctx, url);
      }
      return openAIError(404, `\u672A\u77E5\u8DEF\u5F84: ${pathname}`, "not_found");
    } catch (e) {
      console.error("[fetch]", e);
      return openAIError(500, "internal error", "internal_error");
    }
  },
  async scheduled(_controller, env, ctx) {
    await ensureSchema(env);
    const cfg = settings(env);
    if (cfg.syncEnabled) {
      ctx.waitUntil(
        syncAll(env, { probe: cfg.probePerSync > 0 }).then(
          (r) => console.log(
            `[cron] sync ok=${r.ok} total=${r.total} added=${r.added} removed=${r.removed} ${r.durationMs}ms`
          )
        ).catch((e) => console.error("[cron] sync failed", e))
      );
    }
    ctx.waitUntil(flushUsageBuffer(env));
    ctx.waitUntil(cleanup(env, 90));
  }
};
export {
  Coordinator,
  src_default as default
};
