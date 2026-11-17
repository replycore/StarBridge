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
s, _, r = call("POST", "/admin/api/sync", token=ADM, body={})
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

print("== param drop (thinking) ==")
s, h, r = chat("amd-ds", {"thinking": {"type": "enabled", "budget_tokens": 1024}})
check("first thinking call 200 via same-pick retry", s == 200, str(r)[:160])
check("x-gw-dropped-params reports thinking", h.get("x-gw-dropped-params") == "thinking", str(h.get("x-gw-dropped-params")))
check("attempts >= 2", int(h.get("x-gw-attempts", "0")) >= 2, h.get("x-gw-attempts"))
s, _, r = chat("amd-ds", {"thinking": {"type": "enabled"}})
check("second thinking call 200 (learned drop)", s == 200, str(s))

print("== context-aware routing ==")
call("POST", "/admin/api/groups", token=ADM, body={"id": "ctx-shared", "strategy": "failover"})
long_msg = "x" * 2000
s, h, r = chat("ctx-shared", {"messages": [{"role": "user", "content": long_msg}]})
check("long request fails over to the big-limit provider", s == 200 and h.get("x-gw-provider") == "pl", f"{s} via {h.get('x-gw-provider')}")
s, h, r = chat("ctx-shared")
check("short request sticks to failover-first provider ps", s == 200 and h.get("x-gw-provider") == "ps", f"{s} via {h.get('x-gw-provider')}")

print("== custom models ==")
s, _, r = call("POST", "/admin/api/groups/custom", token=ADM, body={"id": "reg-custom", "keywords": ["solo-ok"]})
check("custom model created, matched 1", s == 200 and r.get("matched") == 1, str(r)[:120])
s, _, r = chat("reg-custom")
check("custom model routes", s == 200, str(s))
s, _, r = call("DELETE", "/admin/api/groups/custom?id=reg-custom", token=ADM)
check("custom model deleted", s == 200 and r.get("ok"), str(r)[:120])
s, _, _ = chat("reg-custom")
check("deleted custom model 404s", s == 404, str(s))

print("== anthropic path ==")
s, _, r = call("POST", "/v1/messages", token=GW, headers={"anthropic-version": "2023-06-01"},
               body={"model": "solo-ok", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]})
check("anthropic messages 200 + shape", s == 200 and r.get("type") == "message", str(r)[:160])

print(f"\nRESULT: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
