// Pages middleware: exposes the fixed backend address to the static app.
// The address comes from the Pages project variable GW_API_BASE
// (set in the Cloudflare dashboard / API for this Pages project), so the
// frontend binary never needs editing when the backend moves, and users
// cannot point the console at a different backend from the login page.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname === "/config.json") {
    const apiBase = String((context.env && context.env.GW_API_BASE) || "https://api.reply.kdns.fr").replace(/\/+$/, "");
    return new Response(JSON.stringify({ apiBase }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
  return context.next();
}
