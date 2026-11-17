import { __name } from "./helpers.js";
import { json } from "./util.js";

export async function coordFetch(env, path, body) {
  const stub = env.COORD.get(env.COORD.idFromName("global"));
  const res = await stub.fetch(`https://coordinator${path}`, {
    method: body === void 0 ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok)
    throw new Error(`coordinator ${path} -> HTTP ${res.status}`);
  return await res.json();
}
__name(coordFetch, "coordFetch");
