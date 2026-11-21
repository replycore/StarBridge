import { __name } from "./helpers.js";
import { checkGatewayToken } from "./auth.js";
import { handleChat, handleModels } from "./router.js";
import { handlePassthrough } from "./passthrough.js";
import { json } from "./util.js";

// MCP (Model Context Protocol) server over Streamable HTTP, kept
// stateless: every POST is a self-contained JSON-RPC exchange, which
// suits an edge worker with no long-lived sessions. The tools are
// thin wrappers over the gateway's own HTTP handlers, so caller
// auth, daily quotas, routing, failover and usage accounting behave
// exactly as they do for direct API calls.
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "starbridge", title: "星桥 StarBridge", version: "1.0.0" };
const TOOLS = [
  {
    name: "list_models",
    title: "List models",
    description: "List the model ids currently available through the gateway: mapping groups, auto aliases (including capability forms such as auto:tools+vision) and provider/model ids.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chat",
    title: "Chat completion",
    description: "Run a chat completion through the gateway's routing (capability filters, failover, quotas included) and return the assistant's reply text.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id, mapping group, or auto alias (default: auto). Capability forms: auto:tools, auto:vision, auto:reasoning, auto:tools+vision." },
        prompt: { type: "string", description: "A single user message (use this or messages)." },
        messages: { type: "array", description: "OpenAI-style message list (use this or prompt).", items: { type: "object" } },
        temperature: { type: "number" },
        max_tokens: { type: "number" }
      }
    }
  },
  {
    name: "generate_image",
    title: "Generate image",
    description: "Generate an image through the gateway and return the image (or its URL).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string", description: "Image model id (default: auto)." },
        size: { type: "string", description: "e.g. 1024x1024" }
      },
      required: ["prompt"]
    }
  }
];
function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}
__name(rpcResult, "rpcResult");
function rpcError(id, code, message, httpStatus = 200) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: httpStatus });
}
__name(rpcError, "rpcError");
function textResult(text, isError) {
  return { content: [{ type: "text", text }], ...isError ? { isError: true } : {} };
}
__name(textResult, "textResult");
function internalRequest(req, path, body) {
  const headers = { "content-type": "application/json" };
  const auth = req.headers.get("authorization");
  if (auth)
    headers.authorization = auth;
  const xkey = req.headers.get("x-api-key");
  if (xkey)
    headers["x-api-key"] = xkey;
  return new Request("https://mcp.internal" + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : void 0
  });
}
__name(internalRequest, "internalRequest");
async function toolListModels(req, env) {
  const res = await handleModels(env, new URL("https://mcp.internal/v1/models"));
  const data = await res.json().catch(() => null);
  const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean);
  if (!ids.length)
    return textResult("No models are currently available.", true);
  return textResult(`${ids.length} models available:\n${ids.join("\n")}`);
}
__name(toolListModels, "toolListModels");
async function toolChat(req, env, ctx, args) {
  const messages = Array.isArray(args?.messages) && args.messages.length ? args.messages : args?.prompt ? [{ role: "user", content: String(args.prompt) }] : null;
  if (!messages)
    return textResult("Provide either `prompt` or `messages`.", true);
  const body = { model: String(args?.model || "auto"), messages, stream: false };
  if (typeof args?.temperature === "number")
    body.temperature = args.temperature;
  if (typeof args?.max_tokens === "number")
    body.max_tokens = args.max_tokens;
  const res = await handleChat(internalRequest(req, "/v1/chat/completions", body), env, ctx);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data)
    return textResult(`Chat failed (HTTP ${res.status}): ${data?.error?.message ?? "unknown error"}`, true);
  const msg = data.choices?.[0]?.message;
  let text = typeof msg?.content === "string" ? msg.content : "";
  if (!text && msg?.content)
    text = JSON.stringify(msg.content);
  if (!text && msg?.tool_calls)
    text = JSON.stringify(msg.tool_calls);
  if (!text)
    return textResult("The model returned an empty reply.", true);
  return textResult(text);
}
__name(toolChat, "toolChat");
async function toolImage(req, env, ctx, args) {
  if (!args?.prompt)
    return textResult("`prompt` is required.", true);
  const body = { model: String(args?.model || "auto"), prompt: String(args.prompt) };
  if (args?.size)
    body.size = String(args.size);
  const res = await handlePassthrough(internalRequest(req, "/v1/images/generations", body), env, ctx, "/v1/images/generations");
  const data = await res.json().catch(() => null);
  if (!res.ok || !data)
    return textResult(`Image generation failed (HTTP ${res.status}): ${data?.error?.message ?? "unknown error"}`, true);
  const first = data.data?.[0];
  if (first?.b64_json)
    return { content: [{ type: "image", data: first.b64_json, mimeType: "image/png" }] };
  if (first?.url)
    return textResult(first.url);
  return textResult("The image endpoint returned no image data.", true);
}
__name(toolImage, "toolImage");
export async function handleMcp(req, env, ctx) {
  const auth = await checkGatewayToken(req, env);
  if (!auth.ok) {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: auth.reason === "unconfigured" ? "gateway token not configured" : "invalid gateway token" } },
      { status: auth.reason === "unconfigured" ? 500 : 401 }
    );
  }
  if (req.method !== "POST") {
    return rpcError(null, -32000, "This MCP server is stateless and offers no server-initiated stream; use POST.", 405);
  }
  let msg;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(msg))
    return rpcError(null, -32600, "Batch requests are not supported", 400);
  const { id, method, params } = msg ?? {};
  const isNotification = id === void 0 || id === null;
  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments ?? {};
        let result;
        if (name === "list_models")
          result = await toolListModels(req, env);
        else if (name === "chat")
          result = await toolChat(req, env, ctx, args);
        else if (name === "generate_image")
          result = await toolImage(req, env, ctx, args);
        else
          return rpcError(id, -32602, `Unknown tool: ${name}`);
        return rpcResult(id, result);
      }
      default:
        if (isNotification)
          return new Response(null, { status: 202 });
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    console.error("[mcp]", e);
    return rpcError(id ?? null, -32603, "Internal error");
  }
}
__name(handleMcp, "handleMcp");
