import { __name } from "./helpers.js";
import { loadGatewayKeys } from "./store.js";
import { timingSafeEqual } from "./util.js";

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
  // Header-only auth (Bearer / x-api-key). The backend serves no
  // pages, so credentials never travel in a URL or a cookie.
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
  if (kvKeys.some((k) => timingSafeEqual(k.key, token)))
    return { ok: true };
  if (base.reason === "unconfigured" && kvKeys.length)
    return { ok: false, reason: "invalid" };
  return base;
}
__name(checkGatewayToken, "checkGatewayToken");
