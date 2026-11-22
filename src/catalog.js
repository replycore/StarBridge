import { __name } from "./helpers.js";
import { clamp, json } from "./util.js";
import { groupKeyOf, matchGroup } from "./groups.js";

export const GROUP_LABEL_PREFIX = "\u6620\u5C04\u7EC4/";
export function labelModelId(id) {
  return id && !id.includes("/") ? GROUP_LABEL_PREFIX + id : id;
}
__name(labelModelId, "labelModelId");
export function parseModelName(raw) {
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
export function isChatModel(id) {
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
function isZeroPrice(pricing) {
  if (!pricing)
    return false;
  const isZero = /* @__PURE__ */ __name((v) => v !== void 0 && v !== null && Number(v) === 0, "isZero");
  const promptFree = isZero(pricing.prompt);
  const completionFree = isZero(pricing.completion);
  const requestFree = pricing.request === void 0 || pricing.request === null || Number(pricing.request) === 0;
  return promptFree && completionFree && requestFree;
}
__name(isZeroPrice, "isZeroPrice");
export function isFreeModel(id, pricing, freeMode, allow, freeRules) {
  if (freeMode === "zero-price") {
    return isZeroPrice(pricing);
  }
  if (freeMode === "rules") {
    // Composable rules: a model is free when ANY enabled rule
    // matches (zero price, :free suffix, or the manual allow
    // regexes). A missing freeRules falls back to price-only,
    // the conservative default the provider form starts from.
    const rules = freeRules && typeof freeRules === "object" ? { price: true, suffix: false, allow: [], ...freeRules } : { price: true, suffix: false, allow: [] };
    if (rules.price && isZeroPrice(pricing))
      return true;
    if (rules.suffix && /:free$/i.test(id))
      return true;
    const list = Array.isArray(rules.allow) ? rules.allow : [];
    return list.some((re) => {
      try {
        return new RegExp(re, "i").test(id);
      } catch {
        return false;
      }
    });
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
export function inferTags(id, supported) {
  const s = id.toLowerCase();
  const tags = /* @__PURE__ */ new Set();
  if (supported?.includes("tools") || supported?.includes("tool_choice"))
    tags.add("tools");
  else if (Array.isArray(supported) && supported.length)
    // The upstream publishes a non-empty supported_parameters list
    // that does not mention tools: positive evidence this endpoint
    // cannot do function calling (as opposed to "unknown", which is
    // the common case and must stay routable).
    tags.add("no-tools");
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
export function buildCatalog(entries, opts) {
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
export var CAP_NAMES = /* @__PURE__ */ new Set(["tools", "vision", "reasoning", "json", "image"]);
export var ALIAS_MODES = /* @__PURE__ */ new Set(["new", "fast", "smart", "long", "cheap"]);
export function rankScore(e, mode) {
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
export function resolveCandidates(entries, requested, opts = {}) {
  const raw = (requested || "auto").trim().replace(/^\u6620\u5C04\u7EC4\//, "");
  const normalized = raw.replace(/^auto[-_](new|fast|smart|long|cheap)$/i, "auto:$1");
  const limit = opts.limit ?? 24;
  const allow = /* @__PURE__ */ __name((e) => !opts.allowed || opts.allowed.has(e.provider), "allow");
  let pool = [];
  let caps;
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
    let mode = "auto";
    if (sub.includes("+")) {
      const tokens = sub.split("+").map((t) => t.trim()).filter(Boolean);
      const capTokens = tokens.filter((t) => CAP_NAMES.has(t));
      const modeTokens = tokens.filter((t) => ALIAS_MODES.has(t));
      if (tokens.length && capTokens.length + modeTokens.length === tokens.length) {
        caps = new Set(capTokens);
        if (modeTokens.length)
          mode = modeTokens[0];
      }
    } else if (sub && CAP_NAMES.has(sub)) {
      caps = new Set([sub]);
    }
    if (!caps && sub && !ALIAS_MODES.has(sub)) {
      pool = pool.filter(
        (e) => e.family.includes(sub) || e.model.toLowerCase().includes(sub)
      );
      if (!pool.length)
        note = `\u6CA1\u6709\u5339\u914D "${sub}" \u7684\u514D\u8D39\u6A21\u578B`;
    }
    if (!caps && ALIAS_MODES.has(sub))
      mode = sub;
    pool.sort((a, b) => rankScore(b, mode) - rankScore(a, mode));
  } else if (pinned) {
    // `pinned` is the lowercased provider id (see the detector
    // above); comparing the catalog's provider against the raw
    // first segment made `amd/...` miss provider `AMD` entirely.
    const mid = normalized.split("/").slice(1).join("/");
    const exactPinned = entries.filter((e) => e.provider.toLowerCase() === pinned && e.model.toLowerCase() === mid.toLowerCase());
    pool = exactPinned.length ? exactPinned : entries.filter((e) => e.provider.toLowerCase() === pinned && e.model.toLowerCase().endsWith(mid.toLowerCase()));
    if (pool.length)
      matched = "exact";
    else
      note = `\u670D\u52A1\u5546 ${pinned} \u6CA1\u6709\u5339\u914D "${mid}" \u7684\u6A21\u578B`;
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
  // The alias branch already sorted the pool by the requested
  // mode (auto:fast / auto:smart / ...); re-sorting it with the
  // default score here would silently discard that ordering (a
  // stable sort keeps it only on exact ties), so the default
  // ranking applies to exact / fuzzy / pinned matches only.
  if (matched !== "group" && matched !== "alias")
    pool.sort((a, b) => rankScore(b, "auto") - rankScore(a, "auto"));
  const prefer = /* @__PURE__ */ __name((list, tag) => {
    const withTag = list.filter((e) => e.tags.includes(tag));
    return withTag.length ? [...withTag, ...list.filter((e) => !e.tags.includes(tag))] : list;
  }, "prefer");
  let degraded;
  if (opts.needsTools || caps?.has("tools")) {
    // Hard filter: endpoints KNOWN not to support function calling
    // ("no-tools" tag) are excluded outright. Unknown-capability
    // endpoints stay eligible. If every candidate is known-bad, keep
    // them all and flag the request as degraded instead of failing.
    const capable = pool.filter((e) => !e.tags.includes("no-tools"));
    if (capable.length)
      pool = capable;
    else if (pool.length)
      degraded = "tools";
    pool = prefer(pool, "tools");
  }
  if (opts.needsVision || caps?.has("vision")) {
    // Hard filter on KNOWN modalities: an endpoint whose advertised
    // input modalities exclude images would only burn an attempt on
    // a guaranteed 400. Unknown-modality endpoints stay eligible; if
    // every known endpoint is text-only, keep the pool and flag it.
    const known = pool.filter((e) => Array.isArray(e.inputModalities) && e.inputModalities.length && e.inputModalitiesSource !== "heuristic");
    const canSee = known.filter((e) => e.inputModalities.includes("image"));
    if (canSee.length)
      pool = canSee;
    else if (known.length)
      degraded = degraded ? `${degraded},vision` : "vision";
    pool = prefer(pool, "vision");
  }
  if (caps) {
    for (const tag of ["reasoning", "json"]) {
      if (!caps.has(tag))
        continue;
      const withTag = pool.filter((e) => e.tags.includes(tag));
      if (withTag.length)
        pool = withTag;
      else if (pool.length)
        degraded = degraded ? `${degraded},${tag}` : tag;
    }
    if (caps.has("image")) {
      const knownOut = pool.filter((e) => Array.isArray(e.outputModalities) && e.outputModalities.length && e.outputModalitiesSource !== "heuristic");
      const canImg = knownOut.filter((e) => e.outputModalities.includes("image"));
      if (canImg.length)
        pool = canImg;
      else if (knownOut.length)
        degraded = degraded ? `${degraded},image` : "image";
    }
  }
  if (opts.needContext) {
    const fits = pool.filter((e) => e.contextLength == null || e.contextLength >= opts.needContext);
    if (fits.length && fits.length < pool.length)
      pool = [...fits, ...pool.filter((e) => e.contextLength != null && e.contextLength < opts.needContext)];
  }
  pool = pool.slice().sort((a, b) => {
    const pa = a.tags.includes("preview") ? 1 : 0;
    const pb = b.tags.includes("preview") ? 1 : 0;
    return pa - pb;
  });
  const picked = pool.slice(0, limit);
  return {
    matched,
    note,
    degraded,
    caps: caps ? [...caps] : void 0,
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
export var VIRTUAL_MODELS = [
  { id: "auto", description: "\u81EA\u52A8\u9009\u62E9\u5F53\u524D\u6700\u4F18\u7684\u514D\u8D39\u6A21\u578B" },
  { id: "auto:new", description: "\u4F18\u5148\u6700\u65B0\u53D1\u5E03\u7684\u6A21\u578B" },
  { id: "auto:fast", description: "\u4F18\u5148\u5C0F\u53C2\u6570\u6A21\u578B\uFF08\u66F4\u5FEB\u3001\u66F4\u7701\u989D\u5EA6\uFF09" },
  { id: "auto:smart", description: "\u4F18\u5148\u5927\u53C2\u6570\u6A21\u578B\uFF08\u8D28\u91CF\u66F4\u9AD8\uFF09" },
  { id: "auto:long", description: "\u4F18\u5148\u957F\u4E0A\u4E0B\u6587\u6A21\u578B" },
  { id: "auto:cheap", description: "\u4F18\u5148\u4EF7\u683C\u6700\u4F4E\u7684\u6A21\u578B" },
  { id: "auto:tools", description: "\u53ea\u9009\u652f\u6301\u5de5\u5177\u8c03\u7528\u7684\u6a21\u578b" },
  { id: "auto:vision", description: "\u53ea\u9009\u652f\u6301\u56fe\u50cf\u8f93\u5165\u7684\u6a21\u578b" },
  { id: "auto:reasoning", description: "\u53ea\u9009\u63a8\u7406\u6a21\u578b" },
  { id: "auto:tools+vision", description: "\u540c\u65f6\u652f\u6301\u5de5\u5177\u8c03\u7528\u4e0e\u56fe\u50cf\u8f93\u5165\u7684\u6a21\u578b" }
];
