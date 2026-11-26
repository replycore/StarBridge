import { CORS } from "./util.js";
import { __name } from "./helpers.js";
import { checkCallerLock, checkGatewayToken, extractToken, noteCallerAuthFailure } from "./auth.js";
import { handleChat } from "./router.js";
import { json, parseSSE } from "./util.js";
import { fromAnthropicTools } from "./tools.js";

export function anthropicError(status, type, message, extra = {}) {
  return json({ type: "error", error: { type, message, ...extra } }, { status });
}
__name(anthropicError, "anthropicError");
export function errorTypeFor(status, innerType) {
  if (status === 401)
    return "authentication_error";
  if (status === 404 || innerType === "model_not_found")
    return "not_found_error";
  if (status === 429 || innerType === "no_capacity")
    return "rate_limit_error";
  if (status === 400)
    return "invalid_request_error";
  if (status >= 500)
    return "api_error";
  return "api_error";
}
__name(errorTypeFor, "errorTypeFor");
export function stopReasonFor(finish) {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}
__name(stopReasonFor, "stopReasonFor");
export function textOfBlocks(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.filter((b) => !!b && typeof b === "object" && b.type === "text").map((b) => String(b.text ?? "")).join("");
}
__name(textOfBlocks, "textOfBlocks");
export function anthropicToOpenAI(body) {
  const messages = [];
  const sysText = textOfBlocks(body.system);
  if (sysText)
    messages.push({ role: "system", content: sysText });
  for (const m of body.messages ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content))
      continue;
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    const reasoningParts = [];
    for (const b of content) {
      if (!b || typeof b !== "object")
        continue;
      switch (b.type) {
        case "text":
          parts.push({ type: "text", text: String(b.text ?? "") });
          break;
        case "thinking":
          // Inbound thinking blocks used to vanish; the reverse
          // direction emits them from reasoning_content, so map
          // them back the same way.
          if (typeof b.thinking === "string" && b.thinking)
            reasoningParts.push(b.thinking);
          break;
        case "redacted_thinking":
          // No plaintext content exists to carry over; skip it
          // rather than failing the whole conversion.
          break;
        case "image": {
          const src = b.source ?? {};
          if (src.type === "base64") {
            parts.push({
              type: "image_url",
              image_url: { url: "data:" + String(src.media_type ?? "image/png") + ";base64," + String(src.data ?? "") }
            });
          } else if (src.type === "url") {
            parts.push({ type: "image_url", image_url: { url: String(src.url ?? "") } });
          }
          break;
        }
        case "tool_use":
          toolCalls.push({
            id: String(b.id ?? ""),
            type: "function",
            function: {
              name: String(b.name ?? ""),
              arguments: JSON.stringify(b.input ?? {})
            }
          });
          break;
        case "document": {
          // Document blocks (e.g. a PDF from a Claude client) used
          // to fall through the switch and vanish; carry them as
          // OpenAI file parts (or text, for text documents).
          const src = b.source ?? {};
          if (src.type === "base64") {
            const media = String(src.media_type ?? "application/pdf");
            const name = media === "application/pdf" ? "document.pdf" : media === "text/plain" ? "document.txt" : "document";
            parts.push({ type: "file", file: { filename: name, file_data: "data:" + media + ";base64," + String(src.data ?? "") } });
          } else if (src.type === "url") {
            parts.push({ type: "file", file: { filename: "document", file_data: String(src.url ?? "") } });
          } else if (src.type === "text") {
            parts.push({ type: "text", text: String(src.data ?? "") });
          } else if (src.type === "content") {
            // A document whose source is itself a block list:
            // convert the inner blocks recursively into parts.
            if (Array.isArray(src.content)) {
              for (const inner of src.content) {
                if (!inner || typeof inner !== "object")
                  continue;
                if (inner.type === "text")
                  parts.push({ type: "text", text: String(inner.text ?? "") });
                else if (inner.type === "image") {
                  const isrc = inner.source ?? {};
                  if (isrc.type === "base64")
                    parts.push({ type: "image_url", image_url: { url: "data:" + String(isrc.media_type ?? "image/png") + ";base64," + String(isrc.data ?? "") } });
                  else if (isrc.type === "url")
                    parts.push({ type: "image_url", image_url: { url: String(isrc.url ?? "") } });
                }
              }
            }
          } else if (src.type === "file") {
            // A provider-side file reference cannot be fetched
            // through this gateway; keep an explicit placeholder so
            // the document's presence is not silently lost.
            parts.push({ type: "text", text: `[document: file ${String(src.file_id ?? "")}]` });
          }
          break;
        }
        case "tool_result": {
          // Images inside tool_result content used to be dropped by
          // the text-only extraction; carry them as image_url parts.
          let trContent = textOfBlocks(b.content) || (typeof b.content === "string" ? b.content : "");
          if (Array.isArray(b.content)) {
            const imgParts = [];
            for (const p of b.content) {
              if (p?.type === "image") {
                const src = p.source ?? {};
                if (src.type === "base64")
                  imgParts.push({ type: "image_url", image_url: { url: "data:" + String(src.media_type ?? "image/png") + ";base64," + String(src.data ?? "") } });
                else if (src.type === "url")
                  imgParts.push({ type: "image_url", image_url: { url: String(src.url ?? "") } });
              }
            }
            if (imgParts.length) {
              const arr = [];
              if (trContent)
                arr.push({ type: "text", text: trContent });
              arr.push(...imgParts);
              trContent = arr;
            }
          }
          if (b.is_error === true) {
            // OpenAI tool messages have no is_error flag; keep the
            // signal as an explicit marker so the model can tell a
            // failed tool result from a successful one.
            if (typeof trContent === "string")
              trContent = "[error] " + trContent;
            else if (Array.isArray(trContent))
              trContent = [{ type: "text", text: "[error]" }, ...trContent];
          }
          toolResults.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id ?? ""),
            content: trContent
          });
          break;
        }
      }
    }
    messages.push(...toolResults);
    if (parts.length || toolCalls.length || reasoningParts.length) {
      const msg = { role, content: parts.length ? parts : "" };
      if (toolCalls.length)
        msg.tool_calls = toolCalls;
      if (reasoningParts.length)
        msg.reasoning_content = reasoningParts.join("");
      messages.push(msg);
    }
  }
  const out = {
    model: String(body.model ?? ""),
    messages,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1024,
    stream: body.stream === true
  };
  if (typeof body.temperature === "number")
    out.temperature = body.temperature;
  if (typeof body.top_p === "number")
    out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences))
    out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    const converted = fromAnthropicTools(body.tools);
    if (converted.tools?.length)
      out.tools = converted.tools;
  }
  const tc = body.tool_choice;
  if (tc && typeof tc === "object") {
    if (tc.type === "auto")
      out.tool_choice = "auto";
    else if (tc.type === "none")
      out.tool_choice = "none";
    else if (tc.type === "any")
      out.tool_choice = "required";
    else if (tc.type === "tool" && tc.name) {
      out.tool_choice = { type: "function", function: { name: String(tc.name) } };
    }
  }
  return out;
}
__name(anthropicToOpenAI, "anthropicToOpenAI");
export function imageBlockFromUrl(url) {
  if (!url || typeof url !== "string")
    return null;
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (m)
      return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    return null;
  }
  return { type: "image", source: { type: "url", url } };
}
__name(imageBlockFromUrl, "imageBlockFromUrl");
export function openAIToAnthropic(data, requestedModel) {
  const choice = (data.choices ?? [])[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content });
  }
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    // Several OpenAI-compatible upstreams return content as a part
    // array; reading only the string form turned those replies
    // into an empty text block.
    const texts = [];
    const images = [];
    for (const p of msg.content) {
      if (!p || typeof p !== "object")
        continue;
      if (p.type === "text" && typeof p.text === "string" && p.text)
        texts.push(p.text);
      else if (p.type === "image_url") {
        const b = imageBlockFromUrl(p.image_url?.url ?? "");
        if (b)
          images.push(b);
      }
    }
    if (texts.length)
      content.push({ type: "text", text: texts.join("") });
    content.push(...images);
  }
  for (const call of msg.tool_calls ?? []) {
    const fn = call.function ?? {};
    let input = {};
    try {
      input = JSON.parse(String(fn.arguments ?? "{}"));
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: String(call.id ?? ""), name: String(fn.name ?? ""), input });
  }
  if (!content.length)
    content.push({ type: "text", text: "" });
  const usage = data.usage ?? {};
  return {
    id: "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReasonFor(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0)
    }
  };
}
__name(openAIToAnthropic, "openAIToAnthropic");
export function openAIStreamToAnthropic(body, requestedModel) {
  const reader = parseSSE(body).getReader();
  const enc = new TextEncoder();
  const msgId = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  let started = false;
  let finished = false;
  let nextIdx = 0;
  let openBlock = null;
  const closedBlocks = /* @__PURE__ */ new Set();
  let textIdx = null;
  let thinkIdx = null;
  const toolIdx = /* @__PURE__ */ new Map();
  let stopReason = "end_turn";
  let inTokens = 0;
  let outTokens = 0;
  let sawError = false;
  let sawContent = false;
  const ev = /* @__PURE__ */ __name((event, data) => `event: ${event}
data: ${JSON.stringify(data)}

`, "ev");
  function startBlock(idx, block, out) {
    if (openBlock !== null && openBlock !== idx) {
      out.push(ev("content_block_stop", { type: "content_block_stop", index: openBlock }));
      closedBlocks.add(openBlock);
    }
    openBlock = idx;
    out.push(ev("content_block_start", { type: "content_block_start", index: idx, content_block: block }));
  }
  __name(startBlock, "startBlock");
  function handleChunk(chunk, out) {
    if (!started) {
      started = true;
      out.push(ev("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }));
    }
    // An in-band error chunk has no choices and used to be silently
    // swallowed, after which finalize fabricated an end_turn
    // success. Surface it as an Anthropic error event instead and
    // drop anything the stream sends afterwards.
    if (chunk && typeof chunk === "object" && chunk.error) {
      if (!sawError) {
        sawError = true;
        const emsg = typeof chunk.error === "string" ? chunk.error : String(chunk.error?.message ?? "upstream error");
        out.push(ev("error", { type: "error", error: { type: "api_error", message: emsg } }));
      }
      return;
    }
    if (sawError)
      return;
    const usage = chunk.usage;
    if (usage) {
      inTokens = Number(usage.prompt_tokens ?? inTokens);
      outTokens = Number(usage.completion_tokens ?? outTokens);
    }
    const choice = (chunk.choices ?? [])[0];
    if (!choice)
      return;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      stopReason = stopReasonFor(choice.finish_reason);
    }
    const delta = choice.delta ?? {};
    if (choice.finish_reason || delta.reasoning_content || delta.content || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))
      sawContent = true;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      if (thinkIdx === null || openBlock !== thinkIdx) {
        thinkIdx = nextIdx++;
        startBlock(thinkIdx, { type: "thinking", thinking: "" }, out);
      }
      out.push(ev("content_block_delta", {
        type: "content_block_delta",
        index: thinkIdx,
        delta: { type: "thinking_delta", thinking: delta.reasoning_content }
      }));
    }
    if (typeof delta.content === "string" && delta.content) {
      if (textIdx === null || openBlock !== textIdx) {
        textIdx = nextIdx++;
        startBlock(textIdx, { type: "text", text: "" }, out);
      }
      out.push(ev("content_block_delta", {
        type: "content_block_delta",
        index: textIdx,
        delta: { type: "text_delta", text: delta.content }
      }));
    }
    for (const call of delta.tool_calls ?? []) {
      // Key blocks by the delta's index when present; upstreams
      // that omit index but carry a call id must still get one
      // block per distinct call, not one shared block at index 0.
      const tkey = typeof call.index === "number" ? "i:" + call.index : call.id ? "d:" + String(call.id) : "i:0";
      let bi = toolIdx.get(tkey);
      const fn = call.function ?? {};
      if (bi === void 0 || closedBlocks.has(bi)) {
        bi = nextIdx++;
        toolIdx.set(tkey, bi);
        startBlock(bi, {
          type: "tool_use",
          id: String(call.id ?? "toolu_" + tkey.replace(":", "_")),
          name: String(fn.name ?? ""),
          input: {}
        }, out);
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        out.push(ev("content_block_delta", {
          type: "content_block_delta",
          index: bi,
          delta: { type: "input_json_delta", partial_json: fn.arguments }
        }));
      }
    }
  }
  __name(handleChunk, "handleChunk");
  function finalize(out) {
    if (finished)
      return;
    finished = true;
    if (!started) {
      started = true;
      out.push(ev("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }));
    }
    if (openBlock !== null) {
      out.push(ev("content_block_stop", { type: "content_block_stop", index: openBlock }));
      openBlock = null;
    }
    if (sawError) {
      // The error event already went out when the error chunk
      // arrived; appending the end_turn success trailer
      // (message_delta + message_stop) would contradict it.
      return;
    }
    if (!sawContent) {
      // The stream carried no content events at all: report an
      // error instead of fabricating a successful empty message.
      out.push(ev("error", {
        type: "error",
        error: { type: "api_error", message: "upstream returned an empty stream" }
      }));
      return;
    }
    if (nextIdx === 0) {
      out.push(ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }));
      out.push(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
    }
    out.push(ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inTokens, output_tokens: outTokens }
    }));
    out.push(ev("message_stop", { type: "message_stop" }));
  }
  __name(finalize, "finalize");
  return new ReadableStream({
    async pull(controller) {
      const out = [];
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) {
            finalize(out);
            for (const s of out)
              controller.enqueue(enc.encode(s));
            controller.close();
            return;
          }
          if (!value || value.data === "[DONE]") {
            if (value?.data === "[DONE]")
              continue;
            continue;
          }
          let chunk;
          try {
            chunk = JSON.parse(value.data);
          } catch {
            continue;
          }
          handleChunk(chunk, out);
          if (out.length) {
            for (const s of out)
              controller.enqueue(enc.encode(s));
            return;
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      reader.cancel().catch(() => void 0);
    }
  });
}
__name(openAIStreamToAnthropic, "openAIStreamToAnthropic");
export function estimateTextTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 11904 && cp <= 40959 || // 中日韩表意 + 假名
    cp >= 40960 && cp <= 45055 || // 彝/谚文等
    cp >= 63744 && cp <= 64255 || // 兼容表意
    cp >= 131072 && cp <= 195103) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 4);
}
__name(estimateTextTokens, "estimateTextTokens");
export async function handleCountTokens(req, env) {
  const lock = await checkCallerLock(env, req);
  if (lock.locked) {
    return anthropicError(429, "rate_limit_error", "too many failed authentication attempts");
  }
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason !== "unconfigured")
      await noteCallerAuthFailure(env, req, lock.id);
    return anthropicError(
      auth.reason === "unconfigured" ? 500 : 401,
      "authentication_error",
      auth.reason === "unconfigured" ? "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN" : "invalid gateway token"
    );
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return anthropicError(400, "invalid_request_error", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return anthropicError(400, "invalid_request_error", "messages \u4E0D\u80FD\u4E3A\u7A7A");
  }
  if (!String(body.model ?? "")) {
    return anthropicError(400, "invalid_request_error", "model \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const oai = anthropicToOpenAI(body);
  let total = 0;
  for (const m of oai.messages ?? []) {
    total += 4;
    const content = m.content;
    if (typeof content === "string") {
      total += estimateTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (p?.type === "text")
          total += estimateTextTokens(String(p.text ?? ""));
        else if (p?.type === "image_url")
          total += 1024;
        else
          total += estimateTextTokens(JSON.stringify(p ?? {}));
      }
    }
    if (Array.isArray(m.tool_calls)) {
      total += estimateTextTokens(JSON.stringify(m.tool_calls));
    }
  }
  if (Array.isArray(oai.tools) && oai.tools.length) {
    total += estimateTextTokens(JSON.stringify(oai.tools)) + 8 * oai.tools.length;
  }
  return json({ input_tokens: Math.max(1, total) });
}
__name(handleCountTokens, "handleCountTokens");
export async function handleMessages(req, env, ctx) {
  const lock = await checkCallerLock(env, req);
  if (lock.locked) {
    return anthropicError(429, "rate_limit_error", "too many failed authentication attempts");
  }
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    if (auth.reason !== "unconfigured") {
      if (ctx?.waitUntil)
        ctx.waitUntil(noteCallerAuthFailure(env, req, lock.id));
      else
        await noteCallerAuthFailure(env, req, lock.id);
    }
    return anthropicError(
      auth.reason === "unconfigured" ? 500 : 401,
      "authentication_error",
      auth.reason === "unconfigured" ? "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN" : "invalid gateway token"
    );
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return anthropicError(400, "invalid_request_error", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return anthropicError(400, "invalid_request_error", "messages \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const requestedModel = String(body.model ?? "");
  if (!requestedModel) {
    return anthropicError(400, "invalid_request_error", "model \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const oai = anthropicToOpenAI(body);
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const token = extractToken(req);
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
    let innerType;
    const extra = {};
    try {
      const ej = await res.json();
      const err = ej.error ?? {};
      if (err.message)
        message = String(err.message);
      if (err.type)
        innerType = String(err.type);
      // Carry the gateway's machine-readable fields through the
      // protocol translation so Anthropic-shaped clients can branch
      // on them too.
      for (const k of ["code", "retryable", "retry_after_ms", "request_id", "attempts"])
        if (err[k] !== void 0)
          extra[k] = err[k];
    } catch {
    }
    return anthropicError(res.status, errorTypeFor(res.status, innerType), message, extra);
  }
  const gwHeaders = { ...CORS };
  // Pass every x-gw-* header through: sticky / degraded /
  // dropped-params are how a caller learns whether this request was
  // degraded, and a fixed whitelist silently drops the newer ones.
  for (const [k, v] of res.headers) {
    if (k.toLowerCase().startsWith("x-gw-"))
      gwHeaders[k.toLowerCase()] = v;
  }
  if (oai.stream) {
    if (!res.body)
      return anthropicError(502, "api_error", "\u4E0A\u6E38\u8FD4\u56DE\u7A7A\u54CD\u5E94\u4F53");
    return new Response(openAIStreamToAnthropic(res.body, requestedModel), {
      status: 200,
      headers: { ...gwHeaders, "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return anthropicError(502, "api_error", "\u4E0A\u6E38\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94");
  }
  return json(openAIToAnthropic(data, requestedModel), { headers: gwHeaders });
}
__name(handleMessages, "handleMessages");
