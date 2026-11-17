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
export async function buildIndex() {
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
export async function loadIndex() {
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
export async function enrichEntries(entries) {
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
