import { __name } from "./helpers.js";
import { base64Decode, base64Encode } from "./util.js";
import { buildGroups } from "./groups.js";

export var PROVIDERS_KEY = "cfg:providers:v1";
export var CATALOG_KEY = "catalog:v1";
export var CACHE_TTL = 3e4;
export var providerCache = null;
export var providersLoadFailed = false;
export var catalogCache = null;
export var groupCache = null;
export var lastStoreWarning = null;
export function storeWarning() {
  return lastStoreWarning;
}
__name(storeWarning, "storeWarning");
export async function masterKey(env) {
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
export async function encrypt(env, value) {
  const plain = JSON.stringify(value);
  const key = await masterKey(env);
  if (!key)
    throw new Error("MASTER_KEY \u672A\u914D\u7F6E\u6216\u4E0D\u662F 32 \u5B57\u8282 base64\uFF0C\u62D2\u7EDD\u4FDD\u5B58\u670D\u52A1\u5546\u914D\u7F6E");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { enc: 1, iv: base64Encode(iv), data: base64Encode(new Uint8Array(ct)) };
}
__name(encrypt, "encrypt");
export async function decrypt(env, env_) {
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
export async function loadProviders(env, force = false) {
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
export async function saveProviders(env, list) {
  if (providersLoadFailed) {
    throw new Error("\u670D\u52A1\u5546\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF08\u591A\u534A\u662F MASTER_KEY \u4E0D\u5BF9\uFF09\uFF0C\u62D2\u7EDD\u5199\u5165\u4EE5\u514D\u8986\u76D6\u539F\u6709\u914D\u7F6E");
  }
  const envelope = await encrypt(env, list);
  await env.GW_KV.put(PROVIDERS_KEY, JSON.stringify(envelope));
  providerCache = { at: Date.now(), data: list };
}
__name(saveProviders, "saveProviders");
export async function removeProvider(env, id) {
  const list = (await loadProviders(env, true)).filter((p) => p.id !== id);
  await saveProviders(env, list);
  return list;
}
__name(removeProvider, "removeProvider");
// Per-mapping-group routing strategy, stored as plain JSON in KV:
// { "<groupKey>": "failover" | "balance" }. Groups without an entry use
// the default ("balance"). No secrets involved, so no encryption envelope.
export var GROUP_STRATEGIES_KEY = "cfg:group-strategies:v1";
export var groupStrategiesCache = null;
export async function loadGroupStrategies(env, force = false) {
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
export async function saveGroupStrategies(env, map) {
  await env.GW_KV.put(GROUP_STRATEGIES_KEY, JSON.stringify(map));
  groupStrategiesCache = { at: Date.now(), data: map };
}
__name(saveGroupStrategies, "saveGroupStrategies");
export function groupStrategy(map, groupKey) {
  return map && groupKey && map[groupKey] === "failover" ? "failover" : "balance";
}
__name(groupStrategy, "groupStrategy");

// Admin-defined custom models: a public model id whose endpoints are the
// catalog entries whose model id contains any of the configured keywords
// (case-insensitive substring match). Stored as plain JSON in KV:
// [{ "id": "my-model", "keywords": ["llama", "qwen"] }]. Custom groups are
// merged ahead of the derived catalog groups everywhere groups are used
// (routing, model listings, admin), and support the same per-group
// routing strategies under the key "custom:<id>".
export var CUSTOM_GROUPS_KEY = "cfg:custom-groups:v1";
export var customGroupsCache = null;
export async function loadCustomGroups(env, force = false) {
  if (!force && customGroupsCache && Date.now() - customGroupsCache.at < CACHE_TTL) {
    return customGroupsCache.data;
  }
  let list = [];
  const raw = await env.GW_KV.get(CUSTOM_GROUPS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (d && typeof d.id === "string" && Array.isArray(d.keywords)) {
            const keywords = [...new Set(d.keywords.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim()))];
            if (d.id.trim() && keywords.length)
              list.push({ id: d.id.trim(), keywords });
          }
        }
      }
    } catch (e) {
      console.error("[store] custom groups parse failed", e);
    }
  }
  customGroupsCache = { at: Date.now(), data: list };
  return list;
}
__name(loadCustomGroups, "loadCustomGroups");
export async function saveCustomGroups(env, list) {
  await env.GW_KV.put(CUSTOM_GROUPS_KEY, JSON.stringify(list));
  customGroupsCache = { at: Date.now(), data: list };
}
__name(saveCustomGroups, "saveCustomGroups");
export function customGroupKey(id) {
  return "custom:" + String(id).trim().toLowerCase();
}
__name(customGroupKey, "customGroupKey");
export function buildCustomGroup(def, entries) {
  const ks = def.keywords.map((k) => k.toLowerCase());
  const eps = entries.filter((e) => {
    const m = e.model.toLowerCase();
    return ks.some((k) => m.includes(k));
  }).slice().sort((a, b) => (b.versionScore ?? 0) - (a.versionScore ?? 0));
  if (!eps.length)
    return null;
  const providers = [...new Set(eps.map((e) => e.provider))].sort();
  const tags = /* @__PURE__ */ new Set();
  for (const e of eps)
    for (const t of e.tags)
      tags.add(t);
  const ctx = Math.max(0, ...eps.map((e) => e.contextLength ?? 0));
  const maxOut = Math.max(0, ...eps.map((e) => e.maxOutput ?? 0));
  const MOD_ORDER3 = ["text", "image", "pdf", "audio", "video"];
  const inSet = /* @__PURE__ */ new Set();
  const outSet = /* @__PURE__ */ new Set();
  for (const e of eps) {
    for (const m of e.inputModalities ?? [])
      inSet.add(m);
    for (const m of e.outputModalities ?? [])
      outSet.add(m);
  }
  const inMods = MOD_ORDER3.filter((m) => inSet.has(m));
  const outMods = MOD_ORDER3.filter((m) => outSet.has(m));
  const created = Math.min(...eps.map((e) => e.created ?? 0).filter((n) => n > 0), Number.MAX_SAFE_INTEGER);
  return {
    id: def.id,
    key: customGroupKey(def.id),
    aliases: [...new Set(eps.map((e) => e.model))],
    endpoints: eps,
    providers,
    family: eps[0].family,
    versionScore: Math.max(...eps.map((e) => e.versionScore ?? 0)),
    contextLength: ctx || void 0,
    maxOutput: maxOut || void 0,
    inputModalities: inMods.length ? inMods : void 0,
    outputModalities: outMods.length ? outMods : void 0,
    tags: [...tags],
    toolsAll: eps.every((e) => e.tags.includes("tools")),
    created: created === Number.MAX_SAFE_INTEGER ? 0 : created,
    custom: true,
    keywords: def.keywords
  };
}
__name(buildCustomGroup, "buildCustomGroup");
export async function allGroupsOf(env, snap) {
  const derived = groupsOf(snap);
  if (!snap || !snap.entries.length)
    return derived;
  const defs = await loadCustomGroups(env);
  if (!defs.length)
    return derived;
  const custom = [];
  for (const def of defs) {
    const g = buildCustomGroup(def, snap.entries);
    if (g)
      custom.push(g);
  }
  return custom.concat(derived);
}
__name(allGroupsOf, "allGroupsOf");

