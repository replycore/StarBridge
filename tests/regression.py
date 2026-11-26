#!/usr/bin/env python3
"""Local regression suite for the gateway (run against `wrangler dev`).

Prereqs (see README in this folder's parent docs): mock upstreams running:
  python3 tests/mock_upstreams.py fail 9105
  python3 tests/mock_upstreams.py amd  9107
  python3 tests/mock_upstreams.py ctx  9103 200
  python3 tests/mock_upstreams.py ctx  9104 100000
  ... plus the remaining mocks (caps 9111/9113, shy 9115, paged 9117,
  vis 9119/9123, sse 9121, priced 9125, dyn 9127, filter 9131,
  sink 9133 <temp file>, echo 9135 <temp file>) and the probe mock
  (~/workspace/shots-work/probe_mock.py on 9143: slow-json/slow-json10,
  slow-m/slow-drip/slow-endless).
  Batch 19 reads GW_SINK_FILE (default /tmp/alert_sink.jsonl);
  batch 24 reads GW_ECHO_FILE (default /tmp/echo.jsonl).
and a dev server on 127.0.0.1:8787 with the local .dev.vars tokens.
Exits non-zero on the first failing group summary if any check fails.
"""
import json
import os
import re
import time
import urllib.request

B = os.environ.get("GW_BASE", "http://127.0.0.1:8787")
# The dev-server port, derived from GW_BASE: the streaming batch opens
# raw sockets, so it cannot use the base URL directly.
from urllib.parse import urlparse as _urlparse
GW_PORT = _urlparse(B).port or 8787
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


def provider(pid, base, keys, weight=None, priority=None, mapping=None, overrides=None, allow=None, drop=None,
             headerTimeoutMs=None, idleTimeoutMs=None, streamMaxMs=None):
    body = {"id": pid, "name": pid, "baseUrl": base, "keys": keys}
    if weight:
        body["weight"] = weight
    if priority is not None:
        body["priority"] = priority
    if mapping is not None:
        body["modelMapping"] = mapping
    if overrides is not None:
        body["paramOverrides"] = overrides
    if allow is not None:
        body["allowFields"] = allow
    if drop is not None:
        body["dropParams"] = drop
    if headerTimeoutMs is not None:
        body["headerTimeoutMs"] = headerTimeoutMs
    if idleTimeoutMs is not None:
        body["idleTimeoutMs"] = idleTimeoutMs
    if streamMaxMs is not None:
        body["streamMaxMs"] = streamMaxMs
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
# Smoothing (weightedSample w' = w + 5% of the pool max) raised the
# weight-1 provider's first-pick chance on a balance draw from ~9%
# to ~12.5%, so a single draw asserting the weight-10 provider
# serves is flaky. Retry like batch 21's b21_two_pick: pass when
# any attempt serves via pca with the tools-degraded marker, which
# bounds the flake to ~0.2% while keeping the check's intent
# ("degraded fallback still serves").
cap_none = None
for _ in range(3):
    s, h, r = chat("cap-none", TOOLS)
    cap_none = (s, h, r)
    if s == 200 and h.get("x-gw-provider") == "pca" and h.get("x-gw-degraded") == "tools":
        break
s, h, r = cap_none
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
conn = http.client.HTTPConnection("127.0.0.1", GW_PORT, timeout=30)
conn.request("POST", "/v1/chat/completions",
             body=json.dumps({"model": "sse-slow", "messages": [{"role": "user", "content": "hi"}], "stream": True}),
             headers={"authorization": f"Bearer {GW}", "content-type": "application/json"})
resp = conn.getresponse()
body_all = resp.read().decode()
check("stream completes with [DONE]", resp.status == 200 and "[DONE]" in body_all, f"{resp.status} len={len(body_all)}")
conn.close()
# abortive client: read one chunk, then slam the socket shut
sock = socket.create_connection(("127.0.0.1", GW_PORT), timeout=10)
req = ("POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1:%d\r\n"
       f"authorization: Bearer {GW}\r\ncontent-type: application/json\r\n"
       "content-length: %d\r\nconnection: close\r\n\r\n%s")
payload = json.dumps({"model": "sse-slow", "messages": [{"role": "user", "content": "hi"}], "stream": True})
sock.sendall((req % (GW_PORT, len(payload), payload)).encode())
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
check("rules price-only: zero-price model in", ppr_chat("priced-zero") == 200)
check("rules price-only: paid model out", ppr_chat("priced-paid") == 404)
check("rules price-only: no-pricing model out", ppr_chat("priced-noprice") == 404)
check("rules price-only: paid free-named model out", ppr_chat("suffix-free:free") == 404)
check("rules price-only: paid mid-name free model out", ppr_chat("mid-free-model") == 404)
check("rules price-only: paid freedom-named model out", ppr_chat("freedom-7b") == 404)
ppr({"price": False, "suffix": True, "allow": []})
check("rules suffix-only: :free model in despite paid pricing", ppr_chat("suffix-free:free") == 200)
check("rules suffix-only: mid-name free model in despite paid pricing", ppr_chat("mid-free-model") == 200)
check("rules suffix-only: zero-price model without free in name out", ppr_chat("priced-zero") == 404)
check("rules suffix-only: paid model without free out", ppr_chat("priced-paid") == 404)
check("rules suffix-only: freedom-named model out", ppr_chat("freedom-7b") == 404)
check("rules suffix-only: freezer-named model out", ppr_chat("freezer-9b") == 404)
ppr({"price": False, "suffix": False, "allow": ["^priced-paid$"]})
check("rules allow-only: listed model in", ppr_chat("priced-paid") == 200)
check("rules allow-only: suffix model out", ppr_chat("suffix-free:free") == 404)
check("rules allow-only: mid-name free model out", ppr_chat("mid-free-model") == 404)
check("rules allow-only: freezer-named model out", ppr_chat("freezer-9b") == 404)
ppr({"price": True, "suffix": True, "allow": ["^priced-paid$"]})
check("rules union: price model in", ppr_chat("priced-zero") == 200)
check("rules union: suffix model in", ppr_chat("suffix-free:free") == 200)
check("rules union: mid-name free model in", ppr_chat("mid-free-model") == 200)
check("rules union: allow model in", ppr_chat("priced-paid") == 200)
check("rules union: no-pricing unlisted model out", ppr_chat("priced-noprice") == 404)
check("rules union: freedom-named model out", ppr_chat("freedom-7b") == 404)
check("rules union: freezer-named model out", ppr_chat("freezer-9b") == 404)
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "ppr", "freeMode": "allowlist", "allow": []})
assert s == 200, f"ppr allowlist save failed: {s} {r}"
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
check("allowlist empty allow: mid-name free model in", ppr_chat("mid-free-model") == 200)
check("allowlist empty allow: paid model without free out", ppr_chat("priced-paid") == 404)
check("allowlist empty allow: zero-price model without free out", ppr_chat("priced-zero") == 404)
check("allowlist empty allow: freedom-named model out", ppr_chat("freedom-7b") == 404)
check("allowlist empty allow: freezer-named model out", ppr_chat("freezer-9b") == 404)
s, _, r = call("POST", "/admin/api/providers/preview-models", token=ADM, body={"providerId": "ppr"})
ids = sorted(m["id"] for m in r.get("models", []))
check("preview-models by providerId lists all seven", s == 200 and len(ids) == 7, f"{s} {ids}")
paid = next((m for m in r.get("models", []) if m["id"] == "priced-paid"), {})
check("preview-models passes pricing through", (paid.get("pricing") or {}).get("prompt") == "0.001", str(paid)[:140])
s, _, r = call("POST", "/admin/api/providers/preview-models", token=ADM,
               body={"baseUrl": "http://127.0.0.1:9125/v1", "key": "k-priced"})
check("preview-models by form values lists models", s == 200 and len(r.get("models", [])) == 7, f"{s} {str(r)[:140]}")
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

print("== batch 19: alert notifications carry a timestamp ==")
import os, re
SINK_FILE = os.environ.get("GW_SINK_FILE", "/tmp/alert_sink.jsonl")
call("PUT", "/admin/api/alerts", token=ADM, body={"enabled": True, "webhook": "http://127.0.0.1:9133/hook"})
s, _, r = call("POST", "/admin/api/alerts/test", token=ADM, body={})
check("alert test push accepted", s == 200 and r.get("ok"), f"{s} {str(r)[:120]}")
time.sleep(1)
sink = ""
try:
    with open(SINK_FILE) as f:
        sink = f.read()
except Exception:
    pass
check("alert body carries a readable timestamp",
      re.search(r"时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC\+8）", sink) is not None, sink[:200])
call("PUT", "/admin/api/alerts", token=ADM, body={"enabled": False, "webhook": None})

print("== batch 20: per-provider usage reset clocks ==")
import datetime
for pid in ("px", "py"):
    call("POST", "/admin/api/providers", token=ADM, body={"id": pid, "kind": "openai", "baseUrl": "http://127.0.0.1:9107", "keys": ["k-a"]})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = chat("px/amd-ds")
check("px chat ok", s == 200, f"{s}")
t_a = time.time()
s, _, r = chat("py/amd-ds")
check("py chat ok", s == 200, f"{s}")
time.sleep(5)
u, _ = prov_usage()
check("both providers count their chat on the default clock",
      u.get("px", {}).get("requests") == 1 and u.get("py", {}).get("requests") == 1,
      str({k: v.get("requests") for k, v in u.items() if k in ("px", "py")}))
s, _, r = call("POST", "/admin/api/providers", token=ADM, body={"id": "px2", "resetOffsetMin": 9999})
check("out-of-range reset offset is rejected", s == 400, f"{s} {str(r)[:120]}")
# Move px's reset boundary to just after its first chat: an offset
# whose clock reads 00:0x right now puts the period start at the
# most recent minute boundary, which the sleep guarantees is after
# the chat. py keeps the default clock and must be unaffected.
time.sleep(65)
now_utc = datetime.datetime.now(datetime.timezone.utc)
off = -(now_utc.hour * 60 + now_utc.minute)
if off < -720:
    off += 1440
s, _, r = call("POST", "/admin/api/providers", token=ADM, body={"id": "px", "resetOffsetMin": off})
check("reset offset saved", s == 200, f"{s} {str(r)[:120]}")
u, _ = prov_usage()
check("chat before the provider's own reset boundary no longer counts for it",
      u.get("px", {}).get("requests", 0) == 0 and u.get("py", {}).get("requests") == 1,
      str({k: v.get("requests") for k, v in u.items() if k in ("px", "py")}))
