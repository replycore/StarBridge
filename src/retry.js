import { __name } from "./helpers.js";
import { errorSourceFor, upstreamErrorMeta } from "./util.js";

// Retry decision table + configurable status-code retry policy.
// Pure functions only; the pick loops in router.js / passthrough.js
// call decideRetry() after each failure, and the admin endpoints in
// admin.js read/write the stored policy. Defaults reproduce the
// pre-table behavior (decision 10: current behavior wins over the
// table): retryRanges covers the status shapes the loops already
// retried (429 rate_limit, 408/504 timeout, 5xx server); bad_param
// (400/422) and model_gone (404) never reach this table — the loops
// handle them with kind rules first.
export var DEFAULT_RETRY_POLICY = { retryRanges: "429,408,500-599", skipRanges: "", skipCodes: ["content_filter"] };

// Parse a status-code range string like "429,408,500-599" into
// [{min, max}, ...]. "" (or all-whitespace) is the empty list.
// Invalid -> {ok:false, error} (Chinese message, normalizeFreeRules
// style): empty segment, non-integer, lo > hi, code outside 100-599.
export function parseStatusRanges(s) {
  if (typeof s !== "string")
    return { ok: false, error: "状态码范围须为字符串" };
  const t = s.trim();
  if (!t)
    return { ok: true, ranges: [] };
  const ranges = [];
  for (const rawSeg of t.split(",")) {
    const seg = rawSeg.trim();
    if (!seg)
      return { ok: false, error: `状态码范围不合法：存在空段（"${s}"）` };
    const parts = seg.split("-");
    if (parts.length > 2)
      return { ok: false, error: `状态码范围不合法：${seg}` };
    const nums = [];
    for (const p of parts) {
      const pp = p.trim();
      if (!/^\d+$/.test(pp))
        return { ok: false, error: `状态码范围不合法：${seg} 不是整数` };
      nums.push(Number(pp));
    }
    const lo = nums[0];
    const hi = nums.length === 2 ? nums[1] : nums[0];
    if (lo > hi)
      return { ok: false, error: `状态码范围不合法：${seg} 下限大于上限` };
    if (lo < 100 || hi > 599)
      return { ok: false, error: `状态码范围不合法：${seg} 超出 100-599` };
    ranges.push({ min: lo, max: hi });
  }
  return { ok: true, ranges };
}
__name(parseStatusRanges, "parseStatusRanges");
function rangesContain(str, status) {
  const parsed = parseStatusRanges(str);
  if (!parsed.ok)
    return false;
  return parsed.ranges.some((r) => status >= r.min && status <= r.max);
}
__name(rangesContain, "rangesContain");

// Normalize a (partial) retry-policy input onto a previous policy
// (or the defaults). Only fields present in `input` are applied;
// `undefined` and `null` both mean "omitted, keep the stored value".
// Throws Error (Chinese message) on malformed input; the admin PUT
// handler catches it and maps it to 400 {ok:false, error}.
export function normalizeRetryPolicy(input, prev) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("重试策略须为 JSON 对象");
  const base = {
    retryRanges: typeof prev?.retryRanges === "string" ? prev.retryRanges : DEFAULT_RETRY_POLICY.retryRanges,
    skipRanges: typeof prev?.skipRanges === "string" ? prev.skipRanges : DEFAULT_RETRY_POLICY.skipRanges,
    skipCodes: Array.isArray(prev?.skipCodes) ? [...prev.skipCodes] : [...DEFAULT_RETRY_POLICY.skipCodes]
  };
  if (input.retryRanges !== undefined && input.retryRanges !== null) {
    if (typeof input.retryRanges !== "string")
      throw new Error("retryRanges 须为字符串，如 \"429,408,500-599\"");
    const parsed = parseStatusRanges(input.retryRanges);
    if (!parsed.ok)
      throw new Error(parsed.error);
    base.retryRanges = input.retryRanges.trim();
  }
  if (input.skipRanges !== undefined && input.skipRanges !== null) {
    if (typeof input.skipRanges !== "string")
      throw new Error("skipRanges 须为字符串，如 \"404\"");
    const parsed = parseStatusRanges(input.skipRanges);
    if (!parsed.ok)
      throw new Error(parsed.error);
    base.skipRanges = input.skipRanges.trim();
  }
  if (input.skipCodes !== undefined && input.skipCodes !== null) {
    if (!Array.isArray(input.skipCodes))
      throw new Error("skipCodes 须为字符串数组");
    if (input.skipCodes.length > 20)
      throw new Error("skipCodes 最多 20 条");
    const seen = new Set();
    const codes = [];
    for (const c of input.skipCodes) {
      if (typeof c !== "string" || !c.trim())
        throw new Error("skipCodes 每一项须为非空字符串");
      const t = c.trim();
      if (t.length > 64)
        throw new Error("skipCodes 每一项最多 64 个字符");
      if (!seen.has(t)) {
        seen.add(t);
        codes.push(t);
      }
    }
    base.skipCodes = codes;
  }
  return base;
}
__name(normalizeRetryPolicy, "normalizeRetryPolicy");

