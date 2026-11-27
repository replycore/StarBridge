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
import { runProbes, syncAll } from "./discovery.js";

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
    // Chunked bodies carry no Content-Length for the size check
    // below to reject, so route them through a counting stream:
    // once more than 32 MB have flowed through, the stream errors
    // and the handler's body read fails instead of materializing
    // an unbounded body in isolate memory.
    if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && req.headers.get("content-length") === null && req.body) {
      let seen = 0;
      const counter = new TransformStream({
        transform(chunk, controller) {
          seen += chunk.byteLength ?? 0;
          if (seen > 32 * 1024 * 1024) {
            controller.error(new Error("request body too large (max 32 MB)"));
            return;
          }
          controller.enqueue(chunk);
        }
      });
      routeReq = new Request(req, { body: req.body.pipeThrough(counter), duplex: "half" });
    }
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.replace(/\/+$/, "");
      if (!pathname)
        pathname = "/";
      const u2 = new URL(url.toString());
      u2.pathname = pathname;
      routeReq = new Request(u2, routeReq);
    }
    try {
      // Application-level body bound: handlers parse whole JSON /
      // multipart bodies into isolate memory, so reject anything
      // absurdly large up front (platform limits sit far higher).
      // A present-but-unparseable Content-Length is rejected too —
      // Number(...) would make it NaN and NaN comparisons are all
      // false. (Chunked bodies carry no length to check here; they
      // were wrapped in a counting stream above instead.)
      const lenHeader = req.headers.get("content-length");
      const bodyLen = lenHeader === null ? 0 : Number(lenHeader);
      if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && (!Number.isFinite(bodyLen) || bodyLen > 32 * 1024 * 1024)) {
        return openAIError(413, "request body too large (max 32 MB)", "invalid_request_error", { code: "invalid_request", retryable: false });
      }
      if (pathname === "/" || pathname === "/healthz") {
        // Deliberately minimal: this endpoint is unauthenticated,
        // so it confirms liveness and nothing else (no endpoint
        // catalogue, no console address).
        return json({
          ok: true,
          service: "starbridge",
          ts: Date.now()
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
        let modelId;
        try {
          modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
        } catch {
          return openAIError(400, "\u6A21\u578B id \u7684 URL \u7F16\u7801\u4E0D\u5408\u6CD5", "invalid_request_error", { code: "invalid_request", retryable: false });
        }
        return handleModelOne(routeReq, env, modelId);
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
  async scheduled(controller, env, ctx) {
    await ensureSchema(env);
    const cfg = settings(env);
    if (controller.cron === "*/15 * * * *") {
      // Health-probe patrol (item 3): list probes only, every 15
      // minutes; runProbes itself enforces the configured interval
      // (15/30/60) and the enabled switch.
      ctx.waitUntil(
        runProbes(env).then(
          (r) => console.log(
            `[cron] probes ok=${r.ok} probed=${(r.probed ?? []).length} skipped=${r.skipped ?? ""} ${r.durationMs ?? 0}ms`
          )
        ).catch((e) => console.error("[cron] probes failed", e))
      );
    } else if (cfg.syncEnabled) {
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
