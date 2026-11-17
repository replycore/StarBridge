import { CORS, classify, classifyThrown, estimateRequestTokens, extractParam, isContextError, json, noCapacityError, openAIError, parseRetryAfter, sleep, truncate, upstreamErrorMeta, withTimeout, deferred } from "./util.js";
import { VIRTUAL_MODELS, resolveCandidates } from "./catalog.js";
import { __name } from "./helpers.js";
import { adapterFor } from "./adapters/index.js";
import { allGroupsOf, groupStrategy, loadCatalog, loadGroupStrategies, loadProviders, providersLoadFailed } from "./store.js";
import { checkGatewayToken } from "./auth.js";
import { coordFetch } from "./coord-client.js";
import { recordUsage } from "./usage.js";
import { requestMaxAttempts, settings } from "./config.js";

export function hasImage(messages) {
  for (const m of messages ?? []) {
    if (Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url"))
      return true;
  }
  return false;
}
__name(hasImage, "hasImage");
export async function invoke(provider, key, model, body, drops, timeoutMs) {
  const adapter = adapterFor(provider.kind);
  const built = adapter.build({ provider, key, model, req: body, drops });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let res;
  try {
    res = await fetch(built.url, { ...built.init, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, text: truncate(String(e?.message ?? e), 300), kind: classifyThrown(e) };
  }
  if (!res.ok) {
    const text = truncate(await res.text().catch(() => ""), 1200);
    clearTimeout(timer);
    const kind = classify(res.status, text);
    return {
      ok: false,
      status: res.status,
      text,
      kind,
      param: kind === "bad_param" ? extractParam(text) : void 0,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? void 0
    };
  }
  if (body.stream) {
    if (!res.body) {
      clearTimeout(timer);
      return { ok: false, status: 502, text: "upstream \u8FD4\u56DE\u7A7A\u54CD\u5E94\u4F53", kind: "server" };
    }
    clearTimeout(timer);
    const sr = adapter.parseStream(res.body, { provider, key, model, req: body, drops });
    let idle;
    const armIdle = /* @__PURE__ */ __name(() => {
      if (idle)
        clearTimeout(idle);
      idle = setTimeout(() => controller.abort("stream idle timeout"), timeoutMs);
    }, "armIdle");
    armIdle();
    // When the client disconnects, a TransformStream's flush() never
    // runs and the adapter's usage deferred never settles. Observe
    // the cancellation explicitly instead: abort the upstream fetch
    // (stop burning quota) and settle the request as aborted.
    const aborted = deferred();
    const reader = sr.stream.getReader();
    const stream = new ReadableStream({
      async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (idle)
              clearTimeout(idle);
            c.close();
            return;
          }
          armIdle();
          c.enqueue(value);
        } catch (e) {
          if (idle)
            clearTimeout(idle);
          c.error(e);
        }
      },
      cancel(reason) {
        if (idle)
          clearTimeout(idle);
        controller.abort("client aborted");
        aborted.resolve(true);
        reader.cancel(reason).catch(() => void 0);
      }
    });
    return { ok: true, type: "stream", stream, usage: sr.usage, aborted: aborted.promise };
  }
  try {
    const data = await res.json();
    clearTimeout(timer);
    const parsed = adapter.parseJson(data, { provider, key, model, req: body, drops });
    const out = parsed.json;
    const choices = out?.choices;
    if (!Array.isArray(choices) || !choices.length) {
      return { ok: false, status: 502, text: "upstream \u8FD4\u56DE\u7A7A choices", kind: "server" };
    }
    return { ok: true, type: "json", json: out, usage: parsed.usage };
  } catch (e) {
    clearTimeout(timer);
    const kind = classifyThrown(e);
    return {
      ok: false,
      status: kind === "content" ? 400 : 502,
      text: `\u89E3\u6790\u4E0A\u6E38\u54CD\u5E94\u5931\u8D25: ${truncate(String(e), 200)}`,
      kind: kind === "content" ? "content" : "server"
    };
  }
}
__name(invoke, "invoke");
export function corsHeaders(extra = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(CORS))
    h.set(k, v);
  for (const [k, v] of Object.entries(extra))
    h.set(k, v);
  return h;
}
__name(corsHeaders, "corsHeaders");
// Session stickiness: a session is identified by the x-gw-session
// header when present, else by the body's `user` field, else — for
// multi-turn conversations only (>= 3 messages; a single-turn request
// never infers one) — by a hash of the first three messages. The
// storage key also binds the requested model/group so different
// models never share a pin. Returns null when no session can be
// identified, in which case routing is completely unaffected.
export async function deriveSessionKey(req, body, requested) {
  let raw = (req.headers.get("x-gw-session") || "").trim();
  if (!raw && typeof body.user === "string")
    raw = body.user.trim();
  if (!raw) {
    const msgs = body.messages;
    if (!Array.isArray(msgs) || msgs.length < 3)
      return null;
    const parts = [];
    for (const m of msgs.slice(0, 3)) {
      let text = "";
      if (typeof m.content === "string")
        text = m.content;
      else if (Array.isArray(m.content))
        text = m.content.map((p) => typeof p?.text === "string" ? p.text : "").join("");
      parts.push(`${m.role ?? ""}:${text}`);
    }
    raw = parts.join("\n");
  }
  if (!raw)
    return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requested + "\n" + raw.slice(0, 4096))
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
__name(deriveSessionKey, "deriveSessionKey");
export async function handleChat(req, env, ctx) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason === "unconfigured") {
      return openAIError(500, "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN\uFF0C\u8BF7\u5148 wrangler secret put GATEWAY_TOKEN", "configuration_error", { code: "configuration_error", retryable: false });
    }
    return openAIError(401, "invalid gateway token", "authentication_error", { code: "authentication_error", retryable: false });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return openAIError(400, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON", "invalid_request_error", { code: "invalid_request", retryable: false });
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return openAIError(400, "messages \u4E0D\u80FD\u4E3A\u7A7A", "invalid_request_error", { code: "invalid_request", retryable: false });
  }
  const cfg = settings(env);
  const maxAttempts = requestMaxAttempts(req, cfg);
  const requested = String(body.model || cfg.defaultAlias).trim();
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const [catalog, providers] = await Promise.all([loadCatalog(env), loadProviders(env)]);
  if (!providers.length && providersLoadFailed) {
    return openAIError(
      503,
      "\u670D\u52A1\u5546\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF08\u591A\u534A\u662F MASTER_KEY \u88AB\u6539\u52A8\uFF09\uFF0C\u8BF7\u5728\u7BA1\u7406\u540E\u53F0\u91CD\u65B0\u5F55\u5165 Key",
      "configuration_error",
      { code: "configuration_error", retryable: false, request_id: requestId }
    );
  }
  if (!catalog || !catalog.entries.length) {
    return openAIError(503, "\u6A21\u578B\u76EE\u5F55\u4E3A\u7A7A\uFF0C\u8BF7\u5148\u6267\u884C POST /admin/api/sync \u540C\u6B65\u6A21\u578B\u5217\u8868", "gateway_unavailable", { code: "gateway_unavailable", retryable: true, request_id: requestId });
  }
  const enabled = providers.filter((p) => p.enabled && p.keys.some((k) => !k.disabled));
  const byId = new Map(enabled.map((p) => [p.id, p]));
  const resolved = resolveCandidates(catalog.entries, requested, {
    needsTools: Array.isArray(body.tools) && body.tools.length > 0,
    needsVision: hasImage(body.messages),
    needContext: estimateRequestTokens(body),
    groups: cfg.grouping ? await allGroupsOf(env, catalog) : void 0,
    allowed: new Set(byId.keys()),
    knownProviders: new Set(providers.map((p) => p.id.toLowerCase()))
  });
  if (!resolved.candidates.length) {
    return openAIError(
      404,
      resolved.note ?? `\u6CA1\u6709\u53EF\u7528\u6A21\u578B\u5339\u914D "${requested}"\uFF08\u53EF\u80FD\u662F\u989D\u5EA6\u8017\u5C3D\u6216\u6A21\u578B\u5DF2\u4E0B\u7EBF\uFF09`,
      "model_not_found",
      { available_virtual_models: VIRTUAL_MODELS.map((v) => v.id), code: "model_not_found", retryable: false, request_id: requestId }
    );
  }
  const groupStrategies = await loadGroupStrategies(env);
  const strategy = groupStrategy(groupStrategies, resolved.group?.key);
  let sessKey = null;
  try {
    sessKey = await deriveSessionKey(req, body, requested);
  } catch {
    sessKey = null;
  }
  let order;
  try {
    order = await coordFetch(env, "/order", {
      strategy,
      session: sessKey ?? void 0,
      gkey: auth.dailyLimit ? { id: auth.keyId, limit: auth.dailyLimit } : void 0,
      candidates: resolved.candidates.map((c) => ({
        provider: c.provider,
        model: c.model,
        weight: c.weight
      })),
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
      `\u8C03\u7528 Key \u7684\u6BCF\u65E5\u8BF7\u6C42\u989D\u5EA6\u5DF2\u7528\u5B8C\uFF08${order.gkey.used}/${order.gkey.limit}\uFF09`,
      "rate_limit_error",
      { code: "caller_quota_exceeded", retryable: true, retry_after_ms: order.gkey.retryAfterMs, request_id: requestId }
    );
    res.headers.set("Retry-After", String(Math.max(1, Math.ceil(order.gkey.retryAfterMs / 1e3))));
    return res;
  }
  if (!order.picks.length) {
    return noCapacityError(order, resolved.candidates.map((c) => `${c.provider}/${c.model}`), requestId);
  }
  // Session stickiness: the pin rode along with /order (no separate
  // round trip). If it names an endpoint among the healthy picks,
  // try that one first; a pin whose endpoint is unavailable is
  // ignored (the request routes normally and re-pins to whatever
  // succeeds).
  let sessPin = null;
  let stickyHit = false;
  if (sessKey) {
    sessPin = order.pin ?? null;
    if (sessPin) {
      const idx = order.picks.findIndex(
        (p) => p.provider === sessPin.provider && p.model === sessPin.model && (!sessPin.keyId || p.keyId === sessPin.keyId)
      );
      if (idx >= 0) {
        stickyHit = true;
        if (idx > 0) {
          const [pk] = order.picks.splice(idx, 1);
          order.picks.unshift(pk);
        }
      }
    }
  }
  const stickyFor = (pick, keyId) => {
    if (!sessKey)
      return {};
    const samePin = sessPin && sessPin.provider === pick.provider && sessPin.model === pick.model && (sessPin.keyId ?? null) === (keyId ?? null);
    if (!samePin || !order.pinFresh) {
      ctx.waitUntil(
        coordFetch(env, "/session-put", {
          key: sessKey,
          provider: pick.provider,
          model: pick.model,
          keyId: keyId ?? null
        }).catch(() => void 0)
      );
    }
    const hit = stickyHit && sessPin && pick.provider === sessPin.provider && pick.model === sessPin.model;
    return { "x-gw-sticky": hit ? "hit" : "new" };
  };
  const degradedHeader = resolved.degraded ? { "x-gw-degraded": resolved.degraded } : {};
  const deadModels = /* @__PURE__ */ new Set();
  const droppedHere = [];
  const localDrops = new Map(
    Object.entries(order.drops).map(([k, v]) => [k, [...v]])
  );
  let attempts = 0;
  let last = null;
  for (const pick of order.picks) {
    if (attempts >= maxAttempts)
      break;
    const provider = byId.get(pick.provider);
    if (!provider)
      continue;
    const key = provider.keys.find((k) => k.id === pick.keyId && !k.disabled);
    if (!key)
      continue;
    const mkey = `${pick.provider}/${pick.model}`;
    if (deadModels.has(mkey))
      continue;
    const t0 = Date.now();
    let result;
    let tries = 0;
    const pickLearned = [];
    for (; ; ) {
      tries += 1;
      result = await invoke(
        provider,
        key,
        pick.model,
        body,
        localDrops.get(pick.provider) ?? [],
        cfg.timeoutMs
      );
      if (result.ok)
        break;
      // Unsupported-param 400: strip the named field and retry THIS pick
      // at once. Without this, the drop was only learned for the next
      // request (or the next pick), so a single-endpoint model always
      // failed its first call carrying an extra field (e.g. minis'
      // `thinking` rejected by the AMD DeepSeek endpoints).
      if (result.kind === "bad_param" && result.param) {
        const arr = localDrops.get(pick.provider) ?? [];
        if (!arr.includes(result.param) && tries <= 3) {
          arr.push(result.param);
          localDrops.set(pick.provider, arr);
          if (!droppedHere.includes(result.param))
            droppedHere.push(result.param);
          pickLearned.push(result.param);
          continue;
        }
      }
      const concurrencyLimited = result.kind === "rate_limit" && /concurren/i.test(result.text);
      if (!concurrencyLimited || tries >= 3)
        break;
      await sleep(1500 * tries);
    }
    attempts += tries;
    const latency = Date.now() - t0;
    if (result.ok) {
      if (result.type === "stream") {
        const firstByteMs = latency;
        ctx.waitUntil(
          withTimeout(
            Promise.race([
              result.usage.then((u) => ({ u })),
              result.aborted.then(() => ({ u: null, aborted: true }))
            ]),
            15 * 6e4,
            { u: null }
          ).then(async (settled) => {
            const wasAborted = settled.aborted === true;
            // An aborted stream settles with its first-byte latency;
            // recording the (up to 15-minute) settlement wait would
            // poison the endpoint's latency EMA.
            const fullLatency = wasAborted ? firstByteMs : Date.now() - t0;
            await coordFetch(env, "/report", {
              provider: pick.provider,
              model: pick.model,
              keyId: key.id,
              ok: true,
              status: 200,
              latencyMs: fullLatency,
              aborted: wasAborted || void 0,
              param: pickLearned[0] ?? void 0,
              day: order.day
            }).catch(() => void 0);
            await recordUsage(env, {
              provider: pick.provider,
              model: pick.model,
              keyId: key.id,
              virtualModel: requested,
              status: 200,
              ok: true,
              usage: settled.u,
              latencyMs: fullLatency,
              attempts,
              errorKind: wasAborted ? "client_abort" : void 0,
              stream: true
            }, ctx);
          }).catch(() => void 0)
        );
        const headers = corsHeaders({
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId,
          ...droppedHere.length ? { "x-gw-dropped-params": droppedHere.join(",") } : {},
          ...stickyFor(pick, key.id),
          ...degradedHeader,
          ...resolved.group ? { "x-gw-group": resolved.group.id, "x-gw-strategy": strategy } : {}
        });
        return new Response(result.stream, { status: 200, headers });
      }
      const out = { ...result.json };
      if (typeof out === "object" && out !== null)
        out.model = requested;
      ctx.waitUntil(
        coordFetch(env, "/report", {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          ok: true,
          status: 200,
          latencyMs: latency,
          param: pickLearned[0] ?? void 0,
          day: order.day
        }).catch(() => void 0)
      );
      ctx.waitUntil(
        recordUsage(env, {
          provider: pick.provider,
          model: pick.model,
          keyId: key.id,
          virtualModel: requested,
          status: 200,
          ok: true,
          usage: result.usage,
          latencyMs: latency,
          attempts,
          stream: false
        }, ctx)
      );
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: corsHeaders({
          "content-type": "application/json; charset=utf-8",
          "x-gw-provider": pick.provider,
          "x-gw-model": pick.model,
          "x-gw-attempts": String(attempts),
          "x-gw-request-id": requestId,
          ...droppedHere.length ? { "x-gw-dropped-params": droppedHere.join(",") } : {},
          ...stickyFor(pick, key.id),
          ...degradedHeader,
          ...resolved.group ? { "x-gw-group": resolved.group.id, "x-gw-strategy": strategy } : {}
        })
      });
    }
    if (result.kind === "model_gone")
      deadModels.add(mkey);
    last = { status: result.status, message: result.text, kind: result.kind, retryAfterMs: result.retryAfterMs };
    ctx.waitUntil(
      coordFetch(env, "/report", {
        provider: pick.provider,
        model: pick.model,
        keyId: key.id,
        ok: false,
        status: result.status,
        kind: result.kind,
        latencyMs: latency,
        retryAfterMs: result.retryAfterMs,
        error: result.text,
        param: result.param ?? pickLearned[pickLearned.length - 1],
        day: order.day
      }).catch(() => void 0)
    );
    if (result.kind === "bad_param") {
      if (result.param) {
        const arr = localDrops.get(pick.provider) ?? [];
        if (!arr.includes(result.param)) {
          arr.push(result.param);
          droppedHere.push(result.param);
        }
        localDrops.set(pick.provider, arr);
      } else if (isContextError(result.text)) {
        // A context-window overflow is a property of this endpoint, not
        // of the request itself: another endpoint in the pool may have a
        // larger window, so fail over instead of returning the 400. If
        // every pick overflows, the loop ends and the last 400 is what
        // the caller gets, as before.
        deadModels.add(mkey);
        continue;
      } else {
        ctx.waitUntil(
          recordUsage(env, {
            provider: pick.provider,
            model: pick.model,
            keyId: key.id,
            virtualModel: requested,
            status: result.status || 400,
            ok: false,
            usage: null,
            latencyMs: Date.now() - startedAt,
            attempts,
            errorKind: "bad_param",
            stream: Boolean(body.stream)
          }, ctx)
        );
        return openAIError(
          result.status >= 400 && result.status < 500 ? result.status : 400,
          truncate(result.text, 500),
          "invalid_request_error",
          { request_id: requestId, code: "invalid_request", retryable: false, attempts }
        );
      }
    }
    if (result.kind === "content") {
      return openAIError(400, truncate(result.text, 500), "content_filter", { request_id: requestId, code: "content_filter", retryable: false, attempts });
    }
  }
  const finalStatus = last && (last.status === 400 || last.status === 422) ? last.status : 503;
  const finalMeta = last?.kind === "bad_param" && isContextError(last.message ?? "") ? { code: "context_length_exceeded", retryable: false } : upstreamErrorMeta(last?.kind, last?.retryAfterMs);
  ctx.waitUntil(
    recordUsage(env, {
      provider: "gateway",
      model: requested,
      keyId: "-",
      virtualModel: requested,
      status: finalStatus,
      ok: false,
      usage: null,
      latencyMs: Date.now() - startedAt,
      attempts,
      errorKind: last?.kind ?? "no_capacity",
      stream: Boolean(body.stream)
    }, ctx)
  );
  return openAIError(
    finalStatus,
    `\u6240\u6709\u5019\u9009\u90FD\u5931\u8D25\u4E86\uFF08\u5C1D\u8BD5 ${attempts} \u6B21\uFF09\u3002\u6700\u540E\u4E00\u6B21: ${truncate(last?.message ?? "\u672A\u77E5\u9519\u8BEF", 300)}`,
    finalStatus === 503 ? "upstream_unavailable" : "invalid_request_error",
    { attempts, last_error: last, request_id: requestId, ...finalMeta }
  );
}
__name(handleChat, "handleChat");
export function capabilityFields(x) {
  const inputs = x.inputModalities ?? ["text"];
  const outputs = x.outputModalities ?? ["text"];
  const out = {
    architecture: {
      modality: inputs.join("+") + "->" + outputs.join("+"),
      input_modalities: inputs,
      output_modalities: outputs
    },
    input_modalities: inputs,
    output_modalities: outputs
  };
  if (x.contextLength || x.maxOutput) {
    out.top_provider = {
      context_length: x.contextLength,
      max_completion_tokens: x.maxOutput
    };
  }
  return out;
}
__name(capabilityFields, "capabilityFields");
export var deadCache = null;
export var DEAD_CACHE_TTL = 15e3;
// The dead-model set changes slowly; caching it for 15s keeps
// /v1/models (the first call every client makes) from queueing on
// the single-threaded Coordinator every time. Real requests still
// go through /order and are unaffected.
async function deadSet(env) {
  if (deadCache && Date.now() - deadCache.at < DEAD_CACHE_TTL)
    return deadCache.set;
  try {
    const d = await coordFetch(env, "/dead");
    deadCache = { at: Date.now(), set: new Set(d.dead ?? []) };
  } catch {
    deadCache = { at: Date.now(), set: deadCache?.set ?? /* @__PURE__ */ new Set() };
  }
  return deadCache.set;
}
__name(deadSet, "deadSet");
export async function handleModels(env, url) {
  const cfg = settings(env);
  const catalog = await loadCatalog(env);
  const providers = await loadProviders(env);
  const allowed = new Set(
    providers.filter((p) => p.enabled && p.keys.some((k) => !k.disabled)).map((p) => p.id)
  );
  const dead = await deadSet(env);
  const entries = (catalog?.entries ?? []).filter(
    (e) => allowed.has(e.provider) && !dead.has(e.key)
  );
  const mode = (url?.searchParams.get("group") ?? "").toLowerCase();
  const grouped = mode === "off" ? false : mode === "on" ? true : cfg.grouping;
  const verbose = url?.searchParams.get("verbose") === "1";
  const data = VIRTUAL_MODELS.map((v) => ({
    id: v.id,
    object: "model",
    created: 0,
    owned_by: "gateway",
    description: v.description
  }));
  const seen = new Set(data.map((d) => d.id));
  if (grouped) {
    for (const g of await allGroupsOf(env, catalog)) {
      if (data.length >= 800)
        break;
      if (!g.endpoints.some((e) => allowed.has(e.provider) && !dead.has(e.key)))
        continue;
      if (seen.has(g.id))
        continue;
      seen.add(g.id);
      const row = {
        id: g.id,
        object: "model",
        created: g.created,
        owned_by: g.providers.length > 1 ? "gateway" : g.providers[0],
        context_length: g.contextLength,
        max_output_tokens: g.maxOutput,
        ...capabilityFields(g),
        providers: g.providers,
        endpoints: g.endpoints.length,
        family: g.family,
        tags: g.tags
      };
      if (verbose)
        row.aliases = g.aliases;
      data.push(row);
    }
    return json({ object: "list", data });
  }
  const counts = /* @__PURE__ */ new Map();
  for (const e of entries)
    counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
  for (const e of entries) {
    if (data.length >= 800)
      break;
    if (seen.has(e.key))
      continue;
    seen.add(e.key);
    data.push({
      id: e.key,
      object: "model",
      created: e.created ?? 0,
      owned_by: e.provider,
      context_length: e.contextLength,
      max_output_tokens: e.maxOutput,
      ...capabilityFields(e),
      family: e.family,
      tags: e.tags
    });
    if ((counts.get(e.model) ?? 0) === 1 && !seen.has(e.model)) {
      seen.add(e.model);
      data.push({
        id: e.model,
        object: "model",
        created: e.created ?? 0,
        owned_by: e.provider,
        context_length: e.contextLength,
        max_output_tokens: e.maxOutput,
        ...capabilityFields(e)
      });
    }
  }
  return json({ object: "list", data });
}
__name(handleModels, "handleModels");