s, _, r = chat("px/amd-ds")
check("px chat in its fresh period ok", s == 200, f"{s}")
time.sleep(5)
u, _ = prov_usage()
pxu = u.get("px", {})
check("new chat counts in the provider's fresh period",
      pxu.get("requests") == 1 and pxu.get("reset_offset_min") == off and (pxu.get("period_start") or 0) / 1000 > t_a,
      str(pxu)[:180])
call("DELETE", "/admin/api/providers/px", token=ADM)
call("DELETE", "/admin/api/providers/py", token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 21: retry decision table + error source + URL masking ==")
# Group A (behavior-locking): these MUST pass against the current code —
# they pin down what the retry table has to reproduce. Group B
# (new behavior): expected to FAIL until the backend lands the
# retry-policy endpoints, error.source, and URL masking.
# Each two-pick model below is served by a bad pick (weight 10) and a
# good pick (weight 1) on the fail mock (9105). The order is a weighted
# draw, so a call retries onto the good pick only ~10/11 of the time;
# loop with a reset between attempts (reset clears the bad pick's
# breaker / pause / dead state) until the retry is observed.
def b21_two_pick(model, good_provider, tries=5):
    seen = []
    best = None
    for _ in range(tries):
        call("POST", "/admin/api/reset", token=ADM)
        s, h, r = chat(model)
        seen.append((s, h.get("x-gw-provider"), h.get("x-gw-attempts")))
        if s == 200 and h.get("x-gw-provider") == good_provider and h.get("x-gw-attempts") == "2":
            return s, h, r, seen
        best = (s, h, r)
    s, h, r = best
    return s, h, r, seen

call("POST", "/admin/api/reset", token=ADM)
provider("p21fb", "http://127.0.0.1:9105/v1", ["k-b21fail"], weight=10)
provider("p21fg", "http://127.0.0.1:9105/v1", ["k-b21fail-ok"], weight=1)
provider("p21rb", "http://127.0.0.1:9105/v1", ["k-b21rl"], weight=10)
provider("p21rg", "http://127.0.0.1:9105/v1", ["k-b21rl-ok"], weight=1)
provider("p21gb", "http://127.0.0.1:9105/v1", ["k-b21gone"], weight=10)
provider("p21gg", "http://127.0.0.1:9105/v1", ["k-b21gone-ok"], weight=1)
provider("p21bb", "http://127.0.0.1:9105/v1", ["k-b21bp"], weight=10)
provider("p21bg", "http://127.0.0.1:9105/v1", ["k-b21bp-ok"], weight=1)
provider("p21au", "http://127.0.0.1:9105/v1", ["k-b21auth"])
provider("p21lk", "http://127.0.0.1:9105/v1", ["k-b21leak"])
provider("p21flt", "http://127.0.0.1:9131", ["k-flt"])
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})

# -- A1: a 500 retries onto the next pick
s, h, r, seen = b21_two_pick("b21-fail", "p21fg")
check("500 retries to the next pick (attempts=2, good provider serves)",
      s == 200 and h.get("x-gw-provider") == "p21fg" and h.get("x-gw-attempts") == "2", str(seen))
# -- A2: content_filter is terminal — exactly one attempt. (The early
# 400 return carries no x-gw-attempts header, so the attempt count is
# asserted on the recorded usage row instead.)
s, h, r = chat("filter-1")
check("content_filter surfaces as a 400",
      s == 400 and r.get("error", {}).get("code") == "content_filter", f"{s} {str(r)[:120]}")
time.sleep(5)
s, _, r = call("GET", "/admin/api/overview", token=ADM)
flt_rows = [x for x in r.get("usage", {}).get("recent", [])
            if x.get("model") == "filter-1" and x.get("provider") == "p21flt" and not x.get("ok")]
check("content_filter stops after one attempt (usage row attempts=1)",
      bool(flt_rows) and flt_rows[0].get("attempts") == 1, str(flt_rows[:1])[:160])
# -- A3: a 400 with no extractable param continues to the next pick
s, h, r, seen = b21_two_pick("b21-badparam", "p21bg")
check("bad_param without a param continues to the next pick (attempts=2)",
      s == 200 and h.get("x-gw-provider") == "p21bg" and h.get("x-gw-attempts") == "2", str(seen))
# -- A4: model_gone (404) moves to the next pick
s, h, r, seen = b21_two_pick("b21-gone", "p21gg")
check("model_gone moves to the next pick (attempts=2, good provider serves)",
      s == 200 and h.get("x-gw-provider") == "p21gg" and h.get("x-gw-attempts") == "2", str(seen))
# -- A5: a 429 retries onto the next pick
s, h, r, seen = b21_two_pick("b21-rl", "p21rg")
check("rate_limit 429 retries to the next pick (attempts=2, good provider serves)",
      s == 200 and h.get("x-gw-provider") == "p21rg" and h.get("x-gw-attempts") == "2", str(seen))

# -- B1: error.source on failed chat responses
call("POST", "/admin/api/reset", token=ADM)
s, _, r = chat("solo-rl")
err = r.get("error", {})
check("rate-limit exhaustion shape is upstream_rate_limited, retryable, attempts=1",
      err.get("code") == "upstream_rate_limited" and err.get("retryable") is True and err.get("attempts") == 1, str(err)[:160])
check("rate-limit failure carries error.source == upstream",
      err.get("source") == "upstream", str(err)[:160])
call("POST", "/admin/api/reset", token=ADM)
s, _, r = chat("b21-auth")
err = r.get("error", {})
check("auth failure surfaces as upstream_auth 503",
      s == 503 and err.get("code") == "upstream_auth", f"{s} {str(err)[:160]}")
check("auth failure carries error.source == channel",
      err.get("source") == "channel", str(err)[:160])

# -- B2: a mock error body carrying a URL with a fake key must not leak
# the key into the admin stats (models[].error is the stored lastErr).
call("POST", "/admin/api/reset", token=ADM)
s, _, r = chat("b21-leak")
check("leak-model chat fails (404 model_gone)", s in (404, 503), f"{s} {str(r)[:120]}")
time.sleep(5)  # let the /report write land in the coordinator before reading stats
s, _, r = call("GET", "/admin/api/stats", token=ADM)
dead = (r.get("models") or {}).get("dead") or []
leak_row = next((x for x in dead if (x.get("model") or "").endswith("b21-leak")), None)
check("leak-model failure is recorded in stats models.dead (non-vacuous)",
      leak_row is not None, str(dead)[:200])
check("stats payload nowhere contains the fake key from the upstream URL",
      "SECRET123" not in json.dumps(r), str(leak_row)[:200])

# -- B3: retry-policy endpoints. The matrix runs while the stored policy
# is still the default (fresh KV); the PUT tests come after it.
s, _, r = call("GET", "/admin/api/retry-policy", token=ADM)
check("GET retry-policy returns the defaults when KV is unset",
      s == 200 and r.get("ok") is True and r.get("retryRanges") == "429,408,500-599"
      and r.get("skipRanges") == "" and r.get("skipCodes") == ["content_filter"], f"{s} {str(r)[:200]}")
from urllib.parse import quote as _b21q
def retry_test(params):
    qs = "&".join(f"{k}={_b21q(str(v), safe='')}" for k, v in params.items())
    return call("GET", "/admin/api/retry-policy/test?" + qs, token=ADM)
MATRIX = [
    ("strict affinity stops", {"strictAffinity": "true"}, False, "strict_session"),
    ("pinned stops", {"pinned": "true"}, False, "pinned_channel"),
    ("skipRetry flag stops", {"skipRetry": "true"}, False, "non_retryable_error"),
    ("content kind stops", {"kind": "content"}, False, "non_retryable_error"),
    ("auth from a channel retries", {"kind": "auth", "source": "channel"}, True, "channel_error"),
    ("quota from a channel retries", {"kind": "quota", "source": "channel"}, True, "channel_error"),
    ("no attempts left stops", {"attemptsLeft": 0}, False, "attempt_budget_exhausted"),
    ("2xx stops", {"status": 200, "kind": "server"}, False, "system_retry_exclusion"),
    ("status 0 retries as unrecognized", {"status": 0, "kind": "network"}, True, "unrecognized_status"),
    ("429 rate_limit retries", {"status": 429, "kind": "rate_limit"}, True, "retry_status_matched"),
    ("500 server retries", {"status": 500, "kind": "server"}, True, "retry_status_matched"),
    ("504 timeout retries", {"status": 504, "kind": "timeout"}, True, "retry_status_matched"),
    ("408 timeout retries", {"status": 408, "kind": "timeout"}, True, "retry_status_matched"),
    ("409 unknown stops", {"status": 409, "kind": "unknown"}, False, "status_not_retryable"),
    ("skip code stops even on 500", {"status": 500, "kind": "server", "errorCode": "content_filter"}, False, "system_retry_exclusion"),
    ("401 auth retries via derived channel source", {"status": 401, "kind": "auth"}, True, "channel_error"),
    ("400 bad_param stops", {"status": 400, "kind": "bad_param"}, False, "status_not_retryable"),
]
for name, params, want_retry, want_reason in MATRIX:
    s, _, r = retry_test(params)
    check(f"retry-policy/test: {name}",
          s == 200 and r.get("ok") is True and r.get("retry") is want_retry and r.get("reason") == want_reason,
          f"{s} {str(r)[:160]}")
