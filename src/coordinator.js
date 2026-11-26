import { __name } from "./helpers.js";
import { json, localDay, maskUrls, nextLocalMidnight, truncate } from "./util.js";

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
    lastUsed: 0,
    stateSetAt: 0,
    downSince: 0
  };
}
// Severity order for down reasons, heaviest first (shared by
// keyDownReason's check order and the providers segment's
// heaviest-reason pick): key_invalid > key_banned > quota >
// breaker > cooldown > rpm.
export var DOWN_SEVERITY = {
  key_invalid: 6,
  key_banned: 5,
  quota: 4,
  breaker: 3,
  cooldown: 2,
  rpm: 1
};
// Why a key cannot serve right now, as a single pure function:
// rankKeys(), report()'s downSince tracking and stats() all read
// from here, so the reason a key is excluded and the reason shown
// for it can never drift apart. Returns {reason, until} or null
// when the key is available. `rpmUntil` is the caller's
// precomputed RPM unblock time (win[0] + 60s when the window is
// full, else null) — this function never touches the rpm window.
// NOTE: breaker is checked BEFORE cooldown on purpose. report()
// sets cooldownUntil >= breakerUntil when it trips the breaker,
// so the unblock time is unchanged, but the reason a tripped key
// reports changes from "cooldown" to "breaker".
export function keyDownReason(ks, now, day, rpmUntil) {
  if (ks.invalid)
    return { reason: "key_invalid", until: Infinity };
  // `banned` does not exist yet (a later wave adds auto-ban); a
  // falsy value simply skips this branch until then.
  if (ks.banned)
    return { reason: "key_banned", until: ks.banUntil ?? Infinity };
  const effectiveDayCount = ks.day === day ? ks.dayCount ?? 0 : 0;
  if ((ks.dayLimit ?? 0) > 0 && effectiveDayCount >= ks.dayLimit)
    return { reason: "quota", until: nextLocalMidnight(now) };
  if ((ks.breakerUntil ?? 0) > now)
    return { reason: "breaker", until: Math.max(ks.breakerUntil, ks.cooldownUntil ?? 0) };
  if ((ks.cooldownUntil ?? 0) > now)
    return { reason: "cooldown", until: ks.cooldownUntil };
  if (rpmUntil != null)
    return { reason: "rpm", until: rpmUntil };
  return null;
}
__name(keyDownReason, "keyDownReason");
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
  gkeys = /* @__PURE__ */ new Map();
  alertState = null;
  rpmWindow = /* @__PURE__ */ new Map();
  flushTimer = null;
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
    // Paged: a single list() call silently truncates at its limit,
    // which would resurrect spent quotas / cooldowns after a restart
    // once the state grows past it.
    let cursor;
    for (let page = 0; page < 50; page++) {
      const entries = await this.state.storage.list({ limit: 1e3, ...(cursor ? { startAfter: cursor } : {}) });
      for (const [k, v] of entries) {
        if (k.startsWith("k:"))
          this.keys.set(k.slice(2), v);
        else if (k.startsWith("m:"))
          this.models.set(k.slice(2), v);
        else if (k === "al:state")
          this.alertState = v;
        else if (k.startsWith("a:"))
          this.authClients.set(k.slice(2), v);
        else if (k.startsWith("d:"))
          this.drops.set(k.slice(2), new Set(v));
        else if (k.startsWith("g:"))
          this.gkeys.set(k.slice(2), v);
      }
      if (entries.size < 1e3)
        break;
      cursor = [...entries.keys()].pop();
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
        case "/alerts":
          return this.json(await this.alertsEval(await request.json()));
        case "/alerts-ack":
          return this.json(await this.alertsAck(await request.json()));
        case "/purge-provider":
          return this.json(await this.purgeProvider(await request.json()));
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
  // Optional per-caller lock threshold: the gateway-token throttle
  // passes a looser one than the admin default. Absent or invalid
  // values fall back to authCfg().maxFails, so existing admin
  // callers (which never send it) behave exactly as before.
  authThreshold(body) {
    const t = Math.floor(Number(body?.threshold));
    return Number.isFinite(t) ? Math.min(1e5, Math.max(3, t)) : null;
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
    const client = String(body.client ?? "unknown");
    const st = this.authStateFor(client, now);
    // A caller-supplied threshold is enforced here too, so failures
    // recorded before the threshold was known (or under a different
    // one) still lock the client at check time.
    const t = this.authThreshold(body);
    if (t !== null && st.fails >= t && !(st.lockedUntil > now)) {
      st.lockedUntil = now + this.authCfg().lockoutMs;
      this.dirty.add(`a:${client}`);
    }
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
    const maxFails = this.authThreshold(body) ?? this.authCfg().maxFails;
    if (st.fails >= maxFails)
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
    const day = input.day ?? localDay(now);
    const session = input.session ? await this.sessionGet({ key: input.session }) : { pin: null, fresh: false };
    // Caller-key daily quota, decided inside /order so it costs no
    // extra round trip. Only keys issued with a dailyLimit take part.
    // The slot is charged only when the order actually yields picks:
    // a request turned away at the door (every candidate cooling or
    // blocked) never reaches an upstream and must not burn quota —
    // during an outage window, ordinary retries would otherwise
    // drain a small daily limit on 503s alone. A request that DOES
    // dispatch still counts even if the upstream then fails.
    let gkey = null;
    let gkeyState = null;
    if (input.gkey?.id && input.gkey.limit > 0) {
      let st = this.gkeys.get(input.gkey.id);
      if (!st || st.day !== day) {
        st = { day, count: 0, limit: input.gkey.limit };
        this.gkeys.set(input.gkey.id, st);
      }
      st.limit = input.gkey.limit;
      gkeyState = st;
      const allowed = st.count < st.limit;
      gkey = { allowed, used: st.count, limit: st.limit, retryAfterMs: allowed ? 0 : Math.max(0, nextLocalMidnight(now) - now) };
    }
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
        pool.push({ pick: { provider: c.provider, model: c.model, keyId: k.id }, w, priority: provider.priority ?? 0 });
      }
    }
    // Per-group routing strategy (set via /admin/api/groups):
    // - "failover": deterministic priority order — highest
    //   priority tier first, then highest weight (weight already
    //   folds in provider weight, health, latency, quota), stable
    //   tie-break, no randomness and no interleaving, so traffic
    //   sticks to the best endpoint until it actually fails.
    // - "balance" (default): weighted random sampling without replacement
    //   + interleave by model, spreading traffic across endpoints.
    // Priority tiers are hard layers above both strategies: the
    // pool is bucketed by priority (descending) and each strategy
    // runs inside one bucket at a time, so a lower tier is only
    // reached once the tiers above it are exhausted. All-zero
    // priorities form a single bucket, which is exactly the old
    // behaviour.
    const strategy = input.strategy === "failover" ? "failover" : "balance";
    let picks;
    if (strategy === "failover") {
      picks = pool.slice().sort((a, b) => {
        if (b.priority !== a.priority)
          return b.priority - a.priority;
        if (b.w !== a.w)
          return b.w - a.w;
        if (a.pick.provider !== b.pick.provider)
          return a.pick.provider < b.pick.provider ? -1 : 1;
        if (a.pick.model !== b.pick.model)
          return a.pick.model < b.pick.model ? -1 : 1;
        return a.pick.keyId < b.pick.keyId ? -1 : 1;
      }).slice(0, input.limit).map((x) => x.pick);
    } else {
      const buckets = /* @__PURE__ */ new Map();
      for (const e of pool) {
        const list = buckets.get(e.priority);
        if (list)
          list.push(e);
        else
          buckets.set(e.priority, [e]);
      }
      picks = [];
      for (const pr of [...buckets.keys()].sort((a, b) => b - a)) {
        if (picks.length >= input.limit)
          break;
        // Interleave by model per bucket, then concatenate: a
        // single interleave across buckets would mix tiers and
        // defeat the layering.
        picks.push(...interleaveByModel(weightedSample(buckets.get(pr), input.limit - picks.length)));
      }
    }
    if (gkeyState && gkey.allowed && picks.length) {
      gkeyState.count += 1;
      gkey.used = gkeyState.count;
      this.dirty.add(`g:${input.gkey.id}`);
    }
    this.scheduleFlush();
    return {
      picks, drops, day, strategy,
      pin: session.pin ?? null,
      pinFresh: session.fresh === true,
      gkey,
      blockedUntil: !picks.length && blockedUntil !== Infinity ? blockedUntil : null,
      blockedReason: !picks.length ? blockedReason : null
    };
  }
  rankKeys(provider, day, now) {
    const out = [];
    let blockedUntil = Infinity, blockedReason = null;
    if (!provider.keys.length) {
      // No keys at all: still surface a concrete reason and a
      // finite unblock time so the 503 carries a Retry-After and
      // the specific hint path instead of a null reason.
      blockedUntil = now + 6e4;
      blockedReason = "no_keys";
    }
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
      // Prune the RPM window first, then let the single shared
      // reason function decide: one mapping for exclusion and
      // display, not a second hand-written copy of it. The
      // day-rollover mutation stays where it was (after the down
      // checks, before the quota ratio) — keyDownReason already
      // treats a stale day's count as 0, so the order is safe.
      let rpmUntil = null;
      if (st.rpm > 0) {
        const win = (this.rpmWindow.get(sk) ?? []).filter((t) => now - t < 6e4);
        this.rpmWindow.set(sk, win);
        if (win.length >= st.rpm)
          rpmUntil = win[0] + 6e4;
      }
      const d = keyDownReason(st, now, day, rpmUntil);
      if (d) {
        note(d.until, d.reason);
        continue;
      }
      if (st.day !== day) {
        st.day = day;
        st.dayCount = 0;
        this.dirty.add(`k:${sk}`);
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
    const day = r.day ?? localDay(now);
    const sk = `${r.provider}:${r.keyId}`;
    let ks = this.keys.get(sk);
    if (!ks) {
      ks = defaultKeyState(day);
      this.keys.set(sk, ks);
    }
    // downSince tracks the "available -> unavailable" transition:
    // the reason before any mutation, and again after all of them.
    // Only a fresh transition stamps the time; a key that stays
    // down keeps its original downSince, and recovery clears it.
    // The rpm window is read (pruned copy) here and again at the
    // end, because this report pushes a new entry into it below.
    const rpmUntilBefore = (() => {
      if (!(ks.rpm > 0))
        return null;
      const win = (this.rpmWindow.get(sk) ?? []).filter((t) => now - t < 6e4);
      return win.length >= ks.rpm ? win[0] + 6e4 : null;
    })();
    const reasonBefore = keyDownReason(ks, now, day, rpmUntilBefore);
    // A report carrying an older day than the key state has already
    // rolled to (a request dispatched just before local midnight,
    // reported just after) must not charge the new day's count.
    const staleDay = day < ks.day;
    if (ks.day < day) {
      ks.day = day;
      ks.dayCount = 0;
    }
    ks.lastUsed = now;
    if (!staleDay)
      ks.dayCount += 1;
    {
      // Prune on every report, not just in rankKeys: for keys with
      // rpm = 0 the window is never read, and an unpruned array would
      // grow by one entry per attempt for the DO's whole lifetime.
      const win = (this.rpmWindow.get(sk) ?? []).filter((t) => now - t < 6e4);
      win.push(now);
      this.rpmWindow.set(sk, win);
    }
    if (r.ok) {
      // A success only rehabilitates failure state that predates
      // this attempt's dispatch. State recorded after the attempt
      // started (e.g. a 429 another in-flight request on the same
      // key just earned) belongs to a newer observation and must
      // survive this older request's completion.
      const startedAt = typeof r.startedAt === "number" && r.startedAt > 0 ? r.startedAt : now;
      if ((ks.stateSetAt ?? 0) <= startedAt) {
        ks.fails = 0;
        ks.transientFails = 0;
        ks.breakerUntil = 0;
        ks.cooldownUntil = 0;
      }
    } else {
      ks.stateSetAt = now;
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
          ks.cooldownUntil = Math.max(ks.cooldownUntil, nextLocalMidnight(now));
          break;
        case "auth":
          if (r.status === 403)
            ks.cooldownUntil = now + 36e5;
          else {
            ks.invalid = true;
            ks.invalidSince = ks.invalidSince || now;
          }
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
      // Client-aborted streams report their first-byte latency only;
      // even that is the client's decision, not the endpoint's speed,
      // so it does not feed the latency EMA.
      if (!r.aborted)
        ms.emaMs = ms.emaMs > 0 ? ms.emaMs * 0.7 + (r.latencyMs ?? 0) * 0.3 : r.latencyMs ?? 0;
      ms.lastErr = "";
      ms.lastErrKind = "";
    } else {
      ms.fail += 1;
      ms.lastErr = truncate(maskUrls(r.error ?? ""), 300);
      ms.lastErrKind = r.kind ?? "unknown";
      switch (r.kind) {
        case "model_gone":
          ms.deadUntil = now + 6 * 36e5;
          break;
        case "rate_limit":
          // Cap like the key-level cooldown above: an uncapped
          // upstream Retry-After (parseRetryAfter allows up to 6 h)
          // would park the model for hours while its key recovers
          // in a minute.
          ms.pauseUntil = now + Math.min(r.retryAfterMs ?? 6e4, 6e4);
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
    const learnedParams = Array.isArray(r.params) ? r.params : r.param ? [r.param] : [];
    if (learnedParams.length) {
      const set = this.drops.get(r.provider) ?? /* @__PURE__ */ new Set();
      let added = false;
      for (const p of learnedParams) {
        if (typeof p === "string" && p && !set.has(p)) {
          set.add(p);
          added = true;
        }
      }
      if (added) {
        this.drops.set(r.provider, set);
        this.dirty.add(`d:${r.provider}`);
      }
    }
    // Second half of the downSince transition: the reason after
    // all state mutations (post-push rpm window). The ok-report's
    // guarded clear is handled automatically — a guard that kept
    // the breaker/cooldown in place still reads as down here.
    const rpmUntilAfter = (() => {
      if (!(ks.rpm > 0))
        return null;
      const win = (this.rpmWindow.get(sk) ?? []).filter((t) => now - t < 6e4);
      return win.length >= ks.rpm ? win[0] + 6e4 : null;
    })();
    const reasonAfter = keyDownReason(ks, now, day, rpmUntilAfter);
    if (reasonBefore === null && reasonAfter !== null)
      ks.downSince = now;
    else if (reasonAfter === null)
      ks.downSince = 0;
    this.scheduleFlush();
    await this.ensureAlarm();
  }
  // Flushes are debounced 300ms: health state lives in memory and is
  // visible to the next request immediately; only durability lags.
  // Persisting synchronously on every report put a storage write
  // inside the DO's serial section for every chat request.
  scheduleFlush() {
    if (this.flushTimer || !this.dirty.size)
      return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((e) => console.error("[coordinator] flush failed", e));
    }, 300);
  }
  async flush() {
    if (!this.dirty.size)
      return;
    // Snapshot the dirty set before the await: state changes that
    // land while the storage write is in flight re-mark their keys,
    // and those newer marks must survive this flush. Clearing the
    // whole set afterwards would drop them without persisting the
    // newer values, resurrecting stale state after a DO restart.
    const gen = this.flushGen ?? 0;
    const pending = new Set(this.dirty);
    const readKey = (k) => {
      if (k.startsWith("k:"))
        return this.keys.get(k.slice(2));
      if (k.startsWith("m:"))
        return this.models.get(k.slice(2));
      if (k.startsWith("d:")) {
        const v = this.drops.get(k.slice(2));
        return v ? [...v] : void 0;
      }
      if (k === "al:state")
        return this.alertState ?? void 0;
      if (k.startsWith("a:"))
        return this.authClients.get(k.slice(2));
      if (k.startsWith("g:"))
        return this.gkeys.get(k.slice(2));
      return void 0;
    };
    const batch = {};
    // Serialized copies of what this flush writes, per key: the
    // batch holds live object references, so after the await the
    // only way to tell whether a key changed again mid-write is to
    // compare a fresh serialization against these.
    const written = {};
    for (const k of pending) {
      const v = readKey(k);
      if (v) {
        batch[k] = v;
        written[k] = JSON.stringify(v);
      }
    }
    if (Object.keys(batch).length)
      await this.state.storage.put(batch);
    if ((this.flushGen ?? 0) === gen) {
      for (const k of pending) {
        // Keep the dirty mark when the key was mutated again while
        // the write was in flight (its current value differs from
        // what was written); the next flush persists the newer one.
        const cur = readKey(k);
        if (cur && written[k] !== void 0 && JSON.stringify(cur) !== written[k])
          continue;
        this.dirty.delete(k);
      }
    } else if (Object.keys(batch).length) {
      // A reset() wiped storage while this write was in flight; the
      // put may have landed after its deleteAll, so remove the keys
      // this stale batch wrote — but only those that post-reset code
      // has not since re-created in memory. A re-created key keeps
      // its (newer) value and is re-marked dirty instead of being
      // deleted out from under the live state.
      const stale = [];
      for (const k of Object.keys(batch)) {
        if (readKey(k))
          this.dirty.add(k);
        else
          stale.push(k);
      }
      if (stale.length)
        await this.state.storage.delete(stale);
    }
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
      else if (!v.lastOkAt && (v.deadUntil ?? 0) < now - 7 * DAY_MS && (v.pauseUntil ?? 0) < now - 7 * DAY_MS)
        // Never-succeeded endpoints whose only state is an expired
        // pause/dead window (e.g. rate-limit pauses, which never set
        // deadUntil or lastOkAt) would otherwise accumulate forever.
        remove.push(`m:${k}`);
    }
    if (remove.length)
      await this.state.storage.delete(remove);
    for (const k of remove)
      this.models.delete(k.slice(2));
    const day = localDay(now);
    for (const [k, v] of this.keys) {
      if (v.day !== day) {
        v.day = day;
        v.dayCount = 0;
        this.dirty.add(`k:${k}`);
      }
      if (v.invalid) {
        // An invalid mark is not a life sentence: after 24h the key
        // gets one real request again. Previously only the cooldowns
        // were cleared here and invalid stayed true forever, so a
        // temporarily-401'd key never rejoined the pool until a
        // manual /reset.
        const since = v.invalidSince ?? 0;
        if (!since) {
          v.invalidSince = now;
          this.dirty.add(`k:${k}`);
        } else if (now - since >= 24 * 36e5) {
          v.invalid = false;
          v.invalidSince = 0;
          v.downSince = 0;
          v.fails = 0;
          v.transientFails = 0;
          v.cooldownUntil = 0;
          v.breakerUntil = 0;
          this.dirty.add(`k:${k}`);
        }
      }
    }
    // Session pins expire lazily on read; pins nobody reads again
    // would stay in storage forever (and crowd the state listing).
    // Sweep the expired ones here, in the daily alarm.
    const expiredPins = [];
    let pinCursor;
    for (let page = 0; page < 5; page++) {
      const pins = await this.state.storage.list({ prefix: "s:", limit: 500, ...(pinCursor ? { startAfter: pinCursor } : {}) });
      for (const [k, v] of pins) {
        if (!v?.exp || v.exp <= now)
          expiredPins.push(k);
      }
      if (pins.size < 500)
        break;
      pinCursor = [...pins.keys()].pop();
    }
    if (expiredPins.length)
      await this.state.storage.delete(expiredPins);
    const staleG = [...this.gkeys].filter(([, v]) => v.day !== day).map(([k]) => `g:${k}`);
    if (staleG.length)
      await this.state.storage.delete(staleG);
    for (const k of staleG)
      this.gkeys.delete(k.slice(2));
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
    const day = localDay(now);
    // Per-key down reason, computed from the same function rankKeys
    // uses (the rpm window is read, not mutated, here — stats is a
    // read path). downUntil is null when the key is available or
    // its unblock time is unbounded (invalid / banned without end).
    const keyDown = (v, sk) => {
      let rpmUntil = null;
      if ((v.rpm ?? 0) > 0) {
        const win = (this.rpmWindow.get(sk) ?? []).filter((t) => now - t < 6e4);
        if (win.length >= v.rpm)
          rpmUntil = win[0] + 6e4;
      }
      return keyDownReason(v, now, day, rpmUntil);
    };
    const keys = [...this.keys.entries()].map(([k, v]) => {
      const d = keyDown(v, k);
      return {
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
        lastUsed: v.lastUsed,
        downReason: d?.reason ?? null,
        downSince: d ? v.downSince ?? 0 : 0,
        downUntil: d && d.until !== Infinity ? d.until : null
      };
    });
    // Provider segment, derived live from the key states (only
    // providers with DO state appear): the single source of truth
    // for "is this provider down" — alerts and the console read
    // this instead of re-deriving it from the key rows. downReason
    // is the heaviest reason among the down keys; downUntil the
    // earliest finite unblock time among them (null when none).
    const byProvider = /* @__PURE__ */ new Map();
    for (const [k, v] of this.keys) {
      const id = k.split(":")[0];
      const list = byProvider.get(id);
      if (list)
        list.push([k, v]);
      else
        byProvider.set(id, [[k, v]]);
    }
    const providers = [...byProvider.entries()].map(([id, list]) => {
      let usableKeys = 0, downReason = null, downUntil = null;
      for (const [k, v] of list) {
        const d = keyDown(v, k);
        if (!d) {
          usableKeys += 1;
          continue;
        }
        if (!downReason || DOWN_SEVERITY[d.reason] > DOWN_SEVERITY[downReason])
          downReason = d.reason;
        if (d.until !== Infinity && (downUntil === null || d.until < downUntil))
          downUntil = d.until;
      }
      const totalKeys = list.length;
      return {
        id,
        status: usableKeys === 0 ? "down" : usableKeys < totalKeys ? "degraded" : "ok",
        usableKeys,
        totalKeys,
        downReason,
        downUntil
      };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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
      providers,
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
      return { pin: null, fresh: false };
    const rec = await this.state.storage.get("s:" + key);
    if (!rec)
      return { pin: null, fresh: false };
    const now = Date.now();
    if (!rec.exp || rec.exp <= now) {
      await this.state.storage.delete("s:" + key);
      return { pin: null, fresh: false };
    }
    // fresh = more than ~2/3 of the TTL remains, so the caller can
    // skip the renewal write for stable sessions.
    return { pin: rec, fresh: rec.exp - now > this.sessionCfg().ttlMs * 0.66 };
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
  // ------------------------------ 告警 -----------------------------------
  // Alert transition state lives here (not in KV) so concurrent
  // evaluations are serialized by the DO's single thread: two
  // simultaneous failure bursts cannot both read a stale state and
  // push duplicates. A down-cycle records which channels actually
  // received the alert (acked); a recovery is only announced on
  // channels that got the down alert, and a cycle suppressed by the
  // re-alert window closes silently.
  alertStateNow() {
    if (!this.alertState)
      this.alertState = { down: {}, alertedAt: {} };
    return this.alertState;
  }
  async alertsEval(body) {
    await this.ensureLoaded();
    const now = Date.now();
    const st = this.alertStateNow();
    const channels = (Array.isArray(body.channels) ? body.channels : []).filter((c) => c === "bark" || c === "webhook");
    const realertMs = Number(body.realertMs) > 0 ? Number(body.realertMs) : 18e5;
    const downSet = new Set((Array.isArray(body.down) ? body.down : []).map(String));
    // Providers the caller still has configured and enabled. A
    // cycle whose provider left the configuration (deleted /
    // disabled / fully rekeyed) closes silently instead of being
    // announced as "recovered". Absent field = legacy caller, every
    // provider counts as configured.
    const configured = Array.isArray(body.configured) ? new Set(body.configured.map(String)) : null;
    const CLAIM_MS = 9e4;
    const downAnnounce = [];
    const recoveredAnnounce = [];
    let changed = false;
    for (const id of downSet) {
      if (configured && !configured.has(id)) {
        if (st.down[id]) {
          delete st.down[id];
          changed = true;
        }
        continue;
      }
      let cyc = st.down[id];
      if (!cyc) {
        cyc = { since: now, acked: {}, suppressed: now - (st.alertedAt[id] ?? 0) <= realertMs };
        st.down[id] = cyc;
        changed = true;
      }
      if (cyc.pendingRecovery) {
        delete cyc.pendingRecovery;
        changed = true;
      }
      if (!cyc.suppressed) {
        // Claim lease: a channel handed out in an announcement is
        // claimed for CLAIM_MS; overlapping evaluations must not
        // hand the same un-acked channel out again (duplicate
        // pushes). An ack clears the claim; a claim that expires
        // without an ack makes the channel announceable again, so
        // a lost send is retried by a later evaluation.
        if (!cyc.claimed)
          cyc.claimed = {};
        const pending = channels.filter((c) => !cyc.acked[c] && !((cyc.claimed[c] ?? 0) > now));
        if (pending.length) {
          for (const c of pending)
            cyc.claimed[c] = now + CLAIM_MS;
          changed = true;
          downAnnounce.push({ id, channels: pending });
        }
      }
    }
    for (const id of Object.keys(st.down)) {
      if (downSet.has(id))
        continue;
      const cyc = st.down[id];
      if (configured && !configured.has(id)) {
        delete st.down[id];
        changed = true;
        continue;
      }
      const ackedChannels = channels.filter((c) => cyc.acked[c]);
      if (!cyc.suppressed && ackedChannels.length) {
        if (!cyc.pendingRecovery) {
          cyc.pendingRecovery = { channels: ackedChannels, claimed: {} };
          changed = true;
        }
        if (!cyc.pendingRecovery.claimed)
          cyc.pendingRecovery.claimed = {};
        const pending = cyc.pendingRecovery.channels.filter((c) => !((cyc.pendingRecovery.claimed[c] ?? 0) > now));
        if (pending.length) {
          for (const c of pending)
            cyc.pendingRecovery.claimed[c] = now + CLAIM_MS;
          changed = true;
          recoveredAnnounce.push({ id, channels: pending });
        }
      } else {
        delete st.down[id];
        changed = true;
      }
    }
    if (changed) {
      this.dirty.add("al:state");
      await this.flush();
    }
    return { downAnnounce, recoveredAnnounce };
  }
  async alertsAck(body) {
    await this.ensureLoaded();
    const now = Date.now();
    const st = this.alertStateNow();
    let changed = false;
    for (const item of body.down ?? []) {
      const cyc = st.down[item?.id];
      if (!cyc)
        continue;
      let any = false;
      for (const c of item.channels ?? []) {
        if (!cyc.acked[c]) {
          cyc.acked[c] = now;
          any = true;
        }
        if (cyc.claimed && c in cyc.claimed) {
          delete cyc.claimed[c];
          any = true;
        }
      }
      if (any) {
        st.alertedAt[item.id] = now;
        changed = true;
      }
    }
    for (const item of body.recovered ?? []) {
      const cyc = st.down[item?.id];
      if (!cyc?.pendingRecovery)
        continue;
      if (cyc.pendingRecovery.claimed)
        for (const c of item.channels ?? [])
          if (c in cyc.pendingRecovery.claimed) {
            delete cyc.pendingRecovery.claimed[c];
            changed = true;
          }
      const remaining = cyc.pendingRecovery.channels.filter((c) => !(item.channels ?? []).includes(c));
      if (!remaining.length) {
        delete st.down[item.id];
        changed = true;
      } else if (remaining.length !== cyc.pendingRecovery.channels.length) {
        cyc.pendingRecovery.channels = remaining;
        changed = true;
      }
    }
    if (changed) {
      this.dirty.add("al:state");
      await this.flush();
    }
    return { ok: true };
  }
  // Purge every piece of Coordinator state belonging to one
  // provider (or a single one of its keys): key health/quota state,
  // model state, session pins, and learned parameter drops. Called
  // by the admin API when a provider/key is deleted so a recreated
  // credential does not inherit its predecessor's health state.
  async purgeProvider(body) {
    await this.ensureLoaded();
    const provider = String(body?.provider ?? "");
    if (!provider)
      return { ok: false, removed: 0 };
    const keyId = body?.keyId ? String(body.keyId) : null;
    let removed = 0;
    const storageDeletes = [];
    for (const sk of [...this.keys.keys()]) {
      if (!sk.startsWith(provider + ":"))
        continue;
      if (keyId && sk !== `${provider}:${keyId}`)
        continue;
      this.keys.delete(sk);
      this.rpmWindow.delete(sk);
      this.dirty.delete(`k:${sk}`);
      storageDeletes.push(`k:${sk}`);
      removed += 1;
    }
    const modelPrefix = provider + "/";
    for (const mk of [...this.models.keys()]) {
      if (!mk.startsWith(modelPrefix))
        continue;
      this.models.delete(mk);
      this.dirty.delete(`m:${mk}`);
      storageDeletes.push(`m:${mk}`);
      removed += 1;
    }
    if (!keyId && this.drops.has(provider)) {
      this.drops.delete(provider);
      this.dirty.delete(`d:${provider}`);
      storageDeletes.push(`d:${provider}`);
      removed += 1;
    }
    // Session pins live only in storage; scan them for this
    // provider's pins (and, for a single-key purge, that key's).
    let cursor;
    for (let page = 0; page < 50; page++) {
      const pins = await this.state.storage.list({ prefix: "s:", limit: 1e3, ...(cursor ? { startAfter: cursor } : {}) });
      for (const [k, v] of pins) {
        if (v?.provider !== provider)
          continue;
        if (keyId && v.keyId !== keyId)
          continue;
        storageDeletes.push(k);
        removed += 1;
      }
      if (pins.size < 1e3)
        break;
      cursor = [...pins.keys()].pop();
    }
    if (storageDeletes.length)
      await this.state.storage.delete(storageDeletes);
    return { ok: true, removed };
  }
  async reset() {
    this.flushGen = (this.flushGen ?? 0) + 1;
    await this.state.storage.deleteAll();
    this.keys.clear();
    this.models.clear();
    this.authClients.clear();
    this.drops.clear();
    this.gkeys.clear();
    this.alertState = null;
    this.rpmWindow.clear();
    this.dirty.clear();
    this.loaded = true;
  }
};
__name(Coordinator, "Coordinator");
export function weightedSample(pool, limit) {
  const out = [];
  const tmp = pool.slice();
  // Smoothing: a zero-weight entry still gets a small slice of the
  // draw (w' = w + 5% of the pool's max weight), so it is not
  // starved forever, while the ranking signal of the health
  // weights is kept — the old weights are continuous health
  // scores (usually < 1), so a large flat bonus would flatten
  // them into a uniform draw. maxW is computed once, up front.
  const maxW = tmp.reduce((m, t) => Math.max(m, t.w), 0);
  const eff = (t) => t.w + 0.05 * maxW;
  while (out.length < limit && tmp.length) {
    let total = 0;
    for (const t of tmp)
      total += eff(t);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < tmp.length; idx++) {
      r -= eff(tmp[idx]);
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
