import { __name } from "./helpers.js";

export var CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-version,x-gw-session,x-request-id",
  "access-control-max-age": "86400"
};
export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  for (const [k, v] of Object.entries(CORS))
    headers.set(k, v);
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}
__name(json, "json");
export function openAIError(status, message, type = "gateway_error", extra = {}) {
  return json(
    { error: { message, type, code: status, ...extra } },
    { status }
  );
}
__name(openAIError, "openAIError");
export function noCapacityError(order, candidates) {
  let hint = "\u53ef\u4ee5\u7b49 UTC \u6b21\u65e5\u989d\u5ea6\u91cd\u7f6e\uff0c\u6216\u901a\u8fc7 POST /admin/api/reset \u6e05\u7a7a\u5065\u5eb7\u72b6\u600c";
  let retryAfterSec = 0;
  if (order && order.blockedUntil) {
    retryAfterSec = Math.max(1, Math.ceil((order.blockedUntil - Date.now()) / 1e3));
    hint = order.blockedReason === "quota"
      ? "\u5019\u9009 Key \u7684\u6bcf\u65e5\u989d\u5ea6\u5df2\u7528\u5b8c\uff0c\u53ef\u4ee5\u7b49 UTC \u6b21\u65e5\u989d\u5ea6\u91cd\u7f6e\uff0c\u6216\u6362\u7528\u5176\u5b83\u6a21\u578b"
      : `\u6240\u6709\u5019\u9009\u90fd\u5728\u51b7\u5374\u4e2d\uff0c\u6700\u65e9\u7ea6 ${retryAfterSec} \u79d2\u540e\u6062\u590d\uff1b\u5efa\u8bae\u6309 Retry-After \u9000\u907f\u91cd\u8bd5\uff0c\u6216\u6362\u7528\u5176\u5b83\u6a21\u578b`;
  } else if (order && order.blockedReason === "key_invalid") {
    hint = "\u5019\u9009 Key \u5df2\u88ab\u6807\u8bb0\u5931\u6548\uff0c\u8bf7\u5728\u7ba1\u7406\u540e\u53f0\u68c0\u67e5\u670d\u52a1\u5546 Key\uff0c\u6216\u901a\u8fc7 POST /admin/api/reset \u6e05\u7a7a\u5065\u5eb7\u72b6\u600c";
  }
  const res = openAIError(503, "\u6240\u6709\u5019\u9009\u6a21\u578b / Key \u5f53\u524d\u90fd\u4e0d\u53ef\u7528\uff08\u989d\u5ea6\u8017\u5c3d\u6216\u5904\u4e8e\u51b7\u5374\u671f\uff09", "no_capacity", {
    candidates: (candidates || []).slice(0, 10),
    ...(retryAfterSec ? { retry_after: retryAfterSec } : {}),
    hint
  });
  if (retryAfterSec)
    res.headers.set("Retry-After", String(retryAfterSec));
  return res;
}
__name(noCapacityError, "noCapacityError");
export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}
__name(preflight, "preflight");
export function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
__name(utcDay, "utcDay");
export function localDay(ts = Date.now()) {
  return new Date(ts + 8 * 36e5).toISOString().slice(0, 10);
}
__name(localDay, "localDay");
export function nextUtcMidnight(ts = Date.now()) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}
__name(nextUtcMidnight, "nextUtcMidnight");
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
__name(clamp, "clamp");
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
__name(sleep, "sleep");
export function withTimeout(p, ms, fallback) {
  return Promise.race([p.catch(() => fallback), sleep(ms).then(() => fallback)]);
}
__name(withTimeout, "withTimeout");
export function parseRetryAfter(h) {
  if (!h)
    return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0)
    return Math.min(secs * 1e3, 6 * 36e5);
  const date = Date.parse(h);
  if (Number.isFinite(date))
    return clamp(date - Date.now(), 0, 6 * 36e5);
  return null;
}
__name(parseRetryAfter, "parseRetryAfter");
export function timingSafeEqual(a, b) {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  if (ae.length !== be.length) {
    let diff2 = 1;
    for (let i = 0; i < ae.length; i++)
      diff2 |= ae[i] ^ be[i % (be.length || 1)];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ae.length; i++)
    diff |= ae[i] ^ be[i];
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
export function maskKey(k) {
  if (!k)
    return "";
  if (k.length <= 12)
    return k.slice(0, 3) + "***";
  return `${k.slice(0, 6)}\u2026${k.slice(-4)}`;
}
__name(maskKey, "maskKey");
export function truncate(s, n) {
  if (!s)
    return "";
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}
__name(truncate, "truncate");
export function randomId(prefix = "") {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + hex;
}
__name(randomId, "randomId");
export function extractParam(text) {
  if (!text)
    return void 0;
  // Structured error bodies usually name the offending field directly;
  // read it before falling back to message patterns. The patterns are
  // then tried on an unescaped copy of the text as well as the raw text,
  // because a JSON-encoded body escapes its quotes (\"thinking\") and
  // the quote-anchored patterns would otherwise never match.
  try {
    const j = JSON.parse(text);
    const p = j?.error?.param ?? j?.param;
    if (typeof p === "string" && p && p.length <= 64 && !["model", "messages", "input", "contents", "prompt"].includes(p))
      return p;
  } catch {
  }
  const patterns = [
    /(?:unsupported|unknown|unrecognized|unexpected|invalid|extra)\s+(?:parameter|field|argument|property|key)s?\s*[:=]?\s*["'`]?([a-zA-Z0-9_.]+)/i,
    /(?:argument|parameter|field|property)s?\s+(?:supplied|provided|given)\s*[:=]?\s*["'`]?([a-zA-Z0-9_.]+)/i,
    /["'`]([a-zA-Z0-9_.]+)["'`]\s+(?:is not supported|not supported|is not allowed|isn't supported)/i,
    /additional propert(?:y|ies)\s+["'`]([a-zA-Z0-9_.]+)["'`]/i,
    /(?:parameter|param)\s+["'`]([a-zA-Z0-9_.]+)["'`]/i,
    /(?:does not support|not support)\s+["'`]([a-zA-Z0-9_.]+)["'`]/i
  ];
  const variants = [text.replace(/\\"/g, '"').replace(/\\'/g, "'"), text];
  for (const variant of variants) {
    for (const re of patterns) {
      const m = variant.match(re);
      if (m && m[1]) {
        const p = m[1].replace(/^["'`]|["'`]$/g, "");
        if (["model", "messages", "input", "contents", "prompt"].includes(p))
          continue;
        if (p.length > 64)
          continue;
        return p;
      }
    }
  }
  return void 0;
}
__name(extractParam, "extractParam");
export function isContextError(text) {
  return /(context|token limit|too long|maximum context|prompt is too long)/.test((text || "").toLowerCase());
}
__name(isContextError, "isContextError");
// Rough request-size estimate in tokens. Used only to prefer endpoints
// whose context window can hold the request, never to reject one: CJK
// chars count ~1 token each, other text ~4 chars per token, images a
// flat 1000 tokens each. The requested output budget is added, capped
// so a huge max_tokens cannot disqualify every endpoint.
export function estimateRequestTokens(body) {
  let chars = 0, cjk = 0, images = 0;
  const scan = (s) => {
    if (typeof s !== "string")
      return;
    chars += s.length;
    const m = s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    if (m)
      cjk += m.length;
  };
  const walkContent = (c) => {
    if (typeof c === "string") {
      scan(c);
      return;
    }
    if (Array.isArray(c))
      for (const p of c) {
        if (!p || typeof p !== "object")
          continue;
        if (typeof p.text === "string")
          scan(p.text);
        if (p.type === "image_url" || p.type === "image")
          images++;
      }
  };
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const msg of msgs) {
    if (!msg || typeof msg !== "object")
      continue;
    walkContent(msg.content);
    if (Array.isArray(msg.tool_calls))
      for (const tc of msg.tool_calls) {
        scan(tc?.function?.name);
        scan(tc?.function?.arguments);
      }
  }
  if (body?.tools) {
    try {
      scan(JSON.stringify(body.tools));
    } catch {
    }
  }
  if (typeof body?.system === "string")
    scan(body.system);
  let est = Math.ceil((chars - cjk) / 4) + cjk + images * 1e3 + msgs.length * 4;
  const want = Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0);
  if (Number.isFinite(want) && want > 0)
    est += Math.min(want, 16384);
  return est;
}
__name(estimateRequestTokens, "estimateRequestTokens");
export function classify(status, body) {
  const t = (body || "").toLowerCase();
  if (status === 402)
    return "quota";
  if (status === 429) {
    if (/(rate_limit|too many requests|retry (in|after)|per[ -]?minute|requests per|nothing is used up)/.test(t)) {
      return "rate_limit";
    }
    if (/(quota|insufficient|exceeded your current quota|billing|credit|daily limit|free tier)/.test(t))
      return "quota";
    return "rate_limit";
  }
  if (status === 401 || status === 403)
    return "auth";
  if (status === 404)
    return "model_gone";
  if (status === 400 || status === 422) {
    if (/(model.*(not found|does not exist|doesn't exist|not exist|unsupported|decommission|deprecat|retired|no longer|shut down|unavailable))/.test(
      t
    ) || /(no such model|unknown model|invalid model)/.test(t) || // 聚合站常见：模型在列表里但没有可用渠道（如 aihubmix 的 no_available_channel）
    /(no_available_channel|cannot be served|no channel available)/.test(t)) {
      return "model_gone";
    }
    if (isContextError(t))
      return "bad_param";
    if (/(param|field|argument|propert|unsupported|unknown|not supported|invalid)/.test(t))
      return "bad_param";
    return "bad_param";
  }
  if (status === 408 || status === 504)
    return "timeout";
  if (status >= 500)
    return "server";
  return "unknown";
}
__name(classify, "classify");
export function classifyThrown(e) {
  const msg = String(e?.message ?? e ?? "").toLowerCase();
  if (msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out"))
    return "timeout";
  if (msg.includes("blocked") || msg.includes("content_filter") || msg.includes("safety"))
    return "content";
  if (msg.includes("network") || msg.includes("fetch") || msg.includes("connect"))
    return "network";
  return "network";
}
__name(classifyThrown, "classifyThrown");
export function parseSSE(input) {
  const decoder = new TextDecoder();
  let buffer = "";
  return input.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseSSEBlock(raw);
          if (ev)
            controller.enqueue(ev);
        }
        if (buffer.length > 512e3) {
          const ev = parseSSEBlock(buffer);
          if (ev)
            controller.enqueue(ev);
          buffer = "";
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const ev = parseSSEBlock(buffer);
          if (ev)
            controller.enqueue(ev);
        }
      }
    })
  );
}
__name(parseSSE, "parseSSE");
export function parseSSEBlock(raw) {
  let event;
  const data = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":"))
      continue;
    if (line.startsWith("event:"))
      event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length && !event)
    return null;
  return { event, data: data.join("\n") };
}
__name(parseSSEBlock, "parseSSEBlock");
export function sseEncode(payload, event) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const text = (event ? `event: ${event}
` : "") + `data: ${body}

`;
  return new TextEncoder().encode(text);
}
__name(sseEncode, "sseEncode");
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
__name(deferred, "deferred");
export function base64Encode(bytes) {
  let bin = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
__name(base64Encode, "base64Encode");
export function base64Decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
__name(base64Decode, "base64Decode");
export function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
__name(safeJsonParse, "safeJsonParse");
