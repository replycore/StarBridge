import { CORS } from "./util.js";
import { __name } from "./helpers.js";
import { allGroupsOf, groupStrategy, loadCatalog, loadGroupStrategies, loadProviders } from "./store.js";
import { checkGatewayToken } from "./auth.js";
import { classify, classifyThrown, extractParam, json, noCapacityError, openAIError, parseRetryAfter, truncate } from "./util.js";
import { coordFetch } from "./coord-client.js";
import { normalizeUsage } from "./adapters/openai.js";
import { recordUsage } from "./usage.js";
import { resolveCandidates } from "./catalog.js";
import { evaluateAlerts } from "./alerts.js";
import { requestMaxAttempts, settings } from "./config.js";

export var PASSTHROUGH_PATHS = /* @__PURE__ */ new Set([
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/embeddings",
  "/v1/completions",
  "/v1/responses",
  "/v1/moderations",
  // AMD 系（TokenLab / 中国站）专属端点：OCR 与决策模型
  "/v1/ocr",
  "/v1/systemone"
]);
export var RETRYABLE = /* @__PURE__ */ new Set([
  "rate_limit",
  "quota",
  "auth",
  "model_gone",
  "server",
  "network",
  "timeout",
  "unknown"
]);
export var TIMEOUT_MS = 12e4;
export async function handlePassthrough(req, env, ctx, pathname) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") {
      return openAIError(500, "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN\uFF0C\u8BF7\u5148 wrangler secret put GATEWAY_TOKEN", "configuration_error");
    }
    return openAIError(401, "invalid gateway token", "authentication_error");
  }
  const suffix = pathname.replace(/^\/v1\//, "");
  const isForm = (req.headers.get("content-type") || "").includes("multipart/form-data");
  let wantsStream = false;
  let jsonBody = null;
  let formEntries = null;
  let requested = "";
  if (isForm) {
    let fd;
    try {
      fd = await req.formData();
    } catch {
      return openAIError(400, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 multipart \u8868\u5355", "invalid_request_error", { code: "invalid_request", retryable: false });
    }
    formEntries = [...fd.entries()];
    const m = fd.get("model");
    requested = typeof m === "string" ? m.trim() : "";
  } else {
    try {
      jsonBody = await req.json();
    } catch {
      return openAIError(400, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON", "invalid_request_error", { code: "invalid_request", retryable: false });
    }
    requested = String(jsonBody?.model ?? "").trim();
    wantsStream = jsonBody?.stream === true;
  }
  if (!requested) {
    return openAIError(400, "model \u4E0D\u80FD\u4E3A\u7A7A", "invalid_request_error", { code: "invalid_request", retryable: false });
  }
  const cfg = settings(env);
  const maxAttempts = requestMaxAttempts(req, cfg);
  const requestId = crypto.randomUUID().slice(0, 8);
  const [catalog, providers] = await Promise.all([loadCatalog(env), loadProviders(env)]);
  const enabled = providers.filter((p) => p.enabled && p.keys.some((k) => !k.disabled));
  const byId = new Map(enabled.map((p) => [p.id, p]));
  const knownProviders = new Set(providers.map((p) => p.id.toLowerCase()));
  let candidates = [];
  let note;
  let strategy = "balance";
  const slash = requested.indexOf("/");
  const pinnedId = slash > 0 ? requested.slice(0, slash).toLowerCase() : null;
  if (pinnedId && knownProviders.has(pinnedId)) {
    const p = enabled.find((x) => x.id.toLowerCase() === pinnedId);
    if (!p) {
      return openAIError(404, `\u670D\u52A1\u5546 ${pinnedId} \u672A\u542F\u7528\u6216\u6CA1\u6709\u53EF\u7528 key`, "model_not_found", { code: "model_not_found", retryable: false, request_id: requestId });
    }
    if (p.kind !== "openai") {
      return openAIError(400, `\u670D\u52A1\u5546 ${pinnedId} \u4E0D\u662F OpenAI \u517C\u5BB9\u63A5\u53E3\uFF0C\u4E0D\u652F\u6301 /v1/${suffix}`, "invalid_request_error", { code: "invalid_request", retryable: false });
    }
    candidates = [{ provider: p.id, model: requested.slice(slash + 1), weight: p.weight ?? 1 }];
  } else {
    if (!catalog || !catalog.entries.length) {
      return openAIError(503, "\u6A21\u578B\u76EE\u5F55\u4E3A\u7A7A\uFF0C\u8BF7\u5148\u6267\u884C POST /admin/api/sync \u540C\u6B65\u6A21\u578B\u5217\u8868", "gateway_unavailable", { code: "gateway_unavailable", retryable: true, request_id: requestId });
    }
    const resolved = resolveCandidates(catalog.entries, requested, {
      groups: cfg.grouping ? await allGroupsOf(env, catalog) : void 0,
      allowed: new Set(byId.keys()),
      knownProviders
    });
    note = resolved.note;
    strategy = groupStrategy(await loadGroupStrategies(env), resolved.group?.key);
    candidates = resolved.candidates.filter((c) => byId.get(c.provider)?.kind === "openai").map((c) => ({ provider: c.provider, model: c.model, weight: c.weight }));
  }
  if (!candidates.length) {
    return openAIError(404, note ?? `\u6CA1\u6709\u53EF\u7528\u6A21\u578B\u5339\u914D "${requested}"`, "model_not_found", { code: "model_not_found", retryable: false, request_id: requestId });
  }
  let order;
  try {
    order = await coordFetch(env, "/order", {
      strategy,
      gkey: auth.dailyLimit ? { id: auth.keyId, limit: auth.dailyLimit } : void 0,
      candidates,
      providers: enabled.map((p) => ({
        id: p.id,
        weight: p.weight,
        keys: p.keys.filter((k) => !k.disabled).map((k) => ({
          id: k.id,
          dailyLimit: k.dailyLimit ?? p.dailyLimitDefault ?? 0,
          rpm: k.rpm ?? p.rpmDefault ?? 0
        }))
      })),
      limit: maxAttempts
    });
  } catch (e) {
    return openAIError(503, `\u8C03\u5EA6\u5668\u4E0D\u53EF\u7528: ${truncate(String(e), 200)}`, "gateway_unavailable", { code: "gateway_unavailable", retryable: true, request_id: requestId });
  }
  if (order.gkey && !order.gkey.allowed) {
    const res = openAIError(
      429,
      `调用 Key 的每日请求额度已用完（${order.gkey.used}/${order.gkey.limit}）`,
      "rate_limit_error",
      { code: "caller_quota_exceeded", retryable: true, retry_after_ms: order.gkey.retryAfterMs, request_id: requestId }
    );
    res.headers.set("Retry-After", String(Math.max(1, Math.ceil(order.gkey.retryAfterMs / 1e3))));
    return res;
  }
  if (!order.picks.length) {
    return noCapacityError(order, candidates.map((c) => `${c.provider}/${c.model}`), requestId);
  }
  let attempts = 0;
  let lastBuf = null;
  let lastStatus = 0;
  let lastCt = "application/json";
  let lastProvider = "";
  let lastModel = "";
  for (const pick of order.picks) {
    if (attempts >= maxAttempts)
      break;
    const provider = byId.get(pick.provider);
    if (!provider)
      continue;
    const key = provider.keys.find((k) => k.id === pick.keyId && !k.disabled);
    if (!key)
      continue;
    attempts++;
    lastProvider = pick.provider;
    lastModel = pick.model;
    const headers = {
      ...provider.headers ?? {},
      authorization: "Bearer " + key.key
    };
    let payload;
    if (formEntries) {
      const fd = new FormData();
      for (const [k, v] of formEntries)
        fd.append(k, v);
      fd.set("model", pick.model);
      payload = fd;
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify({ ...jsonBody, model: pick.model });
    }
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), TIMEOUT_MS);
    let res;
    let buf;
    try {
      res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/${suffix}`, {
        method: "POST",
        headers,
        body: payload,
        signal: ctrl.signal
      });
      if (res.ok && wantsStream && res.body) {
        clearTimeout(timer);
        const latencyMs2 = Date.now() - t0;
        ctx.waitUntil(
          coordFetch(env, "/report", {
            provider: pick.provider,
            model: pick.model,
            keyId: key.id,
            ok: true,
            status: res.status,
            latencyMs: latencyMs2,
            day: order.day
          }).catch(() => void 0)
        );
        ctx.waitUntil(
          recordUsage(env, {
            provider: pick.provider,
            model: pick.model,
            keyId: key.id,
            virtualModel: requested,
            status: res.status,
            ok: true,
            usage: null,
            latencyMs: latencyMs2,
            attempts,
            stream: true
          }, ctx)
        );
        return new Response(res.body, {
          status: res.status,
          headers: {
            ...CORS,
            "content-type": res.headers.get("content-type") || "text/event-stream",
            "x-gw-provider": pick.provider,
            "x-gw-model": pick.model,
            "x-gw-attempts": String(attempts),
            "x-gw-request-id": requestId
          }
        });
      }
      buf = await res.arrayBuffer();
    } catch (e) {
      clearTimeout(timer);
      const kind2 = classifyThrown(e);
      const latencyMs2 = Date.now() - t0;
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: false,
          status: 0,
          kind: kind2,
          latencyMs: latencyMs2,
          day: order.day
        }).catch(() => void 0)
      );
      ctx.waitUntil(
        recordUsage(env, {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          virtualModel: requested,
          status: 0,
          ok: false,
          usage: null,
          latencyMs: latencyMs2,
          attempts,
          errorKind: kind2,
          stream: false
        }, ctx)
      );
      lastStatus = 0;
      lastBuf = null;
      continue;
    }
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    const ct = res.headers.get("content-type") || "application/json";
    if (res.ok) {
      let usage = null;
      if (ct.includes("json")) {
        try {
          usage = normalizeUsage(JSON.parse(new TextDecoder().decode(buf)).usage);
        } catch {
        }
      }
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: true,
          status: res.status,
          latencyMs,
          day: order.day
        }).catch(() => void 0)
      );
      ctx.waitUntil(
        recordUsage(env, {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          virtualModel: requested,
          status: res.status,
          ok: true,
          usage,
          latencyMs,
          attempts,
          stream: false
        }, ctx)
      );
      return new Response(buf, {
        status: res.status,
        headers: {
          ...CORS,
          "content-type": ct,
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId
        }
      });
    }
    const text = truncate(new TextDecoder().decode(buf), 1200);
    let kind = classify(res.status, text);
    if (res.status === 404 && !/no_available_channel|cannot be served|no channel available/i.test(text)) {
      kind = "bad_param";
      return new Response(buf, {
        status: res.status,
        headers: {
          ...CORS,
          "content-type": ct,
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId
        }
      });
    }
    if (kind !== "model_gone") {
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: false,
          status: res.status,
          kind,
          latencyMs,
          error: truncate(text, 300),
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? void 0,
          param: kind === "bad_param" ? extractParam(text) : void 0,
          day: order.day
        }).catch(() => void 0)
      );
    }
    ctx.waitUntil(
      recordUsage(env, {
        provider: pick.provider,
        model: pick.model,
        keyId: key.id,
        virtualModel: requested,
        status: res.status,
        ok: false,
        usage: null,
        latencyMs,
        attempts,
        errorKind: kind,
        stream: false
      }, ctx)
    );
    lastBuf = buf;
    lastStatus = res.status;
    lastCt = ct;
    if (!RETRYABLE.has(kind))
      break;
  }
  if (lastBuf) {
    return new Response(lastBuf, {
      status: lastStatus,
      headers: {
        ...CORS,
        "content-type": lastCt,
        "x-gw-provider": lastProvider,
        "x-gw-model": lastModel,
        "x-gw-attempts": String(attempts),
        "x-gw-request-id": requestId
      }
    });
  }
  ctx.waitUntil(evaluateAlerts(env, "no_capacity"));
  return openAIError(503, "\u6240\u6709\u5019\u9009\u4E0A\u6E38\u5747\u65E0\u54CD\u5E94\uFF08\u7F51\u7EDC/\u8D85\u65F6\uFF09", "gateway_unavailable", { code: "gateway_unavailable", retryable: true, request_id: requestId });
}
__name(handlePassthrough, "handlePassthrough");
export async function handleModelOne(req, env, id) {
  id = (id || "").replace(/^\u6620\u5C04\u7EC4\//, "");
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    return openAIError(auth.reason === "unconfigured" ? 500 : 401, "invalid gateway token", "authentication_error");
  }
  const catalog = await loadCatalog(env);
  if (!catalog)
    return openAIError(404, `\u6A21\u578B "${id}" \u4E0D\u5B58\u5728`, "model_not_found", { code: "model_not_found", retryable: false });
  const group = (await allGroupsOf(env, catalog)).find((g) => g.id === id);
  if (group) {
    return json({
      id: group.id,
      object: "model",
      created: group.created && group.created < 1e12 ? group.created : Math.floor((group.created ?? 0) / 1e3),
      owned_by: group.providers.join(","),
      providers: group.providers,
      endpoints: group.endpoints.length,
      context_length: group.contextLength || void 0
    });
  }
  const entry = catalog.entries.find((e) => e.key === id) ?? catalog.entries.find((e) => e.model === id);
  if (entry) {
    return json({
      id: entry.model,
      object: "model",
      created: entry.created ?? 0,
      owned_by: entry.provider,
      context_length: entry.contextLength || void 0
    });
  }
  return openAIError(404, `\u6A21\u578B "${id}" \u4E0D\u5B58\u5728`, "model_not_found", { code: "model_not_found", retryable: false });
}
__name(handleModelOne, "handleModelOne");
