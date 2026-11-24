#!/usr/bin/env python3
"""Local regression suite for the gateway (run against `wrangler dev`).

Prereqs (see README in this folder's parent docs): mock upstreams running:
  python3 tests/mock_upstreams.py fail 9105
  python3 tests/mock_upstreams.py amd  9107
  python3 tests/mock_upstreams.py ctx  9103 200
  python3 tests/mock_upstreams.py ctx  9104 100000
and a dev server on 127.0.0.1:8787 with the local .dev.vars tokens.
Exits non-zero on the first failing group summary if any check fails.
"""
import json
import os
import time
import urllib.request

B = os.environ.get("GW_BASE", "http://127.0.0.1:8787")
ADM = os.environ.get("GW_ADMIN", "local-test-admin-token")
GW = os.environ.get("GW_TOKEN", "local-test-gateway-token")

passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok -", name)
    else:
        failed += 1
        print("  FAIL -", name, extra)


def call(method, path, token=None, body=None, headers=None):
    req = urllib.request.Request(B + path, method=method)
    if token:
        req.add_header("authorization", "Bearer " + token)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as r:
            return r.status, dict(r.headers), json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, dict(e.headers), json.loads(raw or b"{}")
        except Exception:
            return e.code, dict(e.headers), {"raw": raw[:200]}


def chat(model, extra=None, token=GW):
    body = {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 16}
    body.update(extra or {})
    return call("POST", "/v1/chat/completions", token=token, body=body)


def provider(pid, base, keys, weight=None):
    body = {"id": pid, "name": pid, "baseUrl": base, "keys": keys}
    if weight:
        body["weight"] = weight
    s, _, r = call("POST", "/admin/api/providers", token=ADM, body=body)
    assert s == 200, (pid, s, r)


print("== setup ==")
call("POST", "/admin/api/reset", token=ADM)  # clear health/drops so runs are deterministic
provider("pf", "http://127.0.0.1:9105/v1", ["k-fail"])
provider("pr", "http://127.0.0.1:9105/v1", ["k-rl"])
provider("po", "http://127.0.0.1:9105/v1", ["k-ok"])
provider("pa", "http://127.0.0.1:9107/v1", ["k-amd"])
provider("ps", "http://127.0.0.1:9103/v1", ["k-ctx"], weight=10)
provider("pl", "http://127.0.0.1:9104/v1", ["k-ctx"], weight=1)
provider("pca", "http://127.0.0.1:9111/v1", ["k-cap"], weight=10)
provider("pcb", "http://127.0.0.1:9113/v1", ["k-cap"], weight=1)
s, _, r = call("POST", "/admin/api/sync", token=ADM, body={})
# Group strategies are cached per isolate for 30s: write them ONCE here,
# before the first chat call populates the cache, and never flip them
# mid-suite (cap-shared intentionally keeps the default "balance").
# NOTE: the endpoint takes "key", not "id" — assert the write landed.
s, _, r = call("POST", "/admin/api/groups", token=ADM, body={"key": "ctx-shared", "strategy": "failover"})
assert r.get("ok"), f"strategy write failed: {r}"
check("sync ok", s == 200 and r.get("ok"), str(r)[:120])
s, _, r = call("GET", "/healthz")
check("healthz 200", s == 200)
s, _, _ = call("GET", "/v1/models")
check("models 401 without token", s == 401)

print("== basic routing ==")
s, h, r = chat("solo-ok")
check("solo-ok 200", s == 200 and r["choices"][0]["message"]["content"] == "OK", str(s))

print("== no_capacity diagnostics ==")
s, _, _ = chat("solo-fail")
check("solo-fail first call fails upstream", s in (500, 503), str(s))
s, h, r = chat("solo-fail")
err = r.get("error", {})
check("second call is no_capacity 503", s == 503 and err.get("type") == "no_capacity", str(r)[:160])
check("retry_after present (~30, model pause)", 1 <= (err.get("retry_after") or 0) <= 30, str(err.get("retry_after")))
check("Retry-After header matches", h.get("Retry-After") == str(err.get("retry_after")), h.get("Retry-After"))
check("hint mentions cooling", "冷却" in (err.get("hint") or ""), err.get("hint"))
s, _, _ = chat("solo-rl")
check("solo-rl first call 429/503", s in (429, 503), str(s))
s, h, r = chat("solo-rl")
err = r.get("error", {})
check("solo-rl then no_capacity with retry_after (~60)", s == 503 and 30 <= (err.get("retry_after") or 0) <= 60, str(r)[:160])

print("== machine-readable errors ==")
call("POST", "/admin/api/reset", token=ADM)  # isolate from the states above
s, _, r = chat("nope-model-xyz")
err = r.get("error", {})
check("unknown model: code=model_not_found, not retryable, request_id",
      s == 404 and err.get("code") == "model_not_found" and err.get("retryable") is False and bool(err.get("request_id")), str(err))
s, _, r = call("POST", "/v1/chat/completions", body={"model": "solo-ok", "messages": [{"role": "user", "content": "hi"}]})
err = r.get("error", {})
check("no token: code=authentication_error", s == 401 and err.get("code") == "authentication_error" and err.get("retryable") is False, str(err))
s, _, r = chat("solo-rl")
err = r.get("error", {})
check("rate-limited exhaustion: code=upstream_rate_limited, retryable, attempts=1",
      err.get("code") == "upstream_rate_limited" and err.get("retryable") is True and err.get("attempts") == 1, str(err))
s, _, r = chat("solo-fail")
err = r.get("error", {})
check("server-error exhaustion: code=upstream_server", err.get("code") == "upstream_server" and err.get("retryable") is True, str(err))
s, _, r = chat("solo-fail")
err = r.get("error", {})
check("no_capacity: code + retryable + retry_after_ms + request_id",
      err.get("code") == "no_capacity" and err.get("retryable") is True
      and 1000 <= (err.get("retry_after_ms") or 0) <= 60000 and bool(err.get("request_id")), str(err))
s, _, r = call("POST", "/v1/messages", token=GW, headers={"anthropic-version": "2023-06-01"},
               body={"model": "nope-model-xyz", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]})
err = r.get("error", {})
check("anthropic translation carries code through", r.get("type") == "error" and err.get("code") == "model_not_found", str(r)[:160])

print("== param drop (thinking) ==")
s, h, r = chat("amd-ds", {"thinking": {"type": "enabled", "budget_tokens": 1024}})
check("first thinking call 200 via same-pick retry", s == 200, str(r)[:160])
check("x-gw-dropped-params reports thinking", h.get("x-gw-dropped-params") == "thinking", str(h.get("x-gw-dropped-params")))
check("attempts >= 2", int(h.get("x-gw-attempts", "0")) >= 2, h.get("x-gw-attempts"))
s, _, r = chat("amd-ds", {"thinking": {"type": "enabled"}})
check("second thinking call 200 (learned drop)", s == 200, str(s))

