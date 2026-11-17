import { __name } from "./helpers.js";
import { adapterFor } from "./adapters/index.js";
import { buildCatalog, inferTags, isChatModel, isFreeModel, parseModelName } from "./catalog.js";
import { classify, truncate } from "./util.js";
import { coordFetch } from "./coord-client.js";
import { enrichEntries, normModalities } from "./enrich.js";
import { loadCatalog, loadProviders, saveCatalog } from "./store.js";
import { settings } from "./config.js";

export function modelsUrl(p) {
  const path = p.modelsPath || "/models";
  if (path.startsWith("http"))
    return path;
  return `${p.baseUrl}${path}`;
}
__name(modelsUrl, "modelsUrl");
export function parseCreated(o) {
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
export function normalizeModel(raw) {
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
export async function fetchModels(p, key) {
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
export function toEntry(p, m, prev) {
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
export async function probeModel(p, key, model) {
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
export async function syncAll(env, opts = {}) {
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
