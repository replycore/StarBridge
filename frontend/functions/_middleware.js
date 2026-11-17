// Pages middleware: exposes the fixed backend address to the static app
// and sets the Content-Security-Policy for HTML responses.
//
// The address comes from the Pages project variable GW_API_BASE (set in
// the Cloudflare dashboard / API for this Pages project), so the console
// never needs editing when the backend moves, and users cannot point
// the console at a different backend from the login page. There is no
// built-in fallback address: an unset GW_API_BASE means "same origin"
// (e.g. a reverse proxy in front of the Worker), never somebody else's
// server.
//
// The CSP lives here rather than in _headers because its connect-src
// must name the configured backend origin, which only this code knows.
function cspFor(apiBase) {
  var origin = "";
  try {
    if (apiBase) origin = new URL(apiBase).origin;
  } catch (e) { /* an invalid value is treated as same-origin */ }
  var connect = ["'self'", origin, "https://cloudflareinsights.com", "http://127.0.0.1:*", "http://localhost:*"]
    .filter(Boolean).join(" ");
  return "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
    "connect-src " + connect + "; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const apiBase = String((context.env && context.env.GW_API_BASE) || "").replace(/\/+$/, "");

  if (url.pathname === "/config.json") {
    return new Response(JSON.stringify({ apiBase }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": cspFor(apiBase)
      }
    });
  }

  const res = await context.next();
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const out = new Response(res.body, res);
  out.headers.set("content-security-policy", cspFor(apiBase));
  return out;
}