print("== context-aware routing ==")
long_msg = "x" * 2000
s, h, r = chat("ctx-shared", {"messages": [{"role": "user", "content": long_msg}]})
check("long request fails over to the big-limit provider", s == 200 and h.get("x-gw-provider") == "pl", f"{s} via {h.get('x-gw-provider')}")
s, h, r = chat("ctx-shared")
check("short request sticks to failover-first provider ps", s == 200 and h.get("x-gw-provider") == "ps", f"{s} via {h.get('x-gw-provider')}")

print("== custom models ==")
s, _, r = call("POST", "/admin/api/groups/custom", token=ADM, body={"id": "reg-custom", "keywords": ["solo-ok"]})
check("custom model created, matched >= 1", s == 200 and (r.get("matched") or 0) >= 1, str(r)[:120])
s, _, r = chat("reg-custom")
check("custom model routes", s == 200, str(s))
s, _, r = call("DELETE", "/admin/api/groups/custom?id=reg-custom", token=ADM)
check("custom model deleted", s == 200 and r.get("ok"), str(r)[:120])
s, _, _ = chat("reg-custom")
check("deleted custom model 404s", s == 404, str(s))

print("== session stickiness ==")
seq = []
for _ in range(6):
    s, h, r = call("POST", "/v1/chat/completions", token=GW, headers={"x-gw-session": "reg-sess-1"},
                   body={"model": "cap-shared", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8})
    seq.append((s, h.get("x-gw-provider"), h.get("x-gw-sticky")))
