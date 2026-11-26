import { CORS } from "./util.js";
import { __name } from "./helpers.js";
import { allGroupsOf, groupStrategy, loadCatalog, loadGroupStrategies, loadProviders, loadRetryPolicy } from "./store.js";
import { DEFAULT_RETRY_POLICY, decideRetry } from "./retry.js";
import { checkCallerLock, checkGatewayToken, noteCallerAuthFailure } from "./auth.js";
import { classify, classifyThrown, extractParam, failureProvider, json, noCapacityError, openAIError, parseRetryAfter, stripDefaultFields, truncate } from "./util.js";
import { applyParamOverrides } from "./override.js";
import { coordFetch } from "./coord-client.js";
import { normalizeUsage } from "./adapters/openai.js";
import { recordUsage } from "./usage.js";
import { applyEffort, isFreeModel, parseEffortSuffix, resolveCandidates, resolveUpstreamModel } from "./catalog.js";
import { fetchModels } from "./discovery.js";
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
// Live model lists for the pinned passthrough check below, cached
// per provider for 5 minutes per isolate: the pinned path runs on
// every embeddings/images/audio call, and a /models fetch per call
// would double the upstream traffic for a check that changes
// rarely.
const pinnedListCache = /* @__PURE__ */ new Map();
async function pinnedProviderModels(p) {
  const hit = pinnedListCache.get(p.id);
  if (hit && Date.now() - hit.at < 5 * 6e4)
    return hit.models;
  const keys = (p.keys ?? []).filter((k) => !k.disabled);
  let listed = null;
  for (const k of keys) {
    try {
      listed = await fetchModels(p, k);
      break;
    } catch (e) {
      // Same rotation policy as catalog sync: only a failure the
      // key itself caused is worth retrying with the next key.
      if (!/HTTP (401|402|403|429)/.test(String(e?.message ?? e)))
        break;
    }
  }
  if (!listed)
    return null;
  pinnedListCache.set(p.id, { at: Date.now(), models: listed });
  return listed;
}
__name(pinnedProviderModels, "pinnedProviderModels");
export async function handlePassthrough(req, env, ctx, pathname) {
  const lock = await checkCallerLock(env, req);
  if (lock.locked) {
    const res = openAIError(429, "\u8C03\u7528\u8BA4\u8BC1\u5931\u8D25\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5", "rate_limit_error", { code: "caller_locked", retryable: true, retry_after_ms: lock.retryAfterMs });
    res.headers.set("Retry-After", String(Math.max(1, Math.ceil(lock.retryAfterMs / 1e3))));
    return res;
  }
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") {
      return openAIError(500, "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN\uFF0C\u8BF7\u5148 wrangler secret put GATEWAY_TOKEN", "configuration_error");
    }
    if (ctx?.waitUntil)
      ctx.waitUntil(noteCallerAuthFailure(env, req, lock.id));
    else
      await noteCallerAuthFailure(env, req, lock.id);
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
  // Effort is parsed off the model name before routing, same as
  // the chat path: the bare name matches the catalog (and the
  // pinned free-check below), the effort travels separately and
  // is applied to the JSON body at send time.
  const { base: reqBase, effort: reqEffort } = parseEffortSuffix(requested);
  requested = reqBase;
  const cfg = settings(env);
  const maxAttempts = requestMaxAttempts(req, cfg);
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
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
    // A pinned passthrough call must not bypass the free-model
    // gate: the catalog only carries chat models, so embeddings /
    // images / audio models can never be checked against it —
    // instead the provider's live model list is fetched and the
    // same isFreeModel judgement the catalog sync applies decides.
    // A model that is absent from the list, or present but not
    // free, is a plain model_not_found either way (the caller is
    // not told which of the two it was).
    const wantModel = requested.slice(slash + 1);
    const listed = await pinnedProviderModels(p);
    if (!listed) {
      return openAIError(503, `\u670D\u52A1\u5546 ${p.id} \u7684\u6A21\u578B\u5217\u8868\u6682\u65F6\u62C9\u53D6\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5`, "gateway_unavailable", { code: "gateway_unavailable", retryable: true, request_id: requestId });
    }
    const found = listed.find((m) => m.id === wantModel);
    if (!found || !isFreeModel(found.id, found.pricing, p.freeMode, p.allow, p.freeRules)) {
      return openAIError(404, `\u6A21\u578B "${requested}" \u4E0D\u5B58\u5728`, "model_not_found", { code: "model_not_found", retryable: false, request_id: requestId });
    }
    candidates = [{ provider: p.id, model: wantModel, weight: p.weight ?? 1 }];
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
        priority: p.priority ?? 0,
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
    // Mirror the chat path: a caller-quota rejection is recorded
    // (see the router's note), attributed like a zero-pick one.
    const quotaProviders = [...new Set(candidates.map((c) => c.provider))];
    ctx.waitUntil(
      recordUsage(env, {
        provider: failureProvider(quotaProviders),
        ...(quotaProviders.length > 1 ? { failProviders: quotaProviders } : {}),
        model: requested,
        keyId: "-",
        callerKeyId: auth.keyId ?? "env",
        virtualModel: requested,
        status: 429,
        ok: false,
        usage: null,
        latencyMs: Date.now() - startedAt,
        attempts: 0,
        errorKind: "caller_quota",
        stream: wantsStream
      }, ctx)
    );
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
    // Mirror the chat path: a zero-pick rejection is recorded and
    // runs an alert evaluation instead of returning invisibly,
    // attributed to the candidates' provider when they all share
    // one (a pinned call always does).
    const candProviders = [...new Set(candidates.map((c) => c.provider))];
    ctx.waitUntil(
      recordUsage(env, {
        provider: failureProvider(candProviders),
        ...(candProviders.length > 1 ? { failProviders: candProviders } : {}),
        model: requested,
        keyId: "-",
        callerKeyId: auth.keyId ?? "env",
        virtualModel: requested,
        status: 503,
        ok: false,
        usage: null,
        latencyMs: Date.now() - startedAt,
        attempts: 0,
        errorKind: "no_capacity",
        stream: wantsStream
      }, ctx)
    );
    ctx.waitUntil(evaluateAlerts(env, "no_capacity"));
    return noCapacityError(order, candidates.map((c) => `${c.provider}/${c.model}`), requestId);
  }
  // Retry policy, loaded once per request (defaults on KV failure);
  // decideRetry consults it at the loop end below.
  let retryPolicy = DEFAULT_RETRY_POLICY;
  try {
    retryPolicy = await loadRetryPolicy(env);
  } catch {
  }
  let attempts = 0;
  const attemptProviders = /* @__PURE__ */ new Set();
  let lastKind = null;
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
    // Model mapping is send-time only (same rule as the chat
    // path): the pinned free-check above and the usage rows below
    // keep the requested name; only the name actually sent
    // upstream is resolved here. A mapped name may carry its own
    // effort suffix, which wins over the requested effort.
    const upstream = resolveUpstreamModel(provider, pick.model, reqEffort);
    const headers = {
      ...provider.headers ?? {},
      authorization: "Bearer " + key.key
    };
    let payload;
    if (formEntries) {
      const fd = new FormData();
      for (const [k, v] of formEntries)
        fd.append(k, v);
      fd.set("model", upstream.model);
      payload = fd;
    } else {
      headers["content-type"] = "application/json";
      // Fixed send pipeline, same order as the chat path:
      // default strip (minus allowlist) -> effort -> overrides ->
      // learned drops + dropParams last (drops always win). The
      // learned drops come from /order (order.drops[provider]);
      // passthrough never applied them before — this is new
      // behavior, following the same fixed order. The form-data
      // path above is untouched except the model rename.
      const outBody = { ...jsonBody, model: upstream.model };
      stripDefaultFields(outBody, provider.allowFields);
      applyEffort(outBody, provider.kind, upstream.effort);
      applyParamOverrides(outBody, headers, provider.paramOverrides ?? []);
      const learnedDrops = order.drops?.[provider.id] ?? [];
      for (const p of [...learnedDrops, ...provider.dropParams ?? []])
        delete outBody[p];
      payload = JSON.stringify(outBody);
    }
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), cfg.timeoutMs);
    let res;
    let buf;
    try {
      res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/${suffix}`, {
        method: "POST",
        headers,
        body: payload,
        signal: ctrl.signal
      });
      const declaredLen = Number(res.headers.get("content-length") || 0);
      if (res.ok && res.body && (wantsStream || declaredLen > 32 * 1024 * 1024)) {
        // Streamed (or oversized) responses are NOT settled at
        // header time: the body is pumped through an idle watchdog
        // and the report + usage land when the stream actually
        // ends, stalls, errors, or the client goes away — the same
        // settlement semantics as the chat path. Oversized buffered
        // responses take this path too instead of being fully
        // materialized in isolate memory.
        clearTimeout(timer);
        const reader = res.body.getReader();
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        let settled = false;
        let lastActivity = Date.now();
        // Side-channel usage scan: the forwarded bytes stay untouched,
        // but SSE events are also parsed so streamed passthrough
        // traffic records the usage it carries (chat chunks with a
        // usage field, Responses-API response.completed events)
        // instead of accounting null forever.
        let streamUsage = null;
        let scanBuf = "";
        const scanDecoder = new TextDecoder();
        const scanChunk = (value) => {
          try {
            scanBuf += scanDecoder.decode(value, { stream: true });
            let idx;
            while ((idx = scanBuf.indexOf("\n\n")) >= 0) {
              const block = scanBuf.slice(0, idx);
              scanBuf = scanBuf.slice(idx + 2);
              for (const line of block.split("\n")) {
                const t = line.trim();
                if (!t.startsWith("data:"))
                  continue;
                const dataStr = t.slice(5).trim();
                if (!dataStr || dataStr === "[DONE]")
                  continue;
                try {
                  const obj = JSON.parse(dataStr);
                  const u = normalizeUsage(obj?.usage ?? obj?.response?.usage ?? null);
                  if (u)
                    streamUsage = u;
                } catch {
                }
              }
            }
            if (scanBuf.length > 1 << 20)
              scanBuf = scanBuf.slice(-65536);
          } catch {
          }
        };
        const finish = (outcome, err) => {
          if (settled)
            return;
          settled = true;
          clearInterval(idleTimer);
          const totalMs = Date.now() - t0;
          const okAll = outcome === "done" || outcome === "aborted";
          const kind = outcome === "timeout" ? "timeout" : outcome === "error" ? classifyThrown(err) : void 0;
          ctx.waitUntil(
            coordFetch(env, "/report", {
              provider: pick.provider,
              model: pick.model,
              keyId: key.id,
              ok: okAll,
              status: res.status,
              kind,
              latencyMs: totalMs,
              startedAt: t0,
              aborted: outcome === "aborted" || void 0,
              day: order.day
            }).catch(() => void 0)
          );
          ctx.waitUntil(
            recordUsage(env, {
              provider: pick.provider,
              model: pick.model,
              keyId: key.id,
              callerKeyId: auth.keyId ?? "env",
              virtualModel: requested,
              status: res.status,
              ok: okAll,
              usage: streamUsage,
              latencyMs: totalMs,
              attempts,
              errorKind: outcome === "aborted" ? "client_abort" : kind,
              stream: wantsStream
            }, ctx)
          );
        };
        const idleTimer = setInterval(() => {
          if (Date.now() - lastActivity > cfg.timeoutMs) {
            finish("timeout");
            reader.cancel(new Error("stream idle timeout")).catch(() => void 0);
            writer.abort(new Error("stream idle timeout")).catch(() => void 0);
          }
        }, 5e3);
        const pump = (async () => {
          let failure = null;
          let readErr = null;
          try {
            for (; ; ) {
              const { done, value } = await reader.read();
              if (done)
                break;
              lastActivity = Date.now();
              scanChunk(value);
              try {
                await writer.write(value);
              } catch {
                failure = "aborted";
                break;
              }
            }
          } catch (e) {
            failure = "error";
            readErr = e;
          }
          if (failure === "aborted") {
            finish("aborted");
            reader.cancel().catch(() => void 0);
          } else if (failure === "error") {
            finish("error", readErr);
            writer.abort(readErr).catch(() => void 0);
          } else {
            finish("done");
            await writer.close().catch(() => void 0);
          }
          clearInterval(idleTimer);
        })();
        ctx.waitUntil(pump);
        return new Response(readable, {
          status: res.status,
          headers: {
            ...CORS,
            "content-type": res.headers.get("content-type") || "text/event-stream",
            "x-gw-provider": pick.provider,
            "x-gw-model": pick.model,
            ...(upstream.mapped ? { "x-gw-upstream-model": upstream.model } : {}),
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
      attemptProviders.add(pick.provider);
      lastKind = kind2;
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: false,
          status: 0,
          kind: kind2,
          latencyMs: latencyMs2,
          startedAt: t0,
          day: order.day
        }).catch(() => void 0)
      );
      // No usage row per attempt: the request records ONE row
      // when it settles (below the loop), like the chat path.
      // Keep any earlier attempt's buffered upstream response: a
      // transport failure on this attempt must not erase the
      // concrete error (e.g. a 429 with retry semantics) an earlier
      // candidate already produced — it stays the final fallback.
      // A thrown failure still consults the decision table (a thrown
      // `content` kind stops here, where the old unconditional
      // `continue` retried it — near-unreachable in practice, since
      // fetch rejections carry network/abort/timeout messages).
      const d2 = decideRetry({
        kind: kind2,
        status: 0,
        attemptsLeft: maxAttempts - attempts,
        pinned: pinnedId !== null && order.picks.length === 1,
        strictAffinity: false,
        policy: retryPolicy
      });
      if (!d2.retry)
        break;
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
          startedAt: t0,
          day: order.day
        }).catch(() => void 0)
      );
      ctx.waitUntil(
        recordUsage(env, {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          callerKeyId: auth.keyId ?? "env",
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
          ...(upstream.mapped ? { "x-gw-upstream-model": upstream.model } : {}),
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId
        }
      });
    }
    const text = truncate(new TextDecoder().decode(buf), 1200);
    let kind = classify(res.status, text);
    if (res.status === 404 && !/no_available_channel|cannot be served|no channel available/i.test(text)) {
      kind = "bad_param";
      // A plain upstream 404 is terminal (no other candidate will
      // have the model either), but it still gets its health
      // report here and its usage row at the shared tail.
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: false,
          status: res.status,
          kind,
          latencyMs,
          startedAt: t0,
          error: truncate(text, 300),
          param: extractParam(text),
          day: order.day
        }).catch(() => void 0)
      );
      // No per-attempt row and no direct return: the buffered
      // response is handed to the shared tail below, which
      // records the request's single usage row and returns it.
      attemptProviders.add(pick.provider);
      lastKind = kind;
      lastBuf = buf;
      lastStatus = res.status;
      lastCt = ct;
      lastProvider = pick.provider;
      lastModel = pick.model;
      break;
    }
    // model_gone is reported too (it used to be exempted): without
    // it, passthrough-only models that get delisted upstream never
    // enter the dead set and burn an attempt on every request.
    {
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: false,
          status: res.status,
          kind,
          latencyMs,
          startedAt: t0,
          error: truncate(text, 300),
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? void 0,
          param: kind === "bad_param" ? extractParam(text) : void 0,
          day: order.day
        }).catch(() => void 0)
      );
    }
    // No usage row per attempt: the request records ONE row at
    // the tail, like the chat path (health reports stay
    // per-attempt, above).
    attemptProviders.add(pick.provider);
    lastKind = kind;
    lastBuf = buf;
    lastStatus = res.status;
    lastCt = ct;
    lastProvider = pick.provider;
    lastModel = pick.model;
    // Kind rules first (current behavior, verbatim): model_gone /
    // unknown keep going to the next pick; bad_param / content stop
    // here. Every other kind consults the decision table. The
    // 404-plain terminal break above is untouched.
    if (kind === "model_gone" || kind === "unknown") {
      // fall through to the next pick (no break)
    } else if (kind === "bad_param" || kind === "content") {
      break;
    } else {
      const d = decideRetry({
        kind,
        status: res.status,
        attemptsLeft: maxAttempts - attempts,
        pinned: pinnedId !== null && order.picks.length === 1,
        strictAffinity: false,
        policy: retryPolicy
      });
      if (!d.retry)
        break;
    }
  }
  // The request's single usage row for the all-attempts-failed
  // shape (success and streamed responses record theirs inline
  // and return before reaching here).
  const attemptProviderList = [...attemptProviders];
  ctx.waitUntil(
    recordUsage(env, {
      provider: failureProvider(attemptProviderList),
      ...(attemptProviderList.length > 1 ? { failProviders: attemptProviderList } : {}),
      model: requested,
      keyId: "-",
      callerKeyId: auth.keyId ?? "env",
      virtualModel: requested,
      status: lastStatus || 503,
      ok: false,
      usage: null,
      latencyMs: Date.now() - startedAt,
      attempts,
      errorKind: lastKind ?? "no_capacity",
      stream: wantsStream
    }, ctx)
  );
  // Both exhaustion shapes evaluate alerts: attempts that all
  // threw (no buffered response) and attempts that all returned
  // HTTP errors (buffered response below) — the latter used to
  // return before the evaluation was ever reached.
  ctx.waitUntil(evaluateAlerts(env, "no_capacity"));
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
  return openAIError(503, "\u6240\u6709\u5019\u9009\u4E0A\u6E38\u5747\u65E0\u54CD\u5E94\uFF08\u7F51\u7EDC/\u8D85\u65F6\uFF09", "gateway_unavailable", { code: "gateway_unavailable", retryable: true, request_id: requestId, source: "transport" });
}
__name(handlePassthrough, "handlePassthrough");
export async function handleModelOne(req, env, id) {
  id = (id || "").replace(/^\u6620\u5C04\u7EC4\//, "");
  const lock = await checkCallerLock(env, req);
  if (lock.locked) {
    const res = openAIError(429, "\u8C03\u7528\u8BA4\u8BC1\u5931\u8D25\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5", "rate_limit_error", { code: "caller_locked", retryable: true, retry_after_ms: lock.retryAfterMs });
    res.headers.set("Retry-After", String(Math.max(1, Math.ceil(lock.retryAfterMs / 1e3))));
    return res;
  }
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason !== "unconfigured")
      await noteCallerAuthFailure(env, req, lock.id);
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
