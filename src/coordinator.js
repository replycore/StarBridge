import { __name } from "./helpers.js";
import { json, nextUtcMidnight, truncate, utcDay } from "./util.js";

export var DAY_MS = 864e5;
export function defaultKeyState(day, dayLimit = 0, rpm = 0) {
  return {
    cooldownUntil: 0,
    day,
    dayCount: 0,
    dayLimit,
    rpm,
    invalid: false,
    fails: 0,
    transientFails: 0,
    breakerUntil: 0,
    lastUsed: 0
  };
}
// Failure kinds that mean "this upstream endpoint is unhealthy" (as
// opposed to a problem with the request or the account). Only these
// count towards the circuit breaker.
export var TRANSIENT_KINDS = ["server", "network", "timeout", "unknown"];
__name(defaultKeyState, "defaultKeyState");
export var Coordinator = class {
  state;
  env;
  keys = /* @__PURE__ */ new Map();
  models = /* @__PURE__ */ new Map();
  authClients = /* @__PURE__ */ new Map();
  drops = /* @__PURE__ */ new Map();
  rpmWindow = /* @__PURE__ */ new Map();
  dirty = /* @__PURE__ */ new Set();
  loaded = false;
  alarmChecked = false;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    state.blockConcurrencyWhile(async () => {
      await this.ensureLoaded();
    });
  }
  async ensureLoaded() {
    if (this.loaded)
      return;
    const entries = await this.state.storage.list({ limit: 2e4 });
    for (const [k, v] of entries) {
      if (k.startsWith("k:"))
        this.keys.set(k.slice(2), v);
      else if (k.startsWith("m:"))
        this.models.set(k.slice(2), v);
      else if (k.startsWith("a:"))
        this.authClients.set(k.slice(2), v);
      else if (k.startsWith("d:"))
        this.drops.set(k.slice(2), new Set(v));
    }
    this.loaded = true;
  }
  async fetch(request) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/order":
          return this.json(await this.order(await request.json()));
        case "/report":
          await this.report(await request.json());
          return this.json({ ok: true });
        case "/stats":
          return this.json(this.stats());
        case "/dead":
          return this.json({ dead: this.deadKeys() });
        case "/reset":
          await this.reset();
          return this.json({ ok: true });
        case "/session-get":
          return this.json(await this.sessionGet(await request.json()));
        case "/session-put":
          await this.sessionPut(await request.json());
          return this.json({ ok: true });
        case "/auth-check":
          return this.json(await this.authCheck(await request.json()));
        case "/auth-fail":
          return this.json(await this.authFail(await request.json()));
        case "/auth-ok":
          return this.json(await this.authOk(await request.json()));
        default:
          return this.json({ error: "unknown route" }, 404);
      }
    } catch (e) {
      console.error("[coordinator]", e);
      return this.json({ error: String(e) }, 500);
    }
  }
  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" }
    });
  }
  // ------------------------------ 配置 -----------------------------------
  breakerCfg() {
    const t = Math.floor(Number(this.env.BREAKER_THRESHOLD));
    const c = Math.floor(Number(this.env.BREAKER_COOLDOWN_MS));
    return {
      threshold: Number.isFinite(t) ? Math.min(20, Math.max(2, t)) : 3,
      cooldownMs: Number.isFinite(c) ? Math.min(36e5, Math.max(1e3, c)) : 3e5
    };
  }
  authCfg() {
    const m = Math.floor(Number(this.env.ADMIN_AUTH_MAX_FAILS));
    const l = Math.floor(Number(this.env.ADMIN_AUTH_LOCKOUT_MS));
    return {
      maxFails: Number.isFinite(m) ? Math.min(100, Math.max(3, m)) : 10,
      lockoutMs: Number.isFinite(l) ? Math.min(864e5, Math.max(1e3, l)) : 9e5
    };
  }
  // --------------------- 管理接口鉴权限速 ---------------------
  // Per-client-IP state, persisted in DO storage ("a:" prefix). A
  // successful admin login clears the counter; reaching maxFails
  // consecutive failures locks the client out for lockoutMs. An
  // expired lock resets the counter lazily on the next check.
  authStateFor(client, now) {
    let st = this.authClients.get(client);
    if (!st) {
      st = { fails: 0, lockedUntil: 0, lastFailAt: 0 };
      this.authClients.set(client, st);
    }
    if (st.lockedUntil && st.lockedUntil <= now) {
      st.fails = 0;
      st.lockedUntil = 0;
      this.dirty.add(`a:${client}`);
    }
    return st;
  }
  authView(st, now) {
    const locked = (st.lockedUntil ?? 0) > now;
    return {
      locked,
      fails: st.fails ?? 0,
      retryAfterMs: locked ? st.lockedUntil - now : 0
    };
  }
  async authCheck(body) {
    await this.ensureLoaded();
    const now = Date.now();
    const st = this.authStateFor(String(body.client ?? "unknown"), now);
    if (this.dirty.size)
      await this.flush();
    return this.authView(st, now);
  }
  async authFail(body) {
    await this.ensureLoaded();
    const now = Date.now();
    const client = String(body.client ?? "unknown");
    const st = this.authStateFor(client, now);
    if (st.lockedUntil > now)
      return this.authView(st, now);
    st.fails = (st.fails ?? 0) + 1;
    st.lastFailAt = now;
    if (st.fails >= this.authCfg().maxFails)
      st.lockedUntil = now + this.authCfg().lockoutMs;
    this.dirty.add(`a:${client}`);
    await this.flush();
    return this.authView(st, now);
  }
  async authOk(body) {
    await this.ensureLoaded();
    const client = String(body.client ?? "unknown");
    if (this.authClients.has(client)) {
      this.authClients.delete(client);
      this.dirty.delete(`a:${client}`);
      await this.state.storage.delete(`a:${client}`);
    }
    return { locked: false, fails: 0, retryAfterMs: 0 };
  }
  // ------------------------------ 排序 -----------------------------------
  async order(input) {
    await this.ensureLoaded();
    const now = Date.now();
    const day = input.day ?? utcDay(now);
    const drops = {};
    for (const p of input.providers) {
      const s = this.drops.get(p.id);
      if (s?.size)
        drops[p.id] = [...s];
    }
    const pool = [];
    const seen = /* @__PURE__ */ new Set();
    // When no candidate can serve, report when the earliest one frees up
    // (and why), so the Worker can answer 503 with a useful Retry-After
    // instead of a generic quota hint.
    let blockedUntil = Infinity, blockedReason = null;
    for (const c of input.candidates) {
      const provider = input.providers.find((p) => p.id === c.provider);
      if (!provider)
        continue;
      const mkey = `${c.provider}/${c.model}`;
      const ms = this.models.get(mkey);
      let modelUntil = 0, modelReason = null;
      if (ms) {
        if (ms.deadUntil > now) { modelUntil = ms.deadUntil; modelReason = "model_dead"; }
        if ((ms.pauseUntil ?? 0) > now && (ms.pauseUntil ?? 0) > modelUntil) { modelUntil = ms.pauseUntil; modelReason = "model_paused"; }
      }
      const rk = this.rankKeys(provider, day, now);
      const keyUntil = rk.keys.length ? 0 : rk.blockedUntil;
      const candUntil = Math.max(modelUntil, keyUntil);
      if (candUntil > now) {
        const candReason = modelUntil >= keyUntil ? modelReason : rk.blockedReason;
        if (candUntil < blockedUntil || (candUntil === blockedUntil && blockedReason === null)) { blockedUntil = candUntil; blockedReason = candReason; }
        if (blockedReason === null) blockedReason = candReason;
        continue;
      }
      const ranked = rk.keys;
      const okRate = ms ? (ms.ok + 1) / (ms.ok + ms.fail + 2) : 0.55;
      const latFactor = ms && ms.emaMs > 0 ? 1 / (1 + ms.emaMs / 5e3) : 1;
      for (const k of ranked) {
        const id = `${c.provider}|${c.model}|${k.id}`;
        if (seen.has(id))
          continue;
        seen.add(id);
        const w = Math.max(
          1e-3,
          c.weight * (provider.weight || 1) * okRate * latFactor * (0.3 + 0.7 * k.quotaRatio) / (1 + k.state.fails * 0.4)
        );
        pool.push({ pick: { provider: c.provider, model: c.model, keyId: k.id }, w });
      }
    }
    // Per-group routing strategy (set via /admin/api/groups):
    // - "failover": deterministic priority order — highest weight first
    //   (weight already folds in provider weight, health, latency, quota),
    //   stable tie-break, no randomness and no interleaving, so traffic
    //   sticks to the best endpoint until it actually fails.
    // - "balance" (default): weighted random sampling without replacement
    //   + interleave by model, spreading traffic across endpoints.
    const strategy = input.strategy === "failover" ? "failover" : "balance";
    let picks;
    if (strategy === "failover") {
      picks = pool.slice().sort((a, b) => {
        if (b.w !== a.w)
          return b.w - a.w;
        if (a.pick.provider !== b.pick.provider)
          return a.pick.provider < b.pick.provider ? -1 : 1;
        if (a.pick.model !== b.pick.model)
          return a.pick.model < b.pick.model ? -1 : 1;
        return a.pick.keyId < b.pick.keyId ? -1 : 1;
      }).slice(0, input.limit).map((x) => x.pick);
    } else {
      picks = interleaveByModel(weightedSample(pool, input.limit));
    }
    if (this.dirty.size) {
      try {
        await this.flush();
      } catch (e) {
        console.error("[coordinator] order flush failed", e);
      }
    }
    return {
      picks, drops, day, strategy,
      blockedUntil: !picks.length && blockedUntil !== Infinity ? blockedUntil : null,
      blockedReason: !picks.length ? blockedReason : null
    };
  }
  rankKeys(provider, day, now) {
    const out = [];
    let blockedUntil = Infinity, blockedReason = null;
    const note = (until, reason) => {
      if (until < blockedUntil || (until === blockedUntil && blockedReason === null)) { blockedUntil = until; blockedReason = reason; }
      if (blockedReason === null) blockedReason = reason;
    };
    for (const meta of provider.keys) {
      const sk = `${provider.id}:${meta.id}`;
      let st = this.keys.get(sk);
      if (!st) {
        st = defaultKeyState(day, meta.dailyLimit, meta.rpm);
        this.keys.set(sk, st);
        this.dirty.add(`k:${sk}`);
      } else {
        if (st.dayLimit !== meta.dailyLimit) {
          st.dayLimit = meta.dailyLimit;
          this.dirty.add(`k:${sk}`);
        }
        if (st.rpm !== meta.rpm) {
          st.rpm = meta.rpm;
          this.dirty.add(`k:${sk}`);
        }
      }
      if (st.invalid) {
        note(Infinity, "key_invalid");
        continue;
      }
      if (st.cooldownUntil > now) {
        if (st.day === day && st.dayLimit > 0 && st.dayCount >= st.dayLimit)
          note(nextUtcMidnight(now), "quota");
        else
          note(st.cooldownUntil, "cooldown");
        continue;
      }
      if ((st.breakerUntil ?? 0) > now) {
        note(st.breakerUntil, "breaker");
        continue;
      }
      if (st.day !== day) {
        st.day = day;
        st.dayCount = 0;
        this.dirty.add(`k:${sk}`);
      }
      if (st.dayLimit > 0 && st.dayCount >= st.dayLimit) {
        note(nextUtcMidnight(now), "quota");
        continue;
      }
      if (st.rpm > 0) {
        const win = (this.rpmWindow.get(sk) ?? []).filter((t) => now - t < 6e4);
        this.rpmWindow.set(sk, win);
        if (win.length >= st.rpm) {
          note(win[0] + 6e4, "rpm");
          continue;
        }
      }
      const quotaRatio = st.dayLimit > 0 ? Math.max(0, (st.dayLimit - st.dayCount) / st.dayLimit) : 1;
      out.push({ id: meta.id, state: st, quotaRatio });
    }
    out.sort((a, b) => b.quotaRatio - a.quotaRatio);
    return { keys: out, blockedUntil, blockedReason };
  }
  // ------------------------------ 回报 -----------------------------------
  async report(r) {
    await this.ensureLoaded();
    const now = Date.now();
    const day = r.day ?? utcDay(now);
    const sk = `${r.provider}:${r.keyId}`;
    let ks = this.keys.get(sk);
    if (!ks) {
      ks = defaultKeyState(day);
      this.keys.set(sk, ks);
    }
    if (ks.day < day) {
      ks.day = day;
      ks.dayCount = 0;
    }
    ks.lastUsed = now;
    ks.dayCount += 1;
    {
      const win = this.rpmWindow.get(sk) ?? [];
      win.push(now);
      this.rpmWindow.set(sk, win);
    }
    if (r.ok) {
      ks.fails = 0;
      ks.transientFails = 0;
      ks.breakerUntil = 0;
      ks.cooldownUntil = 0;
    } else {
      ks.fails += 1;
      switch (r.kind) {
        case "rate_limit":
          if (/concurren/i.test(r.error ?? "")) {
            ks.cooldownUntil = Math.max(ks.cooldownUntil, now + 2e3);
          } else {
            ks.cooldownUntil = now + Math.min(r.retryAfterMs ?? 3e4, 6e4);
          }
          break;
        case "quota":
          if (ks.dayLimit > 0)
            ks.dayCount = Math.max(ks.dayCount, ks.dayLimit);
          ks.cooldownUntil = Math.max(ks.cooldownUntil, nextUtcMidnight(now));
          break;
        case "auth":
          if (r.status === 403)
            ks.cooldownUntil = now + 36e5;
          else
            ks.invalid = true;
          break;
        case "server":
        case "network":
        case "timeout":
          ks.cooldownUntil = now + 5e3;
          break;
        default:
          break;
      }
      // Circuit breaker (key level): enough consecutive transient
      // failures trip a long cooldown for the whole key, across all
      // models, instead of the short per-failure pause above.
      if (TRANSIENT_KINDS.includes(r.kind ?? "")) {
        ks.transientFails = (ks.transientFails ?? 0) + 1;
        const bcfg = this.breakerCfg();
        if (ks.transientFails >= bcfg.threshold) {
          ks.breakerUntil = now + bcfg.cooldownMs;
          ks.cooldownUntil = Math.max(ks.cooldownUntil, ks.breakerUntil);
        }
      }
    }
    this.dirty.add(`k:${sk}`);
    const mkey = `${r.provider}/${r.model}`;
    const ms = this.models.get(mkey) ?? {
      ok: 0,
      fail: 0,
      consecFails: 0,
      deadUntil: 0,
      emaMs: 0,
      lastOkAt: 0,
      lastErr: "",
      lastErrKind: ""
    };
    if (r.ok) {
      ms.ok += 1;
      ms.consecFails = 0;
      ms.deadUntil = 0;
      ms.pauseUntil = 0;
      ms.lastOkAt = now;
      ms.emaMs = ms.emaMs > 0 ? ms.emaMs * 0.7 + (r.latencyMs ?? 0) * 0.3 : r.latencyMs ?? 0;
      ms.lastErr = "";
      ms.lastErrKind = "";
    } else {
      ms.fail += 1;
      ms.lastErr = truncate(r.error ?? "", 300);
      ms.lastErrKind = r.kind ?? "unknown";
      switch (r.kind) {
        case "model_gone":
          ms.deadUntil = now + 6 * 36e5;
          break;
        case "rate_limit":
          ms.pauseUntil = now + (r.retryAfterMs ?? 6e4);
          break;
        case "quota":
          break;
        case "server":
        case "network":
        case "timeout":
        case "unknown": {
          // Circuit breaker (endpoint level): the usual pause is
          // 30 s, but once consecutive transient failures reach the
          // threshold this endpoint stays dead for the full breaker
          // cooldown instead of being retried every 30 s.
          ms.consecFails = (ms.consecFails ?? 0) + 1;
          const bcfg2 = this.breakerCfg();
          ms.deadUntil = now + (ms.consecFails >= bcfg2.threshold ? Math.max(3e4, bcfg2.cooldownMs) : 3e4);
          break;
        }
        default:
          break;
      }
    }
    this.models.set(mkey, ms);
    this.dirty.add(`m:${mkey}`);
    if (r.param) {
      const set = this.drops.get(r.provider) ?? /* @__PURE__ */ new Set();
      set.add(r.param);
      this.drops.set(r.provider, set);
      this.dirty.add(`d:${r.provider}`);
    }
    await this.flush();
    await this.ensureAlarm();
  }
  async flush() {
    if (!this.dirty.size)
      return;
    const batch = {};
    for (const k of this.dirty) {
      if (k.startsWith("k:")) {
        const v = this.keys.get(k.slice(2));
        if (v)
          batch[k] = v;
      } else if (k.startsWith("m:")) {
        const v = this.models.get(k.slice(2));
        if (v)
          batch[k] = v;
      } else if (k.startsWith("d:")) {
        const v = this.drops.get(k.slice(2));
        if (v)
          batch[k] = [...v];
      } else if (k.startsWith("a:")) {
        const v = this.authClients.get(k.slice(2));
        if (v)
          batch[k] = v;
      }
    }
    if (Object.keys(batch).length)
      await this.state.storage.put(batch);
    this.dirty.clear();
  }
  async ensureAlarm() {
    if (this.alarmChecked)
      return;
    this.alarmChecked = true;
    const existing = await this.state.storage.getAlarm();
    if (existing == null)
      await this.state.storage.setAlarm(Date.now() + DAY_MS);
  }
  async alarm() {
    await this.ensureLoaded();
    const now = Date.now();
    const remove = [];
    for (const [k, v] of this.models) {
      if (v.deadUntil > 0 && v.deadUntil < now - 7 * DAY_MS)
        remove.push(`m:${k}`);
      else if (!v.deadUntil && v.lastOkAt && v.lastOkAt < now - 90 * DAY_MS)
        remove.push(`m:${k}`);
    }
    if (remove.length)
      await this.state.storage.delete(remove);
    for (const k of remove)
      this.models.delete(k.slice(2));
    const day = utcDay(now);
    for (const [k, v] of this.keys) {
      if (v.day !== day) {
        v.day = day;
        v.dayCount = 0;
        this.dirty.add(`k:${k}`);
      }
      if (v.invalid) {
        v.cooldownUntil = 0;
        v.breakerUntil = 0;
      }
    }
    const removeAuth = [];
    for (const [k, v] of this.authClients) {
      if (!(v.lockedUntil > now) && v.lastFailAt && v.lastFailAt < now - DAY_MS)
        removeAuth.push(`a:${k}`);
    }
    if (removeAuth.length)
      await this.state.storage.delete(removeAuth);
    for (const k of removeAuth) {
      this.authClients.delete(k.slice(2));
      this.dirty.delete(k);
    }
    await this.flush();
    this.alarmChecked = false;
    await this.state.storage.setAlarm(Date.now() + DAY_MS);
  }
  // ------------------------------ 运维 -----------------------------------
  /** 当前被拉黑（deadUntil 未到期）的模型键列表，供 /v1/models 过滤 */
  deadKeys() {
    const now = Date.now();
    const out = [];
    for (const [k, v] of this.models) {
      if (v.deadUntil > now)
        out.push(k);
    }
    return out;
  }
  stats() {
    const now = Date.now();
    const day = utcDay(now);
    const keys = [...this.keys.entries()].map(([k, v]) => ({
      key: k,
      day: v.day,
      dayCount: v.day === day ? v.dayCount : 0,
      dayLimit: v.dayLimit,
      cooldownUntil: v.cooldownUntil,
      cooling: v.cooldownUntil > now,
      invalid: v.invalid,
      fails: v.fails,
      transientFails: v.transientFails ?? 0,
      breakerUntil: v.breakerUntil ?? 0,
      breakerTripped: (v.breakerUntil ?? 0) > now,
      lastUsed: v.lastUsed
    }));
    const dead = [];
    const erroring = [];
    for (const [k, v] of this.models) {
      if (v.deadUntil > now) {
        dead.push({ model: k, deadUntil: v.deadUntil, kind: v.lastErrKind, error: v.lastErr, consecFails: v.consecFails ?? 0 });
      } else if (v.fail > 0) {
        erroring.push({ model: k, ok: v.ok, fail: v.fail, consecFails: v.consecFails ?? 0, emaMs: Math.round(v.emaMs) });
      }
    }
    erroring.sort((a, b) => b.fail - a.fail);
    const drops = {};
    for (const [k, v] of this.drops)
      drops[k] = [...v];
    const authLocked = [...this.authClients.entries()].filter(([, v]) => (v.lockedUntil ?? 0) > now).map(([k, v]) => ({ client: k, lockedUntil: v.lockedUntil, fails: v.fails ?? 0 }));
    return {
      day,
      keys,
      models: { total: this.models.size, dead: dead.slice(0, 50), erroring: erroring.slice(0, 30) },
      drops,
      auth: { locked: authLocked },
      now
    };
  }
  // --------------------- 会话粘滞 ---------------------
  // Session pins live directly in DO storage under the "s:" prefix
  // (never loaded into the in-memory maps): {provider, model, keyId,
  // exp}. A pin is honoured by the router only while that endpoint is
  // still among the request's healthy picks; expiry is lazy (checked
  // on read) plus the TTL below. reset() wipes them via deleteAll().
  sessionCfg() {
    const t = Math.floor(Number(this.env.SESSION_TTL_MS));
    return { ttlMs: Number.isFinite(t) ? Math.min(864e5, Math.max(6e4, t)) : 18e5 };
  }
  async sessionGet({ key }) {
    if (!key)
      return { pin: null };
    const rec = await this.state.storage.get("s:" + key);
    if (!rec)
      return { pin: null };
    if (!rec.exp || rec.exp <= Date.now()) {
      await this.state.storage.delete("s:" + key);
      return { pin: null };
    }
    return { pin: rec };
  }
  async sessionPut({ key, provider, model, keyId }) {
    if (!key || !provider || !model)
      return;
    await this.state.storage.put("s:" + key, {
      provider,
      model,
      keyId: keyId ?? null,
      exp: Date.now() + this.sessionCfg().ttlMs
    });
  }
  async reset() {
    await this.state.storage.deleteAll();
    this.keys.clear();
    this.models.clear();
    this.authClients.clear();
    this.drops.clear();
    this.rpmWindow.clear();
    this.dirty.clear();
    this.loaded = true;
  }
};
__name(Coordinator, "Coordinator");
export function weightedSample(pool, limit) {
  const out = [];
  const tmp = pool.slice();
  while (out.length < limit && tmp.length) {
    let total = 0;
    for (const t of tmp)
      total += t.w;
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < tmp.length; idx++) {
      r -= tmp[idx].w;
      if (r <= 0)
        break;
    }
    idx = Math.min(idx, tmp.length - 1);
    out.push(tmp[idx].pick);
    tmp.splice(idx, 1);
  }
  return out;
}
__name(weightedSample, "weightedSample");
export function interleaveByModel(picks) {
  const groups = /* @__PURE__ */ new Map();
  const order = [];
  for (const p of picks) {
    const k = `${p.provider}/${p.model}`;
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k).push(p);
  }
  const out = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const k of order) {
      const g = groups.get(k);
      if (g[i]) {
        out.push(g[i]);
        added = true;
      }
    }
    if (!added)
      break;
  }
  return out;
}
__name(interleaveByModel, "interleaveByModel");
