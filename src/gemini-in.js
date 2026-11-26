import { CORS } from "./util.js";
import { __name } from "./helpers.js";
import { allGroupsOf, loadCatalog } from "./store.js";
import { checkCallerLock, checkGatewayToken, extractToken, noteCallerAuthFailure } from "./auth.js";
import { handleChat } from "./router.js";
import { json, parseSSE } from "./util.js";
import { settings } from "./config.js";
import { fromGeminiTools } from "./tools.js";

export function geminiError(status, statusText, message, extra = {}) {
  return json({ error: { code: status, message, status: statusText, ...extra } }, { status });
}
__name(geminiError, "geminiError");
export function statusTextFor(status) {
  if (status === 400)
    return "INVALID_ARGUMENT";
  if (status === 401)
    return "UNAUTHENTICATED";
  if (status === 404)
    return "NOT_FOUND";
  if (status === 429)
    return "RESOURCE_EXHAUSTED";
  if (status === 503)
    return "UNAVAILABLE";
  return "INTERNAL";
}
__name(statusTextFor, "statusTextFor");
export async function geminiAuth(req, env, url) {
  const lock = await checkCallerLock(env, req);
  if (lock.locked)
    return { ok: false, locked: true, retryAfterMs: lock.retryAfterMs };
  const base = await checkGatewayToken(req, env);
  if (base.ok)
    return base;
  const key = url.searchParams.get("key");
  if (key) {
    const headers = new Headers(req.headers);
    headers.set("x-goog-api-key", key);
    const cloned = new Request(req.url, { headers });
    const second = await checkGatewayToken(cloned, env);
    if (second.ok)
      return second;
    if (second.reason !== "unconfigured")
      await noteCallerAuthFailure(env, req, lock.id);
    return second;
  }
  if (base.reason !== "unconfigured")
    await noteCallerAuthFailure(env, req, lock.id);
  return base;
}
__name(geminiAuth, "geminiAuth");
export function finishReasonFor(finish) {
  switch (finish) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return "STOP";
  }
}
__name(finishReasonFor, "finishReasonFor");
export function partsToOpenAI(parts, role, out, toolCalls, idFor) {
  if (!Array.isArray(parts))
    return;
  for (const p of parts) {
    if (!p || typeof p !== "object")
      continue;
    if (typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
    } else if (p.inlineData && typeof p.inlineData === "object") {
      const d = p.inlineData;
      out.push({
        type: "image_url",
        image_url: { url: "data:" + String(d.mimeType ?? "image/png") + ";base64," + String(d.data ?? "") }
      });
    } else if (p.fileData && typeof p.fileData === "object") {
      const d = p.fileData;
      if (d.fileUri)
        out.push({ type: "image_url", image_url: { url: String(d.fileUri) } });
    } else if (p.functionCall && typeof p.functionCall === "object" && role === "assistant") {
      const fc = p.functionCall;
      toolCalls.push({
        id: idFor ? idFor(String(fc.name ?? "fn")) : "call_" + String(fc.name ?? "fn"),
        type: "function",
        function: { name: String(fc.name ?? ""), arguments: JSON.stringify(fc.args ?? {}) }
      });
    }
  }
}
__name(partsToOpenAI, "partsToOpenAI");
export function geminiToOpenAI(body, model) {
  const messages = [];
  const sysParts = [];
  // Synthesized tool-call ids pair the n-th call to a function with
  // the n-th response for it; a bare "call_" + name collides when
  // one function is called twice in a conversation, and adapters
  // that key results by id then attach results to the wrong call.
  const callSeq = /* @__PURE__ */ new Map();
  const respSeq = /* @__PURE__ */ new Map();
  const nextId = (map, name) => {
    const n = (map.get(name) ?? 0) + 1;
    map.set(name, n);
    return "call_" + name + "_" + n;
  };
  const si = body.systemInstruction;
  if (si)
    partsToOpenAI(si.parts, "user", sysParts, []);
  const sysText = sysParts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("");
  if (sysText)
    messages.push({ role: "system", content: sysText });
  for (const c of body.contents ?? []) {
    const role = c.role === "model" ? "assistant" : "user";
    const parts = [];
    const toolCalls = [];
    const toolMsgs = [];
    if (Array.isArray(c.parts)) {
      for (const p of c.parts) {
        if (p?.functionResponse && typeof p.functionResponse === "object") {
          const fr = p.functionResponse;
          const resp = fr.response;
          toolMsgs.push({
            role: "tool",
            tool_call_id: nextId(respSeq, String(fr.name ?? "fn")),
            content: typeof resp === "string" ? resp : JSON.stringify(resp ?? {})
          });
        }
      }
    }
    partsToOpenAI(c.parts, role, parts, toolCalls, (name) => nextId(callSeq, name));
    messages.push(...toolMsgs);
    if (parts.length || toolCalls.length) {
      const msg = { role, content: parts.length ? parts : "" };
      if (toolCalls.length)
        msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }
  const out = { model, messages, stream: false };
  const gc = body.generationConfig ?? {};
  if (typeof gc.maxOutputTokens === "number")
    out.max_tokens = gc.maxOutputTokens;
  if (typeof gc.temperature === "number")
    out.temperature = gc.temperature;
  if (typeof gc.topP === "number")
    out.top_p = gc.topP;
  if (Array.isArray(gc.stopSequences))
    out.stop = gc.stopSequences;
  if (gc.responseMimeType === "application/json") {
    out.response_format = gc.responseSchema && typeof gc.responseSchema === "object"
      ? { type: "json_schema", json_schema: { name: "response", schema: gc.responseSchema } }
      : { type: "json_object" };
  }
  const convertedTools = fromGeminiTools(body.tools);
  if (convertedTools.tools?.length)
    out.tools = convertedTools.tools;
  const tc = body.toolConfig?.functionCallingConfig;
  if (tc) {
    if (tc.mode === "NONE")
      out.tool_choice = "none";
    else if (tc.mode === "ANY") {
      const allowed = tc.allowedFunctionNames ?? [];
      out.tool_choice = allowed.length === 1 ? { type: "function", function: { name: allowed[0] } } : "required";
    }
  }
  return out;
}
__name(geminiToOpenAI, "geminiToOpenAI");
export function partsFromMessage(msg) {
  const parts = [];
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content)
    parts.push({ text: msg.reasoning_content, thought: true });
  if (typeof msg.content === "string" && msg.content)
    parts.push({ text: msg.content });
  if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p?.type === "text" && typeof p.text === "string")
        parts.push({ text: p.text });
    }
  }
  for (const call of msg.tool_calls ?? []) {
    const fn = call.function ?? {};
    let args = {};
    try {
      args = JSON.parse(String(fn.arguments ?? "{}"));
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: String(fn.name ?? ""), args } });
  }
  return parts;
}
__name(partsFromMessage, "partsFromMessage");
export function usageMeta(usage) {
  const u = usage ?? {};
  const prompt = Number(u.prompt_tokens ?? 0);
  const cand = Number(u.completion_tokens ?? 0);
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: cand,
    totalTokenCount: Number(u.total_tokens ?? prompt + cand)
  };
}
__name(usageMeta, "usageMeta");
export function openAIToGemini(data, model) {
  const choice = (data.choices ?? [])[0] ?? {};
  const parts = partsFromMessage(choice.message ?? {});
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: finishReasonFor(choice.finish_reason),
        index: 0
      }
    ],
    usageMetadata: usageMeta(data.usage),
    modelVersion: model
  };
}
__name(openAIToGemini, "openAIToGemini");
export async function* geminiChunks(body, model) {
  const reader = parseSSE(body).getReader();
  let usage;
  // OpenAI streams tool calls as argument fragments spread over many
  // deltas; Gemini expects one whole functionCall part. Accumulate
  // the fragments per tool-call index and emit them once, complete,
  // on the finish chunk (or at stream end if none arrives) instead
  // of one empty-args functionCall per fragment.
  const pendingTools = new Map();
  const flushTools = (parts) => {
    for (const idx of [...pendingTools.keys()].sort((a, b) => a - b)) {
      const tc = pendingTools.get(idx);
      let args = {};
      try {
        args = JSON.parse(tc.argsStr || "{}");
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: tc.name, args } });
    }
    pendingTools.clear();
  };
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) {
      if (pendingTools.size) {
        const parts = [];
        flushTools(parts);
        yield {
          candidates: [{ content: { role: "model", parts }, index: 0, finishReason: "STOP" }],
          ...usage ? { usageMetadata: usageMeta(usage) } : {},
          modelVersion: model
        };
      }
      return;
    }
    if (!value || value.data === "[DONE]")
      continue;
    let chunk;
    try {
      chunk = JSON.parse(value.data);
    } catch {
      continue;
    }
    // An in-band error chunk has no choices and used to be skipped,
    // after which the stream closed with no error and no finish
    // reason (or pending tool fragments were flushed as a normal
    // STOP). Decision 8: it now ends the stream as a terminal
    // error chunk (200 + structured Gemini error) instead of
    // throwing — throwing errored the client stream as a transport
    // failure. Pending tool fragments are discarded with the
    // generator state instead of being flushed.
    if (chunk && typeof chunk === "object" && chunk.error) {
      const emsg = typeof chunk.error === "string" ? chunk.error : String(chunk.error?.message ?? "upstream error");
      yield {
        error: {
          code: 500,
          message: emsg,
          status: "INTERNAL",
          ...(typeof chunk.error?.code === "string" ? { gw_code: chunk.error.code } : {})
        }
      };
      return;
    }
    if (chunk.usage)
      usage = chunk.usage;
    const choice = (chunk.choices ?? [])[0];
    if (!choice)
      continue;
    const delta = choice.delta ?? {};
    for (const tc of delta.tool_calls ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const cur = pendingTools.get(idx) ?? { name: "", argsStr: "" };
      if (tc.function?.name)
        cur.name = String(tc.function.name);
      if (typeof tc.function?.arguments === "string")
        cur.argsStr += tc.function.arguments;
      pendingTools.set(idx, cur);
    }
    const parts = partsFromMessage({ content: delta.content, reasoning_content: delta.reasoning_content });
    const isLast = typeof choice.finish_reason === "string" && !!choice.finish_reason;
    if (isLast)
      flushTools(parts);
    if (!parts.length && !isLast)
      continue;
    const out = {
      candidates: [
        {
          content: { role: "model", parts },
          index: 0,
          ...isLast ? { finishReason: finishReasonFor(choice.finish_reason) } : {}
        }
      ],
      modelVersion: model
    };
    if (isLast && usage)
      out.usageMetadata = usageMeta(usage);
    yield out;
  }
}
__name(geminiChunks, "geminiChunks");
export async function handleGeminiModels(req, env, url) {
  const auth = await geminiAuth(req, env, url);
  if (auth.locked)
    return geminiError(429, "RESOURCE_EXHAUSTED", "too many failed authentication attempts", { gw_code: "caller_locked" });
  if (!auth.ok)
    return geminiError(401, "UNAUTHENTICATED", "invalid gateway token");
  const catalog = await loadCatalog(env);
  if (!catalog)
    return json({ models: [] });
  const cfg = settings(env);
  // Staged (staleSince) entries are hidden from the listing like
  // everywhere else, while routing can still hit them.
  const groups = (cfg.grouping ? await allGroupsOf(env, catalog) : []).filter((g) => g.endpoints.some((e) => !e.staleSince));
  const models = groups.length ? groups.map((g) => ({
    name: "models/" + g.id,
    displayName: g.id,
    ...g.contextLength ? { inputTokenLimit: g.contextLength } : {},
    ...g.maxOutput ? { outputTokenLimit: g.maxOutput } : {},
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
  })) : [...new Set(catalog.entries.filter((e) => !e.staleSince).map((e) => e.model))].map((id) => ({
    name: "models/" + id,
    displayName: id,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
  }));
  return json({ models });
}
__name(handleGeminiModels, "handleGeminiModels");
export async function handleGemini(req, env, ctx, pathname, url) {
  const rest = decodeURIComponent(pathname.slice("/v1beta/models/".length));
  let stream = false;
  let model = rest;
  if (rest.endsWith(":streamGenerateContent")) {
    stream = true;
    model = rest.slice(0, -":streamGenerateContent".length);
  } else if (rest.endsWith(":generateContent")) {
    model = rest.slice(0, -":generateContent".length);
  } else {
    return geminiError(404, "NOT_FOUND", `\u672A\u77E5\u52A8\u4F5C: ${rest}`);
  }
  if (!model)
    return geminiError(400, "INVALID_ARGUMENT", "model \u4E0D\u80FD\u4E3A\u7A7A");
  const auth = await geminiAuth(req, env, url);
  if (auth.locked)
    return geminiError(429, "RESOURCE_EXHAUSTED", "too many failed authentication attempts", { gw_code: "caller_locked" });
  if (!auth.ok)
    return geminiError(401, "UNAUTHENTICATED", "invalid gateway token");
  let body;
  try {
    body = await req.json();
  } catch {
    return geminiError(400, "INVALID_ARGUMENT", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  const oai = geminiToOpenAI(body, model);
  oai.stream = stream;
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const token = extractToken(req) || url.searchParams.get("key") || "";
  if (token)
    headers.set("authorization", "Bearer " + token);
  for (const h of ["x-gw-session", "x-gw-max-attempts"]) {
    const v = req.headers.get(h);
    if (v)
      headers.set(h, v);
  }
  const inner = new Request("https://gateway.internal/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(oai)
  });
  const res = await handleChat(inner, env, ctx);
  if (res.status !== 200) {
    let message = `\u4E0A\u6E38\u9519\u8BEF (${res.status})`;
    const extra = {};
    try {
      const ej = await res.json();
      const err = ej.error ?? {};
      if (err.message)
        message = String(err.message);
      // Same machine-readable fields the OpenAI/Anthropic paths
      // carry; note error.code here stays the HTTP status per the
      // Gemini shape, the gateway code rides along as gw_code.
      for (const k of ["retryable", "retry_after_ms", "request_id", "attempts"])
        if (err[k] !== void 0)
          extra[k] = err[k];
      if (err.code !== void 0)
        extra.gw_code = err.code;
    } catch {
    }
    return geminiError(res.status, statusTextFor(res.status), message, extra);
  }
  const gwHeaders = { ...CORS };
  for (const [k, v] of res.headers) {
    if (k.toLowerCase().startsWith("x-gw-"))
      gwHeaders[k.toLowerCase()] = v;
  }
  if (!stream) {
    let data;
    try {
      data = await res.json();
    } catch {
      return geminiError(502, "INTERNAL", "\u4E0A\u6E38\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94");
    }
    return json(openAIToGemini(data, model), { headers: gwHeaders });
  }
  if (!res.body)
    return geminiError(502, "INTERNAL", "\u4E0A\u6E38\u8FD4\u56DE\u7A7A\u54CD\u5E94\u4F53");
  if (url.searchParams.get("alt") === "sse") {
    const enc = new TextEncoder();
    // Keepalive ping (item 11) at the gateway's own SSE frame
    // layer: after pingMs with no converted chunk, an SSE comment
    // `: ping` is enqueued. The race keeps one pending generator
    // step at a time (a second next() while one is pending would
    // queue behind it and lose a chunk).
    const pingMs = settings(env).streamPingMs;
    const sse = new ReadableStream({
      async start(controller) {
        const it = geminiChunks(res.body, model)[Symbol.asyncIterator]();
        let lastYieldAt = Date.now();
        let pendingNext = null;
        try {
          for (;;) {
            let next;
            if (!pingMs) {
              next = await it.next();
            } else {
              if (!pendingNext)
                pendingNext = it.next();
              let timer;
              const timeoutP = new Promise((res) => {
                timer = setTimeout(() => res(true), pingMs);
              });
              const raced = await Promise.race([
                pendingNext.then((v) => ({ ...v, ping: false })),
                timeoutP.then(() => ({ ping: true }))
              ]);
              clearTimeout(timer);
              if (raced.ping) {
                if (Date.now() - lastYieldAt >= pingMs) {
                  try {
                    controller.enqueue(enc.encode(": ping\n\n"));
                  } catch {
                  }
                }
                continue;
              }
              pendingNext = null;
              next = raced;
            }
            if (next.done)
              break;
            lastYieldAt = Date.now();
            controller.enqueue(enc.encode("data: " + JSON.stringify(next.value) + "\n\n"));
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      }
    });
    return new Response(sse, {
      status: 200,
      headers: { ...gwHeaders, "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }
  const chunks = [];
  for await (const c of geminiChunks(res.body, model))
    chunks.push(JSON.stringify(c));
  return new Response("[" + chunks.join(",") + "]", {
    status: 200,
    headers: { ...gwHeaders, "content-type": "application/json" }
  });
}
__name(handleGemini, "handleGemini");
