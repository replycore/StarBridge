import { __name } from "./helpers.js";

export var NOISE = /* @__PURE__ */ new Set(["instruct", "chat", "it", "versatile", "instant", "latest", "hf", "thinking"]);
// "thinking" is the effort suffix (model-thinking): it must not
// split the bare-name group — model-thinking joins model's group.
export var QUANT = /* @__PURE__ */ new Set(["fp8", "fp16", "bf16", "int8", "int4", "awq", "gptq", "gguf", "mlx", "exl2", "4bit", "8bit"]);
export function groupKeyOf(raw) {
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
export function canonicalScore(name) {
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
export function buildGroups(entries, previous) {
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
    const providers = [...new Set(eps.map((e) => e.provider))].sort();
    // A name carried by a single provider is not a mapping
    // group: the model stays a plain catalog entry, routable by
    // its own name and listed as itself. A group exists only to
    // aggregate one name across several providers.
    if (providers.length < 2)
      continue;
    const id = prevByKey.get(key)?.id || names.slice().sort((a, b) => canonicalScore(a) - canonicalScore(b) || a.length - b.length)[0];
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
export function matchGroup(groups, requested) {
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
