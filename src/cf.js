import { __name } from "./helpers.js";

// Cloudflare account analytics behind the overview's free-tier
// usage monitor. One GraphQL POST carries four aliased sub-queries
// (workers / D1 / KV / Durable Objects) for today (UTC) so far.
// Failure model: each sub-query fails independently — a per-alias
// GraphQL error (or a missing section in the response) nulls just
// that section and is noted in partialErrors. Only a transport-level
// failure (network error, non-2xx HTTP, unparseable body, top-level
// errors with no usable account data) throws, and the admin layer
// turns that into the response's error field.

const GQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const SCRIPT_NAME = "free-ai-gateway";
// The D1 database and KV namespace are found by name through the
// Cloudflare REST API, so no account-specific IDs live in the code:
// the D1 database is the one named "free-ai-gateway" and the KV
// namespace is the one wrangler created for the GW_KV binding
// ("free-ai-gateway-GW_KV"). The resolved IDs are cached in-isolate
// for an hour; if a lookup fails the d1 / kv section of the usage
// panel degrades to "unavailable" instead of failing the whole call.
const D1_DATABASE_NAME = "free-ai-gateway";
const KV_NAMESPACE_TITLE = "free-ai-gateway-GW_KV";
let resolvedIds = null;
let resolvedIdsAt = 0;
const RESOLVED_IDS_TTL_MS = 3600000;

async function resolveResourceIds(headers, accountId) {
  const now = Date.now();
  if (resolvedIds && now - resolvedIdsAt < RESOLVED_IDS_TTL_MS)
    return resolvedIds;
  const out = { d1: "", kv: "" };
  try {
    const d1res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
      headers,
      signal: AbortSignal.timeout(15000)
    });
    if (d1res.ok) {
      const d1 = await d1res.json();
      const hit = Array.isArray(d1?.result) ? d1.result.find((x) => x?.name === D1_DATABASE_NAME) : null;
      if (hit?.uuid)
        out.d1 = hit.uuid;
    }
  } catch { /* unresolved: the d1 section degrades */ }
  try {
    const kvres = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
      headers,
      signal: AbortSignal.timeout(15000)
    });
    if (kvres.ok) {
      const kv = await kvres.json();
      const hit = Array.isArray(kv?.result) ? kv.result.find((x) => x?.title === KV_NAMESPACE_TITLE) : null;
      if (hit?.id)
        out.kv = hit.id;
    }
  } catch { /* unresolved: the kv section degrades */ }
  resolvedIds = out;
  resolvedIdsAt = now;
  return out;
}
__name(resolveResourceIds, "resolveResourceIds");

// Cloudflare free-plan daily limits, returned with the usage so the
// console can draw quota bars. These are reference values for the
// free plan, not a reading of the account's actual plan.
export const CF_FREE_LIMITS = {
  workersRequestsPerDay: 100000,
  cpuMsPerInvocation: 10,
  d1RowsReadPerDay: 5000000,
  d1RowsWrittenPerDay: 100000,
  kvReadsPerDay: 100000,
  kvWritesPerDay: 1000,
  kvDeletesPerDay: 1000,
  kvListsPerDay: 1000,
  doRequestsPerDay: 100000,
  doDurationGBsPerDay: 13000
};

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
__name(round3, "round3");

// The account tag and the day boundary are interpolated into the
// query text (the analytics API's datetime filter is happiest with
// literals, and both values are strictly shaped: the tag is checked
// against the 32-hex form the config endpoint enforces, the date is
// generated here from the current time).
function buildQuery(accountId, sinceIso, d1Id, kvId) {
  return `{
  viewer {
    accounts(filter: { accountTag: "${accountId}" }) {
      workers: workersInvocationsAdaptive(limit: 1, filter: { datetime_gt: "${sinceIso}", scriptName: "${SCRIPT_NAME}" }) {
        sum { requests errors cpuTimeUs }
        quantiles { cpuTimeP99 }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { datetime_gt: "${sinceIso}", databaseId: "${d1Id}" }) {
        sum { rowsRead rowsWritten readQueries writeQueries }
      }
      kv: kvOperationsAdaptiveGroups(limit: 20, filter: { datetime_gt: "${sinceIso}", namespaceId: "${kvId}" }) {
        dimensions { actionType }
        sum { requests }
      }
      doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { datetime_gt: "${sinceIso}" }) {
        sum { requests }
      }
      doPeriodic: durableObjectsPeriodicGroups(limit: 1, filter: { datetime_gt: "${sinceIso}" }) {
        sum { duration }
      }
    }
  }
}`;
}
__name(buildQuery, "buildQuery");

