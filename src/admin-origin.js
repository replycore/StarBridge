import { CORS } from "./util.js";
import { __name } from "./helpers.js";
import { openAIError } from "./util.js";

// ADMIN_ORIGIN (comma-separated allowlist, e.g.
// "https://console.example.com,https://free-ai-gateway-admin.pages.dev")
// verifies that browser calls to /admin/api/* really come from the
// deployed frontend. Requests without an Origin header (curl, scripts)
// are not origin-checked; the Bearer ADMIN_TOKEN is still required.
export function adminOrigins(env) {
  return (env.ADMIN_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}
__name(adminOrigins, "adminOrigins");
export function originAllowed(env, req) {
  const origin = req.headers.get("origin");
  if (!origin)
    return true;
  // No Origin header = a script/curl caller, which CORS does not
  // govern anyway. But a browser request while ADMIN_ORIGIN is
  // unconfigured must fail closed: otherwise any web page could
  // drive the admin API with a token stored in the victim's browser.
  const list = adminOrigins(env);
  if (!list.length)
    return false;
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