// The retry decision table. Input:
// {kind, status, source, skipRetry, attemptsLeft, pinned,
//  strictAffinity, errorCode, policy}
// source / skipRetry / errorCode are derived from kind (+ status)
// via errorSourceFor / upstreamErrorMeta when omitted. Missing
// attemptsLeft means unlimited. Missing policy means the defaults.
// Returns {retry, reason} only. Steps are evaluated in order, first
// match wins:
//  1 strictAffinity -> stop / strict_session
//  2 pinned -> stop / pinned_channel
//  3 skipRetry -> stop / non_retryable_error
//  4 source == "channel" -> retry / channel_error
//  5 attemptsLeft <= 0 -> stop / attempt_budget_exhausted
//  6 status 2xx -> stop / system_retry_exclusion
//  7 status < 100 || > 599 -> retry / unrecognized_status
//  8 status in skipRanges OR errorCode in skipCodes -> stop /
//    system_retry_exclusion
//  9 status in retryRanges -> retry / retry_status_matched
// 10 else -> stop / status_not_retryable
// Step 4 deliberately precedes step 5: a channel error with an
// exhausted budget still returns retry:true; the loop-top
// `attempts >= maxAttempts` check is the hard enforcement.
export function decideRetry(input) {
  const inp = input && typeof input === "object" ? input : {};
  const kind = inp.kind;
  const status = Number.isFinite(inp.status) ? inp.status : 0;
  const policy = {
    retryRanges: typeof inp.policy?.retryRanges === "string" ? inp.policy.retryRanges : DEFAULT_RETRY_POLICY.retryRanges,
    skipRanges: typeof inp.policy?.skipRanges === "string" ? inp.policy.skipRanges : DEFAULT_RETRY_POLICY.skipRanges,
    skipCodes: Array.isArray(inp.policy?.skipCodes) ? inp.policy.skipCodes : DEFAULT_RETRY_POLICY.skipCodes
  };
  const derived = errorSourceFor(kind, status);
  const source = inp.source ?? derived.source;
  const skipRetry = inp.skipRetry ?? derived.skipRetry;
  const errorCode = inp.errorCode ?? upstreamErrorMeta(kind).code;
  const attemptsLeft = Number.isFinite(inp.attemptsLeft) ? Math.floor(inp.attemptsLeft) : undefined;
  const pinned = Boolean(inp.pinned);
  const strictAffinity = Boolean(inp.strictAffinity);
  if (strictAffinity)
    return { retry: false, reason: "strict_session" };
  if (pinned)
    return { retry: false, reason: "pinned_channel" };
  if (skipRetry)
    return { retry: false, reason: "non_retryable_error" };
  if (source === "channel")
    return { retry: true, reason: "channel_error" };
  if (attemptsLeft !== undefined && attemptsLeft <= 0)
    return { retry: false, reason: "attempt_budget_exhausted" };
  if (status >= 200 && status <= 299)
    return { retry: false, reason: "system_retry_exclusion" };
  if (status < 100 || status > 599)
    return { retry: true, reason: "unrecognized_status" };
  if (rangesContain(policy.skipRanges, status) || policy.skipCodes.includes(errorCode))
    return { retry: false, reason: "system_retry_exclusion" };
  if (rangesContain(policy.retryRanges, status))
    return { retry: true, reason: "retry_status_matched" };
  return { retry: false, reason: "status_not_retryable" };
}
__name(decideRetry, "decideRetry");
