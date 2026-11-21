import { Coordinator } from "./coordinator.js";
import { PASSTHROUGH_PATHS, handleModelOne, handlePassthrough } from "./passthrough.js";
import { adminPreflight } from "./admin-origin.js";
import { checkGatewayToken } from "./auth.js";
import { cleanup, flushUsageBuffer } from "./usage.js";
import { ensureSchema } from "./schema.js";
import { handleAdmin } from "./admin.js";
import { handleChat, handleModels } from "./router.js";
import { handleMcp } from "./mcp.js";
import { handleCountTokens, handleMessages } from "./anthropic-in.js";
import { handleGemini, handleGeminiModels } from "./gemini-in.js";
import { json, openAIError, preflight } from "./util.js";
import { settings } from "./config.js";
import { syncAll } from "./discovery.js";

export var src_default = {
  async fetch(req, env, ctx) {
    await ensureSchema(env);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
        return adminPreflight(env, req);
      return preflight();
    }
    let routeReq = req;
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.replace(/\/+$/, "");
      const u2 = new URL(url.toString());
      u2.pathname = pathname;
      routeReq = new Request(u2, req);
    }
    try {
      // Application-level body bound: handlers parse whole JSON /
      // multipart bodies into isolate memory, so reject anything
      // absurdly large up front (platform limits sit far higher).
      const bodyLen = Number(req.headers.get("content-length") || 0);
      if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && bodyLen > 32 * 1024 * 1024) {
        return openAIError(413, "request body too large (max 32 MB)", "invalid_request_error", { code: "invalid_request", retryable: false });
      }
      if (pathname === "/" || pathname === "/healthz") {
        return json({
          ok: true,
          service: "free-ai-gateway",
          time: (/* @__PURE__ */ new Date()).toISOString(),
          endpoints: {
            chat: "POST /v1/chat/completions",
            models: "GET /v1/models",
            anthropic: "POST /v1/messages, POST /v1/messages/count_tokens",
            gemini: "GET /v1beta/models, POST /v1beta/models/{model}:generateContent",
            passthrough: "POST /v1/audio/*, /v1/images/*, /v1/embeddings, /v1/completions, /v1/responses, /v1/moderations, /v1/ocr, /v1/systemone",
            mcp: "POST /mcp (MCP server: list_models, chat, generate_image)",
            admin_api: "/admin/api/* (Authorization: Bearer <ADMIN_TOKEN>)",
            admin_ui: "https://ai.reply.kdns.fr"
          }
        });
      }
      if (pathname === "/v1/models") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return openAIError(405, "\u8BF7\u4F7F\u7528 GET");
        }
        const auth = await checkGatewayToken(routeReq, env);
        if (!auth.ok) {
          return openAIError(
            auth.reason === "unconfigured" ? 500 : 401,
            auth.reason === "unconfigured" ? "\u7F51\u5173\u672A\u914D\u7F6E GATEWAY_TOKEN" : "invalid gateway token",
            "authentication_error"
          );
        }
        return handleModels(env, url);
      }
      if (pathname.startsWith("/v1/models/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return openAIError(405, "\u8BF7\u4F7F\u7528 GET");
        }
        return handleModelOne(routeReq, env, decodeURIComponent(pathname.slice("/v1/models/".length)));
      }
      if (pathname === "/v1/chat/completions") {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleChat(routeReq, env, ctx);
      }
      if (pathname === "/v1/messages") {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleMessages(routeReq, env, ctx);
      }
      if (pathname === "/v1/messages/count_tokens") {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleCountTokens(routeReq, env);
      }
      if (pathname === "/v1beta/models") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return openAIError(405, "\u8BF7\u4F7F\u7528 GET");
        }
        return handleGeminiModels(routeReq, env, url);
      }
      if (pathname.startsWith("/v1beta/models/")) {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handleGemini(routeReq, env, ctx, pathname, url);
      }
      if (pathname === "/mcp") {
        return handleMcp(routeReq, env, ctx);
      }
      if (PASSTHROUGH_PATHS.has(pathname)) {
        if (req.method !== "POST")
          return openAIError(405, "\u8BF7\u4F7F\u7528 POST");
        return handlePassthrough(routeReq, env, ctx, pathname);
      }
      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        return handleAdmin(routeReq, env, ctx, url);
      }
      return openAIError(404, `\u672A\u77E5\u8DEF\u5F84: ${pathname}`, "not_found");
    } catch (e) {
      console.error("[fetch]", e);
      return openAIError(500, "internal error", "internal_error");
    }
  },
  async scheduled(_controller, env, ctx) {
    await ensureSchema(env);
    const cfg = settings(env);
    if (cfg.syncEnabled) {
      ctx.waitUntil(
        syncAll(env, { probe: cfg.probePerSync > 0 }).then(
          (r) => console.log(
            `[cron] sync ok=${r.ok} total=${r.total} added=${r.added} removed=${r.removed} ${r.durationMs}ms`
          )
        ).catch((e) => console.error("[cron] sync failed", e))
      );
    }
    ctx.waitUntil(flushUsageBuffer(env));
    ctx.waitUntil(cleanup(env, 90));
  }
};

export default src_default;
export { Coordinator };
