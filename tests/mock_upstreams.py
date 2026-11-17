#!/usr/bin/env python3
"""Mock upstream servers for local gateway tests.

Usage:
  mock_upstreams.py fail 9105   # per-key models: k-fail->solo-fail (HTTP 500),
                                # k-rl->solo-rl (HTTP 429), k-ok->solo-ok (200)
  mock_upstreams.py amd  9107   # amd-ds: rejects a `thinking` field with an
                                # AMD-style 400 carrying "param":"thinking"
  mock_upstreams.py ctx  9103 200      # ctx-shared (adv. ctx 100000) and
  mock_upstreams.py ctx  9104 100000   # ctx-tiny (adv. ctx 100); chat fails
                                # with a context_length_exceeded 400 when the
                                # total message chars exceed the limit arg
  mock_upstreams.py caps 9111 a        # cap-shared + cap-none, metadata
                                # says NO tools (supported_parameters without
                                # "tools")
  mock_upstreams.py caps 9113 b        # cap-shared, metadata says tools
  mock_upstreams.py shy  9115          # tools-shy: 400 with param:"tools"
                                # whenever the request carries tools
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = sys.argv[1]
PORT = int(sys.argv[2])
LIMIT = int(sys.argv[3]) if MODE == "ctx" and len(sys.argv) > 3 else 0
VARIANT = sys.argv[3] if MODE == "caps" and len(sys.argv) > 3 else ""

KEY_MODELS = {"k-fail": ["solo-fail"], "k-rl": ["solo-rl"], "k-ok": ["solo-ok"]}
AMD_ERROR = {
    "error": {
        "message": "\"thinking\" is not supported on /v1/chat/completions and was not applied. Use \"reasoning_effort\" (or \"reasoning.effort\") to control thinking.",
        "type": "invalid_request_error",
        "param": "thinking",
        "code": "unsupported_parameter",
    }
}


def completion(model):
    return {
        "id": "chatcmpl-mock", "object": "chat.completion", "created": 1, "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
    }


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.path.endswith("/models"):
            return self._json(404, {"error": {"message": "nf"}})
        if MODE == "fail":
            key = (self.headers.get("authorization") or "").replace("Bearer ", "")
            ids = KEY_MODELS.get(key, [])
            data = [{"id": m, "object": "model", "context_length": 100000} for m in ids]
        elif MODE == "amd":
            data = [{"id": "amd-ds", "object": "model", "context_length": 100000}]
        elif MODE == "ctx":
            data = [{"id": "ctx-shared", "object": "model", "context_length": 100000},
                    {"id": "ctx-tiny", "object": "model", "context_length": 100}]
        elif MODE == "shy":
            data = [{"id": "tools-shy", "object": "model", "context_length": 100000}]
        elif MODE == "caps":
            if VARIANT == "a":
                data = [{"id": "cap-shared", "object": "model", "context_length": 100000,
                         "supported_parameters": ["temperature", "top_p"]},
                        {"id": "cap-none", "object": "model", "context_length": 100000,
                         "supported_parameters": ["temperature"]}]
            else:
                data = [{"id": "cap-shared", "object": "model", "context_length": 100000,
                         "supported_parameters": ["tools", "temperature"]}]
        else:
            data = []
        self._json(200, {"object": "list", "data": data})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        model = body.get("model", "")
        if MODE == "fail":
            if model == "solo-fail":
                return self._json(500, {"error": {"message": "upstream internal error", "type": "api_error"}})
            if model == "solo-rl":
                return self._json(429, {"error": {"message": "rate limit exceeded", "type": "rate_limit_error"}})
            if model == "solo-ok":
                return self._json(200, completion(model))
            return self._json(404, {"error": {"message": "unknown model", "type": "invalid_request_error"}})
        if MODE == "amd":
            if "thinking" in body:
                return self._json(400, AMD_ERROR)
            return self._json(200, completion(model))
        if MODE == "shy":
            if "tools" in body:
                return self._json(400, {"error": {"message": "tools is not supported by this model",
                                                  "type": "invalid_request_error", "param": "tools"}})
            return self._json(200, completion(model))
        if MODE == "caps":
            return self._json(200, completion(model))
        if MODE == "ctx":
            chars = sum(len(str(m.get("content", ""))) for m in body.get("messages", []))
            if chars > LIMIT:
                return self._json(400, {"error": {
                    "message": f"This model's maximum context length is {LIMIT} tokens, but your messages resulted in more than that.",
                    "type": "invalid_request_error", "code": "context_length_exceeded"}})
            return self._json(200, completion(model))
        self._json(404, {"error": {"message": "nf"}})


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