check("session calls all 200", all(x[0] == 200 for x in seq), str(seq))
check("first call sticky=new", seq[0][2] == "new", str(seq[0]))
check("later calls sticky=hit", all(x[2] == "hit" for x in seq[1:]), str(seq))
check("all calls pinned to one provider", len({x[1] for x in seq}) == 1, str(seq))
seq = []
for _ in range(3):
    s, h, r = call("POST", "/v1/chat/completions", token=GW,
                   body={"model": "cap-shared", "user": "reg-agent-1",
                         "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8})
    seq.append((h.get("x-gw-provider"), h.get("x-gw-sticky")))
check("user field infers a session (new then hit)", seq[0][1] == "new" and all(x[1] == "hit" for x in seq[1:]), str(seq))
check("user-inferred session pinned", len({x[0] for x in seq}) == 1, str(seq))
s, h, r = chat("cap-shared")
check("single-turn without session id gets no sticky header", s == 200 and h.get("x-gw-sticky") is None, str(h.get("x-gw-sticky")))
conv = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi there"}, {"role": "user", "content": "again"}]
s1, h1, _ = call("POST", "/v1/chat/completions", token=GW, body={"model": "cap-shared", "messages": conv, "max_tokens": 8})
conv2 = conv + [{"role": "assistant", "content": "ok"}, {"role": "user", "content": "more"}]
s2, h2, _ = call("POST", "/v1/chat/completions", token=GW, body={"model": "cap-shared", "messages": conv2, "max_tokens": 8})
check("multi-turn hash inference (new then hit, same provider)",
      h1.get("x-gw-sticky") == "new" and h2.get("x-gw-sticky") == "hit" and h1.get("x-gw-provider") == h2.get("x-gw-provider"),
      f"{h1.get('x-gw-sticky')}/{h1.get('x-gw-provider')} -> {h2.get('x-gw-sticky')}/{h2.get('x-gw-provider')}")

print("== tools hard filter ==")
TOOLS = {"tools": [{"type": "function", "function": {"name": "f", "parameters": {"type": "object", "properties": {}}}}]}
hits = set()
for _ in range(6):
    s, h, r = chat("cap-shared", TOOLS)
    hits.add(h.get("x-gw-provider"))
check("tools requests never hit the known no-tools endpoint", hits == {"pcb"}, str(hits))
hits = set()
for _ in range(8):
    s, h, r = chat("cap-shared")
    hits.add(h.get("x-gw-provider"))
check("without tools both endpoints serve", "pca" in hits, str(hits))
s, h, r = chat("cap-none", TOOLS)
check("all endpoints no-tools -> degraded fallback still serves", s == 200 and h.get("x-gw-provider") == "pca", f"{s} via {h.get('x-gw-provider')}")
check("x-gw-degraded marks the fallback", h.get("x-gw-degraded") == "tools", str(h.get("x-gw-degraded")))
s, h, r = chat("cap-none")
check("no degraded header when the request needs no tools", s == 200 and h.get("x-gw-degraded") is None, str(h.get("x-gw-degraded")))

print("== x-gw-max-attempts ==")
long_msg = "y" * 2000
s, h, r = call("POST", "/v1/chat/completions", token=GW, headers={"x-gw-max-attempts": "1"},
               body={"model": "ctx-shared", "messages": [{"role": "user", "content": long_msg}], "max_tokens": 8})
check("max-attempts=1 stops after the first (failing) pick", s != 200, f"status {s}")
s, h, r = call("POST", "/v1/chat/completions", token=GW, headers={"x-gw-max-attempts": "2"},
               body={"model": "ctx-shared", "messages": [{"role": "user", "content": long_msg}], "max_tokens": 8})
check("max-attempts=2 reaches the failover pick", s == 200 and h.get("x-gw-provider") == "pl" and h.get("x-gw-attempts") == "2",
      f"{s} via {h.get('x-gw-provider')} attempts {h.get('x-gw-attempts')}")
s, h, r = call("POST", "/v1/chat/completions", token=GW, headers={"x-gw-max-attempts": "99"},
               body={"model": "ctx-shared", "messages": [{"role": "user", "content": long_msg}], "max_tokens": 8})
check("max-attempts above the default clamps, does not error", s == 200 and h.get("x-gw-provider") == "pl", f"{s} via {h.get('x-gw-provider')}")

print("== param drop whitelist (P0-3) ==")
provider("pshy", "http://127.0.0.1:9115/v1", ["k-shy"])
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = chat("tools-shy", TOOLS)
err = r.get("error", {})
check("tools rejection is NOT silently dropped: caller gets the 400",
      s == 400 and err.get("code") == "invalid_request", f"{s} {str(err)[:120]}")
s, _, r = chat("tools-shy")
check("same model without tools works", s == 200, str(s))

print("== sync pagination + key rotation (P0-1/P0-2) ==")
provider("ppg", "http://127.0.0.1:9117/v1", ["k-pg"])
provider("prot", "http://127.0.0.1:9105/v1", ["k-bad", "k-ok"])
s, _, r = call("POST", "/admin/api/sync", token=ADM, body={})
states = {p["id"]: p for p in r.get("providers", [])}
check("paginated sync lists all 3 models", states.get("ppg", {}).get("listed") == 3, str(states.get("ppg")))
s, _, r = chat("pg-c")
check("page-2 model is routable", s == 200, str(s))
check("sync rotates past a 401 key to the next key", states.get("prot", {}).get("ok") is True and states.get("prot", {}).get("listed", 0) >= 1, str(states.get("prot")))

print("== vision hard filter (P1-10) ==")
provider("pvt", "http://127.0.0.1:9119/v1", ["k-vt"])
provider("pvs", "http://127.0.0.1:9123/v1", ["k-vs"])
call("POST", "/admin/api/sync", token=ADM, body={})
IMG = [{"role": "user", "content": [{"type": "text", "text": "what is this"},
                                    {"type": "image_url", "image_url": {"url": "https://x/y.png"}}]}]
s, h, r = call("POST", "/v1/chat/completions", token=GW,
               body={"model": "vis-shared", "messages": IMG, "max_tokens": 50})
check("image request goes to the image-capable endpoint first try",
      s == 200 and h.get("x-gw-provider") == "pvs" and h.get("x-gw-attempts") == "1",
      f"{s} {h.get('x-gw-provider')} att={h.get('x-gw-attempts')}")
s, _, r = chat("vis-shared")
check("text request to the same group still works", s == 200, str(s))

print("== streaming + client abort (P1-6) ==")
import http.client, socket, time as _time
provider("psse", "http://127.0.0.1:9121/v1", ["k-sse"])
call("POST", "/admin/api/sync", token=ADM, body={})
conn = http.client.HTTPConnection("127.0.0.1", 8787, timeout=30)
conn.request("POST", "/v1/chat/completions",
             body=json.dumps({"model": "sse-slow", "messages": [{"role": "user", "content": "hi"}], "stream": True}),
             headers={"authorization": f"Bearer {GW}", "content-type": "application/json"})
resp = conn.getresponse()
body_all = resp.read().decode()
check("stream completes with [DONE]", resp.status == 200 and "[DONE]" in body_all, f"{resp.status} len={len(body_all)}")
conn.close()
# abortive client: read one chunk, then slam the socket shut
sock = socket.create_connection(("127.0.0.1", 8787), timeout=10)
req = ("POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1:8787\r\n"
       f"authorization: Bearer {GW}\r\ncontent-type: application/json\r\n"
       "content-length: %d\r\nconnection: close\r\n\r\n%s")
payload = json.dumps({"model": "sse-slow", "messages": [{"role": "user", "content": "hi"}], "stream": True})
sock.sendall((req % (len(payload), payload)).encode())
buf = b""
for _ in range(20):
    part = sock.recv(4096)
    if not part:
        break
    buf += part
    if b"tok0" in buf:
        break
check("abortive client got a first chunk", b"tok0" in buf, str(buf[:80]))
sock.close()
_time.sleep(6)  # report + buffered usage flush
s, _, r = call("GET", "/admin/api/overview", token=ADM)
recent = r.get("usage", {}).get("recent", [])
aborts = [x for x in recent if x.get("provider") == "psse" and x.get("error_kind") == "client_abort"]
check("client abort is recorded as client_abort usage", len(aborts) >= 1, f"recent={len(recent)} aborts={len(aborts)}")

print("== batch 5: quota / id validation / origin / header pass-through ==")
s, _, r = call("POST", "/admin/api/gateway-keys", token=ADM,
               body={"key": "gw-limited-test-key-0123456789abcdef", "label": "reg", "dailyLimit": 2})
check("gateway key issued with dailyLimit", s == 200 and r.get("entry", {}).get("dailyLimit") == 2, str(r)[:140])
for i in (1, 2):
    s, _, r = call("POST", "/v1/chat/completions", token="gw-limited-test-key-0123456789abcdef",
                   body={"model": "solo-ok", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 20})
    check(f"limited key call {i} within quota", s == 200, str(s))
s, h, r = call("POST", "/v1/chat/completions", token="gw-limited-test-key-0123456789abcdef",
               body={"model": "solo-ok", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 20})
err = r.get("error", {})
check("third call exceeds the caller quota -> 429 caller_quota_exceeded",
      s == 429 and err.get("code") == "caller_quota_exceeded" and (bool(h.get("retry-after") or h.get("Retry-After"))),
      f"{s} {str(err)[:120]} ra={h.get('retry-after') or h.get('Retry-After')}")
# passthrough endpoints enforce the same caller quota (audit P1)
s, h, r = call("POST", "/v1/embeddings", token="gw-limited-test-key-0123456789abcdef",
               body={"model": "solo-ok", "input": "hi"})
err = r.get("error", {})
check("passthrough call also blocked by caller quota -> 429",
      s == 429 and err.get("code") == "caller_quota_exceeded",
      f"{s} {str(err)[:120]}")
kid = r and None
s, _, r2 = call("GET", "/admin/api/gateway-keys", token=ADM)
for k in r2.get("keys", []):
    if k.get("key") == "gw-limited-test-key-0123456789abcdef":
        call("DELETE", f"/admin/api/gateway-keys/{k['id']}", token=ADM)
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "bad:id", "baseUrl": "http://127.0.0.1:9/v1", "keys": ["x"]})
check("provider id with ':' is rejected", s >= 400 and "provider id" in json.dumps(r), f"{s} {str(r)[:120]}")
# partial provider update must not reset unlisted fields (audit P1)
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "partial-test", "baseUrl": "http://127.0.0.1:9105/v1", "kind": "openai",
                     "dailyLimitDefault": 77, "keys": ["sk-partial-1"]})
check("provider created for partial-update test", s == 200, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "partial-test", "enabled": False})
s, _, r = call("GET", "/admin/api/providers", token=ADM)
prov = [p for p in r.get("providers", []) if p.get("id") == "partial-test"]
p0 = prov[0] if prov else {}
check("partial update preserves baseUrl and limits",
      p0.get("baseUrl") == "http://127.0.0.1:9105/v1" and p0.get("dailyLimitDefault") == 77 and p0.get("enabled") is False,
      str(p0)[:160])
