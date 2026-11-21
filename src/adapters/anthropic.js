import { __name } from "../helpers.js";
import { deferred, json, parseSSE, safeJsonParse, sseEncode } from "../util.js";
import { normalizeUsage } from "./openai.js";

export var STOP_REASON = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
  pause_turn: "stop"
};
export function argsObject(raw) {
  const v = safeJsonParse(raw ?? "{}", null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
__name(argsObject, "argsObject");
export function textOf(content) {
  if (content == null)
    return "";
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((p) => p && typeof p === "object" && typeof p.text === "string" ? p.text : "").join("");
  }
  return String(content);
}
__name(textOf, "textOf");
export function imageBlock(url) {
  if (!url)
    return null;
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) {
      return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    }
    return null;
  }
  return { type: "image", source: { type: "url", url } };
}
__name(imageBlock, "imageBlock");
export function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  const push = /* @__PURE__ */ __name((role, blocks) => {
    if (!blocks.length)
      return;
    const last = out[out.length - 1];
    if (last && last.role === role)
      last.content.push(...blocks);
    else
      out.push({ role, content: blocks });
  }, "push");
  for (const m of messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (t)
        systemParts.push(t);
      continue;
    }
    if (m.role === "tool") {
      // Tool results can carry images (array content); textOf alone
      // would silently drop them, so map the parts to Anthropic
      // blocks when the content is an array.
      let content = textOf(m.content) || "";
      if (Array.isArray(m.content)) {
        const blocks = [];
        for (const p of m.content) {
          if (p?.type === "text" && p.text)
            blocks.push({ type: "text", text: p.text });
          else if (p?.type === "image_url" && p.image_url?.url)
            blocks.push(imageBlock(p.image_url.url));
        }
        if (blocks.length)
          content = blocks;
      }
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id ?? "unknown",
          content: content || "(no output)"
        }
      ]);
      continue;
    }
    if (m.role === "assistant") {
      const blocks2 = [];
      const text = textOf(m.content);
      if (text)
        blocks2.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        blocks2.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name ?? "tool",
          input: argsObject(tc.function?.arguments)
        });
      }
      push("assistant", blocks2);
      continue;
    }
    const blocks = [];
    if (typeof m.content === "string") {
      if (m.content)
        blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p)
          continue;
        if (p.type === "text" && p.text)
          blocks.push({ type: "text", text: p.text });
        else if (p.type === "image_url") {
          const b = imageBlock(p.image_url?.url ?? "");
          if (b)
            blocks.push(b);
        }
      }
    }
    if (!blocks.length)
      blocks.push({ type: "text", text: "(empty)" });
    push("user", blocks);
  }
  if (out.length && out[0].role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "\u7EE7\u7EED" }] });
  }
  if (!out.length)
    out.push({ role: "user", content: [{ type: "text", text: "(empty)" }] });
  return { system: systemParts.length ? systemParts.join("\n\n") : void 0, messages: out };
}
__name(toAnthropicMessages, "toAnthropicMessages");
export function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length)
    return void 0;
  return tools.filter((t) => t && typeof t === "object" && t.function).map((t) => {
    const f = t.function;
    return {
      name: f.name,
      description: f.description ?? "",
      input_schema: f.parameters ?? { type: "object", properties: {} }
    };
  });
}
__name(toAnthropicTools, "toAnthropicTools");
export function toAnthropicToolChoice(choice) {
  if (choice == null)
    return void 0;
  if (choice === "auto")
    return { type: "auto" };
  if (choice === "required")
    return { type: "any" };
  if (choice === "none")
    return { type: "none" };
  if (typeof choice === "object") {
    const c = choice;
    const name = c.function?.name ?? (c.type === "function" ? c.name : void 0);
    if (c.type === "function" && name)
      return { type: "tool", name };
  }
  return void 0;
}
__name(toAnthropicToolChoice, "toAnthropicToolChoice");
export function toAnthropicRequest(req, model) {
  const { system, messages } = toAnthropicMessages(req.messages);
  const body = {
    model,
    max_tokens: Math.max(1, Number(req.max_tokens ?? req.max_completion_tokens ?? 4096)),
    messages
  };
  if (system)
    body.system = system;
  if (req.stream)
    body.stream = true;
  if (typeof req.temperature === "number")
    body.temperature = Math.min(1, Math.max(0, req.temperature));
  if (typeof req.top_p === "number" && typeof req.temperature !== "number")
    body.top_p = req.top_p;
  if (req.parallel_tool_calls === false)
    body.disable_parallel_tool_use = true;
  if (req.stop)
    body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  const tools = toAnthropicTools(req.tools);
  if (tools?.length) {
    body.tools = tools;
    const tc = toAnthropicToolChoice(req.tool_choice);
    if (tc)
      body.tool_choice = tc;
  }
  return body;
}
__name(toAnthropicRequest, "toAnthropicRequest");
export function fromAnthropicResponse(data, model) {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const reasoning = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("");
  const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
    id: b.id,
    type: "function",
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
  }));
  const usage = normalizeUsage(data.usage) ?? {
    prompt_tokens: Number(data.usage?.input_tokens ?? 0),
    completion_tokens: Number(data.usage?.output_tokens ?? 0),
    total_tokens: Number(data.usage?.input_tokens ?? 0) + Number(data.usage?.output_tokens ?? 0)
  };
  const message = { role: "assistant", content: text || null };
  if (reasoning)
    message.reasoning_content = reasoning;
  if (toolCalls.length)
    message.tool_calls = toolCalls;
  return {
    id: data.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON[data.stop_reason] ?? "stop"
      }
    ],
    usage
  };
}
__name(fromAnthropicResponse, "fromAnthropicResponse");
export function anthropicStream(body, model) {
  const usage = deferred();
  let promptTokens = 0;
  let completionTokens = 0;
  let toolIndex = -1;
  const blockToTool = /* @__PURE__ */ new Map();
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  let finished = false;
  let finalReason = null;
  const chunk = /* @__PURE__ */ __name((delta, finish = null, withUsage = false) => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1e3),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }]
    };
    if (withUsage) {
      payload.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      };
    }
    return payload;
  }, "chunk");
  const resolveUsage = /* @__PURE__ */ __name(() => {
    usage.resolve({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    });
  }, "resolveUsage");
  const stream = parseSSE(body).pipeThrough(
    new TransformStream({
      transform(ev, controller) {
        if (!ev.data)
          return;
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        const type = data.type ?? ev.event;
        switch (type) {
          case "message_start": {
            promptTokens = Number(data.message?.usage?.input_tokens ?? 0);
            controller.enqueue(
              sseEncode(chunk({ role: "assistant", content: "" }))
            );
            break;
          }
          case "content_block_start": {
            const block = data.content_block;
            if (block?.type === "tool_use") {
              toolIndex += 1;
              blockToTool.set(Number(data.index ?? 0), toolIndex);
              controller.enqueue(
                sseEncode(
                  chunk({
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: block.id,
                        type: "function",
                        function: { name: block.name, arguments: "" }
                      }
                    ]
                  })
                )
              );
            }
            break;
          }
          case "content_block_delta": {
            const d = data.delta;
            if (d?.type === "text_delta" && d.text) {
              controller.enqueue(sseEncode(chunk({ content: d.text })));
            } else if (d?.type === "thinking_delta" && d.thinking) {
              controller.enqueue(sseEncode(chunk({ reasoning_content: d.thinking })));
            } else if (d?.type === "input_json_delta") {
              const idx = blockToTool.get(Number(data.index ?? 0)) ?? 0;
              controller.enqueue(
                sseEncode(
                  chunk({
                    tool_calls: [
                      { index: idx, function: { arguments: d.partial_json ?? "" } }
                    ]
                  })
                )
              );
            }
            break;
          }
          case "message_delta": {
            if (data.usage?.output_tokens != null) {
              completionTokens = Number(data.usage.output_tokens);
            }
            const fr = STOP_REASON[data.delta?.stop_reason];
            if (fr)
              finalReason = fr;
            break;
          }
          case "message_stop": {
            if (!finished) {
              finished = true;
              controller.enqueue(sseEncode(chunk({}, finalReason ?? "stop", true)));
              controller.enqueue(sseEncode("[DONE]"));
              resolveUsage();
            }
            break;
          }
          case "error": {
            controller.enqueue(
              sseEncode({
                error: {
                  message: data.error?.message ?? "anthropic upstream error",
                  type: "upstream_error"
                }
              })
            );
            if (!finished) {
              finished = true;
              controller.enqueue(sseEncode("[DONE]"));
              resolveUsage();
            }
            break;
          }
        }
      },
      flush(controller) {
        if (!finished) {
          finished = true;
          controller.enqueue(sseEncode(chunk({}, finalReason ?? "stop", true)));
          controller.enqueue(sseEncode("[DONE]"));
          resolveUsage();
        }
      }
    })
  );
  return { stream, usage: usage.promise };
}
__name(anthropicStream, "anthropicStream");
export var anthropicAdapter = {
  build(ctx) {
    const body = toAnthropicRequest(ctx.req, ctx.model);
    for (const p of [...ctx.drops, ...ctx.provider.dropParams ?? []])
      delete body[p];
    if (ctx.req.parallel_tool_calls === false && body.disable_parallel_tool_use) {
      body.tool_choice = { ...body.tool_choice ?? { type: "auto" }, disable_parallel_tool_use: true };
      delete body.disable_parallel_tool_use;
    }
    return {
      url: `${ctx.provider.baseUrl.replace(/\/+$/, "")}/v1/messages`,
      init: {
        method: "POST",
        headers: {
          ...ctx.provider.headers ?? {},
          "content-type": "application/json",
          "x-api-key": ctx.key.key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      }
    };
  },
  parseJson(data, ctx) {
    const obj = data ?? {};
    const out = fromAnthropicResponse(obj, ctx.model);
    return { json: out, usage: out.usage };
  },
  parseStream(body, ctx) {
    return anthropicStream(body, ctx.model);
  }
};
