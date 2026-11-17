# Deployment Guide

[中文](DEPLOY.md) · Back to [README](../README.en.md)

free-ai-gateway has two parts, deployed separately:

| Part | Platform | Contents |
|---|---|---|
| Backend | Cloudflare Worker | The gateway itself + admin API (`src/` modular source) |
| Frontend | Cloudflare Pages | Admin console (`frontend/` static site + one Pages Function) |

## 0. Prerequisite resources

The backend needs four Cloudflare resources. The Durable Object and the
cron live in `wrangler.toml` and take effect on deploy; D1 and KV must be
created first, and their IDs pasted into `wrangler.toml` (the IDs in the
repo belong to the author's production environment — replace them with
your own).

Create them with wrangler:

```bash
npx wrangler d1 create free-ai-gateway        # prints database_id -> wrangler.toml [[d1_databases]]
npx wrangler kv namespace create GW_KV        # prints id -> wrangler.toml [[kv_namespaces]]
```

Or in the Cloudflare dashboard: D1 under "Storage & databases → D1",
KV under "Storage & databases → KV", then copy the IDs into
`wrangler.toml`.

- **D1 `DB`** — usage records (`usage` table, auto-created by the Worker
  on first use; `schema.sql` holds the same DDL for reference).
- **KV `GW_KV`** — provider configs, the model catalog, gateway keys.
- **Durable Object `COORD`** (class `Coordinator`) — coordinates routing
  order, rate limits, the circuit breaker and the login throttle. The
  `[[migrations]]` entry in `wrangler.toml` creates it on first deploy;
  no manual step.
- **Cron** — `13 1,7,13,19 * * *` (4×/day): syncs the model catalog and
  deletes usage rows older than 90 days. Also from `wrangler.toml`.

## 1. Deploy the backend (Worker)

### Option A: one-click deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/free-ai-gateway)

Cloudflare's flow clones this repo into your GitHub account and deploys
the Worker from `wrangler.toml`. It is **not fully automatic**:

- During/after the flow, point the D1 and KV bindings at resources in
  your own account (section 0).
- The three secrets (`ADMIN_TOKEN`, `GATEWAY_TOKEN`, `MASTER_KEY`) must
  be added manually under the Worker's "Settings → Variables and
  Secrets" (section 3).
- The Pages console is not part of this flow; deploy it separately
  (section 2).
- This button flow has not been verified end-to-end by the project; if
  anything goes wrong, use Option B — the steps are equivalent.

### Option B: wrangler CLI (recommended)

```bash
git clone https://github.com/replycore/free-ai-gateway.git
cd free-ai-gateway
# create D1 / KV per section 0 and paste their IDs into wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put MASTER_KEY     # 32-byte base64: openssl rand -base64 32
npx wrangler deploy                    # or: npm run deploy
```

### Option C: Git integration (Workers Builds)

In the dashboard, "Workers & Pages → Create → Import a repository",
connect your GitHub repo with build settings: root directory `/`,
deploy command `npx wrangler deploy`. Every push then deploys
automatically. Bindings, variables and secrets are still configured in
the dashboard (section 3).

### Option D: manual upload in the dashboard

Create a Worker under "Workers & Pages", open "Edit code" and upload
all files under `src/` keeping the same directory structure (the entry
is `src/index.js`), then add everything by hand under
"Settings": bindings (D1, KV, Durable Object with class name
`Coordinator`), variables (section 3), secrets (all three), the cron
trigger `13 1,7,13,19 * * *`, and compatibility date `2025-01-15`.
This path is the easiest to misconfigure; use it only for a quick look.

## 2. Deploy the frontend (Pages)

### Option A: wrangler pages deploy (recommended)

**Run it from inside `frontend/`:**

```bash
cd frontend
npx wrangler pages deploy . --project-name free-ai-gateway-admin
# or from the repo root: npm run deploy:ui
```

Deploying from the repo root silently skips `functions/` — the Pages
Function never ships, `/config.json` breaks and the console cannot find
its backend. This is the most common deployment mistake.

Afterwards, set `GW_API_BASE` in the Pages project's "Settings →
Environment variables" for Production (and Preview if needed) — see
section 3.

### Option B: Pages Git integration