# add-key route must reject a string keys value, not split it into chars (audit P1)
s, _, r = call("POST", "/admin/api/providers/partial-test/keys", token=ADM, body={"keys": "sk-should-not-split"})
check("string keys value rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("GET", "/admin/api/providers", token=ADM)
prov = [p for p in r.get("providers", []) if p.get("id") == "partial-test"]
check("no char-split keys were stored", bool(prov) and len(prov[0].get("keys", [])) == 1, str(prov)[:160])
call("DELETE", "/admin/api/providers/partial-test", token=ADM)
import requests as _rq
resp = _rq.get(B + "/admin/api/overview", headers={"authorization": f"Bearer {ADM}", "origin": "https://evil.example"}, timeout=30)
check("browser Origin rejected when ADMIN_ORIGIN unconfigured (fail closed)", resp.status_code == 403, str(resp.status_code))
# anthropic path now passes x-gw-* through (sticky visible to agents)
ANT = {"authorization": f"Bearer {GW}", "anthropic-version": "2023-06-01", "content-type": "application/json",
       "x-gw-session": "reg-ant-sticky"}
abody = {"model": "cap-shared", "max_tokens": 50, "messages": [{"role": "user", "content": "hi"}]}
_rq.post(B + "/v1/messages", headers=ANT, json=abody, timeout=60)
resp = _rq.post(B + "/v1/messages", headers=ANT, json=abody, timeout=60)
check("anthropic path passes x-gw-sticky through", resp.headers.get("x-gw-sticky") == "hit",
      f"{resp.status_code} sticky={resp.headers.get('x-gw-sticky')}")
# gemini path: error carries the machine-readable fields
resp = _rq.post(B + "/v1beta/models/nope-model:generateContent",
                headers={"authorization": f"Bearer {GW}", "content-type": "application/json"},
                json={"contents": [{"parts": [{"text": "hi"}]}]}, timeout=60)
gj = resp.json().get("error", {})
check("gemini error carries gw_code + retryable", gj.get("gw_code") == "model_not_found" and gj.get("retryable") is False,
      f"{resp.status_code} {str(gj)[:140]}")

print("== anthropic path ==")
s, _, r = call("POST", "/v1/messages", token=GW, headers={"anthropic-version": "2023-06-01"},
               body={"model": "solo-ok", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]})
check("anthropic messages 200 + shape", s == 200 and r.get("type") == "message", str(r)[:160])

print("== capability-string routing ==")
s, h, r = chat("auto:tools")
check("auto:tools serves and echoes x-gw-caps", s == 200 and h.get("x-gw-caps") == "tools", f"{s} caps={h.get('x-gw-caps')}")
s, h, r = chat("auto:tools", TOOLS)
check("auto:tools with a tools body stays on tools-capable endpoints", s == 200 and h.get("x-gw-caps") == "tools", str(s))
s, h, r = call("POST", "/v1/chat/completions", token=GW,
               body={"model": "auto:vision", "messages": IMG, "max_tokens": 50})
check("auto:vision never lands on the known text-only endpoint",
      s == 200 and h.get("x-gw-caps") == "vision" and h.get("x-gw-provider") != "pvt",
      f"{s} via {h.get('x-gw-provider')} caps={h.get('x-gw-caps')}")
s, h, r = call("POST", "/v1/chat/completions", token=GW,
               body={"model": "auto:tools+vision", "messages": IMG, "max_tokens": 50, **TOOLS})
check("auto:tools+vision combines both capability filters",
      s == 200 and h.get("x-gw-caps") == "tools+vision" and h.get("x-gw-provider") != "pvt",
      f"{s} via {h.get('x-gw-provider')} caps={h.get('x-gw-caps')}")
s, h, r = chat("auto:reasoning")
check("auto:reasoning serves (degraded pool is acceptable)", s in (200, 503) and h.get("x-gw-caps") == "reasoning", f"{s} caps={h.get('x-gw-caps')}")

print("== MCP endpoint ==")
def rpc(body, token=GW):
    return call("POST", "/mcp", token=token, body=body)
