import { __name } from "../helpers.js";
import { argsObject, textOf } from "./anthropic.js";
import { deferred, json, parseSSE, safeJsonParse, sseEncode } from "../util.js";
import { normalizeUsage } from "./openai.js";

export var FINISH_REASON = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  MALFORMED_FUNCTION_CALL: "stop",
  OTHER: "stop"
};
export var SCHEMA_DROP = /* @__PURE__ */ new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "strict",
  "default",
  "examples",
  "const",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "patternProperties",
  "if",
  "then",
  "else",
  "not",
  "dependentRequired",
  "nullable",
  "discriminator",
  "readOnly",
  "writeOnly",
  "deprecated"
]);
export function cleanSchema(node) {
  if (Array.isArray(node))
    return node.map(cleanSchema);
  if (!node || typeof node !== "object")
    return node;
  const src = node;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (SCHEMA_DROP.has(k))
      continue;
    out[k] = cleanSchema(v);
  }
  if (Array.isArray(out.type)) {
    const nonNull = out.type.filter((t) => t !== "null");
    if (out.type.length !== nonNull.length)
      out.nullable = true;
    if (nonNull.length === 1)
      out.type = nonNull[0];
    else if (nonNull.length === 0)
      delete out.type;
    else
      out.type = nonNull[0];
  }
  if (Array.isArray(out.anyOf)) {
    const branches = out.anyOf;
    const nonNull = branches.filter((b) => b?.type !== "null");
    if (nonNull.length !== branches.length)
      out.nullable = true;
    if (nonNull.length === 1) {
      Object.assign(out, nonNull[0]);
      delete out.anyOf;
    } else {
      out.anyOf = nonNull;
    }
  }
  if (out.properties && !out.type)
    out.type = "object";
  if (out.items && !out.type)
    out.type = "array";
  return out;
}
__name(cleanSchema, "cleanSchema");
export function argsObject2(raw) {
  const v = safeJsonParse(raw ?? "{}", null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
__name(argsObject2, "argsObject");
export function dataUrlToInline(url) {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m)
    return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}
__name(dataUrlToInline, "dataUrlToInline");
export function textOf2(content) {
  if (content == null)
    return "";
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((p) => p && typeof p === "object" && typeof p.text === "string" ? p.text : "").join("");
  }
  return String(content);
}
__name(textOf2, "textOf");
export function toGeminiRequest(req) {
  const contents = [];
  const systemParts = [];
  const toolNameById = /* @__PURE__ */ new Map();
  const push = /* @__PURE__ */ __name((role, parts) => {
    if (!parts.length)
      return;
    const last = contents[contents.length - 1];
    if (last && last.role === role)
      last.parts.push(...parts);
    else
      contents.push({ role, parts });
  }, "push");
  for (const m of req.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const t = textOf2(m.content);
      if (t)
        systemParts.push(t);
      continue;
    }
    if (m.role === "tool") {
      // A tool result whose call id was never seen must not be
      // labelled with an undeclared function name — Gemini 400s
      // the whole request for that. Fall back to the single known
      // function when there is exactly one candidate, else drop
      // the orphaned result.
      let name = toolNameById.get(m.tool_call_id ?? "");
      if (!name) {
        const known = [...new Set([...toolNameById.values(), ...(req.tools ?? []).map((t) => t?.function?.name).filter(Boolean)])];
        if (known.length === 1)
          name = known[0];
        else
          continue;
      }
      const raw = textOf2(m.content);
      const parsed = safeJsonParse(raw, null);
      const response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { content: raw || "(no output)" };
      push("user", [{ functionResponse: { name, response } }]);
      continue;
    }
    if (m.role === "assistant") {
      const parts2 = [];
      const text = textOf2(m.content);
      if (text)
        parts2.push({ text });
      for (const tc of m.tool_calls ?? []) {
        toolNameById.set(tc.id, tc.function?.name ?? "tool");
        parts2.push({
          functionCall: {
            name: tc.function?.name ?? "tool",
            args: argsObject2(tc.function?.arguments)
          }
        });
      }
      push("model", parts2);
      continue;
    }
    const parts = [];
    if (typeof m.content === "string") {
      if (m.content)
        parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p)
          continue;
        if (p.type === "text" && p.text)
          parts.push({ text: p.text });
        else if (p.type === "image_url" && p.image_url?.url) {
          const inline = dataUrlToInline(p.image_url.url);
          if (inline)
            parts.push(inline);
          else
            parts.push({ fileData: { fileUri: p.image_url.url } });
        }
      }
    }
    if (!parts.length)
      parts.push({ text: "(empty)" });
    push("user", parts);
  }
  if (!contents.length)
    contents.push({ role: "user", parts: [{ text: "(empty)" }] });
  if (contents[0].role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "\u7EE7\u7EED" }] });
  }
  const body = { contents };
  if (systemParts.length)
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  const gen = {};
  if (typeof req.temperature === "number")
    gen.temperature = Math.max(0, Math.min(2, req.temperature));
  if (typeof req.top_p === "number")
    gen.topP = req.top_p;
  const maxOut = req.max_tokens ?? req.max_completion_tokens;
  if (typeof maxOut === "number")
    gen.maxOutputTokens = Math.max(1, maxOut);
  if (req.stop)
    gen.stopSequences = Array.isArray(req.stop) ? req.stop.slice(0, 5) : [req.stop];
  if (req.response_format && (req.response_format.type === "json_object" || req.response_format.type === "json_schema")) {
    gen.responseMimeType = "application/json";
    const schema = req.response_format.json_schema?.schema;
    if (schema)
      gen.responseSchema = cleanSchema(schema);
  }
  if (Object.keys(gen).length)
    body.generationConfig = gen;
  if (Array.isArray(req.tools) && req.tools.length) {
    const decls = req.tools.filter((t) => t && typeof t === "object" && t.function).map((t) => {
      const f = t.function;
      return {
        name: f.name,
        description: f.description ?? "",
        parameters: cleanSchema(f.parameters ?? { type: "object", properties: {} })
      };
    });
    if (decls.length) {
      body.tools = [{ functionDeclarations: decls }];
      const choice = req.tool_choice;
      let mode;
      let allowedFunctionNames;
      if (choice === "auto")
        mode = "AUTO";
      else if (choice === "required")
        mode = "ANY";
      else if (choice === "none")
        mode = "NONE";
      else if (choice && typeof choice === "object") {
        const c = choice;
        const name = c.function?.name ?? (c.type === "function" ? c.name : void 0);
        if (c.type === "function" && name) {
          mode = "ANY";
          allowedFunctionNames = [String(name)];
        }
      }
      if (mode) {
        body.toolConfig = {
          functionCallingConfig: {
            mode,
            ...allowedFunctionNames ? { allowedFunctionNames } : {}
          }
        };
      }
    }
  }
  return body;
}
__name(toGeminiRequest, "toGeminiRequest");
export function extractParts(data) {
  const cand = data.candidates?.[0] ?? {};
  const parts = cand.content?.parts ?? [];
  let text = "";
  const toolCalls = [];
  for (const p of parts) {
    if (typeof p.text === "string" && !p.thought)
      text += p.text;
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function",
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {})
        }
      });
    }
  }
  return { text, toolCalls, finishReason: cand.finishReason, parts };
}
__name(extractParts, "extractParts");
export function fromGeminiResponse(data, model) {
  if (data.promptFeedback?.blockReason) {
    // Return a classified content_filter completion instead of
    // throwing: the caller otherwise gets an opaque exception
    // rather than the structured outcome the streaming path emits.
    const usage = normalizeUsage(data.usageMetadata) ?? {
      prompt_tokens: Number(data.usageMetadata?.promptTokenCount ?? 0),
      completion_tokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0),
      total_tokens: Number(data.usageMetadata?.totalTokenCount ?? 0)
    };
    return {
      id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1e3),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: "content_filter"
        }
      ],
      usage
    };
  }
  const { text, toolCalls, finishReason } = extractParts(data);
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length)
    message.tool_calls = toolCalls;
  const usage = normalizeUsage(data.usageMetadata) ?? {
    prompt_tokens: Number(data.usageMetadata?.promptTokenCount ?? 0),
    completion_tokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0),
    total_tokens: Number(data.usageMetadata?.totalTokenCount ?? 0)
  };
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [
      {
        index: 0,
        message,
        // Gemini 函数调用完成时 finishReason 仍是 STOP，必须按有没有 tool call 判定
        finish_reason: toolCalls.length ? "tool_calls" : FINISH_REASON[finishReason ?? "STOP"] ?? "stop"
      }
    ],
    usage
  };
}
__name(fromGeminiResponse, "fromGeminiResponse");
export function geminiStream(body, model) {
  const usage = deferred();
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  let toolIndex = -1;
  let lastUsage = null;
  let finished = false;
  let doneSent = false;
  const chunk = /* @__PURE__ */ __name((delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  }), "chunk");
  const stream = parseSSE(body).pipeThrough(
    new TransformStream({
      transform(ev, controller) {
        if (finished)
          return;
        if (!ev.data || ev.data === "[DONE]")
          return;
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (data.promptFeedback?.blockReason) {
          controller.enqueue(
            sseEncode({
              error: {
                message: `gemini blocked: ${data.promptFeedback.blockReason}`,
                type: "content_filter"
              }
            })
          );
          controller.enqueue(sseEncode(chunk({}, "content_filter")));
          controller.enqueue(sseEncode("[DONE]"));
          finished = true;
          doneSent = true;
          usage.resolve(lastUsage);
          return;
        }
        const u = normalizeUsage(data.usageMetadata);
        if (u)
          lastUsage = u;
        const { text, toolCalls, finishReason } = extractParts(data);
        if (text)
          controller.enqueue(sseEncode(chunk({ content: text })));
        for (const tc of toolCalls) {
          toolIndex += 1;
          controller.enqueue(
            sseEncode(
              chunk({
                tool_calls: [
                  {
                    index: toolIndex,
                    id: tc.id,
                    type: "function",
                    function: tc.function
                  }
                ]
              })
            )
          );
        }
        if (finishReason) {
          const reason = toolIndex >= 0 ? "tool_calls" : FINISH_REASON[finishReason] ?? "stop";
          const finalChunk = chunk({}, reason);
          if (lastUsage)
            finalChunk.usage = lastUsage;
          controller.enqueue(sseEncode(finalChunk));
          finished = true;
        }
      },
      flush(controller) {
        finished = true;
        if (!doneSent)
          controller.enqueue(sseEncode("[DONE]"));
        usage.resolve(lastUsage);
      }
    })
  );
  return { stream, usage: usage.promise };
}
__name(geminiStream, "geminiStream");
export var geminiAdapter = {
  build(ctx) {
    const body = toGeminiRequest(ctx.req);
    const GEN_MAP = {
      temperature: "temperature",
      top_p: "topP",
      max_tokens: "maxOutputTokens",
      max_completion_tokens: "maxOutputTokens",
      stop: "stopSequences"
    };
    for (const p of [...ctx.drops, ...ctx.provider.dropParams ?? []]) {
      delete body[p];
      const mapped = GEN_MAP[p];
      if (mapped && body.generationConfig)
        delete body.generationConfig[mapped];
    }
    if (body.generationConfig && !Object.keys(body.generationConfig).length) {
      delete body.generationConfig;
    }
    const verb = ctx.req.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return {
      url: `${ctx.provider.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(ctx.model)}:${verb}`,
      init: {
        method: "POST",
        headers: {
          ...ctx.provider.headers ?? {},
          "content-type": "application/json",
          "x-goog-api-key": ctx.key.key
        },
        body: JSON.stringify(body)
      }
    };
  },
  parseJson(data, ctx) {
    const obj = data ?? {};
    const out = fromGeminiResponse(obj, ctx.model);
    return { json: out, usage: out.usage };
  },
  parseStream(body, ctx) {
    return geminiStream(body, ctx.model);
  }
};
