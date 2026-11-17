import { CORS } from "./util.js";
import { __name } from "./helpers.js";
import { allGroupsOf, loadCatalog } from "./store.js";
import { checkGatewayToken, extractToken } from "./auth.js";
import { handleChat } from "./router.js";
import { json, parseSSE } from "./util.js";
import { settings } from "./config.js";

export function geminiError(status, statusText, message) {
  return json({ error: { code: status, message, status: statusText } }, { status });
}
__name(geminiError, "geminiError");
export function statusTextFor(status) {
  if (status === 400)
    return "INVALID_ARGUMENT";
  if (status === 401)
    return "UNAUTHENTICATED";
  if (status === 404)
    return "NOT_FOUND";
  if (status === 429 || status === 503)
    return "RESOURCE_EXHAUSTED";
  return "INTERNAL";
}
__name(statusTextFor, "statusTextFor");
export async function geminiAuth(req, env, url) {
  const base = await checkGatewayToken(req, env);
  if (base.ok)
    return base;
  const key = url.searchParams.get("key");
  if (key) {
    const headers = new Headers(req.headers);
    headers.set("x-goog-api-key", key);
    const cloned = new Request(req.url, { headers });
    return checkGatewayToken(cloned, env);
  }
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
export function partsToOpenAI(parts, role, out, toolCalls) {
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
        id: "call_" + String(fc.name ?? "fn"),
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
            tool_call_id: "call_" + String(fr.name ?? "fn"),
            content: typeof resp === "string" ? resp : JSON.stringify(resp ?? {})
          });
        }
      }
    }
    partsToOpenAI(c.parts, role, parts, toolCalls);
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
  const tools = [];
  for (const t of body.tools ?? []) {
    for (const fd of t?.functionDeclarations ?? []) {
      tools.push({
        type: "function",
        function: {
          name: String(fd.name ?? ""),
          description: String(fd.description ?? ""),
          parameters: fd.parameters ?? { type: "object", properties: {} }
        }
      });
    }
  }
  if (tools.length)
    out.tools = tools;
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
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done)
      return;
    if (!value || value.data === "[DONE]")
      continue;
    let chunk;
    try {
      chunk = JSON.parse(value.data);
    } catch {
      continue;
    }
    if (chunk.usage)
      usage = chunk.usage;
    const choice = (chunk.choices ?? [])[0];
    if (!choice)
      continue;
    const delta = choice.delta ?? {};
    const parts = partsFromMessage({ content: delta.content, tool_calls: delta.tool_calls });
    const isLast = typeof choice.finish_reason === "string" && !!choice.finish_reason;
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
  if (!auth.ok)
    return geminiError(401, "UNAUTHENTICATED", "invalid gateway token");
  const catalog = await loadCatalog(env);
  if (!catalog)
    return json({ models: [] });
  const cfg = settings(env);
  const groups = cfg.grouping ? await allGroupsOf(env, catalog) : [];
  const models = groups.length ? groups.map((g) => ({
    name: "models/" + g.id,
    displayName: g.id,
    ...g.contextLength ? { inputTokenLimit: g.contextLength } : {},
    ...g.maxOutput ? { outputTokenLimit: g.maxOutput } : {},
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
  })) : [...new Set(catalog.entries.map((e) => e.model))].map((id) => ({
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
  const inner = new Request("https://gateway.internal/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(oai)
  });
  const res = await handleChat(inner, env, ctx);
  if (res.status !== 200) {
    let message = `\u4E0A\u6E38\u9519\u8BEF (${res.status})`;
    try {
      const ej = await res.json();
      const err = ej.error ?? {};
      if (err.message)
        message = String(err.message);
    } catch {
    }
    return geminiError(res.status, statusTextFor(res.status), message);
  }
  if (!stream) {
    let data;
    try {
      data = await res.json();
    } catch {
      return geminiError(502, "INTERNAL", "\u4E0A\u6E38\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94");
    }
    return json(openAIToGemini(data, model));
  }
  if (!res.body)
    return geminiError(502, "INTERNAL", "\u4E0A\u6E38\u8FD4\u56DE\u7A7A\u54CD\u5E94\u4F53");
  if (url.searchParams.get("alt") === "sse") {
    const enc = new TextEncoder();
    const sse = new ReadableStream({
      async start(controller) {
        try {
          for await (const c of geminiChunks(res.body, model)) {
            controller.enqueue(enc.encode("data: " + JSON.stringify(c) + "\n\n"));
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      }
    });
    return new Response(sse, {
      status: 200,
      headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }
  const chunks = [];
  for await (const c of geminiChunks(res.body, model))
    chunks.push(JSON.stringify(c));
  return new Response("[" + chunks.join(",") + "]", {
    status: 200,
    headers: { ...CORS, "content-type": "application/json" }
  });
}
__name(handleGemini, "handleGemini");
