import { CORS } from "./util.js";
import { __name } from "./helpers.js";
import { openAIError } from "./util.js";

// ADMIN_ORIGIN (comma-separated allowlist, e.g.
// "https://ai.reply.kdns.fr,https://free-ai-gateway-admin.pages.dev")
// verifies that browser calls to /admin/api/* really come from the
// deployed frontend. Requests without an Origin header (curl, scripts)
// are not origin-checked; the Bearer ADMIN_TOKEN is still required.
export function adminOrigins(env) {
  return (env.ADMIN_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}
__name(adminOrigins, "adminOrigins");
export function originAllowed(env, req) {
  const list = adminOrigins(env);
  if (!list.length)
    return true;
  const origin = req.headers.get("origin");
  if (!origin)
    return true;
  return list.includes(origin.replace(/\/+$/, ""));
}
__name(originAllowed, "originAllowed");
export function adminPreflight(env, req) {
  if (!originAllowed(env, req))
    return openAIError(403, "origin not allowed", "forbidden");
  const headers = { ...CORS };
  const origin = req.headers.get("origin");
  if (origin && adminOrigins(env).length)
    headers["access-control-allow-origin"] = origin;
  return new Response(null, { status: 204, headers });
}
__name(adminPreflight, "adminPreflight");
