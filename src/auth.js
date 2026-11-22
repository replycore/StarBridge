import { __name } from "./helpers.js";
import { loadGatewayKeys } from "./store.js";
import { timingSafeEqual } from "./util.js";
import { coordFetch } from "./coord-client.js";

export function extractToken(req) {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer "))
    return auth.slice(7).trim();
  return req.headers.get("x-api-key") ?? req.headers.get("x-goog-api-key") ?? "";
}
__name(extractToken, "extractToken");
export function checkToken(req, env, kind) {
  const configured = (kind === "gateway" ? env.GATEWAY_TOKEN : env.ADMIN_TOKEN) ?? "";
  const allowed = configured.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length)
    return { ok: false, reason: "unconfigured" };
  // Header auth (Bearer / x-api-key / x-goog-api-key) at the admin
  // and OpenAI-compatible entry points. One deliberate exception:
  // the Gemini entry point additionally accepts a ?key= query
  // parameter, because the official Gemini SDK authenticates that
  // way (see gemini-in.js) — callers there should be aware the key
  // can land in URL logs.
  const token = extractToken(req);
  if (!token)
    return { ok: false, reason: "missing" };
  const ok = allowed.some((a) => timingSafeEqual(a, token));
  return ok ? { ok: true } : { ok: false, reason: "invalid" };
}
__name(checkToken, "checkToken");
export async function checkGatewayToken(req, env) {
  const base = checkToken(req, env, "gateway");
  if (base.ok)
    return base;
  const token = extractToken(req);
  if (!token)
    return base;
  const kvKeys = await loadGatewayKeys(env).catch(() => []);
  const hit = kvKeys.find((k) => k.revoked !== true && timingSafeEqual(k.key, token));
  if (hit)
    return { ok: true, keyId: hit.id, dailyLimit: Number(hit.dailyLimit) || 0 };
  if (base.reason === "unconfigured" && kvKeys.length)
    return { ok: false, reason: "invalid" };
  return base;
}
__name(checkGatewayToken, "checkGatewayToken");
// ---------------- Caller auth-failure throttle ----------------
// The admin API throttles failed logins per client (see admin.js);
// caller (gateway token) auth gets the same treatment at a looser
// threshold, so a leaked-key guessing loop or a misconfigured
// client hammering with a stale token is slowed down. State lives
// in the Coordinator under "gw:"-prefixed client ids, which can
// never collide with the admin throttle's raw client ids.
export var CALLER_AUTH_THRESHOLD = 60;
export async function callerClientId(req) {
  // Same keying rule as the admin throttle: only the
  // Cloudflare-injected header is trusted; without it, fall back to
  // a stable fingerprint of the caller's own headers rather than a
  // shared "unknown" bucket (and never to X-Forwarded-For, which a
  // caller could rotate to mint a fresh bucket per request).
  const cf = (req.headers.get("cf-connecting-ip") ?? "").trim();
  if (cf)
    return cf.slice(0, 128);
  try {
    const fp = (req.headers.get("user-agent") ?? "") + "\n" + (req.headers.get("accept-language") ?? "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fp));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return ("hdr-" + hex.slice(0, 24)).slice(0, 128);
  } catch {
    return "unknown";
  }
}
__name(callerClientId, "callerClientId");
// Isolate cache of "not locked" verdicts (30 s): the happy path
// must not pay a Coordinator round trip per request. Only negative
// verdicts are cached, and recording a failure invalidates the
// entry, so a client that trips the lock is seen locked on its
// very next request.
let callerClearCache = { id: null, at: 0 };
export async function checkCallerLock(env, req) {
  const id = "gw:" + (await callerClientId(req));
  const now = Date.now();
  if (callerClearCache.id === id && now - callerClearCache.at < 3e4)
    return { locked: false, fails: 0, retryAfterMs: 0, id };
  try {
    const st = await coordFetch(env, "/auth-check", { client: id, threshold: CALLER_AUTH_THRESHOLD });
    if (st?.locked)
      return { locked: true, fails: st.fails ?? 0, retryAfterMs: st.retryAfterMs ?? 0, id };
    callerClearCache = { id, at: now };
    return { locked: false, fails: st?.fails ?? 0, retryAfterMs: 0, id };
  } catch {
    // Fail open, like the admin throttle: a Coordinator outage
    // must not lock every caller out.
    return { locked: false, fails: 0, retryAfterMs: 0, id };
  }
}
__name(checkCallerLock, "checkCallerLock");
export async function noteCallerAuthFailure(env, req, idHint) {
  const id = idHint ?? "gw:" + (await callerClientId(req));
  if (callerClearCache.id === id)
    callerClearCache = { id: null, at: 0 };
  try {
    return await coordFetch(env, "/auth-fail", { client: id, threshold: CALLER_AUTH_THRESHOLD });
  } catch {
    return null;
  }
}
__name(noteCallerAuthFailure, "noteCallerAuthFailure");
