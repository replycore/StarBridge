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
               body={"key": "gw-limited-test", "label": "reg", "dailyLimit": 2})
check("gateway key issued with dailyLimit", s == 200 and r.get("entry", {}).get("dailyLimit") == 2, str(r)[:140])
for i in (1, 2):
    s, _, r = call("POST", "/v1/chat/completions", token="gw-limited-test",
                   body={"model": "solo-ok", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 20})
    check(f"limited key call {i} within quota", s == 200, str(s))
s, h, r = call("POST", "/v1/chat/completions", token="gw-limited-test",
               body={"model": "solo-ok", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 20})
err = r.get("error", {})
check("third call exceeds the caller quota -> 429 caller_quota_exceeded",
      s == 429 and err.get("code") == "caller_quota_exceeded" and (bool(h.get("retry-after") or h.get("Retry-After"))),
      f"{s} {str(err)[:120]} ra={h.get('retry-after') or h.get('Retry-After')}")
kid = r and None
s, _, r2 = call("GET", "/admin/api/gateway-keys", token=ADM)
for k in r2.get("keys", []):
    if k.get("key") == "gw-limited-test":
        call("DELETE", f"/admin/api/gateway-keys/{k['id']}", token=ADM)
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "bad:id", "baseUrl": "http://127.0.0.1:9/v1", "keys": ["x"]})
check("provider id with ':' is rejected", s >= 400 and "provider id" in json.dumps(r), f"{s} {str(r)[:120]}")
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

print(f"\nRESULT: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