s, _, r = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "reg", "version": "0"}}})
check("mcp initialize returns server info", s == 200 and r.get("result", {}).get("serverInfo", {}).get("name") == "starbridge", str(r)[:160])
s, _, r = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
names = {t.get("name") for t in r.get("result", {}).get("tools", [])}
check("mcp tools/list exposes the three tools", names == {"list_models", "chat", "generate_image"}, str(names))
s, _, r = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "chat", "arguments": {"model": "solo-ok", "prompt": "hi"}}})
content = r.get("result", {}).get("content", [])
check("mcp chat tool returns reply text", s == 200 and content and content[0].get("type") == "text" and len(content[0].get("text", "")) > 0 and not r.get("result", {}).get("isError"), str(r)[:200])
s, _, r = rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "list_models", "arguments": {}}})
text = r.get("result", {}).get("content", [{}])[0].get("text", "")
check("mcp list_models includes the capability aliases", "auto:tools" in text, text[:120])
s, _, r = rpc({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "nope", "arguments": {}}})
check("mcp unknown tool is a JSON-RPC error", r.get("error", {}).get("code") == -32602, str(r)[:120])
s, _, r = rpc({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "chat", "arguments": {"model": "auto:tools", "prompt": "hi"}}})
check("mcp chat honours capability model strings", s == 200 and not r.get("result", {}).get("isError"), str(r)[:160])
s, _, r = rpc({"jsonrpc": "2.0", "id": 7, "method": "initialize"}, token=None)
check("mcp rejects missing token with 401", s == 401, str(s))
req = urllib.request.Request(B + "/mcp", method="POST", data=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode())
req.add_header("authorization", "Bearer " + GW)
req.add_header("content-type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        nstatus = resp.status
except urllib.error.HTTPError as e:
    nstatus = e.code
check("mcp notifications get 202 with no body", nstatus == 202, str(nstatus))

print("== batch 9: audit P2 fixes ==")
s, _, r = rpc({"jsonrpc": "2.0", "id": 20, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
check("mcp initialize falls back for an unknown protocol version",
      r.get("result", {}).get("protocolVersion") == "2025-06-18", str(r)[:140])
s, _, r = rpc({"jsonrpc": "2.0", "id": 21, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
check("mcp initialize echoes a supported client version",
      r.get("result", {}).get("protocolVersion") == "2025-03-26", str(r)[:140])
req = urllib.request.Request(B + "/mcp", method="POST", data=json.dumps({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "list_models", "arguments": {}}}).encode())
req.add_header("authorization", "Bearer " + GW)
req.add_header("content-type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        nstatus, nbody = resp.status, resp.read()
except urllib.error.HTTPError as e:
    nstatus, nbody = e.code, e.read()
check("mcp notification tools/call is not executed (202, empty)", nstatus == 202 and not nbody, f"{nstatus} {nbody[:80]}")
s, _, r = call("POST", "/admin/api/import", token=ADM,
               body={"kind": "config-backup", "data": {"providers": [{"id": "bad:id", "baseUrl": "http://127.0.0.1:9105/v1", "keys": ["x"]}]}})
check("import rejects an invalid provider id", s == 400, f"{s} {str(r)[:140]}")
s, _, r = call("POST", "/admin/api/import", token=ADM,
               body={"kind": "config-backup", "data": {"gatewayKeys": [{"label": "no-key-field"}]}})
check("import rejects a gateway key without a key string", s == 400, f"{s} {str(r)[:140]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "objkey-test", "baseUrl": "http://127.0.0.1:9105/v1", "keys": [{"key": "x"}]})
check("provider creation rejects object key entries", s >= 400 and "必须是字符串" in json.dumps(r, ensure_ascii=False), f"{s} {str(r)[:140]}")
s, _, r = call("POST", "/admin/api/probe", token=ADM, body={"provider": "po", "model": "solo-ok"})
check("probe result is not double-wrapped", s == 200 and isinstance(r.get("ok"), bool), f"{s} {str(r)[:140]}")
provider("MixedCase", "http://127.0.0.1:9105/v1", ["k-ok"])
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("POST", "/v1/chat/completions", token=GW,
               body={"model": "mixedcase/solo-ok", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 10})
check("pinned call with lowercased provider id routes", s == 200, f"{s} {str(r)[:140]}")
call("DELETE", "/admin/api/providers/MixedCase", token=ADM)

print("== batch 10: second-audit fixes ==")
# MCP: a non-object JSON body is an Invalid Request, not a notification
req = urllib.request.Request(B + "/mcp", method="POST", data=b"42")
req.add_header("authorization", "Bearer " + GW)
req.add_header("content-type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        mcp42_status, mcp42 = r.status, json.loads(r.read() or b"{}")
except urllib.error.HTTPError as e:
    mcp42_status, mcp42 = e.code, json.loads(e.read() or b"{}")
check("mcp rejects a non-object body with -32600",
      mcp42_status == 400 and mcp42.get("error", {}).get("code") == -32600, f"{mcp42_status} {str(mcp42)[:120]}")
# Alerts PUT: omitting `enabled` preserves the stored value
call("PUT", "/admin/api/alerts", token=ADM, body={"enabled": True, "webhook": "http://127.0.0.1:9132/hook"})
call("PUT", "/admin/api/alerts", token=ADM, body={"webhook": "http://127.0.0.1:9999/hook"})
s, _, r = call("GET", "/admin/api/alerts", token=ADM)
check("alerts PUT without enabled keeps alerting on",
      r.get("enabled") is True and r.get("webhookHost") == "127.0.0.1:9999", str(r)[:140])
call("PUT", "/admin/api/alerts", token=ADM, body={"enabled": False, "webhook": None})
# Zero-pick rejections must not burn caller quota, but must be recorded
provider("pz", "http://127.0.0.1:9105/v1", ["k-fail"])
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("POST", "/admin/api/gateway-keys", token=ADM, body={"dailyLimit": 2})
gk, gkid = r["entry"]["key"], r["entry"]["id"]
s1, _, r1 = chat("pz/solo-fail", token=gk)
s2, _, r2 = chat("pz/solo-fail", token=gk)
check("zero-pick rejection is a no_capacity 503",
      s2 == 503 and r2.get("error", {}).get("code") == "no_capacity", f"{s2} {str(r2)[:140]}")
time.sleep(6)
s3, _, r3 = chat("pz/solo-fail", token=gk)
check("zero-pick rejection did not consume caller quota",
      s3 == 503 and r3.get("error", {}).get("code") != "caller_quota_exceeded", f"{s3} {str(r3)[:140]}")
s, _, r = call("GET", "/admin/api/overview", token=ADM)
check("zero-pick rejection is recorded under its only provider",
      any(x.get("provider") == "pz" and x.get("model") == "pz/solo-fail" and x.get("error_kind") == "no_capacity" and x.get("attempts") == 0
          for x in r.get("usage", {}).get("recent", [])), str(r.get("usage", {}).get("recent", []))[:200])
call("DELETE", "/admin/api/providers/pz", token=ADM)
call("DELETE", "/admin/api/gateway-keys/" + gkid, token=ADM)
# Import persists the normalized records it validated
s, _, exp = call("GET", "/admin/api/export", token=ADM)
bundle = exp["data"]
bundle["providers"] = list(bundle.get("providers") or []) + [
    {"id": "imp1", "baseUrl": "http://127.0.0.1:9105/v1", "weight": "7", "keys": [{"key": "k-ok", "label": "main"}]}]
s, _, r = call("POST", "/admin/api/import", token=ADM, body={"kind": "config-backup", "data": bundle})
check("import accepts the bundle", s == 200, f"{s} {str(r)[:140]}")
s, _, r = call("GET", "/admin/api/providers", token=ADM)
imp = next((p for p in r["providers"] if p["id"] == "imp1"), {})
check("import stored normalized values (numeric weight, key label kept)",
      imp.get("weight") == 7 and (imp.get("keys") or [{}])[0].get("label") == "main", str(imp)[:200])
call("DELETE", "/admin/api/providers/imp1", token=ADM)

print("== batch 11: external-audit fixes ==")
# F-01: pinned passthrough verifies the model against the provider's live list + free filter
s, _, r = call("POST", "/v1/completions", token=GW, body={"model": "po/solo-ok", "prompt": "hi"})
check("pinned passthrough to a listed free model works", s == 200, f"{s} {str(r)[:140]}")
s, _, r = call("POST", "/v1/completions", token=GW, body={"model": "pf/not-a-real-model", "prompt": "hi"})
check("pinned passthrough to an unlisted model is 404 model_not_found",
      s == 404 and (r.get("error") or {}).get("code") == "model_not_found", f"{s} {str(r)[:140]}")
# F-05: exhausted-failure errors carry no upstream text in last_error
s, _, r = chat("pf/solo-fail")
le = (r.get("error") or {}).get("last_error") or {}
check("exhausted error has no upstream text in last_error", s == 503 and "message" not in le, f"{s} {str(r)[:200]}")
# F-08b: short custom gateway keys are rejected, long ones accepted
s, _, r = call("POST", "/admin/api/gateway-keys", token=ADM, body={"key": "too-short-key"})
check("short custom gateway key rejected", s == 400, f"{s} {str(r)[:140]}")
s, _, r = call("POST", "/admin/api/gateway-keys", token=ADM, body={"key": "k" * 40, "label": "batch11"})
check("long custom gateway key accepted", s == 200, f"{s} {str(r)[:140]}")
s, _, r = call("GET", "/admin/api/gateway-keys", token=ADM)
kid = next((k["id"] for k in r.get("keys", []) if k.get("label") == "batch11"), None)
if kid:
    call("DELETE", f"/admin/api/gateway-keys/{kid}", token=ADM)
# F-03: provider baseUrl validation (public http IP literal rejected, https domain accepted)
s, _, r = call("POST", "/admin/api/providers", token=ADM, body={"id": "badurl1", "baseUrl": "http://203.0.113.5/v1", "keys": ["x"]})
check("public http IP-literal baseUrl rejected", s == 400, f"{s} {str(r)[:140]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM, body={"id": "badurl2", "baseUrl": "https://example.com/v1", "keys": ["x"]})
check("https domain baseUrl accepted", s == 200, f"{s} {str(r)[:140]}")
call("DELETE", "/admin/api/providers/badurl2", token=ADM)
# F-15: healthz no longer exposes the endpoint list / admin UI address
s, _, r = call("GET", "/healthz")
check("healthz is minimal", s == 200 and "endpoints" not in r and "admin_ui" not in r, f"{s} {str(r)[:140]}")
# F-12: malformed percent-encoding in a model id is a 400, not a 500
s, _, r = call("GET", "/v1/models/%E0%A4%A", token=GW)
check("malformed model id encoding is 400", s == 400, f"{s} {str(r)[:140]}")

print("== batch 12: per-provider free rules ==")
def ppr(rules):
    s, _, r = call("POST", "/admin/api/providers", token=ADM,
                   body={"id": "ppr", "baseUrl": "http://127.0.0.1:9125/v1", "keys": ["k-priced"],
                         "freeMode": "rules", "freeRules": rules})
    assert s == 200, f"ppr save failed: {s} {r}"
    # sync twice: entries dropped by a rules change carry a 2-miss grace in discovery
    call("POST", "/admin/api/sync", token=ADM, body={})
    call("POST", "/admin/api/sync", token=ADM, body={})
def ppr_chat(m):
    s, _, _ = chat(f"ppr/{m}")
    return s
ppr({"price": True, "suffix": False, "allow": []})
check("rules price-only: zero-price model in", ppr_chat("priced-free") == 200)
check("rules price-only: paid model out", ppr_chat("priced-paid") == 404)
check("rules price-only: no-pricing model out", ppr_chat("priced-noprice") == 404)
check("rules price-only: paid :free-suffix model out", ppr_chat("suffix-free:free") == 404)
ppr({"price": False, "suffix": True, "allow": []})
check("rules suffix-only: :free model in despite paid pricing", ppr_chat("suffix-free:free") == 200)
check("rules suffix-only: zero-price model out", ppr_chat("priced-free") == 404)
ppr({"price": False, "suffix": False, "allow": ["^priced-paid$"]})
check("rules allow-only: listed model in", ppr_chat("priced-paid") == 200)
check("rules allow-only: suffix model out", ppr_chat("suffix-free:free") == 404)
ppr({"price": True, "suffix": True, "allow": ["^priced-paid$"]})
check("rules union: price model in", ppr_chat("priced-free") == 200)
check("rules union: suffix model in", ppr_chat("suffix-free:free") == 200)
check("rules union: allow model in", ppr_chat("priced-paid") == 200)
check("rules union: no-pricing unlisted model out", ppr_chat("priced-noprice") == 404)
s, _, r = call("POST", "/admin/api/providers/preview-models", token=ADM, body={"providerId": "ppr"})
ids = sorted(m["id"] for m in r.get("models", []))
check("preview-models by providerId lists all four", s == 200 and len(ids) == 4, f"{s} {ids}")
paid = next((m for m in r.get("models", []) if m["id"] == "priced-paid"), {})
check("preview-models passes pricing through", (paid.get("pricing") or {}).get("prompt") == "0.001", str(paid)[:140])
s, _, r = call("POST", "/admin/api/providers/preview-models", token=ADM,
               body={"baseUrl": "http://127.0.0.1:9125/v1", "key": "k-priced"})
check("preview-models by form values lists models", s == 200 and len(r.get("models", [])) == 4, f"{s} {str(r)[:140]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "ppr", "freeMode": "rules", "freeRules": {"price": False, "suffix": False, "allow": ["("]}})
check("invalid allow regex rejected at save", s == 400, f"{s} {str(r)[:140]}")
call("DELETE", "/admin/api/providers/ppr", token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 13: provider preset is recorded ==")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "presetprobe", "preset": "openrouter", "keys": ["sk-probe"]})
check("provider created from a preset", s == 200, f"{s} {str(r)[:140]}")
s, _, r = call("GET", "/admin/api/providers", token=ADM)
pp = next((p for p in r["providers"] if p["id"] == "presetprobe"), {})
check("preset name stored on the record", pp.get("preset") == "openrouter", str(pp.get("preset")))
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "presetprobe", "weight": 3})
s, _, r = call("GET", "/admin/api/providers", token=ADM)
pp = next((p for p in r["providers"] if p["id"] == "presetprobe"), {})
check("partial update keeps the stored preset", pp.get("preset") == "openrouter" and pp.get("weight") == 3, str(pp.get("preset")))
s, _, r = call("GET", "/admin/api/providers", token=ADM)
pz = next((p for p in r["providers"] if p["id"] == "pz-nonexistent"), None)
pf0 = next((p for p in r["providers"] if p["id"] == "pf"), {})
check("custom provider has empty preset", pf0.get("preset") in ("", None), str(pf0.get("preset")))
call("DELETE", "/admin/api/providers/presetprobe", token=ADM)

print("== batch 14: CF account config + usage ==")
s, _, r = call("GET", "/admin/api/cf-config", token=ADM)
check("cf-config starts unconfigured", s == 200 and r.get("configured") is False, f"{s} {str(r)[:140]}")
s, _, r = call("GET", "/admin/api/cf-usage", token=ADM)
check("cf-usage unconfigured shape", s == 200 and r.get("configured") is False, f"{s} {str(r)[:140]}")
s, _, r = call("PUT", "/admin/api/cf-config", token=ADM, body={"accountId": "not-hex", "apiKey": "x"})
check("cf-config rejects a bad account id", s == 400, f"{s} {str(r)[:140]}")
FAKEKEY = "cfk_fakefakefakefakefakefakefakefake1234"
s, _, r = call("PUT", "/admin/api/cf-config", token=ADM,
               body={"accountId": "a" * 32, "email": "ops@example.com", "apiKey": FAKEKEY})
check("cf-config saves", s == 200 and r.get("configured") is True and r.get("authType") == "global", f"{s} {str(r)[:160]}")
check("cf-config never returns the secret", FAKEKEY not in json.dumps(r), str(r)[:140])
s, _, r = call("PUT", "/admin/api/cf-config", token=ADM, body={"accountId": "a" * 32, "email": "ops2@example.com"})
s, _, r2 = call("GET", "/admin/api/cf-config", token=ADM)
check("cf-config blank key keeps the stored one", r2.get("configured") is True and r2.get("email") == "ops2@example.com", str(r2)[:160])
s, _, r = call("GET", "/admin/api/cf-usage", token=ADM)
check("cf-usage with bad creds returns an error field, not a 500",
      s == 200 and r.get("configured") is True and bool(r.get("error")), f"{s} {str(r)[:180]}")
s, _, r = call("DELETE", "/admin/api/cf-config", token=ADM)
s, _, r = call("GET", "/admin/api/cf-config", token=ADM)
check("cf-config cleared", s == 200 and r.get("configured") is False, f"{s} {str(r)[:140]}")

print("== batch 15: bound-domains discovery ==")
s, _, r = call("GET", "/admin/api/domains", token=ADM)
check("domains unconfigured shape", s == 200 and r.get("configured") is False and r.get("domains") == [], f"{s} {str(r)[:140]}")
s, _, r = call("PUT", "/admin/api/cf-config", token=ADM,
               body={"accountId": "b" * 32, "email": "ops@example.com", "apiKey": "cfk_fakefakefakefakefakefakefakefake5678"})
check("domains test cf-config saved", s == 200 and r.get("configured") is True, f"{s} {str(r)[:140]}")
s, _, r = call("GET", "/admin/api/domains", token=ADM)
check("domains with bad creds returns an error field, not a 500",
      s == 200 and r.get("configured") is True and r.get("domains") == [] and bool(r.get("error")), f"{s} {str(r)[:180]}")
s, _, r = call("DELETE", "/admin/api/cf-config", token=ADM)
s, _, r = call("GET", "/admin/api/domains", token=ADM)
check("domains back to unconfigured after clear", s == 200 and r.get("configured") is False, f"{s} {str(r)[:140]}")

print("== batch 16: sync fingerprint skip ==")
import os
DYN_FILE = os.environ.get("GW_DYN_FILE", "/tmp/dyn_models.json")
def dyn_write(models):
    with open(DYN_FILE, "w") as f:
        json.dump(models, f)
def dyn_state(rep):
    return next((p for p in rep.get("providers", []) if p.get("id") == "pdyn"), {})
def sync_now():
    s, _, r = call("POST", "/admin/api/sync", token=ADM)
    assert s == 200, f"sync failed: {s} {r}"
    return r

dyn_write([{"id": "dyn-a", "object": "model", "context_length": 100000},
           {"id": "dyn-b", "object": "model", "context_length": 100000}])
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "pdyn", "kind": "openai", "baseUrl": "http://127.0.0.1:9127", "keys": ["k-dyn"]})
check("pdyn created", s == 200, f"{s} {str(r)[:120]}")
rep = sync_now()
check("first sync rebuilds pdyn", dyn_state(rep).get("skipped") is not True and dyn_state(rep).get("kept") == 2, str(dyn_state(rep))[:140])
s, _, r = chat("dyn-a")
check("dyn-a routable after first sync", s == 200, f"{s} {str(r)[:120]}")
rep = sync_now()
check("second sync skips pdyn (unchanged)", dyn_state(rep).get("skipped") is True, str(dyn_state(rep))[:140])
dyn_write([{"id": "dyn-b", "object": "model", "context_length": 100000},
           {"id": "dyn-c", "object": "model", "context_length": 100000}])
rep = sync_now()
check("changed list rebuilds pdyn", dyn_state(rep).get("skipped") is not True, str(dyn_state(rep))[:140])
s, _, r = chat("dyn-c")
check("dyn-c routable", s == 200, f"{s}")
s, _, r = chat("dyn-a")
check("dyn-a survives one absence (grace)", s == 200, f"{s}")
rep = sync_now()
check("next sync skips pdyn again", dyn_state(rep).get("skipped") is True, str(dyn_state(rep))[:140])
s, _, r = chat("dyn-a")
check("dyn-a aged out on the skipped sync", s == 404, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM, body={"id": "pdyn", "freeMode": "zero-price"})
check("pdyn config updated", s == 200, f"{s}")
rep = sync_now()
check("config change rebuilds pdyn", dyn_state(rep).get("skipped") is not True and dyn_state(rep).get("kept") == 0, str(dyn_state(rep))[:140])
rep = sync_now()
check("post-config sync skips pdyn", dyn_state(rep).get("skipped") is True, str(dyn_state(rep))[:140])
s, _, r = chat("dyn-b")
check("dyn-b gone after zero-price aging", s == 404, f"{s}")
call("DELETE", "/admin/api/providers/pdyn", token=ADM)
sync_now()

print("== batch 17: failure attribution ==")
def recent_row(model):
    s, _, r = call("GET", "/admin/api/overview", token=ADM)
    for x in r.get("usage", {}).get("recent", []):
        if x.get("model") == model and not x.get("ok"):
            return x
    return None
def prov_usage():
    s, _, r = call("GET", "/admin/api/overview", token=ADM)
    u = r.get("usage", {})
    return {p["name"]: p for p in u.get("byProvider", [])}, u.get("today", {})
# A zero-pick failure touching one provider belongs to that provider
call("POST", "/admin/api/providers", token=ADM, body={"id": "px1", "kind": "openai", "baseUrl": "http://127.0.0.1:9107", "keys": ["k-px1"], "dailyLimitDefault": 1})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = chat("px1/amd-ds")
check("px1 first chat ok (burns its key quota)", s == 200, f"{s} {str(r)[:120]}")
s, _, r = chat("px1/amd-ds")
check("px1 second chat is no_capacity", s == 503 and r.get("error", {}).get("code") == "no_capacity", f"{s} {str(r)[:120]}")
time.sleep(5)
row = recent_row("px1/amd-ds")
check("zero-pick failure is attributed to its only provider",
      row is not None and row.get("provider") == "px1" and row.get("error_kind") == "no_capacity" and row.get("attempts") == 0, str(row)[:160])
# Exhausted attempts against one provider belong to it too
call("POST", "/admin/api/providers", token=ADM, body={"id": "pf2", "kind": "openai", "baseUrl": "http://127.0.0.1:9105/v1", "keys": ["k-fail"]})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = chat("pf2/solo-fail")
check("pf2 chat fails upstream", s >= 500, f"{s} {str(r)[:120]}")
time.sleep(5)
row = recent_row("pf2/solo-fail")
check("exhausted-attempts failure is attributed to its only provider",
      row is not None and row.get("provider") == "pf2", str(row)[:160])
# A mapping model whose suppliers are ALL down: the recent row stays
# in the gateway bucket, but per-provider usage books the failure
# against each supplier and never lists the gateway itself. Both
# suppliers point at the dyn mock (fresh model ids no other provider
# carries), so the keyword matches exactly their two entries.
dyn_write([{"id": "b17-m1", "object": "model", "context_length": 100000},
           {"id": "b17-m2", "object": "model", "context_length": 100000}])
call("POST", "/admin/api/providers", token=ADM, body={"id": "pg1", "kind": "openai", "baseUrl": "http://127.0.0.1:9127", "keys": ["k-b17a"], "dailyLimitDefault": 1})
call("POST", "/admin/api/providers", token=ADM, body={"id": "pg2", "kind": "openai", "baseUrl": "http://127.0.0.1:9127", "keys": ["k-b17b"], "dailyLimitDefault": 1})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("POST", "/admin/api/groups/custom", token=ADM, body={"id": "bothdead", "keywords": ["b17-m1"]})
check("bothdead group created over two providers", s == 200 and (r.get("matched") or 0) >= 2, str(r)[:120])
s, _, r = chat("pg1/b17-m1")
check("pg1 burn chat ok", s == 200, f"{s}")
s, _, r = chat("pg2/b17-m1")
check("pg2 burn chat ok", s == 200, f"{s}")
time.sleep(5)
before, today_before = prov_usage()
s, _, r = chat("bothdead")
check("bothdead chat is no_capacity", s == 503 and r.get("error", {}).get("code") == "no_capacity", f"{s} {str(r)[:140]}")
time.sleep(5)
row = recent_row("bothdead")
check("aggregate failure stays in the gateway bucket in recent",
      row is not None and row.get("provider") == "gateway", str(row)[:160])
after, today_after = prov_usage()
check("per-provider usage has no gateway entry", "gateway" not in after, str(list(after))[:160])
check("aggregate failure is booked against each supplier",
      after.get("pg1", {}).get("requests", 0) == before.get("pg1", {}).get("requests", 0) + 1
      and after.get("pg2", {}).get("requests", 0) == before.get("pg2", {}).get("requests", 0) + 1,
      f"pg1 {before.get('pg1')} -> {after.get('pg1')}; pg2 {before.get('pg2')} -> {after.get('pg2')}")
check("aggregate failure counts once in the day totals",
      today_after.get("requests", 0) == today_before.get("requests", 0) + 1, f"{today_before.get('requests')} -> {today_after.get('requests')}")
call("DELETE", "/admin/api/groups/custom?id=bothdead", token=ADM)
for pid in ("px1", "pf2", "pg1", "pg2"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 18: usage-log completeness + single-provider groups ==")
# (a) A content_filter rejection is recorded (it used to vanish)
call("POST", "/admin/api/providers", token=ADM, body={"id": "pflt", "kind": "openai", "baseUrl": "http://127.0.0.1:9131", "keys": ["k-flt"]})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = chat("filter-1")
check("content rejection surfaces as content_filter", s == 400 and r.get("error", {}).get("code") == "content_filter", f"{s} {str(r)[:140]}")
time.sleep(5)
row = recent_row("filter-1")
check("content rejection is recorded under its provider",
      row is not None and row.get("provider") == "pflt" and row.get("error_kind") == "content", str(row)[:160])
call("DELETE", "/admin/api/providers/pflt", token=ADM)
# (b) A passthrough request records ONE usage row, however many
# attempts it needed (it used to record one row per attempt)
call("POST", "/admin/api/providers", token=ADM, body={"id": "pf3", "kind": "openai", "baseUrl": "http://127.0.0.1:9105/v1", "keys": ["k-fail", "k-fail2"]})
call("POST", "/admin/api/sync", token=ADM, body={})
time.sleep(5)
_, today_before = prov_usage()
s, h, r = call("POST", "/v1/completions", token=GW, body={"model": "pf3/solo-fail", "prompt": "hi"}, headers={"x-gw-max-attempts": "3"})
check("passthrough failure made several attempts", s >= 500 and int(h.get("x-gw-attempts", "0")) >= 2, f"{s} attempts={h.get('x-gw-attempts')}")
time.sleep(5)
_, today_after = prov_usage()
check("passthrough request counts once in the day totals",
      today_after.get("requests", 0) == today_before.get("requests", 0) + 1, f"{today_before.get('requests')} -> {today_after.get('requests')}")
call("DELETE", "/admin/api/providers/pf3", token=ADM)
# (c) A caller-quota rejection is recorded (it used to vanish)
s, _, r = call("POST", "/admin/api/gateway-keys", token=ADM, body={"dailyLimit": 1})
gk2, gkid2 = r["entry"]["key"], r["entry"]["id"]
s, _, r = chat("amd-ds", token=gk2)
check("quota key first chat ok", s == 200, f"{s} {str(r)[:120]}")
s, _, r = chat("amd-ds", token=gk2)
check("quota key second chat is caller_quota_exceeded",
      s == 429 and r.get("error", {}).get("code") == "caller_quota_exceeded", f"{s} {str(r)[:140]}")
time.sleep(5)
row = recent_row("amd-ds")
check("caller-quota rejection is recorded",
      row is not None and row.get("error_kind") == "caller_quota" and row.get("attempts") == 0, str(row)[:160])
call("DELETE", "/admin/api/gateway-keys/" + gkid2, token=ADM)
# (d) A single-provider model is not a group, but still routes and
# is listed under its own name; multi-provider names stay groups
dyn_write([{"id": "solo-m1", "object": "model", "context_length": 100000}])
call("POST", "/admin/api/providers", token=ADM, body={"id": "psolo", "kind": "openai", "baseUrl": "http://127.0.0.1:9127", "keys": ["k-solo"]})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("GET", "/v1/models", token=GW)
rows = r.get("data", [])
solo_row = next((x for x in rows if x.get("id") == "solo-m1"), None)
check("single-provider model is listed as itself, not as a group",
      solo_row is not None and "providers" not in solo_row and solo_row.get("owned_by") == "psolo", str(solo_row)[:160])
grp_row = next((x for x in rows if (x.get("id") or "").endswith("solo-ok") and x.get("providers")), None)
check("multi-provider model stays a group",
      grp_row is not None and len(grp_row.get("providers") or []) >= 2, str(grp_row)[:160])
s, _, r = call("GET", "/admin/api/groups", token=ADM)
glist = r.get("groups") or r.get("list") or []
gids = [g.get("id") for g in glist]
check("admin group list has no single-provider auto group",
      "solo-m1" not in gids and "solo-ok" in gids, str(gids)[:200])
s, _, r = chat("solo-m1")
check("single-provider model still routes by its bare name", s == 200, f"{s} {str(r)[:120]}")
call("DELETE", "/admin/api/providers/psolo", token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print(f"\nRESULT: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
