const fs = require('fs');
const BASE = 'http://127.0.0.1:8787';
const vars = {};
for (const line of fs.readFileSync(require('path').join(__dirname, '..', '.dev.vars'),'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) vars[m[1]] = m[2].trim();
}
const ADMIN = vars.ADMIN_TOKEN, GW = vars.GATEWAY_TOKEN;
let passed = 0, failed = 0;
function check(name, cond, extra='') {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name, extra); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function admin(path, token, method='GET', body) {
  const res = await fetch(BASE + path, {method, headers:{authorization:'Bearer '+token, 'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined});
  let data = null; try { data = await res.json(); } catch {}
  return {status: res.status, data, headers: res.headers};
}
async function chat(model) {
  const res = await fetch(BASE + '/v1/chat/completions', {method:'POST', headers:{authorization:'Bearer '+GW, 'content-type':'application/json'}, body: JSON.stringify({model, messages:[{role:'user', content:'hi'}]})});
  let data = null; try { data = await res.json(); } catch {}
  return {status: res.status, data, provider: res.headers.get('x-gw-provider')};
}
async function mockStats(port) { const r = await fetch(`http://127.0.0.1:${port}/__stats`); return r.json(); }
async function gwStats() { const r = await admin('/admin/api/stats', ADMIN); return r.data; }
async function waitFor(fn, timeout=8000, step=300) {
  const t0 = Date.now(); let v;
  while (Date.now() - t0 < timeout) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}
(async () => {
  // ---- setup ----
  let r = await admin('/admin/api/reset', ADMIN, 'POST', {});
  check('reset coordinator', r.status === 200, JSON.stringify(r.data));
  r = await admin('/admin/api/providers', ADMIN, 'POST', {id:'aaa', kind:'openai', baseUrl:'http://127.0.0.1:9101/v1', apiKey:'test-aaa-key'});
  check('add provider aaa', r.status === 200, JSON.stringify(r.data));
  r = await admin('/admin/api/providers', ADMIN, 'POST', {id:'bbb', kind:'openai', baseUrl:'http://127.0.0.1:9102/v1', apiKey:'test-bbb-key'});
  check('add provider bbb', r.status === 200, JSON.stringify(r.data));
  r = await admin('/admin/api/sync', ADMIN, 'POST', {});
  check('sync catalog', r.status === 200, JSON.stringify(r.data).slice(0,200));
  const modelsRes = await fetch(BASE + '/v1/models', {headers:{authorization:'Bearer '+GW}});
  const models = await modelsRes.json();
  const ids = (models.data||[]).map(m=>m.id);
  check('models include mock-a and mock-shared-1', ids.includes('mock-a') && ids.includes('mock-shared-1'), ids.join(','));

  // ---- circuit breaker: trip ----
  // NOTE: each transient failure already pauses the key for 5s (pre-existing
  // behaviour), so space the failing requests >5s apart or /order excludes
  // the key and no new failure is recorded.
  for (const m of ['mock-a','mock-b','mock-c']) {
    const c = await chat(m);
    check(`chat ${m} fails 503 while aaa is bad`, c.status === 503, 'got '+c.status+' '+JSON.stringify(c.data).slice(0,150));
    if (m !== 'mock-c') { console.log('waiting out the 5s key pause'); await sleep(5600); }
    else await sleep(400);
  }
  const tripped = await waitFor(async () => {
    const s = await gwStats();
    const k = (s.keys||[]).find(x => x.key.startsWith('aaa:'));
    return k && k.transientFails >= 3 && k.breakerTripped ? k : null;
  });
  check('breaker tripped for aaa key after 3 transient failures', !!tripped, JSON.stringify(tripped));
  if (tripped) check('breaker cooldown in future (>3s)', tripped.breakerUntil - Date.now() > 3000, 'breakerUntil-now='+(tripped.breakerUntil-Date.now()));
  let ms = await mockStats(9101);
  check('aaa received exactly 3 chat attempts', ms.chatAttempts === 3, 'attempts='+ms.chatAttempts);
  const s1 = await gwStats();
  const deadA = (s1.models?.dead||[]).find(x => x.model === 'aaa/mock-a');
  check('aaa/mock-a in dead list with consecFails>=1', !!deadA, JSON.stringify(s1.models));

  // ---- while tripped: no new attempt to aaa ----
  const c4 = await chat('mock-d');
  check('chat mock-d 503 while breaker open (no capacity)', c4.status === 503, 'got '+c4.status);
  await sleep(400);
  ms = await mockStats(9101);
  check('aaa got NO new attempt while breaker open', ms.chatAttempts === 3, 'attempts='+ms.chatAttempts);

  // ---- recovery after cooldown ----
  await fetch('http://127.0.0.1:9101/__toggle', {method:'POST'});
  const waitMs = Math.max(0, (tripped ? tripped.breakerUntil - Date.now() : 0)) + 1200;
  console.log('waiting breaker cooldown expiry:', waitMs, 'ms');
  await sleep(waitMs);
  const c5 = await chat('mock-e');
  check('chat mock-e succeeds via aaa after cooldown + upstream recovery', c5.status === 200 && c5.provider === 'aaa', 'got '+c5.status+' provider='+c5.provider+' '+JSON.stringify(c5.data).slice(0,150));
  const cleared = await waitFor(async () => {
    const s = await gwStats();
    const k = (s.keys||[]).find(x => x.key.startsWith('aaa:'));
    return k && k.transientFails === 0 && !k.breakerTripped ? k : null;
  });
  check('breaker state reset after success', !!cleared, JSON.stringify(cleared));
  const c6 = await chat('mock-shared-1');
  check('shared model chat succeeds', c6.status === 200, 'got '+c6.status);

  // ---- admin auth throttle ----
  let a;
  a = await admin('/admin/api/overview', 'wrong-token-1'); check('wrong admin token #1 -> 401', a.status === 401, 'got '+a.status);
  a = await admin('/admin/api/overview', 'wrong-token-2'); check('wrong admin token #2 -> 401', a.status === 401, 'got '+a.status);
  a = await admin('/admin/api/overview', ADMIN); check('correct token after 2 fails -> 200 (counter cleared)', a.status === 200, 'got '+a.status);
  for (let i = 1; i <= 4; i++) { a = await admin('/admin/api/overview', 'bad-'+i); check(`wrong token round2 #${i} -> 401`, a.status === 401, 'got '+a.status); }
  a = await admin('/admin/api/overview', 'bad-5');
  check('5th consecutive wrong token -> 429 locked', a.status === 429, 'got '+a.status+' '+JSON.stringify(a.data).slice(0,150));
  check('429 carries Retry-After header', Number(a.headers.get('retry-after')) >= 1, 'retry-after='+a.headers.get('retry-after'));
  a = await admin('/admin/api/overview', ADMIN);
  check('correct token while locked -> 429', a.status === 429, 'got '+a.status);
  console.log('waiting lockout expiry ~8.5s');
  await sleep(8500);
  a = await admin('/admin/api/overview', ADMIN);
  check('correct token after lockout expiry -> 200', a.status === 200, 'got '+a.status);
  const s2 = await gwStats();
  check('stats show no locked admin clients after recovery', Array.isArray(s2.auth?.locked) && s2.auth.locked.length === 0, JSON.stringify(s2.auth));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
