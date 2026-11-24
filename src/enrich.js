import { __name } from "./helpers.js";

export var MOD_ORDER = ["text", "image", "pdf", "audio", "video"];
export function normModality(raw) {
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
export function normModalities(list) {
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
export var indexCache = null;
export var indexInflight = null;
export var INDEX_TTL = 6 * 36e5;
export function infoOf(m) {
  return {
    context: typeof m.limit?.context === "number" && m.limit.context > 0 ? m.limit.context : void 0,
    output: typeof m.limit?.output === "number" && m.limit.output > 0 ? m.limit.output : void 0,
    inputs: normModalities(m.modalities?.input),
    outputs: normModalities(m.modalities?.output)
  };
}
__name(infoOf, "infoOf");
export async function buildIndex(wanted) {
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
        const low = mid.toLowerCase();
        const base = low.split("/").pop();
        const keys = [low, base, `${prov.toLowerCase()}::${base}`, squash(base)];
        // With a wanted set (the catalog's candidate keys), only
        // models a lookup could actually hit are indexed: the
        // upstream file carries ~10k models and building info for
        // all of them is the sync's biggest CPU cost.
        if (wanted && !keys.some((k) => wanted.has(k)))
          continue;
        const info = infoOf(m);
        for (const k of keys)
          put(k, info);
      }
    }
    return index;
  } finally {
    clearTimeout(timer);
  }
}
__name(buildIndex, "buildIndex");
export var INDEX_KV_KEY = "cfg:enrich-index:v1";
export var INDEX_KV_TTL = 24 * 36e5;
export var indexInflightSig = null;
// A cheap stable signature for a wanted-key set. A slim index is
// only reused when the catalog asks for exactly the same keys, so a
// newly appearing model (which brings new keys) always triggers a
// fresh build instead of silently missing its enrichment.
export function wantedSig(wanted) {
  const keys = [...wanted].sort();
  const s = keys.join("\n");
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 31) ^ c) >>> 0;
  }
  return keys.length + ":" + h1.toString(16) + ":" + h2.toString(16);
}
__name(wantedSig, "wantedSig");
export async function loadIndex(env, wanted, sig) {
  if (indexCache && indexCache.sig === sig && Date.now() - indexCache.at < INDEX_TTL)
    return indexCache.index;
  // A KV copy of a previous slim build: reading back a small set of
  // already-digested entries is far cheaper than re-reading and
  // re-parsing the multi-MB models.dev file on every cold isolate.
  let kvCopy = null;
  try {
    kvCopy = env?.GW_KV ? await env.GW_KV.get(INDEX_KV_KEY, "json") : null;
  } catch {
    kvCopy = null;
  }
  if (kvCopy && kvCopy.sig === sig && Array.isArray(kvCopy.entries) && Date.now() - (kvCopy.at ?? 0) < INDEX_KV_TTL) {
    const index = new Map(kvCopy.entries);
    indexCache = { at: Date.now(), sig, index };
    return index;
  }
  if (!indexInflight || indexInflightSig !== sig) {
    indexInflightSig = sig;
    indexInflight = buildIndex(wanted).then(async (index) => {
      indexCache = { at: Date.now(), sig, index };
      try {
        await env?.GW_KV?.put(INDEX_KV_KEY, JSON.stringify({ at: Date.now(), sig, entries: [...index] }));
      } catch {
        // The KV cache write is best-effort.
      }
      return index;
    }).finally(() => {
      if (indexInflightSig === sig) {
        indexInflight = null;
        indexInflightSig = null;
      }
    });
  }
  try {
    return await indexInflight;
  } catch (e) {
    console.error("[enrich] models.dev \u62C9\u53D6\u5931\u8D25\uFF0C\u8DF3\u8FC7\u5BCC\u5316", e);
    // A stale KV copy still beats no enrichment at all.
    if (kvCopy && Array.isArray(kvCopy.entries))
      return new Map(kvCopy.entries);
    return null;
  }
}
__name(loadIndex, "loadIndex");
export function squash(s) {
  return s.replace(/[-_.\s]/g, "");
}
__name(squash, "squash");
export var COLON_SUFFIX = /:(free|beta|latest|preview|stable|experimental)$/;
export var VARIANT_SUFFIX = /[-_](thinking|reasoning|uncensored|fast|turbo|instruct|chat|preview|beta|latest|exp|it|\d{4}|\d{2}-\d{2}|\d{8})$/;
export function candidateKeys(model) {
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
export function lookupDev(index, model) {
  for (const k of candidateKeys(model)) {
    const hit = index.get(k);
    if (hit)
      return hit;
  }
  return void 0;
}
__name(lookupDev, "lookupDev");
export function heuristicModalities(model) {
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
export async function enrichEntries(entries, env) {
  const wanted = /* @__PURE__ */ new Set();
  for (const e of entries)
    for (const k of candidateKeys(e.model))
      wanted.add(k);
  const index = await loadIndex(env, wanted, wantedSig(wanted));
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
        // Name-based guesses are marked as such: routing must not
        // treat them as provider-published ("known") modalities
        // when hard-filtering (see resolveCandidates in catalog.js).
        if (!e.inputModalities) {
          e.inputModalities = h.inputs;
          e.inputModalitiesSource = "heuristic";
        }
        if (!e.outputModalities) {
          e.outputModalities = h.outputs;
          e.outputModalitiesSource = "heuristic";
        }
      }
    }
  }
}
__name(enrichEntries, "enrichEntries");
