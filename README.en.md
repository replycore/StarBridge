# free-ai-gateway

[中文](README.md)

An OpenAI / Anthropic / Gemini compatible AI gateway running as a single
Cloudflare Worker. It aggregates upstream free-model providers behind one
endpoint, keeps a synced model catalog, and routes each request across
providers with health-aware ordering, failover and per-key quotas.

- **Backend:** https://api.reply.kdns.fr — model base URL `https://api.reply.kdns.fr/v1`
- **Admin console:** https://ai.reply.kdns.fr (Cloudflare Pages, source in
  `frontend/`; UI available in 中文 / English with a persisted switch;
  every catalog model has a built-in test chat with multi-turn
  conversations and file attachments)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/free-ai-gateway)

> The button deploys only the backend Worker; bindings, secrets and the
> frontend still need manual steps — see the
> [deployment guide](docs/DEPLOY.en.md).

## Endpoints

- `POST /v1/chat/completions`, `GET /v1/models` (OpenAI)
- `POST /v1/messages`, `POST /v1/messages/count_tokens` (Anthropic)
- `GET /v1beta/models`, `POST /v1beta/models/{model}:generateContent` (Gemini)
- Passthrough: `/v1/audio/*`, `/v1/images/*`, `/v1/embeddings`,
  `/v1/completions`, `/v1/responses`, `/v1/moderations`, `/v1/ocr`,
  `/v1/systemone`
- `GET /healthz`, `GET /` — JSON status only; the Worker serves no UI
- `/admin/api/*` — admin API (see below); anything else under `/admin`
  is a JSON 404

## How it works

- **Catalog.** A cron (`13 1,7,13,19 * * *`) syncs every provider's model
  list into a catalog stored in KV, and cleans up usage rows older than
  90 days. Models are grouped into *mapping groups* (one public model id
  backed by one or more provider endpoints) and families, with `auto`
  aliases picking the best available model per family.
- **Routing.** A Durable Object (`Coordinator`) orders candidate
  endpoints per request. Ordering weight combines the configured weights
  with live health: success rate, latency, remaining daily quota and
  recent failures. Each mapping group has a routing strategy:
  - `balance` (default) — weighted random spread across endpoints;
  - `failover` — deterministic best-first order, sticks to the top
    endpoint until it fails.
  Strategies are stored per group in KV (`cfg:group-strategies:v1`) and
  set from the admin console or `POST /admin/api/groups`.
- **Custom models.** An admin can define a model id of their own plus a
  set of keywords: every catalog endpoint whose model name contains any
  keyword (case-insensitive substring match) joins the model. It appears
  in `/v1/models`, works on all three compatible APIs, and supports the
  per-group routing strategies. Definitions live in KV
  (`cfg:custom-groups:v1`) and are managed with
  `POST /admin/api/groups/custom` and
  `DELETE /admin/api/groups/custom?id=…`; ids colliding with catalog
  models are rejected, and a custom model with no matching endpoints is
  shown only in the admin list.
- **Context-aware routing.** The gateway roughly estimates each
  request's token count (text by characters, images at a flat rate,
  plus the requested output budget) and prefers endpoints whose context
  window can hold it. If an upstream still returns a context-length
  error, the request fails over to the next endpoint instead of failing
  immediately, until one fits or all have been tried. Request
  parameters dropped because an upstream does not support them are
  reported in the `x-gw-dropped-params` response header.
- **Circuit breaker.** Consecutive transient upstream failures (server /
  network / timeout) are counted per provider key across all models, and
  per model endpoint. At `BREAKER_THRESHOLD` (default 3) the key is
  cooled down for `BREAKER_COOLDOWN_MS` (default 5 min) and the
  endpoint's short pause escalates to the same cooldown. Any success
  resets the counters.
- **Recovery hint when out of capacity.** When every candidate is unavailable and the gateway answers 503 (`no_capacity`), the response reports the earliest recovery time: a `Retry-After` header and a `retry_after` field (seconds) taken from the soonest candidate unblock (cooldown / circuit breaker / pause / daily-quota reset), and the `hint` names the actual cause (cooling down / daily quota exhausted / key invalid), so agent clients can back off intelligently instead of hammering.
- **Quotas.** Provider keys carry daily limits and RPM caps, tracked by
  the Coordinator. RPM is counted after the fact, so a burst can exceed
  the cap by a small margin for an instant.
