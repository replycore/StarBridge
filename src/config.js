import { __name } from "./helpers.js";
import { baseName } from "./catalog.js";
import { DEFAULT_STRIP_FIELDS } from "./util.js";
import { BLOCKED_HEADERS, OVERRIDE_OPS } from "./override.js";

export function settings(env) {
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
// Per-request attempt budget: the x-gw-max-attempts header lets the
// caller (typically an agent tool loop) cap how many upstream attempts
// one request may burn, clamped to [1, cfg.maxAttempts]. Absent or
// invalid header -> the configured default.
export function requestMaxAttempts(req, cfg) {
  const n = Math.floor(Number(req.headers.get("x-gw-max-attempts")));
  return Number.isFinite(n) && n > 0 ? Math.min(n, cfg.maxAttempts) : cfg.maxAttempts;
}
__name(requestMaxAttempts, "requestMaxAttempts");
export var PRESETS = {
  openrouter: {
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    freeMode: "zero-price",
    dailyLimitDefault: 50,
    resetOffsetMin: 0,
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
    allow: ["\\bfree\\b"],
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
// Validate a service URL that stored credentials will be sent to
// (provider baseUrl / modelsPath, alert push targets). Returns the
// normalized URL string (trimmed, no trailing slash) or null when
// the URL is not acceptable:
//   - must parse as a URL, with no embedded credentials or fragment;
//   - https: only, except loopback hosts (localhost / 127.0.0.0/8 /
//     ::1) which may use http: — local dev and the regression mocks
//     run on loopback http and must keep working;
//   - the host must not be a non-loopback IP literal (v4 or v6):
//     provider/push endpoints are named services, and a bare public
//     IP is the shape credential-exfiltration and SSRF probes take.
export function validateServiceUrl(u) {
  if (typeof u !== "string")
    return null;
  const s = u.trim();
  if (!s)
    return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.username || url.password)
    return null;
  if (url.hash)
    return null;
  // url.hostname is parser-normalized (lowercased; exotic IPv4 forms
  // folded to dotted quad); IPv6 literals keep their brackets.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.protocol === "http:") {
    if (!loopback)
      return null;
  } else if (url.protocol !== "https:") {
    return null;
  }
  const isIpLiteral = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.includes(":");
  if (isIpLiteral && !loopback)
    return null;
  return s.replace(/\/+$/, "");
}
__name(validateServiceUrl, "validateServiceUrl");
export const FREE_MODES = ["all-free", "zero-price", "allowlist", "rules"];
// Normalize the composable free-model rules stored on a provider
// (freeMode "rules"): price/suffix are booleans (price defaults to
// true when the field is absent, matching the isFreeModel fallback
// for a missing freeRules); `suffix` means the model id contains the
// word "free" (case-insensitive) as a standalone word, not inside a
// longer word such as "freedom". allow is a list of model-id regexes —
// trimmed, de-duplicated, at most 50 entries of at most 80 chars,
// each required to compile. Anything malformed throws, so the
// providers POST and the backup import both reject it with a 400
// instead of storing a rule set that silently matches nothing (or
// everything).
export function normalizeFreeRules(input) {
  if (input == null)
    return { price: true, suffix: false, allow: [] };
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("freeRules 必须是对象 {price, suffix, allow}");
  const allowRaw = input.allow ?? [];
  if (!Array.isArray(allowRaw))
    throw new Error("freeRules.allow 必须是字符串数组（正则）");
  const allow = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of allowRaw) {
    if (typeof item !== "string")
      throw new Error("freeRules.allow 必须是字符串数组（正则）");
    const re = item.trim();
    if (!re || seen.has(re))
      continue;
    if (re.length > 80)
      throw new Error(`freeRules.allow 中的正则过长（≤80 字符）：${re.slice(0, 40)}…`);
    try {
      new RegExp(re, "i");
    } catch {
      throw new Error(`freeRules.allow 中的正则不合法：${re}`);
    }
    seen.add(re);
    allow.push(re);
  }
  if (allow.length > 50)
    throw new Error("freeRules.allow 最多 50 条");
  return {
    price: input.price == null ? true : !!input.price,
    suffix: !!input.suffix,
    allow
  };
}
__name(normalizeFreeRules, "normalizeFreeRules");
// A provider's usage "today" is counted from midnight on the
// clock its own free quota resets on, expressed as a fixed UTC
// offset in minutes (480 = UTC+8, the gateway default; 0 = UTC).
// Anything outside the real-world offset range is rejected at
// save time like other malformed provider fields.
export function normalizeResetOffset(v) {
  if (v == null)
    return 480;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -720 || n > 840)
    throw new Error("resetOffsetMin 须为 -720..840 之间的分钟数（相对 UTC 的偏移）");
  return Math.round(n);
}
__name(normalizeResetOffset, "normalizeResetOffset");
// Model mapping table: {requested model: upstream model}, stored
// on a provider. Keys are folded to lowercase for matching
// (upstream names are case-sensitive, so values are used as-is).
// At most 200 entries; keys and values are non-empty strings of
// at most 120 chars. Two keys differing only by case are rejected,
// and a static cycle in the directed graph is rejected naming the
// cycle nodes; a self-map (a→a) is allowed and terminates the
// walk. Anything malformed throws, so the providers POST and the
// backup import both reject it with a 400 instead of storing a
// mapping that silently loops or collides.
export function normalizeModelMapping(input) {
  if (input == null)
    return {};
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("modelMapping 必须是对象 {请求模型: 上游模型}");
  const rawEntries = Object.entries(input);
  if (rawEntries.length > 200)
    throw new Error("modelMapping 最多 200 条");
  const out = {};
  for (const [k, v] of rawEntries) {
    if (typeof k !== "string" || !k.trim())
      throw new Error("modelMapping 的键须为非空字符串");
    if (typeof v !== "string" || !v.trim())
      throw new Error(`modelMapping 的值须为非空字符串：${k}`);
    if (k.trim().length > 120)
      throw new Error(`modelMapping 的键过长（≤120 字符）：${k.trim().slice(0, 40)}…`);
    if (v.trim().length > 120)
      throw new Error(`modelMapping 的值过长（≤120 字符）：${k.trim()}`);
    const lk = k.trim().toLowerCase();
    if (Object.hasOwn(out, lk))
      throw new Error(`modelMapping 的键大小写冲突：${k.trim()} 与已有键仅大小写不同`);
    out[lk] = v.trim();
  }
  // Static cycle detection over the directed graph: an edge from a
  // key to the key its value resolves to (exact match first, then
  // the baseName fallback the runtime walk uses — the same
  // resolution as resolveUpstreamModel). A self-map resolves to
  // its own key and terminates, so it is not a cycle.
  const nextKey = (k) => {
    const v = out[k];
    if (v == null)
      return null;
    const lv = v.toLowerCase();
    if (Object.hasOwn(out, lv))
      return lv;
    const b = baseName(v).toLowerCase();
    return Object.hasOwn(out, b) ? b : null;
  };
  for (const start of Object.keys(out)) {
    const path = [start];
    const seen = /* @__PURE__ */ new Set([start]);
    let cur = start;
    for (;;) {
      const nx = nextKey(cur);
      if (nx === null || nx === cur)
        break;
      if (seen.has(nx)) {
        const idx = path.indexOf(nx);
        throw new Error(`modelMapping 存在环：${[...path.slice(idx), nx].join(" → ")}`);
      }
      seen.add(nx);
      path.push(nx);
      cur = nx;
    }
  }
  return out;
}
__name(normalizeModelMapping, "normalizeModelMapping");
// Routing priority tier for a provider: higher serves first, as a
// hard layer above weights (not a weight tweak). Absent -> 0, the
// tier every provider is in by default, which keeps routing
// identical to before until an operator sets one.
export function normalizePriority(v) {
  if (v == null)
    return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < -100 || n > 100)
    throw new Error("priority 须为 -100..100 之间的整数");
  return n;
}
__name(normalizePriority, "normalizePriority");
// A value is JSON-safe when it round-trips through JSON
// unchanged: plain objects / arrays / strings / finite numbers /
// booleans / null only — no undefined, functions, symbols,
// bigints, non-finite numbers, or cycles (JSON.stringify would
// silently drop or rewrite those). Shared by the override-rule
// value checks below.
function assertJsonSafe(value, what) {
  const seen = new Set();
  const walk = (v) => {
    if (v === null)
      return;
    const t = typeof v;
    if (t === "string" || t === "boolean")
      return;
    if (t === "number") {
      if (!Number.isFinite(v))
        throw new Error(`${what} 须为 JSON 安全值（不允许非有限数字）`);
      return;
    }
    if (Array.isArray(v)) {
      if (seen.has(v))
        throw new Error(`${what} 须为 JSON 安全值（不允许循环引用）`);
      seen.add(v);
      for (const item of v)
        walk(item);
      seen.delete(v);
      return;
    }
    if (t === "object") {
      if (seen.has(v))
        throw new Error(`${what} 须为 JSON 安全值（不允许循环引用）`);
      seen.add(v);
      for (const [k, item] of Object.entries(v))
        walk(item);
      seen.delete(v);
      return;
    }
    throw new Error(`${what} 须为 JSON 安全值（不允许 ${t} 类型）`);
  };
  walk(value);
  let s;
  try {
    s = JSON.stringify(value);
  } catch {
    throw new Error(`${what} 须为 JSON 安全值（无法序列化）`);
  }
  if (s === void 0 || s.length > 4096)
    throw new Error(`${what} 序列化后须 ≤ 4 KB`);
}
__name(assertJsonSafe, "assertJsonSafe");
// A dot path into a JSON body: segments of letters, digits, "_"
// or "-" (a numeric segment is an array index). No wildcards in
// v1. Header-op paths are header names instead (letters, digits,
// "-" only); both share the non-empty / ≤120-char limits.
function assertValidPath(path, what) {
  if (typeof path !== "string" || !path.trim())
    throw new Error(`${what} 须为非空字符串`);
  const p = path.trim();
  if (p.length > 120)
    throw new Error(`${what} 过长（≤120 字符）：${p.slice(0, 40)}…`);
  for (const seg of p.split(".")) {
    if (!/^[A-Za-z0-9_-]+$/.test(seg))
      throw new Error(`${what} 不合法（点分路径，每段只允许字母/数字/_/-，v1 不支持通配符）：${p}`);
  }
  return p;
}
__name(assertValidPath, "assertValidPath");
function assertValidHeaderName(path, what) {
  if (typeof path !== "string" || !path.trim())
    throw new Error(`${what} 须为非空字符串`);
  const p = path.trim();
  if (p.length > 120)
    throw new Error(`${what} 过长（≤120 字符）：${p.slice(0, 40)}…`);
  if (!/^[A-Za-z0-9-]+$/.test(p))
    throw new Error(`${what} 须为合法请求头名：${p}`);
  return p;
}
__name(assertValidHeaderName, "assertValidHeaderName");
// Per-provider parameter rewrite rules (paramOverrides): an
// array of at most 30 rules {op, path, value?, from?, to?, when?}.
// Each op's required fields are checked here so a bad rule is a
// 400 at save time, never a silently-skipped rule at send time.
// Header ops may never target the auth headers (hard blocklist,
// enforced again at runtime). Anything malformed throws, so the
// providers POST and the backup import both reject it with a 400.
export function normalizeParamOverrides(input) {
  if (input == null)
    return [];
  if (!Array.isArray(input))
    throw new Error("paramOverrides 必须是数组");
  if (input.length > 30)
    throw new Error("paramOverrides 最多 30 条");
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("paramOverrides 的每条规则须为对象 {op, path, ...}");
    const op = raw.op;
    if (typeof op !== "string" || !OVERRIDE_OPS.has(op))
      throw new Error(`paramOverrides 的 op 不合法：${String(op)}（须为 ${[...OVERRIDE_OPS].join(" / ")} 之一）`);
    const isHeader = op === "set_header" || op === "delete_header";
    const path = isHeader ? assertValidHeaderName(raw.path, "paramOverrides.path") : assertValidPath(raw.path, "paramOverrides.path");
    if (isHeader && BLOCKED_HEADERS.has(path.toLowerCase()))
      throw new Error(`paramOverrides 不得改写鉴权请求头：${path}`);
    const rule = { op, path };
    const needValue = ["set", "prepend", "append", "trim_prefix", "trim_suffix", "ensure_prefix", "ensure_suffix"].includes(op);
    if (needValue) {
      if (!("value" in raw) || raw.value === void 0)
        throw new Error(`paramOverrides 的 ${op} 规则须带 value`);
      assertJsonSafe(raw.value, `paramOverrides.${op}.value`);
      rule.value = raw.value;
    }
    if (op === "set_header") {
      if (typeof raw.value !== "string")
        throw new Error("paramOverrides 的 set_header 规则 value 须为字符串");
      rule.value = raw.value;
    }
    if (op === "move" || op === "copy") {
      if (typeof raw.to !== "string" || !raw.to.trim())
        throw new Error(`paramOverrides 的 ${op} 规则须带目标路径 to`);
      rule.to = assertValidPath(raw.to, `paramOverrides.${op}.to`);
    }
    if (op === "replace") {
      if (typeof raw.from !== "string" || !raw.from)
        throw new Error("paramOverrides 的 replace 规则须带非空字符串 from");
      if (typeof raw.to !== "string")
        throw new Error("paramOverrides 的 replace 规则须带字符串 to");
      rule.from = raw.from;
      rule.to = raw.to;
    }
    if (op === "regex_replace") {
      if (typeof raw.from !== "string" || !raw.from)
        throw new Error("paramOverrides 的 regex_replace 规则须带非空正则 from");
      if (raw.from.length > 200)
        throw new Error("paramOverrides 的 regex_replace 正则过长（≤200 字符）");
      try {
        new RegExp(raw.from);
      } catch {
        throw new Error(`paramOverrides 的 regex_replace 正则不合法：${raw.from}`);
      }
      if (typeof raw.to !== "string")
        throw new Error("paramOverrides 的 regex_replace 规则须带字符串 to");
      rule.from = raw.from;
      rule.to = raw.to;
    }
    if (op === "trim_prefix" || op === "trim_suffix" || op === "ensure_prefix" || op === "ensure_suffix") {
      if (typeof raw.value !== "string")
        throw new Error(`paramOverrides 的 ${op} 规则 value 须为字符串`);
    }
    if (raw.when != null) {
      const w = raw.when;
      if (!w || typeof w !== "object" || Array.isArray(w))
        throw new Error("paramOverrides.when 须为对象 {path, op, value, invert?}");
      const wpath = assertValidPath(w.path, "paramOverrides.when.path");
      if (typeof w.op !== "string" || !["eq", "contains", "regex", "gt", "lt"].includes(w.op))
        throw new Error(`paramOverrides.when.op 不合法：${String(w.op)}（须为 eq / contains / regex / gt / lt 之一）`);
      if (!("value" in w) || w.value === void 0)
        throw new Error("paramOverrides.when 须带 value");
      assertJsonSafe(w.value, "paramOverrides.when.value");
      if (w.op === "regex") {
        if (typeof w.value !== "string")
          throw new Error("paramOverrides.when 的 regex 条件 value 须为字符串");
        if (w.value.length > 200)
          throw new Error("paramOverrides.when 的 regex 过长（≤200 字符）");
        try {
          new RegExp(w.value);
        } catch {
          throw new Error(`paramOverrides.when 的 regex 不合法：${w.value}`);
        }
      }
      const when = { path: wpath, op: w.op, value: w.value };
      if (w.invert != null) {
        if (typeof w.invert !== "boolean")
          throw new Error("paramOverrides.when.invert 须为布尔值");
        when.invert = w.invert;
      }
      rule.when = when;
    }
    out.push(rule);
  }
  return out;
}
__name(normalizeParamOverrides, "normalizeParamOverrides");
// Default-strip allowlist (allowFields): only values from
// DEFAULT_STRIP_FIELDS, at most 10. Anything else throws, so the
// providers POST and the backup import both reject it with a 400.
export function normalizeAllowFields(input) {
  if (input == null)
    return [];
  if (!Array.isArray(input))
    throw new Error("allowFields 必须是字符串数组");
  if (input.length > 10)
    throw new Error("allowFields 最多 10 条");
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (typeof item !== "string" || !DEFAULT_STRIP_FIELDS.includes(item))
      throw new Error(`allowFields 只允许 ${DEFAULT_STRIP_FIELDS.join(" / ")} 中的值：${String(item)}`);
    if (seen.has(item))
      continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
__name(normalizeAllowFields, "normalizeAllowFields");
export function applyPreset(input) {
  const preset = input.preset ? PRESETS[input.preset] : void 0;
  const base = preset ?? {};
  const now = Date.now();
  const merged = {
    id: input.id,
    preset: input.preset && PRESETS[input.preset] ? input.preset : "",
    label: input.label ?? base.label ?? input.id,
    kind: input.kind ?? base.kind ?? "openai",
    baseUrl: (input.baseUrl ?? base.baseUrl ?? "").replace(/\/+$/, ""),
    keys: input.keys ?? [],
    enabled: input.enabled ?? true,
    weight: input.weight ?? 1,
    priority: normalizePriority(input.priority ?? base.priority),
    freeMode: input.freeMode ?? base.freeMode ?? "all-free",
    freeRules: normalizeFreeRules(input.freeRules ?? base.freeRules),
    modelMapping: normalizeModelMapping(input.modelMapping ?? base.modelMapping),
    allow: input.allow ?? base.allow,
    deny: input.deny ?? base.deny,
    headers: input.headers ?? base.headers,
    dailyLimitDefault: input.dailyLimitDefault ?? base.dailyLimitDefault ?? 0,
    rpmDefault: input.rpmDefault ?? base.rpmDefault ?? 0,
    resetOffsetMin: normalizeResetOffset(input.resetOffsetMin ?? base.resetOffsetMin),
    modelsPath: input.modelsPath ?? base.modelsPath ?? "/models",
    streamUsage: input.streamUsage ?? base.streamUsage ?? true,
    dropParams: input.dropParams ?? base.dropParams,
    paramOverrides: normalizeParamOverrides(input.paramOverrides ?? base.paramOverrides),
    allowFields: normalizeAllowFields(input.allowFields ?? base.allowFields),
    notes: input.notes,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  };
  if (!merged.baseUrl)
    throw new Error(`provider ${input.id} \u7F3A\u5C11 baseUrl\uFF08\u4E14\u6CA1\u6709\u5339\u914D\u7684\u9884\u8BBE\uFF09`);
  if (!FREE_MODES.includes(merged.freeMode))
    throw new Error(`provider ${input.id} 的 freeMode 不合法：${merged.freeMode}（须为 ${FREE_MODES.join(" / ")} 之一）`);
  // Stored provider credentials are sent to baseUrl (and to
  // modelsPath when it is an absolute URL) on every sync/chat, so
  // both are validated before the record can be saved — a record
  // pointing at an attacker-controlled host must not be creatable
  // via the providers POST or a backup import.
  const baseUrl = validateServiceUrl(merged.baseUrl);
  if (!baseUrl)
    throw new Error(`provider ${input.id} 的 baseUrl 不合法：须为 https:// 地址（本机回环可用 http://），不能使用 IP 字面量、内嵌凭据或 # 片段`);
  merged.baseUrl = baseUrl;
  if (typeof merged.modelsPath === "string" && /^https?:\/\//i.test(merged.modelsPath)) {
    const modelsPath = validateServiceUrl(merged.modelsPath);
    if (!modelsPath)
      throw new Error(`provider ${input.id} 的 modelsPath 不合法：绝对 URL 须为 https:// 地址（本机回环可用 http://），不能使用 IP 字面量、内嵌凭据或 # 片段`);
    merged.modelsPath = modelsPath;
  }
  return merged;
}
__name(applyPreset, "applyPreset");