In the dashboard, "Workers & Pages → Create → Pages → Connect to Git",
pick the repo with build settings:

- Framework preset: None
- Root directory: `frontend`
- Build command: leave empty (pure static site)
- Build output directory: `/` (the root of `frontend`)

Then add the `GW_API_BASE` environment variable in the project
settings. Pushes deploy automatically afterwards.

### Option C: direct upload in the dashboard

When creating the Pages project choose "Upload assets" and upload the
**contents** of `frontend/` (`index.html`, `_headers`, `functions/`).
`functions/` must be included or `/config.json` will not work.

## 3. Variables reference

### Worker variables (`[vars]` in `wrangler.toml`, editable in the dashboard)

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_ORIGIN` | (the author's console domains) | Browser-origin allowlist for `/admin/api/*`, comma-separated. **Set it to your own console domain(s)** or console logins get 403 |
| `DEFAULT_ALIAS` | `auto` | Default family strategy for the `auto` alias |
| `KEEP_PER_FAMILY` | `4` | Catalog entries kept per model family |
| `MAX_ATTEMPTS` | `6` | Max upstream endpoints tried per request |
| `MODEL_GROUPING` | `on` | Merge same-named models across providers into mapping groups |
| `PROBE_PER_SYNC` | `0` | Models probed during each sync (0 = none) |
| `SYNC_ENABLED` | `true` | Enable the cron catalog sync |
| `UPSTREAM_TIMEOUT_MS` | `90000` | Per-attempt upstream timeout (ms) |
| `BREAKER_THRESHOLD` | `3` | Circuit breaker: consecutive transient failures per key before cooldown |
| `BREAKER_COOLDOWN_MS` | `300000` | Circuit-breaker cooldown (ms, default 5 min) |
| `ADMIN_AUTH_MAX_FAILS` | `10` | Failed admin logins per IP before lockout |
| `ADMIN_AUTH_LOCKOUT_MS` | `900000` | Login lockout duration (ms, default 15 min) |

### Worker secrets (set via `wrangler secret put` or the dashboard — **never write them into files**)

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | Bearer credential for the admin console / admin API. Pick a long random string |
| `GATEWAY_TOKEN` | Built-in caller token for `/v1/*` (the console can also issue revocable gateway keys) |
| `MASTER_KEY` | Encrypts provider keys at rest. Must be **32 bytes in base64** (`openssl rand -base64 32`). Changing it makes previously stored provider keys undecryptable — they must be re-entered |

### Worker bindings

| Binding | Type | Notes |
|---|---|---|
| `DB` | D1 | Usage records (section 0) |
| `GW_KV` | KV | Config and catalog storage (section 0) |
| `COORD` | Durable Object | Class `Coordinator`, created by the migration |

### Pages variables

| Variable | Required | Purpose |
|---|---|---|
| `GW_API_BASE` | Yes | Full backend origin, e.g. `https://api.example.com` (origin only, no `/v1`). The console reads it at startup from `/config.json`, served by the Pages Function. If missing it falls back to the author's production backend, so **always set it for your own deployment** |

## 4. Post-deploy checklist

1. All three secrets are set (section 3) and `wrangler.toml` carries
   **your** D1 / KV IDs.
2. `ADMIN_ORIGIN` lists your console's real origins (both the
   `*.pages.dev` URL and any custom domain); redeploy the Worker after
   changing it.
3. Open the console, log in with `ADMIN_TOKEN`, and run "Sync Models"
   once.
4. Add upstream providers and their keys in the Providers tab.
5. Check the Base URL in the Access tab and make a test
   `/v1/chat/completions` call with `GATEWAY_TOKEN` or a console-issued
   key.
6. (Optional) Custom domains: bind the backend under the Worker's
   "Settings → Domains & Routes" and the console under the Pages
   project's "Custom domains". After adding a console domain, update
   `ADMIN_ORIGIN` to match.

## 5. Local development

```bash
cp .dev.vars.example .dev.vars   # fill in dummy local tokens + a local MASTER_KEY
npm run dev                      # backend  http://127.0.0.1:8787
npm run dev:ui                   # frontend http://127.0.0.1:8788 (GW_API_BASE points at the local backend)
```