- **Usage accounting.** Every call is recorded in the D1 `usage` table
  (provider, model, key, tokens, latency, status). Writes are buffered
  in the isolate and flushed as one D1 batch at 20 rows or 4 s; admin
  reads and the cron flush first, and a failed batch re-queues its rows.
  The table is created automatically on first use (`ensureSchema`);
  `schema.sql` holds the same DDL for reference / manual setup.

## Admin API and security model

- Auth is a single `ADMIN_TOKEN` sent as `Authorization: Bearer …`.
  There is no query-string or cookie auth.
- Browser calls to `/admin/api/*` must come from an origin listed in
  the `ADMIN_ORIGIN` var (the console origins); other origins, including
  their preflights, get 403. Requests without an `Origin` header
  (curl, scripts) are unaffected.
- Failed admin auth attempts are counted per client IP in the
  Coordinator: at `ADMIN_AUTH_MAX_FAILS` (default 10) the client is
  locked out for `ADMIN_AUTH_LOCKOUT_MS` (default 15 min) and gets
  `429` + `Retry-After` even with the correct token. A successful login
  clears the counter; if the Coordinator is unreachable the throttle
  fails open (the token check still applies).
- Provider API keys are stored AES-GCM encrypted under `MASTER_KEY`;
  the admin API only ever returns masked keys.
- Callers authenticate with the `GATEWAY_TOKEN` secret or with gateway
  keys issued in the console (Access tab), which can be revoked
  individually.
- Main routes: `GET /admin/api/overview`, `/providers` (GET/POST,
  `/providers/{id}`, `/providers/{id}/keys`), `/gateway-keys`,
  `/groups` (GET/POST), `/catalog`, `/stats`, `POST /sync`, `/probe`,
  `/reset`.

## Layout

- `index.js` — the Worker. A single-file bundle and the source of
  truth; all backend development happens in this file.
- `wrangler.toml` — bindings, vars, cron. Contains no secrets.
- `schema.sql` — DDL of the D1 `usage` table (reference; the Worker
  also creates it automatically).
- `frontend/` — the admin console (static site + one Pages Function),
  deployed to the Pages project `free-ai-gateway-admin`. All UI strings
  go through a string table; 中文 / English can be switched and the
  choice is remembered.
- `docs/` — the [deployment guide](docs/DEPLOY.en.md)
  ([中文](docs/DEPLOY.md)): every deployment path for both parts, the
  full variables reference and a post-deploy checklist.
- `tests/` — local verification scripts (mock upstreams, API suite,
  browser suite) for use against `wrangler dev`; see the header of each
  file.
- `package.json` — convenience scripts (below).
- `.dev.vars.example` — template for local development secrets; copy it
  to `.dev.vars` (gitignored — never commit real secrets).

## Configuration at a glance

Bindings (see `wrangler.toml`): D1 `DB`, KV `GW_KV`, Durable Object
`COORD` (class `Coordinator`).

Secrets (Cloudflare `secret_text`, never in this repo):

```bash
wrangler secret put ADMIN_TOKEN     # admin console / admin API
wrangler secret put GATEWAY_TOKEN   # built-in caller token
wrangler secret put MASTER_KEY      # encrypts provider keys (32-byte base64)
```

Vars live in `wrangler.toml` `[vars]` with explanatory comments:
`ADMIN_ORIGIN`, `DEFAULT_ALIAS`, `KEEP_PER_FAMILY`, `MAX_ATTEMPTS`,
`MODEL_GROUPING`, `PROBE_PER_SYNC`, `SYNC_ENABLED`,
`UPSTREAM_TIMEOUT_MS`, and the breaker / auth-throttle knobs above.
See the [variables reference](docs/DEPLOY.en.md#3-variables-reference)
for what each one does and its default.

The Pages side needs exactly one variable: `GW_API_BASE` (the full
backend origin), served to the frontend by the Pages Function at
`/config.json`.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # dummy local tokens are fine
npm run dev                      # backend  http://127.0.0.1:8787
npm run dev:ui                   # frontend http://127.0.0.1:8788 (bound to the local backend)

# trigger the cron handler manually
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

## Deployment

```bash
npm run deploy       # backend: wrangler deploy from the project root
npm run deploy:ui    # frontend: the script cds into frontend/ first
                     # (deploying Pages from the root silently skips
                     # the Functions bundle and breaks /config.json)
```

For a first-time deployment — creating D1 / KV, setting secrets, the
one-click button, Git integration and dashboard-only paths — see the
[deployment guide](docs/DEPLOY.en.md).