export var GATEWAY_KEYS_KEY = "cfg:gateway-keys:v1";
export var gatewayKeysCache = null;
export async function loadGatewayKeys(env, force = false) {
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
export async function saveGatewayKeys(env, list) {
  const envelope = await encrypt(env, list);
  await env.GW_KV.put(GATEWAY_KEYS_KEY, JSON.stringify(envelope));
  gatewayKeysCache = { at: Date.now(), data: list };
}
__name(saveGatewayKeys, "saveGatewayKeys");
export async function loadCatalog(env, force = false) {
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
export async function saveCatalog(env, snap) {
  await env.GW_KV.put(CATALOG_KEY, JSON.stringify(snap));
  catalogCache = { at: Date.now(), data: snap };
}
__name(saveCatalog, "saveCatalog");
export function invalidateCaches() {
  providerCache = null;
  catalogCache = null;
  groupCache = null;
  gatewayKeysCache = null;
  groupStrategiesCache = null;
  customGroupsCache = null;
}
__name(invalidateCaches, "invalidateCaches");
export function groupsOf(snap) {
  if (!snap || !snap.entries.length)
    return [];
  if (groupCache && groupCache.version === snap.version)
    return groupCache.data;
  const data = buildGroups(snap.entries, groupCache?.data);
  groupCache = { version: snap.version, data };
  return data;
}
__name(groupsOf, "groupsOf");
