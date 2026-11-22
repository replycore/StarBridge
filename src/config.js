import { __name } from "./helpers.js";

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
export function applyPreset(input) {
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