export async function fetchCfUsage(cfg) {
  const accountId = typeof cfg?.accountId === "string" ? cfg.accountId.trim() : "";
  if (!/^[0-9a-fA-F]{32}$/.test(accountId))
    throw new Error("已保存的 CF 账号 ID 格式不对");
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const sinceIso = `${day}T00:00:00Z`;
  const headers = { "content-type": "application/json" };
  if (cfg.token)
    headers["Authorization"] = `Bearer ${cfg.token}`;
  else {
    headers["X-Auth-Email"] = cfg.email ?? "";
    headers["X-Auth-Key"] = cfg.apiKey ?? "";
  }
  let res;
  try {
    const ids = await resolveResourceIds(headers, accountId);
    res = await fetch(GQL_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: buildQuery(accountId, sinceIso, ids.d1, ids.kv) }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new Error(`请求 Cloudflare 接口失败：${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (!res.ok)
    throw new Error(`Cloudflare 接口返回 HTTP ${res.status}`);
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error("Cloudflare 接口返回了无法解析的内容");
  }
  const gqlErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  const acct = payload?.data?.viewer?.accounts?.[0];
  if (!acct || typeof acct !== "object") {
    const first = gqlErrors[0]?.message;
    throw new Error(first ? `Cloudflare 接口报错：${String(first).slice(0, 160)}` : "Cloudflare 接口没有返回该账号的数据");
  }
  // Map each GraphQL error to the alias in its path, when it has one,
  // so a failed section can carry its own explanation.
  const aliasError = (alias) => {
    const hit = gqlErrors.find((e) => Array.isArray(e?.path) && e.path.includes(alias));
    return hit ? String(hit.message ?? "query failed").slice(0, 160) : null;
  };
  const partialErrors = {};
  const section = (alias, build) => {
    try {
      const out = build(acct[alias]);
      if (out == null)
        throw new Error("no data");
      return out;
    } catch {
      partialErrors[alias] = aliasError(alias) ?? "该项数据暂不可用";
      return null;
    }
  };
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const workers = section("workers", (rows) => {
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row)
      return null;
    const requests = num(row.sum?.requests);
    const cpuTimeUs = num(row.sum?.cpuTimeUs);
    return {
      requests,
      errors: num(row.sum?.errors),
      cpuAvgMs: requests > 0 ? round3(cpuTimeUs / requests / 1000) : 0,
      cpuP99Ms: round3(num(row.quantiles?.cpuTimeP99) / 1000)
    };
  });
  const d1 = section("d1", (rows) => {
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row)
      return null;
    return {
      rowsRead: num(row.sum?.rowsRead),
      rowsWritten: num(row.sum?.rowsWritten),
      readQueries: num(row.sum?.readQueries),
      writeQueries: num(row.sum?.writeQueries)
    };
  });
  const kv = section("kv", (rows) => {
    if (!Array.isArray(rows))
      return null;
    const out = { read: 0, write: 0, delete: 0, list: 0, other: 0 };
    for (const row of rows) {
      const action = String(row?.dimensions?.actionType ?? "").toLowerCase();
      const n = num(row?.sum?.requests);
      if (action === "read" || action === "write" || action === "delete" || action === "list")
        out[action] += n;
      else
        out.other += n;
    }
    return out;
  });
  // Durable Objects usage comes from two datasets (invocations and
  // periodic duration); they succeed or fail as one section.
  let doUsage = null;
  try {
    const inv = Array.isArray(acct.doInvocations) ? acct.doInvocations[0] : null;
    const per = Array.isArray(acct.doPeriodic) ? acct.doPeriodic[0] : null;
    if (!inv || !per)
      throw new Error("no data");
    doUsage = {
      requests: num(inv.sum?.requests),
      durationGBs: num(per.sum?.duration)
    };
  } catch {
    partialErrors.do = aliasError("doInvocations") ?? aliasError("doPeriodic") ?? "该项数据暂不可用";
  }
  const out = {
    day,
    workers,
    d1,
    kv,
    do: doUsage,
    limits: CF_FREE_LIMITS
  };
  if (Object.keys(partialErrors).length)
    out.partialErrors = partialErrors;
  return out;
}
__name(fetchCfUsage, "fetchCfUsage");

// The Worker's actually-bound custom domains, read from the
// Cloudflare REST API with the same stored account credentials.
// Returns the enabled hostnames, lowercased and sorted. Any failure
// throws; the admin layer turns it into the response's error field.
export async function listWorkerDomains(cfg) {
  const accountId = typeof cfg?.accountId === "string" ? cfg.accountId.trim() : "";
  if (!/^[0-9a-fA-F]{32}$/.test(accountId))
    throw new Error("已保存的 CF 账号 ID 格式不对");
  const headers = {};
  if (cfg.token)
    headers["Authorization"] = `Bearer ${cfg.token}`;
  else {
    headers["X-Auth-Email"] = cfg.email ?? "";
    headers["X-Auth-Key"] = cfg.apiKey ?? "";
  }
  let res;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?service=${SCRIPT_NAME}`, {
      headers,
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new Error(`请求 Cloudflare 接口失败：${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (!res.ok)
    throw new Error(`Cloudflare 接口返回 HTTP ${res.status}`);
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error("Cloudflare 接口返回了无法解析的内容");
  }
  if (!payload?.success || !Array.isArray(payload.result))
    throw new Error("Cloudflare 接口没有返回域名列表");
  const domains = payload.result
    .filter((d) => d && d.enabled !== false && typeof d.hostname === "string" && d.hostname)
    .map((d) => d.hostname.toLowerCase())
    .sort();
  return [...new Set(domains)];
}
__name(listWorkerDomains, "listWorkerDomains");