s, _, r = retry_test({"status": "abc"})
check("retry-policy/test rejects a non-numeric status with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = retry_test({"attemptsLeft": "abc"})
check("retry-policy/test rejects a non-numeric attemptsLeft with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = retry_test({"status": 401, "kind": "auth"})
check("retry-policy/test derives source=channel for auth",
      s == 200 and r.get("source") == "channel" and r.get("status") == 401 and r.get("kind") == "auth",
      f"{s} {str(r)[:160]}")

# -- B4: PUT validation, persistence, and partial updates
s, _, r = call("PUT", "/admin/api/retry-policy", token=ADM, body={"retryRanges": "abc"})
check("PUT retry-policy rejects an invalid range string with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("PUT", "/admin/api/retry-policy", token=ADM, body={"skipRanges": "xyz"})
check("PUT retry-policy rejects an invalid skip range string with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("PUT", "/admin/api/retry-policy", token=ADM,
               body={"retryRanges": "429,500-503", "skipRanges": "404", "skipCodes": ["content_filter", "custom_code"]})
check("PUT retry-policy with valid ranges succeeds and echoes them",
      s == 200 and r.get("ok") is True and r.get("retryRanges") == "429,500-503"
      and r.get("skipRanges") == "404" and r.get("skipCodes") == ["content_filter", "custom_code"],
      f"{s} {str(r)[:160]}")
s, _, r = call("GET", "/admin/api/retry-policy", token=ADM)
check("GET retry-policy returns the stored ranges",
      s == 200 and r.get("retryRanges") == "429,500-503" and r.get("skipRanges") == "404"
      and r.get("skipCodes") == ["content_filter", "custom_code"], f"{s} {str(r)[:160]}")
s, _, r = call("PUT", "/admin/api/retry-policy", token=ADM, body={"retryRanges": "408,429"})
check("PUT retry-policy accepts a partial update",
      s == 200 and r.get("ok") is True and r.get("retryRanges") == "408,429", f"{s} {str(r)[:160]}")
s, _, r = call("GET", "/admin/api/retry-policy", token=ADM)
check("PUT partial preserves omitted fields",
      s == 200 and r.get("retryRanges") == "408,429" and r.get("skipRanges") == "404"
      and r.get("skipCodes") == ["content_filter", "custom_code"], f"{s} {str(r)[:160]}")
s, _, r = call("PUT", "/admin/api/retry-policy", token=ADM,
               body={"retryRanges": "429,408,500-599", "skipRanges": "", "skipCodes": ["content_filter"]})
check("PUT retry-policy restores the defaults",
      s == 200 and r.get("ok") is True and r.get("retryRanges") == "429,408,500-599", f"{s} {str(r)[:160]}")
s, _, r = call("GET", "/admin/api/retry-policy", token=ADM)
check("GET retry-policy shows the restored defaults",
      s == 200 and r.get("retryRanges") == "429,408,500-599" and r.get("skipRanges") == ""
      and r.get("skipCodes") == ["content_filter"], f"{s} {str(r)[:160]}")

for pid in ("p21fb", "p21fg", "p21rb", "p21rg", "p21gb", "p21gg", "p21bb", "p21bg", "p21au", "p21lk", "p21flt"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 22: priority tiers ==")
call("POST", "/admin/api/reset", token=ADM)
provider("p22hi", "http://127.0.0.1:9105/v1", ["k-b21fail-ok"], weight=1, priority=1)
provider("p22lo", "http://127.0.0.1:9105/v1", ["k-b21fail-ok"], weight=10, priority=0)
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
# The derived group key for b21-fail: both providers serve it, so it
# forms a mapping group; the admin list carries the routing key.
s, _, r = call("GET", "/admin/api/groups", token=ADM)
glist = r.get("groups") or []
g22 = next((g for g in glist if (g.get("id") or "").endswith("b21-fail")), None)
check("b21-fail forms a mapping group over p22hi/p22lo",
      g22 is not None and set(g22.get("providers") or []) == {"p22hi", "p22lo"}, str(g22)[:200])
gkey22 = g22["key"] if g22 else "b21-fail"
s, _, r = call("POST", "/admin/api/groups", token=ADM, body={"key": gkey22, "strategy": "failover"})
check("b21-fail group strategy set to failover",
      s == 200 and r.get("ok") and r.get("strategy") == "failover", f"{s} {str(r)[:120]}")
s, h, r = chat("b21-fail")
check("failover + priority tier: priority-1 provider serves despite weight 1 vs 10",
      s == 200 and h.get("x-gw-provider") == "p22hi" and h.get("x-gw-attempts") == "1",
      f"{s} via {h.get('x-gw-provider')} attempts {h.get('x-gw-attempts')}")
# Tier fallthrough: swap the pair for a failing tier-1 pick and a
# healthy tier-0 pick. The tier-1 pick must be tried first (500)
# and the request must then fall to tier 0 (200, attempts=2).
for pid in ("p22hi", "p22lo"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})
provider("p22fb", "http://127.0.0.1:9105/v1", ["k-b21fail"], weight=1, priority=1)
provider("p22fg", "http://127.0.0.1:9105/v1", ["k-b21fail-ok"], weight=10, priority=0)
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
s, h, r = chat("b21-fail")
check("priority-1 pick is tried first (500) then falls to priority 0 (200)",
      s == 200 and h.get("x-gw-provider") == "p22fg" and h.get("x-gw-attempts") == "2",
      f"{s} via {h.get('x-gw-provider')} attempts {h.get('x-gw-attempts')}")
# Priority round-trips through the provider record, and an
# out-of-range value is rejected with 400.
s, _, r = call("GET", "/admin/api/providers", token=ADM)
plist = r.get("providers") or []
by_id = {p.get("id"): p for p in plist}
check("priority round-trips (1 and 0)",
      by_id.get("p22fb", {}).get("priority") == 1 and by_id.get("p22fg", {}).get("priority") == 0,
      str({k: v.get("priority") for k, v in by_id.items() if k.startswith("p22")}))
s, _, r = call("POST", "/admin/api/providers", token=ADM, body={"id": "p22fb", "priority": 200})
check("priority 200 is rejected with 400", s == 400, f"{s} {str(r)[:120]}")
for pid in ("p22fb", "p22fg"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
s, _, r = call("POST", "/admin/api/groups", token=ADM, body={"key": gkey22, "strategy": "balance"})
check("b21-fail group strategy restored to balance",
      s == 200 and r.get("ok") and r.get("strategy") == "balance", f"{s} {str(r)[:120]}")
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 23: providers segment + per-key down reasons ==")
# One provider, two keys on the fail mock (9105): key A (k-b21fail)
# always 500s b21-fail, key B (k-b21fail-ok) serves it 200 but 500s
# solo-fail like every other key. Tripping A therefore never
# touches B (B succeeds whenever it is tried, which clears its
# transient failures), and B's single failure comes later via
# solo-fail, when A is already breaker-blocked and not tried.
# Two ordering facts matter:
# - Sync lists models with the FIRST key only, so B (the key whose
#   list carries solo-fail) must be keys[0]; A is keys[1].
# - Key ids are assigned k1/k2/... in creation order and are NOT
#   the secret strings: stats rows are "p23:k1"/"p23:k2". Resolve
#   them from GET /admin/api/providers instead of guessing.
# NOTE on the design doc's literal wording: tripping BOTH keys into
# the breaker would make the "recover after ~6s" check impossible
# (breakerUntil is now + 5 min), so B gets exactly ONE transient
# failure (5 s cooldown) instead.
def stats_now():
    s, _, r = call("GET", "/admin/api/stats", token=ADM)
    assert s == 200, (s, str(r)[:120])
    return r
def key_row(st, pid, kid):
    for k in st.get("keys", []):
        if k.get("key") == f"{pid}:{kid}":
            return k
    return None
def prov_seg(st, pid):
    for p in st.get("providers", []):
        if p.get("id") == pid:
            return p
    return None
def hdr(h, name):
    for k, v in h.items():
        if k.lower() == name.lower():
            return v
    return None

call("POST", "/admin/api/reset", token=ADM)
provider("p23", "http://127.0.0.1:9105/v1", ["k-b21fail-ok", "k-b21fail"])
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("GET", "/admin/api/providers", token=ADM)
p23 = next((p for p in r.get("providers", []) if p.get("id") == "p23"), None)
kids = [k.get("id") for k in (p23 or {}).get("keys", [])]
check("p23 has two keys with assigned ids (creation order)",
      len(kids) == 2, str(kids))
key_b, key_a = kids[0], kids[1]
s, _, r = call("GET", "/admin/api/catalog?limit=2000", token=ADM)
have = {(e.get("provider"), e.get("model")) for e in r.get("entries", [])}
check("p23 serves b21-fail and solo-fail",
      ("p23", "b21-fail") in have and ("p23", "solo-fail") in have,
      str(sorted(x for x in have if x[0] == "p23"))[:200])
# Trip key A into the breaker: each pinned chat tries A first about
# half the time (balance draw; B succeeds on retry, so B stays
# clean). After a failure A cools 5 s, so attempts are spaced 6 s
# apart — faster calls would exclude A and record nothing.
tripped = False
ka = None
for _ in range(20):
    s, h, r = chat("p23/b21-fail")
    time.sleep(6)
    ka = key_row(stats_now(), "p23", key_a)
    if ka and ka.get("breakerTripped"):
        tripped = True
        break
check("key A trips into the breaker after repeated 500s", tripped, str(ka)[:160])
# Key B's exactly-one transient failure: A is breaker-blocked now,
# so the pinned solo-fail chat tries only B, which 500s once.
time.sleep(6)
s, h, r = chat("p23/solo-fail")
check("key B fails exactly once (500, no failover pick left)", s >= 500, f"{s} {str(r)[:120]}")
st1 = stats_now()
seg1 = prov_seg(st1, "p23")
ka1 = key_row(st1, "p23", key_a)
kb1 = key_row(st1, "p23", key_b)
check("providers segment shows p23 down with breaker reason",
      seg1 is not None and seg1.get("status") == "down" and seg1.get("downReason") == "breaker"
      and seg1.get("usableKeys") == 0 and seg1.get("totalKeys") == 2, str(seg1)[:200])
check("key A downReason is breaker with downSince set",
      ka1 is not None and ka1.get("downReason") == "breaker" and (ka1.get("downSince") or 0) > 0
      and (ka1.get("transientFails") or 0) >= 3, str(ka1)[:200])
check("key B downReason is cooldown with downSince set (exactly one failure)",
      kb1 is not None and kb1.get("downReason") == "cooldown" and (kb1.get("downSince") or 0) > 0
      and kb1.get("transientFails") == 1, str(kb1)[:200])
st2 = stats_now()
ka2 = key_row(st2, "p23", key_a)
kb2 = key_row(st2, "p23", key_b)
check("downSince is stable across two consecutive stats reads while still down",
      ka2 is not None and kb2 is not None
      and ka2.get("downSince") == (ka1 or {}).get("downSince") and kb2.get("downSince") == (kb1 or {}).get("downSince"),
      f"A {(ka1 or {}).get('downSince')} -> {(ka2 or {}).get('downSince')}; B {(kb1 or {}).get('downSince')} -> {(kb2 or {}).get('downSince')}")
# Cross-check against rankKeys: blockedReason is NOT client-visible
# (the 503 body does not expose it), so check the 503's Retry-After
# instead. NOTE: blockedUntil is the EARLIEST unblock time, so while
# B is merely cooling the 503 says ~5 s (B's cooldown), not ~300 s;
# the ~300 s breaker value is only observable once every key is
# breaker-blocked (asserted at the end of this batch).
s, h, r = chat("p23/b21-fail")
ra = hdr(h, "Retry-After")
check("both keys down: chat is no_capacity with Retry-After ~ B's 5s cooldown",
      s == 503 and r.get("error", {}).get("code") == "no_capacity" and ra is not None and 1 <= int(ra) <= 6,
      f"{s} Retry-After={ra} {str(r)[:120]}")
time.sleep(7)
st3 = stats_now()
seg3 = prov_seg(st3, "p23")
kb3 = key_row(st3, "p23", key_b)
check("after ~6s key B recovers: p23 degraded, usableKeys 1, reason still breaker",
      seg3 is not None and seg3.get("status") == "degraded" and seg3.get("usableKeys") == 1
      and seg3.get("totalKeys") == 2 and seg3.get("downReason") == "breaker", str(seg3)[:200])
check("key B is available again after its cooldown (downReason cleared)",
      kb3 is not None and kb3.get("downReason") is None and (kb3.get("downSince") or 0) == 0, str(kb3)[:200])
# Final cross-check: trip B into the breaker too, then a zero-pick
# chat's Retry-After must be the breaker cooldown (~300 s).
# NOTE: a transient failure also parks the ENDPOINT (model) for
# 30 s (coordinator report(): server/network/timeout/unknown set
# deadUntil = +30 s, longer once consecFails hits the threshold),
# so a solo-fail retry inside that window is a zero-pick 503 that
# records nothing on B. Each attempt therefore retries until the
# stats show B's transientFails actually grew.
def fail_b_once():
    before = (key_row(stats_now(), "p23", key_b) or {}).get("transientFails") or 0
    for _ in range(8):
        s, h, r = chat("p23/solo-fail")
        time.sleep(6)
        after = (key_row(stats_now(), "p23", key_b) or {}).get("transientFails") or 0
        if after > before:
            return True
    return False
check("key B fails a second time (past the 30s endpoint-dead window)", fail_b_once())
check("key B fails a third time (past the 30s endpoint-dead window)", fail_b_once())
kb4 = key_row(stats_now(), "p23", key_b)
check("key B trips into the breaker after two more failures",
      kb4 is not None and kb4.get("breakerTripped"), str(kb4)[:200])
# The 503's Retry-After is the earliest unblock time, which is A's
# breaker end (A tripped first): compare against the live stats
# value instead of a fixed ~300 s, since minutes elapse between
# A's trip and this check.
st5 = stats_now()
ka5 = key_row(st5, "p23", key_a)
exp_ra = None
if ka5 and ka5.get("downUntil"):
    exp_ra = int((ka5["downUntil"] - (st5.get("now") or 0)) / 1000)
s, h, r = chat("p23/b21-fail")
ra = hdr(h, "Retry-After")
check("both keys breaker-blocked: Retry-After is the breaker cooldown",
      s == 503 and r.get("error", {}).get("code") == "no_capacity" and ra is not None
      and exp_ra is not None and abs(int(ra) - exp_ra) <= 5,
      f"{s} Retry-After={ra} expected~{exp_ra} {str(r)[:120]}")
call("DELETE", "/admin/api/providers/p23", token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 24: model mapping + effort suffix (echo mock) ==")
# The echo mock (9135) records every upstream request body in
# GW_ECHO_FILE and answers a valid chat completion, so the body the
# gateway actually sent can be asserted directly. Chats below are
# pinned (p24m/...) where the provider matters and bare where it
# does not (both echo providers serve the same models).
ECHO_FILE = os.environ.get("GW_ECHO_FILE", "/tmp/echo.jsonl")
def echo_clear():
    open(ECHO_FILE, "w").close()
def echo_last():
    try:
        with open(ECHO_FILE) as f:
            lines = [ln for ln in f if ln.strip()]
    except FileNotFoundError:
        return None
    return json.loads(lines[-1]) if lines else None
def recent_any(model):
    # Success rows carry model = the bare catalog name (pick.model)
    # and virtual_model = the requested (pinned) string; match on
    # either so a pinned chat's row is found.
    s, _, r = call("GET", "/admin/api/overview", token=ADM)
    for x in r.get("usage", {}).get("recent", []):
        if x.get("model") == model or x.get("virtual_model") == model:
            return x
    return None
def echo_chat(model):
    # Unpinned: either echo provider may serve, but the body lands
    # in the same echo file either way.
    echo_clear()
    s, h, r = chat(model)
    return s, echo_last()

call("POST", "/admin/api/reset", token=ADM)
MAP24 = {"b24-a": "b24-b", "b24-b": "b24-c", "b24-x": "b24-x", "b24-foo": "b24-foo-upstream"}
provider("p24m", "http://127.0.0.1:9135/v1", ["k-echo"], mapping=MAP24)
provider("p24n", "http://127.0.0.1:9135/v1", ["k-echo"])
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("GET", "/admin/api/providers", token=ADM)
p24m = next((p for p in r.get("providers", []) if p.get("id") == "p24m"), {})
check("modelMapping round-trips through the provider record",
      p24m.get("modelMapping") == MAP24, str(p24m.get("modelMapping"))[:200])
# Chain a -> b -> c: the upstream body carries c, and the response
# header names the upstream model.
echo_clear()
s, h, r = chat("p24m/b24-a")
body = echo_last()
check("mapping chain a->b->c sends upstream model b24-c",
      s == 200 and (body or {}).get("model") == "b24-c", f"{s} {str(body)[:120]}")
check("mapped chat carries x-gw-upstream-model: b24-c",
      hdr(h, "x-gw-upstream-model") == "b24-c", str(hdr(h, "x-gw-upstream-model")))
# Usage is recorded under the catalog name, not the upstream name:
# the row's model is the bare catalog name b24-a (its
# virtual_model is the requested pinned string p24m/b24-a); the
# upstream name b24-c appears in neither.
time.sleep(5)
row = recent_any("p24m/b24-a")
check("usage row records the catalog model, not the upstream name",
      row is not None and row.get("provider") == "p24m" and row.get("model") == "b24-a",
      str(row)[:160])
# Self-map x -> x terminates with no rename: no upstream header.
echo_clear()
s, h, r = chat("p24m/b24-x")
body = echo_last()
check("self-map x->x sends b24-x as-is",
      s == 200 and (body or {}).get("model") == "b24-x", f"{s} {str(body)[:120]}")
check("self-map carries no x-gw-upstream-model header",
      hdr(h, "x-gw-upstream-model") is None, str(hdr(h, "x-gw-upstream-model")))
# Plain rename foo -> foo-upstream.
echo_clear()
s, h, r = chat("p24m/b24-foo")
body = echo_last()
check("plain rename foo->foo-upstream sends the upstream name",
      s == 200 and (body or {}).get("model") == "b24-foo-upstream", f"{s} {str(body)[:120]}")
check("renamed chat carries x-gw-upstream-model: b24-foo-upstream",
      hdr(h, "x-gw-upstream-model") == "b24-foo-upstream", str(hdr(h, "x-gw-upstream-model")))
# Unmapped model on the mapped provider, and a mapped model on the
# provider without a mapping: both go through as-is, no header.
echo_clear()
s, h, r = chat("p24m/echo-ok")
body = echo_last()
check("unmapped model on the mapped provider goes as-is",
      s == 200 and (body or {}).get("model") == "echo-ok", f"{s} {str(body)[:120]}")
check("unmapped chat carries no x-gw-upstream-model header",
      hdr(h, "x-gw-upstream-model") is None, str(hdr(h, "x-gw-upstream-model")))
echo_clear()
s, h, r = chat("p24n/b24-a")
body = echo_last()
check("provider without a mapping sends b24-a as-is",
      s == 200 and (body or {}).get("model") == "b24-a", f"{s} {str(body)[:120]}")
check("mapping-less provider carries no x-gw-upstream-model header",
      hdr(h, "x-gw-upstream-model") is None, str(hdr(h, "x-gw-upstream-model")))
# Mapping validation at save time.
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p24cyc", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "modelMapping": {"m1": "m2", "m2": "m1"}})
msg = r.get("error", {})
msg = msg.get("message", "") if isinstance(msg, dict) else str(msg)
check("cyclic mapping rejected with 400 naming the cycle",
      s == 400 and "m1" in msg and "m2" in msg, f"{s} {msg[:160]}")
s, _, r = call("GET", "/admin/api/providers", token=ADM)
check("cyclic provider was not stored",
      "p24cyc" not in [p.get("id") for p in r.get("providers", [])],
      str([p.get("id") for p in r.get("providers", []) if p.get("id", "").startswith("p24")]))
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p24long", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "modelMapping": {"k" * 121: "b24-c"}})
check("mapping key over 120 chars rejected with 400", s == 400, f"{s} {str(r)[:120]}")
# resolve-mapping endpoint (pure function, no side effects).
s, _, r = call("POST", "/admin/api/providers/resolve-mapping", token=ADM,
               body={"mapping": {"a": "b", "b": "c"}, "model": "a"})
check("resolve-mapping follows the chain a->b->c",
      s == 200 and r.get("ok") is True and r.get("model") == "c" and r.get("mapped") is True
      and r.get("chain") == ["a", "b", "c"], f"{s} {str(r)[:160]}")
s, _, r = call("POST", "/admin/api/providers/resolve-mapping", token=ADM,
               body={"mapping": {"foo": "foo-up"}, "model": "foo:free"})
check("resolve-mapping falls back to the base name (foo:free -> foo-up)",
      s == 200 and r.get("model") == "foo-up" and r.get("mapped") is True, f"{s} {str(r)[:160]}")
s, _, r = call("POST", "/admin/api/providers/resolve-mapping", token=ADM,
               body={"mapping": {"a": "b"}, "model": "z"})
check("resolve-mapping leaves an unmapped model as-is",
      s == 200 and r.get("model") == "z" and r.get("mapped") is False, f"{s} {str(r)[:160]}")
s, _, r = call("POST", "/admin/api/providers/resolve-mapping", token=ADM,
               body={"mapping": {"m1": "m2", "m2": "m1"}, "model": "m1"})
check("resolve-mapping rejects a cyclic mapping with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/providers/resolve-mapping", token=ADM,
               body={"mapping": {"a": "b"}})
check("resolve-mapping rejects a missing model with 400", s == 400, f"{s} {str(r)[:120]}")
# Effort suffixes: the upstream body gets reasoning_effort, or none.
s, b = echo_chat("echo-ok@high")
check("echo-ok@high sends reasoning_effort high",
      s == 200 and (b or {}).get("reasoning_effort") == "high", f"{s} {str(b)[:140]}")
s, b = echo_chat("echo-ok-thinking")
check("echo-ok-thinking sends reasoning_effort medium",
      s == 200 and (b or {}).get("reasoning_effort") == "medium", f"{s} {str(b)[:140]}")
s, b = echo_chat("echo-ok@low")
check("echo-ok@low sends reasoning_effort low",
      s == 200 and (b or {}).get("reasoning_effort") == "low", f"{s} {str(b)[:140]}")
s, b = echo_chat("echo-ok-thinking-low")
check("echo-ok-thinking-low sends reasoning_effort low",
      s == 200 and (b or {}).get("reasoning_effort") == "low", f"{s} {str(b)[:140]}")
s, b = echo_chat("echo-ok")
check("no suffix sends no reasoning_effort field",
      s == 200 and "reasoning_effort" not in (b or {}), f"{s} {str(b)[:140]}")
s, b = echo_chat("echo-ok@none")
check("echo-ok@none sends no reasoning_effort field",
      s == 200 and "reasoning_effort" not in (b or {}), f"{s} {str(b)[:140]}")
for pid in ("p24m", "p24n"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 25: strict session + switch-on-success ==")
# Two providers serve the same model (b21-fail) on the fail mock:
# p25a's key serves it 200 but 500s solo-fail, so the key can be
# tripped into the breaker after the session pins to it; p25b stays
# healthy so the pin has somewhere to move to. The session key
# binds the requested model string, so every chat here uses the
# same bare "b21-fail" (a pinned "p25a/b21-fail" would derive a
# different session). Failover + weight 10/1 makes the first chat
# land on p25a deterministically.
def schat(model, mode=None, session="w3sess"):
    headers = {"x-gw-session": session}
    if mode:
        headers["x-gw-session-mode"] = mode
    return call("POST", "/v1/chat/completions", token=GW, headers=headers,
                body={"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 16})
def b25_rows():
    s, _, r = call("GET", "/admin/api/overview", token=ADM)
    return [x for x in r.get("usage", {}).get("recent", []) if x.get("provider") == "p25b"]

call("POST", "/admin/api/reset", token=ADM)
provider("p25a", "http://127.0.0.1:9105/v1", ["k-b21fail-ok"], weight=10)
provider("p25b", "http://127.0.0.1:9105/v1", ["k-b21fail-ok"], weight=1)
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("GET", "/admin/api/groups", token=ADM)
glist = r.get("groups") or []
g25 = next((g for g in glist if (g.get("id") or "").endswith("b21-fail")), None)
check("b21-fail forms a mapping group over p25a/p25b",
      g25 is not None and set(g25.get("providers") or []) == {"p25a", "p25b"}, str(g25)[:200])
gkey25 = g25["key"] if g25 else "b21-fail"
s, _, r = call("POST", "/admin/api/groups", token=ADM, body={"key": gkey25, "strategy": "failover"})
check("b21-fail group strategy set to failover",
      s == 200 and r.get("ok") and r.get("strategy") == "failover", f"{s} {str(r)[:120]}")
s, h, r = schat("b21-fail")
check("session chat pins to p25a (failover, weight 10 first)",
      s == 200 and h.get("x-gw-provider") == "p25a" and h.get("x-gw-sticky") == "new",
      f"{s} via {h.get('x-gw-provider')} sticky={h.get('x-gw-sticky')}")
s, h, r = schat("b21-fail")
check("second session chat sticks to p25a",
      s == 200 and h.get("x-gw-provider") == "p25a" and h.get("x-gw-sticky") == "hit",
      f"{s} via {h.get('x-gw-provider')} sticky={h.get('x-gw-sticky')}")
# Trip p25a's only key into the breaker via pinned solo-fail chats
# (500 every time). Each landing failure parks the p25a/solo-fail
# endpoint for ~30s, so attempts inside the window record nothing;
# retry until the stats show the breaker (same shape as batch 23).
s, _, r = call("GET", "/admin/api/providers", token=ADM)
p25a = next((p for p in r.get("providers", []) if p.get("id") == "p25a"), None)
key_a25 = ((p25a or {}).get("keys", []) or [{}])[0].get("id")
check("p25a has one key with an assigned id", bool(key_a25), str(p25a)[:160])
tripped25 = False
ka25 = None
for _ in range(25):
    s, h, r = chat("p25a/solo-fail")
    time.sleep(6)
    ka25 = key_row(stats_now(), "p25a", key_a25)
    if ka25 and ka25.get("breakerTripped"):
        tripped25 = True
        break
check("p25a key trips into the breaker after repeated solo-fail 500s", tripped25, str(ka25)[:160])
# Strict: the pinned endpoint is unavailable, so the request must
# fail without silently switching to the healthy provider.
before_b25 = len(b25_rows())
s, h, r = schat("b21-fail", mode="strict")
err = r.get("error", {})
check("strict request with a dead pinned endpoint is 503 strict_session_binding_unavailable",
      s == 503 and err.get("code") == "strict_session_binding_unavailable", f"{s} {str(r)[:160]}")
check("strict failure is not retryable", err.get("retryable") is False, str(err)[:120])
time.sleep(5)
check("strict failure produced no usage row on the healthy provider p25b",
      len(b25_rows()) == before_b25, f"before {before_b25} after {len(b25_rows())}")
# Same condition, prefer: succeeds via p25b, and the pin moves.
s, h, r = schat("b21-fail", mode="prefer")
check("prefer request under the same condition succeeds via p25b",
      s == 200 and h.get("x-gw-provider") == "p25b", f"{s} via {h.get('x-gw-provider')}")
s, h, r = schat("b21-fail")
check("next same-session request is pinned to p25b (switch-on-success)",
      s == 200 and h.get("x-gw-provider") == "p25b" and h.get("x-gw-sticky") == "hit",
      f"{s} via {h.get('x-gw-provider')} sticky={h.get('x-gw-sticky')}")
# session-clear: the pin is gone, so a strict request routes normally.
s, _, r = call("POST", "/admin/api/session-clear", token=ADM, body={"key": "w3sess", "model": "b21-fail"})
check("session-clear removes the pin",
      s == 200 and r.get("ok") is True and r.get("cleared") is True, f"{s} {str(r)[:160]}")
s, _, r = call("POST", "/admin/api/session-clear", token=ADM, body={"key": "w3sess", "model": "b21-fail"})
check("session-clear with no pin reports cleared false",
      s == 200 and r.get("ok") is True and r.get("cleared") is False, f"{s} {str(r)[:160]}")
s, h, r = schat("b21-fail", mode="strict")
check("strict request after session-clear routes normally (200 via p25b)",
      s == 200 and h.get("x-gw-provider") == "p25b", f"{s} via {h.get('x-gw-provider')} {str(r)[:120]}")
for pid in ("p25a", "p25b"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
s, _, r = call("POST", "/admin/api/groups", token=ADM, body={"key": gkey25, "strategy": "balance"})
check("b21-fail group strategy restored to balance",
      s == 200 and r.get("ok") and r.get("strategy") == "balance", f"{s} {str(r)[:120]}")
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 26: param overrides + default strip / allowFields (echo mock) ==")
# Chat-path assertions use the echo mock (9135): it records the body
# the gateway actually sent and answers a valid completion. The sink
# mock cannot serve passthrough here — its /models list is empty, so
# a pinned passthrough call fails the free-model gate with 404 and
# an unpinned one has no catalog entries — so passthrough bodies are
# asserted through the echo mock too (pinned p26pt/p26pto, whose
# live list contains echo-ok).
call("POST", "/admin/api/reset", token=ADM)
provider("p26set", "http://127.0.0.1:9135/v1", ["k-echo"],
         overrides=[{"op": "set", "path": "temperature", "value": 0.42}])
provider("p26del", "http://127.0.0.1:9135/v1", ["k-echo"],
         overrides=[{"op": "delete", "path": "max_tokens"}])
provider("p26move", "http://127.0.0.1:9135/v1", ["k-echo"],
         overrides=[{"op": "move", "path": "messages.0.content", "to": "prompt"}])
provider("p26re", "http://127.0.0.1:9135/v1", ["k-echo"],
         overrides=[{"op": "regex_replace", "path": "messages.0.content", "from": "hi", "to": "hello"}])
provider("p26when", "http://127.0.0.1:9135/v1", ["k-echo"],
         overrides=[{"op": "set", "path": "w_hit", "value": 1,
                     "when": {"path": "messages.0.content", "op": "eq", "value": "hi"}},
                    {"op": "set", "path": "w_miss", "value": 1,
                     "when": {"path": "messages.0.content", "op": "eq", "value": "zzz"}}])
provider("p26ord", "http://127.0.0.1:9135/v1", ["k-echo"], allow=[],
         overrides=[{"op": "set", "path": "service_tier", "value": "flex"}])
provider("p26drop", "http://127.0.0.1:9135/v1", ["k-echo"], drop=["custom_field"],
         overrides=[{"op": "set", "path": "custom_field", "value": "x"}])
provider("p26strip", "http://127.0.0.1:9135/v1", ["k-echo"], allow=[])
provider("p26allow", "http://127.0.0.1:9135/v1", ["k-echo"], allow=["service_tier"])
provider("p26pt", "http://127.0.0.1:9135/v1", ["k-echo"], allow=[])
provider("p26pto", "http://127.0.0.1:9135/v1", ["k-echo"],
         overrides=[{"op": "set", "path": "user", "value": "pt-user"}])
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
s, _, r = call("GET", "/admin/api/providers", token=ADM)
by26 = {p.get("id"): p for p in r.get("providers", [])}
check("paramOverrides round-trip through the provider record",
      by26.get("p26set", {}).get("paramOverrides") == [{"op": "set", "path": "temperature", "value": 0.42}],
      str(by26.get("p26set", {}).get("paramOverrides"))[:160])
check("allowFields round-trips through the provider record",
      by26.get("p26allow", {}).get("allowFields") == ["service_tier"],
      str(by26.get("p26allow", {}).get("allowFields"))[:160])

def echo_pinned(pid, extra=None):
    echo_clear()
    s, h, r = chat(pid + "/echo-ok", extra)
    return s, h, r, echo_last()

s, h, r, body = echo_pinned("p26set")
check("set override adds temperature 0.42",
      s == 200 and (body or {}).get("temperature") == 0.42, f"{s} {str(body)[:140]}")
s, h, r, body = echo_pinned("p26del")
check("delete override removes max_tokens",
      s == 200 and "max_tokens" not in (body or {}), f"{s} {str(body)[:140]}")
s, h, r, body = echo_pinned("p26move")
check("move override relocates messages.0.content to prompt",
      s == 200 and (body or {}).get("prompt") == "hi"
      and "content" not in (body or {}).get("messages", [{}])[0],
      f"{s} {str(body)[:160]}")
s, h, r, body = echo_pinned("p26re")
check("regex_replace rewrites the message content hi -> hello",
      s == 200 and (body or {}).get("messages", [{}])[0].get("content") == "hello",
      f"{s} {str(body)[:160]}")
s, h, r, body = echo_pinned("p26when")
check("when-conditioned rule applies when the condition holds",
      s == 200 and (body or {}).get("w_hit") == 1, f"{s} {str(body)[:160]}")
check("when-conditioned rule is skipped when the condition fails",
      s == 200 and "w_miss" not in (body or {}), f"{s} {str(body)[:160]}")
# Order: default strip runs before overrides, so an override can
# re-add a stripped field; drops run last and always win.
s, h, r, body = echo_pinned("p26ord", {"service_tier": "auto", "safety_identifier": "sid-1"})
check("override re-adding a stripped field wins over the default strip",
      s == 200 and (body or {}).get("service_tier") == "flex", f"{s} {str(body)[:160]}")
check("a stripped field with no override stays stripped",
      s == 200 and "safety_identifier" not in (body or {}), f"{s} {str(body)[:160]}")
s, h, r, body = echo_pinned("p26drop", {"custom_field": "orig"})
check("a field both overridden and in dropParams is absent upstream (drops win)",
      s == 200 and "custom_field" not in (body or {}), f"{s} {str(body)[:160]}")
# Default strip + allowlist.
s, h, r, body = echo_pinned("p26strip", {"service_tier": "flex", "safety_identifier": "sid-1"})
check("allowFields empty strips service_tier and safety_identifier",
      s == 200 and "service_tier" not in (body or {}) and "safety_identifier" not in (body or {}),
      f"{s} {str(body)[:160]}")
s, h, r, body = echo_pinned("p26allow", {"service_tier": "flex", "safety_identifier": "sid-1"})
check("allowFields [service_tier] lets only service_tier through",
      s == 200 and (body or {}).get("service_tier") == "flex" and "safety_identifier" not in (body or {}),
      f"{s} {str(body)[:160]}")
# Validation at save time: illegal rule, >30 rules, auth-header
# override, illegal allowlist value, uncompilable regex.
def err_msg(r):
    e = r.get("error", {})
    return e.get("message", "") if isinstance(e, dict) else str(e)
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p26badop", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "paramOverrides": [{"op": "explode", "path": "x"}]})
check("unknown override op rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p26many", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "paramOverrides": [{"op": "set", "path": "x%d" % i, "value": i} for i in range(31)]})
check("more than 30 override rules rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p26auth", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "paramOverrides": [{"op": "set_header", "path": "authorization", "value": "Bearer x"}]})
check("override touching the authorization header rejected with 400",
      s == 400 and "authorization" in err_msg(r).lower(), f"{s} {err_msg(r)[:160]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p26auth2", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "paramOverrides": [{"op": "delete_header", "path": "x-api-key"}]})
check("override touching the x-api-key header rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p26badallow", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "allowFields": ["store"]})
check("allowFields with a value outside the strip list rejected with 400",
      s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/providers", token=ADM,
               body={"id": "p26badre", "baseUrl": "http://127.0.0.1:9135/v1", "keys": ["k-echo"],
                     "paramOverrides": [{"op": "regex_replace", "path": "messages.0.content", "from": "[", "to": "x"}]})
check("override with an uncompilable regex rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("GET", "/admin/api/providers", token=ADM)
stored26 = {p.get("id") for p in r.get("providers", [])}
check("rejected batch-26 providers were not stored",
      not ({"p26badop", "p26many", "p26auth", "p26auth2", "p26badallow", "p26badre"} & stored26),
      str(sorted(stored26 & {"p26badop", "p26many", "p26auth", "p26auth2", "p26badallow", "p26badre"})))
# Passthrough (JSON path): strip and overrides apply there too.
def pt_echo(model, body_in):
    echo_clear()
    s, h, r = call("POST", "/v1/embeddings", token=GW, body=body_in)
    return s, h, r, echo_last()
s, h, r, body = pt_echo("p26pt/echo-ok",
                        {"model": "p26pt/echo-ok", "input": "hi", "service_tier": "flex", "safety_identifier": "sid-1"})
check("passthrough embeddings with service_tier + safety_identifier sends neither",
      s == 200 and "service_tier" not in (body or {}) and "safety_identifier" not in (body or {}),
      f"{s} {str(body)[:160]}")
s, h, r, body = pt_echo("p26pto/echo-ok", {"model": "p26pto/echo-ok", "input": "hi"})
check("passthrough override applies (set user)",
      s == 200 and (body or {}).get("user") == "pt-user", f"{s} {str(body)[:160]}")
for pid in ("p26set", "p26del", "p26move", "p26re", "p26when", "p26ord", "p26drop",
            "p26strip", "p26allow", "p26pt", "p26pto"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 27: tools round-trip (item 13, HTTP level) ==")
# /v1/messages with tools via the amd mock (OpenAI upstream): the
# mock answers a tools request with one tool_call, so the gateway's
# OpenAI -> Anthropic conversion must surface a tool_use block.
# There is no Gemini-shaped mock, so the x-gw-tools-dropped header
# is covered in b3units instead; here the header must be ABSENT on
# a clean OpenAI-tools round-trip.
call("POST", "/admin/api/reset", token=ADM)
ANT27 = {"anthropic-version": "2023-06-01"}
ANTOOLS = [{"type": "function", "function": {"name": "get_weather", "description": "Get the weather",
           "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]
s, h, r = call("POST", "/v1/messages", token=GW, headers=ANT27,
               body={"model": "amd-ds", "max_tokens": 64,
                     "messages": [{"role": "user", "content": "weather in Paris?"}],
                     "tools": [{"name": "get_weather", "description": "Get the weather",
                                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}}]})
blocks = r.get("content", []) if isinstance(r.get("content"), list) else []
tool_use = next((b for b in blocks if b.get("type") == "tool_use"), None)
check("/v1/messages with tools returns a tool_use block",
      s == 200 and tool_use is not None and tool_use.get("name") == "get_weather",
      f"{s} {str(r)[:200]}")
check("tool_use input carries the mock arguments",
      tool_use is not None and tool_use.get("input") == {"city": "Paris"}, str(tool_use)[:120])
check("no x-gw-tools-dropped header on a clean OpenAI-tools round-trip",
      hdr(h, "x-gw-tools-dropped") is None, str(hdr(h, "x-gw-tools-dropped")))
check("no x-gw-degraded header on a clean OpenAI-tools round-trip",
      hdr(h, "x-gw-degraded") is None, str(hdr(h, "x-gw-degraded")))
s, h, r = chat("amd-ds", {"tools": ANTOOLS})
check("OpenAI chat with tools round-trips 200 without a tools-dropped header",
      s == 200 and hdr(h, "x-gw-tools-dropped") is None, f"{s} {str(hdr(h, 'x-gw-tools-dropped'))}")

print("== batch 28: health probes + auto-ban ==")
# Probe/auto-ban contracts (items 3/4): probe-config + auto-ban
# config endpoints, probe recovery of a tripped breaker (chat and
# list modes, without burning quota), probes tripping a breaker,
# 401 auto-ban + manual unban, and the two not-banned controls.
# NOTE on the design doc's literal probe wording: a probe only ever
# clears the breaker of the key it probes, so the recovery probe
# below targets the same tripped provider (fail mock, solo-ok — the
# mock 200s that model) rather than a different provider's key.
def b28_key_id(pid):
    s, _, r = call("GET", "/admin/api/providers", token=ADM)
    p = next((x for x in r.get("providers", []) if x.get("id") == pid), None)
    kids = (p or {}).get("keys", [])
    return (kids[0].get("id") if kids else None)

call("POST", "/admin/api/reset", token=ADM)
# -- probe-config: defaults, partial update, validation, restore
s, _, r = call("GET", "/admin/api/probe-config", token=ADM)
check("GET probe-config returns the defaults (enabled, 15 min)",
      s == 200 and r.get("enabled") is True and r.get("intervalMin") == 15, f"{s} {str(r)[:160]}")
s, _, r = call("PUT", "/admin/api/probe-config", token=ADM, body={"intervalMin": 30})
check("PUT probe-config partial update sets the interval",
      s == 200 and r.get("intervalMin") == 30 and r.get("enabled") is True, f"{s} {str(r)[:160]}")
s, _, r = call("GET", "/admin/api/probe-config", token=ADM)
check("GET probe-config shows the stored interval",
      s == 200 and r.get("intervalMin") == 30 and r.get("enabled") is True, f"{s} {str(r)[:160]}")
s, _, r = call("PUT", "/admin/api/probe-config", token=ADM, body={"enabled": "yes"})
check("PUT probe-config rejects a non-boolean enabled with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("PUT", "/admin/api/probe-config", token=ADM, body={"intervalMin": 45})
check("PUT probe-config rejects intervalMin 45 with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("PUT", "/admin/api/probe-config", token=ADM, body={"enabled": False, "intervalMin": 60})
check("PUT probe-config sets enabled false + interval 60",
      s == 200 and r.get("enabled") is False and r.get("intervalMin") == 60, f"{s} {str(r)[:160]}")
s, _, r = call("PUT", "/admin/api/probe-config", token=ADM, body={"enabled": True})
check("PUT probe-config partial update preserves the interval",
      s == 200 and r.get("enabled") is True and r.get("intervalMin") == 60, f"{s} {str(r)[:160]}")
s, _, r = call("PUT", "/admin/api/probe-config", token=ADM, body={"enabled": True, "intervalMin": 15})
check("PUT probe-config restores the defaults",
      s == 200 and r.get("enabled") is True and r.get("intervalMin") == 15, f"{s} {str(r)[:160]}")
# -- auto-ban config: defaults, round-trip, validation, restore
s, _, r = call("GET", "/admin/api/auto-ban", token=ADM)
check("GET auto-ban returns the defaults (on, 401, quota keywords)",
      s == 200 and r.get("enabled") is True and r.get("statusCodes") == [401]
      and "credit balance is too low" in (r.get("keywords") or []), f"{s} {str(r)[:200]}")
s, _, r = call("PUT", "/admin/api/auto-ban", token=ADM,
               body={"enabled": True, "statusCodes": [401, 402], "keywords": ["quota"]})
check("PUT auto-ban with valid rules succeeds and echoes them",
      s == 200 and r.get("enabled") is True and r.get("statusCodes") == [401, 402]
      and r.get("keywords") == ["quota"], f"{s} {str(r)[:160]}")
s, _, r = call("GET", "/admin/api/auto-ban", token=ADM)
check("GET auto-ban shows the stored rules",
      s == 200 and r.get("statusCodes") == [401, 402] and r.get("keywords") == ["quota"],
      f"{s} {str(r)[:160]}")
s, _, r = call("PUT", "/admin/api/auto-ban", token=ADM, body={"statusCodes": ["x"]})
check("PUT auto-ban rejects a non-numeric status code with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("PUT", "/admin/api/auto-ban", token=ADM, body={"keywords": ["k%d" % i for i in range(11)]})
check("PUT auto-ban rejects more than 10 keywords with 400", s == 400, f"{s} {str(r)[:120]}")
BAN_DEFAULTS = ["credit balance is too low", "exceeded your current quota", "insufficient"]
s, _, r = call("PUT", "/admin/api/auto-ban", token=ADM,
               body={"enabled": True, "statusCodes": [401], "keywords": BAN_DEFAULTS})
check("PUT auto-ban restores the defaults",
      s == 200 and r.get("enabled") is True and r.get("statusCodes") == [401]
      and r.get("keywords") == BAN_DEFAULTS, f"{s} {str(r)[:160]}")

provider("p28f", "http://127.0.0.1:9105/v1", ["k-fail"])
provider("p28a", "http://127.0.0.1:9105/v1", ["k-auth"])
provider("p28flt", "http://127.0.0.1:9131", ["k-flt"])
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
k28f = b28_key_id("p28f")
k28a = b28_key_id("p28a")
k28flt = b28_key_id("p28flt")
check("batch-28 providers have assigned key ids", bool(k28f and k28a and k28flt), f"{k28f} {k28a} {k28flt}")

# Trip p28f's key into the breaker with pinned solo-fail chats.
# Each landing failure parks the endpoint for ~30 s, so attempts
# inside the window are zero-pick 503s that record nothing; retry
# until the stats show the breaker (batch 23's shape).
tripped28 = False
ka28 = None
for _ in range(25):
    s, h, r = chat("p28f/solo-fail")
    time.sleep(6)
    ka28 = key_row(stats_now(), "p28f", k28f)
    if ka28 and ka28.get("breakerTripped"):
        tripped28 = True
        break
check("p28f key trips into the breaker after repeated 500s", tripped28, str(ka28)[:200])
check("a 500-tripped key is NOT auto-banned (control)",
      ka28 is not None and not ka28.get("banned") and ka28.get("downReason") == "breaker", str(ka28)[:200])
d28_0 = (ka28 or {}).get("dayCount") or 0
# A chat-mode probe against the same provider (solo-ok 200s on the
# fail mock) recovers it: breaker cleared, probe fields set, and the
# probe itself did not burn quota.
s, _, r = call("POST", "/admin/api/probe", token=ADM, body={"provider": "p28f", "model": "solo-ok", "mode": "chat"})
check("chat probe succeeds and reports the cleared breaker",
      s == 200 and r.get("ok") is True and r.get("mode") == "chat" and "breaker" in (r.get("cleared") or [])
      and "solo-ok" in (r.get("sentBody") or ""), f"{s} {str(r)[:200]}")
kp28 = key_row(stats_now(), "p28f", k28f)
check("probe success clears the breaker in /stats",
      kp28 is not None and not kp28.get("breakerTripped"), str(kp28)[:200])
check("probe fields are recorded (probeAt, probeOk, latency, probeFails 0)",
      kp28 is not None and (kp28.get("probeAt") or 0) > 0 and kp28.get("probeOk") is True
      and (kp28.get("probeLatencyMs") or 0) >= 0 and kp28.get("probeFails") == 0, str(kp28)[:200])
check("probe did not increase dayCount",
      kp28 is not None and kp28.get("dayCount") == d28_0, f"{d28_0} -> {kp28.get('dayCount') if kp28 else None}")
s, h, r = chat("p28f/solo-ok")
check("chat succeeds immediately after the probe (no 5-min wait)", s == 200, f"{s} {str(r)[:120]}")
# Reverse: three chat probes against the failing model trip the
# breaker again (probe failures count toward it, like real ones).
for _ in range(3):
    s, _, r = call("POST", "/admin/api/probe", token=ADM, body={"provider": "p28f", "model": "solo-fail", "mode": "chat"})
    check("failing chat probe reports ok false, kind server",
          s == 200 and r.get("ok") is False and r.get("kind") == "server", f"{s} {str(r)[:160]}")
    time.sleep(6)
kp28b = key_row(stats_now(), "p28f", k28f)
check("three failing probes trip the breaker",
      kp28b is not None and kp28b.get("breakerTripped"), str(kp28b)[:200])
check("three failing probes are counted (probeFails 3, probeOk false)",
      kp28b is not None and kp28b.get("probeFails") == 3 and kp28b.get("probeOk") is False, str(kp28b)[:200])
# A list-mode probe success clears it too (zero token cost).
s, _, r = call("POST", "/admin/api/probe", token=ADM, body={"provider": "p28f", "model": "solo-ok", "mode": "list"})
check("list probe succeeds and reports the cleared breaker",
      s == 200 and r.get("ok") is True and r.get("mode") == "list" and "breaker" in (r.get("cleared") or [])
      and r.get("sentBody") == "", f"{s} {str(r)[:200]}")
kp28c = key_row(stats_now(), "p28f", k28f)
check("list probe success clears the breaker in /stats",
      kp28c is not None and not kp28c.get("breakerTripped") and kp28c.get("probeOk") is True
      and kp28c.get("probeFails") == 0, str(kp28c)[:200])
s, h, r = chat("p28f/solo-ok")
check("chat succeeds immediately after the list probe", s == 200, f"{s} {str(r)[:120]}")
# A probe for an unknown provider / without a model in chat mode is
# a 400, not a 500.
s, _, r = call("POST", "/admin/api/probe", token=ADM, body={"provider": "p28-nope", "model": "solo-ok", "mode": "chat"})
check("probe of an unknown provider is 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/probe", token=ADM, body={"provider": "p28f", "mode": "chat"})
check("chat probe without a model is 400", s == 400, f"{s} {str(r)[:120]}")

# Auto-ban behaviour: one 401 bans the key; the next chat is a
# zero-pick no_capacity with no new upstream attempt; manual unban
# restores it. (The ban report rides on ctx.waitUntil, so poll for
# the ban to land in /stats instead of assuming it is immediate.)
s, _, r = chat("p28a/auth-fail")
err = r.get("error", {})
check("401 chat surfaces as upstream_auth 503",
      s == 503 and err.get("code") == "upstream_auth", f"{s} {str(r)[:160]}")
banned28 = None
for _ in range(15):
    banned28 = key_row(stats_now(), "p28a", k28a)
    if banned28 and banned28.get("banned") == "auto":
        break
    time.sleep(1)
check("one 401 auto-bans the key (banned auto, reason 401, downReason key_banned)",
      banned28 is not None and banned28.get("banned") == "auto" and banned28.get("banReason") == "401"
      and banned28.get("downReason") == "key_banned", str(banned28)[:200])
before28 = ((banned28 or {}).get("transientFails"), (banned28 or {}).get("dayCount"), (banned28 or {}).get("probeFails"))
s, h, r = chat("p28a/auth-fail")
err = r.get("error", {})
check("banned key chat is no_capacity with no attempts header",
      s == 503 and err.get("code") == "no_capacity" and h.get("x-gw-attempts") in (None, "0"),
      f"{s} att={h.get('x-gw-attempts')} {str(r)[:140]}")
time.sleep(2)
after28 = key_row(stats_now(), "p28a", k28a)
check("banned key chat made no new upstream attempt (key stats unchanged)",
      after28 is not None
      and (after28.get("transientFails"), after28.get("dayCount"), after28.get("probeFails")) == before28,
      f"{before28} -> {((after28 or {}).get('transientFails'), (after28 or {}).get('dayCount'), (after28 or {}).get('probeFails'))}")
s, _, r = call("POST", "/admin/api/unban", token=ADM, body={"provider": "p28a", "keyId": k28a})
check("manual unban reports cleared true",
      s == 200 and r.get("ok") is True and r.get("cleared") is True, f"{s} {str(r)[:160]}")
ub28 = key_row(stats_now(), "p28a", k28a)
check("unbanned key shows no ban in /stats",
      ub28 is not None and not ub28.get("banned") and ub28.get("downReason") is None, str(ub28)[:200])
s, h, r = chat("p28a/auth-ok")
check("chat succeeds after manual unban", s == 200, f"{s} {str(r)[:120]}")
s, _, r = call("POST", "/admin/api/unban", token=ADM, body={"provider": "p28a", "keyId": k28a})
check("unban with no ban reports cleared false",
      s == 200 and r.get("ok") is True and r.get("cleared") is False, f"{s} {str(r)[:160]}")
s, _, r = call("POST", "/admin/api/unban", token=ADM, body={"provider": "p28a"})
check("unban without keyId is 400", s == 400, f"{s} {str(r)[:120]}")
# A content_filter rejection does NOT ban (control).
s, _, r = chat("p28flt/filter-1")
check("content_filter surfaces as a 400", s == 400 and r.get("error", {}).get("code") == "content_filter",
      f"{s} {str(r)[:140]}")
time.sleep(3)
flt28 = key_row(stats_now(), "p28flt", k28flt)
check("content_filter key is NOT auto-banned (control)",
      flt28 is not None and not flt28.get("banned"), str(flt28)[:200])
# probe-all: async; poll for a never-probed key (p28flt's) to gain
# a probeAt, which proves the patrol actually ran.
flt_before = (flt28 or {}).get("probeAt")
s, _, r = call("POST", "/admin/api/probe-all", token=ADM, body={})
check("probe-all accepts and reports started true",
      s == 200 and r.get("started") is True, f"{s} {str(r)[:160]}")
probed28 = False
for _ in range(40):
    time.sleep(1)
    row = key_row(stats_now(), "p28flt", k28flt)
    if row and row.get("probeAt"):
        probed28 = True
        break
check("probe-all patrol probed the never-probed filter key",
      probed28 and flt_before is None, f"before={flt_before}")
for pid in ("p28f", "p28a", "p28flt"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print("== batch 29: split timeouts (item 12) ==")
# Per-provider timeout overrides. The contract ranges are header
# 5–300 s, idle 10–600 s, streamMax 60–3600 s, so the behaviour
# tests run at the in-range minimums (5000 / 10000 / 60000 ms)
# against the probe mock's slow models (slow-json10: 10 s delayed
# 200; slow-drip: one chunk then 20 s silence; slow-endless: a
# 1 chunk/s drip that never ends). The design doc's shorthand
# values (1000 / 1000 / 3000 ms) are below those minimums and the
# save rejects them — the range checks below pin that down.
# Raw-SSE reader: call() only parses JSON, and a mid-stream abort
# surfaces as an IncompleteRead, not a clean body. http.client's
# read() also blocks trying to fill its buffer on a slow drip, so
# the reader works on a raw socket: recv returns as data arrives,
# EOF / a read timeout without [DONE] means the stream broke.
# Structured SSE error events are item 11 (a later wave), so the
# idle/stream-max breaks are asserted as truncation + timing, not
# as an event. Returns (status, text, elapsed, done, note).
import socket as _sock
def raw_sse(path, payload, timeout=30):
    t0 = time.time()
    raw = json.dumps(payload)
    req = ("POST %s HTTP/1.1\r\nhost: 127.0.0.1:%d\r\n"
           f"authorization: Bearer {GW}\r\ncontent-type: application/json\r\n"
           "content-length: %d\r\nconnection: close\r\n\r\n%s") % (path, GW_PORT, len(raw), raw)
    s = _sock.create_connection(("127.0.0.1", GW_PORT), timeout=timeout)
    s.settimeout(timeout)
    buf = b""
    status = None
    try:
        s.sendall(req.encode())
        while True:
            # Overall deadline: a steady drip resets the per-recv timeout
            # forever (each recv returns data), so bound the total read
            # here; otherwise an endless stream hangs the caller thread.
            if time.time() - t0 > timeout:
                return status, buf.decode("utf-8", "replace"), time.time() - t0, False, "deadline"
            try:
                part = s.recv(65536)
            except _sock.timeout:
                return status, buf.decode("utf-8", "replace"), time.time() - t0, False, "read-timeout"
            if not part:
                return status, buf.decode("utf-8", "replace"), time.time() - t0, False, "eof"
            buf += part
            if status is None:
                m = re.search(rb"HTTP/1\.1 (\d+)", buf)
                if m:
                    status = int(m.group(1))
            if b"[DONE]" in buf:
                return status, buf.decode("utf-8", "replace"), time.time() - t0, True, ""
    finally:
        s.close()
def chat_sse(model, timeout=30):
    return raw_sse("/v1/chat/completions",
                   {"model": model, "messages": [{"role": "user", "content": "hi"}],
                    "max_tokens": 16, "stream": True}, timeout)
def pt_sse(model, timeout=90):
    return raw_sse("/v1/completions", {"model": model, "prompt": "hi", "stream": True}, timeout)

call("POST", "/admin/api/reset", token=ADM)
# -- range validation at save time (and the minimums round-trip)
def b29_save(pid, **kw):
    body = {"id": pid, "baseUrl": "http://127.0.0.1:9143", "keys": ["k-slow"]}
    body.update(kw)
    return call("POST", "/admin/api/providers", token=ADM, body=body)
s, _, r = b29_save("p29rng", headerTimeoutMs=4999)
check("headerTimeoutMs 4999 ms (below 5 s) is rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = b29_save("p29rng", idleTimeoutMs=9999)
check("idleTimeoutMs 9999 ms (below 10 s) is rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = b29_save("p29rng", streamMaxMs=59999)
check("streamMaxMs 59999 ms (below 60 s) is rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = b29_save("p29rng", headerTimeoutMs=300001)
check("headerTimeoutMs above 300 s is rejected with 400", s == 400, f"{s} {str(r)[:120]}")
s, _, r = b29_save("p29rng", headerTimeoutMs=5000, idleTimeoutMs=10000, streamMaxMs=60000)
check("timeout minimums (5000/10000/60000) save", s == 200, f"{s} {str(r)[:120]}")
s, _, r = call("GET", "/admin/api/providers", token=ADM)
p29rng = next((p for p in r.get("providers", []) if p.get("id") == "p29rng"), {})
check("timeout fields round-trip through the provider record",
      p29rng.get("headerTimeoutMs") == 5000 and p29rng.get("idleTimeoutMs") == 10000
      and p29rng.get("streamMaxMs") == 60000, str(p29rng)[:200])
# Explicit null clears a timeout back to inherit (a blank console
# input sends null in edit mode); an omitted field keeps the stored
# value, so null must be distinguishable from absent.
s, _, r = b29_save("p29rng", headerTimeoutMs=None, idleTimeoutMs=None, streamMaxMs=None)
check("explicit null timeouts save (clear)", s == 200, f"{s} {str(r)[:120]}")
s, _, r = call("GET", "/admin/api/providers", token=ADM)
p29rng = next((p for p in r.get("providers", []) if p.get("id") == "p29rng"), {})
check("cleared timeouts are absent from the stored record (inherit)",
      "headerTimeoutMs" not in p29rng and "idleTimeoutMs" not in p29rng
      and "streamMaxMs" not in p29rng, str(p29rng)[:200])
call("DELETE", "/admin/api/providers/p29rng", token=ADM)
# -- header timeout: slow-json10 answers after 10 s; a 5 s header
# budget must fail fast with upstream_timeout.
provider("p29h", "http://127.0.0.1:9143", ["k-slow"], headerTimeoutMs=5000)
provider("p29i", "http://127.0.0.1:9143", ["k-slow"], idleTimeoutMs=10000)
provider("p29m", "http://127.0.0.1:9143", ["k-slow"], streamMaxMs=60000)
provider("p29c", "http://127.0.0.1:9143", ["k-slow"], streamMaxMs=60000)
call("POST", "/admin/api/sync", token=ADM, body={})
call("POST", "/admin/api/sync", token=ADM, body={})
t0 = time.time()
s, _, r = chat("p29h/slow-json10")
el = time.time() - t0
err = r.get("error", {})
check("5 s header timeout fails fast on a 10 s upstream (upstream_timeout)",
      s in (500, 502, 503, 504) and err.get("code") == "upstream_timeout" and 4.0 <= el < 9.0,
      f"{s} elapsed={el:.2f}s {str(err)[:140]}")
# -- idle timeout: slow-drip sends one chunk then stays silent for
# 20 s; a 10 s idle budget must break the stream mid-silence.
st, text, el, done, note = chat_sse("p29i/slow-drip", timeout=30)
chunks = text.count("data:")
check("10 s idle timeout breaks a 20 s silent stream (no [DONE], ~10 s)",
      st == 200 and not done and "[DONE]" not in text and chunks >= 1 and 9.0 <= el < 16.0,
      f"status={st} elapsed={el:.2f}s chunks={chunks} done={done} {note} {text[:120]}")
# -- stream max: slow-endless drips forever, so only the 60 s cap
# can end it. The passthrough pump tears the stream down at the
# cap (chat-path settlement only caps its own wait — see the report
# note — so the behaviour is asserted on the passthrough path).
# The chat path is read concurrently as an observation: it must
# still be flowing past the cap (logged, not asserted) — the
# 75 s reader deadline, not the 60 s cap, ends the observation.
import threading as _th
pt_res = {}
chat_res = {}
def _pt_stream_max():
    pt_res.update(zip(("status", "text", "elapsed", "done", "note"),
                      pt_sse("p29m/slow-endless", timeout=90)))
def _chat_stream_max():
    chat_res.update(zip(("status", "text", "elapsed", "done", "note"),
                        chat_sse("p29c/slow-endless", timeout=75)))
t_pt = _th.Thread(target=_pt_stream_max)
t_chat = _th.Thread(target=_chat_stream_max)
t_pt.start()
t_chat.start()
t_pt.join(timeout=100)
t_chat.join(timeout=100)
pt_chunks = (pt_res.get("text") or "").count("data:")
check("60 s streamMax ends the passthrough endless drip (no [DONE], ~60 s)",
      pt_res.get("status") == 200 and not pt_res.get("done") and "[DONE]" not in (pt_res.get("text") or "")
      and pt_chunks >= 1 and 55.0 <= (pt_res.get("elapsed") or 0) < 75.0,
      f"status={pt_res.get('status')} elapsed={pt_res.get('elapsed')} chunks={pt_chunks} done={pt_res.get('done')} note={pt_res.get('note')}")
chat_chunks = (chat_res.get("text") or "").count("data:")
check("60 s streamMax ends the chat endless drip too (no [DONE], ~60 s)",
      chat_res.get("status") == 200 and not chat_res.get("done") and "[DONE]" not in (chat_res.get("text") or "")
      and chat_chunks >= 1 and 55.0 <= (chat_res.get("elapsed") or 0) < 75.0,
      f"status={chat_res.get('status')} elapsed={chat_res.get('elapsed')} chunks={chat_chunks} done={chat_res.get('done')} note={chat_res.get('note')}")
for pid in ("p29h", "p29i", "p29m", "p29c"):
    call("DELETE", "/admin/api/providers/" + pid, token=ADM)
call("POST", "/admin/api/sync", token=ADM, body={})

print(f"\nRESULT: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
