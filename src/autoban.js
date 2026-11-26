import { __name } from "./helpers.js";
import { errorSourceFor } from "./util.js";

// Auto-ban (item 4): a key whose own account is the problem gets
// persistently disabled in the Coordinator until a probe success or
// a manual /unban revives it — instead of being retried every 5
// minutes on the breaker's schedule. The rule fires only when the
// failure's source is `channel` (auth/quota kinds, per
// errorSourceFor) AND the status is listed OR the error text
// contains a keyword. 403 is deliberately NOT in the default status
// list: it already gets a 1-hour cooldown, and some upstreams use
// it for model-level "not enabled" rejections, where banning the
// whole key would be disproportionate.
export var DEFAULT_AUTO_BAN = {
  enabled: true,
  statusCodes: [401],
  keywords: ["credit balance is too low", "exceeded your current quota", "insufficient"]
};

// Normalize a (partial) auto-ban input onto a previous config (or
// the defaults). Only fields present in `input` are applied;
// `undefined` and `null` both mean "omitted, keep the stored
// value". Throws Error (Chinese message) on malformed input; the
// admin PUT handler catches it and maps it to 400.
export function normalizeAutoBan(input, prev) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("自动封禁配置须为 JSON 对象");
  const base = {
    enabled: typeof prev?.enabled === "boolean" ? prev.enabled : DEFAULT_AUTO_BAN.enabled,
    statusCodes: Array.isArray(prev?.statusCodes) ? [...prev.statusCodes] : [...DEFAULT_AUTO_BAN.statusCodes],
    keywords: Array.isArray(prev?.keywords) ? [...prev.keywords] : [...DEFAULT_AUTO_BAN.keywords]
  };
  if (input.enabled !== undefined && input.enabled !== null) {
    if (typeof input.enabled !== "boolean")
      throw new Error("enabled 须为布尔值");
    base.enabled = input.enabled;
  }
  if (input.statusCodes !== undefined && input.statusCodes !== null) {
    if (!Array.isArray(input.statusCodes))
      throw new Error("statusCodes 须为整数数组");
    const codes = [];
    for (const c of input.statusCodes) {
      const n = Number(c);
      if (!Number.isInteger(n) || n < 400 || n > 599)
        throw new Error(`statusCodes 每一项须为 400-599 之间的整数：${String(c)}`);
      if (!codes.includes(n))
        codes.push(n);
    }
    base.statusCodes = codes;
  }
  if (input.keywords !== undefined && input.keywords !== null) {
    if (!Array.isArray(input.keywords))
      throw new Error("keywords 须为字符串数组");
    if (input.keywords.length > 10)
      throw new Error("keywords 最多 10 条");
    const seen = new Set();
    const words = [];
    for (const k of input.keywords) {
      if (typeof k !== "string" || !k.trim())
        throw new Error("keywords 每一项须为非空字符串");
      const t = k.trim().toLowerCase();
      if (t.length > 80)
        throw new Error(`keywords 每一项最多 80 字符：${t.slice(0, 40)}…`);
      if (!seen.has(t)) {
        seen.add(t);
        words.push(t);
      }
    }
    base.keywords = words;
  }
  return base;
}
__name(normalizeAutoBan, "normalizeAutoBan");

// The ban decision for one failure. Pure function (unit-tested):
// {kind, status, error} + config -> {banned: "auto", reason} or
// null. `reason` is the matched status ("401") or the matched
// keyword, exactly what lands in the Coordinator's banReason.
// `error` is the upstream error text (already truncated by the
// caller); matching is a lowercase substring test.
export function shouldAutoBan({ kind, status, error }, cfg) {
  const c = cfg ?? DEFAULT_AUTO_BAN;
  if (!c.enabled)
    return null;
  if (errorSourceFor(kind, status).source !== "channel")
    return null;
  const st = Number(status);
  if (Array.isArray(c.statusCodes) && c.statusCodes.includes(st))
    return { banned: "auto", reason: String(st) };
  const text = typeof error === "string" ? error.toLowerCase() : "";
  if (text) {
    for (const kw of c.keywords ?? []) {
      if (typeof kw === "string" && kw && text.includes(kw.toLowerCase()))
        return { banned: "auto", reason: kw };
    }
  }
  return null;
}
__name(shouldAutoBan, "shouldAutoBan");
