# Deployment Guide

[中文](DEPLOY.md) · Back to [README](../README.en.md)

free-ai-gateway has two parts, deployed separately:

| Part | Platform | Contents |
|---|---|---|
| Backend | Cloudflare Worker | The gateway itself + admin API (`src/` modular source) |
| Frontend | Cloudflare Pages | Admin console (`frontend/` static site + Pages Function middleware) |

The backend has four deployment routes and the frontend three — pick
one each. The wrangler CLI is the least work; the Cloudflare
dashboard UI needs no terminal at all. Either way, the resources in
section 0 and the variables/secrets in section 3 must all be in
place.

## 0. Prerequisite resources

The backend needs four Cloudflare resources. The Durable Object and
the cron live in `wrangler.toml` and take effect on deploy; D1 and
KV must be created first, and their IDs pasted into `wrangler.toml`
(the IDs in the repo belong to the author's production environment —
replace them with your own).

### Create them with wrangler

```bash
npx wrangler d1 create free-ai-gateway        # prints database_id → [[d1_databases]] in wrangler.toml
npx wrangler kv namespace create GW_KV        # prints id → [[kv_namespaces]] in wrangler.toml
```

### Create them in the dashboard (UI)

1. In the Cloudflare dashboard, go to **Storage & Databases →
   D1 SQL Database**, click **Create database**, name it
   `free-ai-gateway`, and copy the **Database ID** from the list /
   overview page into `database_id` under `[[d1_databases]]` in
   `wrangler.toml`. (Optional: open the database's **Console** tab
   and paste `schema.sql` to create the `usage` table up front —
   not required, the Worker creates it automatically on first use.)
2. Go to **Storage & Databases → KV**, click **Create namespace**,
   name it `GW_KV`, and copy the namespace ID into `id` under
   `[[kv_namespaces]]` in `wrangler.toml`.

The four resources:

- **D1 `DB`** — the `usage` records table.
- **KV `GW_KV`** — provider configuration, the model catalog,
  gateway keys.
- **Durable Object `COORD`** (class `Coordinator`) — the
  coordinator for routing order, rate limits, the circuit breaker
  and login throttling. The `[[migrations]]` in `wrangler.toml`
  create it on first deploy; nothing to do by hand.
- **Cron** — `13 1,7,13,19 * * *` (4×/day): syncs the model
  catalog and prunes usage records older than 90 days. Also from
  `wrangler.toml`.

## 1. Deploy the backend (Worker)

### Option A: one-click deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/free-ai-gateway)

The flow after clicking:

1. Sign in to Cloudflare and authorize access to your GitHub;
2. the repo is cloned into your GitHub account and the Worker is
   created and deployed from `wrangler.toml`;
3. afterwards, open the Worker's **Settings → Variables and
   Secrets / Bindings** and, per section 3, point the bindings at
   the D1 / KV you created in section 0 and add the three secrets;
4. the frontend console is not part of this flow — deploy it
   separately per section 2.

This button flow has not been tested end to end; if anything goes
wrong, use Option B — the steps are equivalent.

### Option B: wrangler CLI (recommended)

```bash
git clone https://github.com/replycore/free-ai-gateway.git
cd free-ai-gateway
# create D1 / KV per section 0 and put their IDs in wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put MASTER_KEY     # 32-byte base64: openssl rand -base64 32
npx wrangler deploy                    # or npm run deploy
```

### Option C: Git integration (Workers Builds, all in the UI)

For no local tooling, with automatic deploys on every push:

1. In the dashboard go to **Workers & Pages**, click **Create
   application → Workers → Import a repository** (Connect to Git);
2. authorize and pick your fork/clone of `free-ai-gateway`;
3. build settings: project name `free-ai-gateway`, root directory
   `/`, build command empty, deploy command `npx wrangler deploy`;
4. click **Deploy** and wait for the first build. Everything in
   `wrangler.toml` (bindings, variables, cron, the Durable Object
   migration) takes effect from the file — provided the D1 / KV
   IDs in it are already yours (section 0);
5. afterwards open the Worker's **Settings → Variables and
   Secrets** and add the three secrets (section 3). Secrets cannot
   live in the repo; this page (or `wrangler secret put`) is the
   only place;
6. every later push to the repo redeploys automatically.

### Option D: manual upload in the dashboard (UI)

1. **Workers & Pages → Create application → Workers → Start with
   Hello World**, name it `free-ai-gateway` and deploy, giving you
   a placeholder Worker;
2. open the Worker, click **Edit code**, delete the placeholder
   file, and upload/create **all** files from this repo's `src/`
   directory, keeping the same layout (the entry is `src/index.js`;
   the other files are modules it imports and must all be there);
3. click **Deploy** to save the code;
4. open the Worker's **Settings** and fill in every item (none is
   optional):
   - **Bindings**: add D1 (variable name `DB`, the database from
     section 0), KV (variable name `GW_KV`, the namespace from
     section 0), Durable Object (variable name `COORD`, class
     `Coordinator`);
   - **Variables and Secrets**: add all plain variables from
     section 3 (at minimum keep `ADMIN_ORIGIN`,
     `UPSTREAM_TIMEOUT_MS`, … consistent with `wrangler.toml`)
     and the three secrets;
   - **Triggers**: add the cron `13 1,7,13,19 * * *`;
   - set the runtime compatibility date to `2025-01-15`;
5. after changing bindings/variables in Settings, deploy once more
   for the changes to take effect.

This route is the easiest to misconfigure; use it only for a quick
trial. For anything long-lived, use Option B or C.

### Bind a custom domain to the backend (optional, UI)

Worker overview → **Settings → Domains & Routes → Add → Custom
domain**, enter your domain (e.g. `api.example.com`; it must be on
Cloudflare DNS in this account). The model base URL then becomes
`https://api.example.com/v1`.

## 2. Deploy the frontend (Pages)

### Option A: wrangler pages deploy (recommended)

**Run it from inside `frontend/`**:

```bash
cd frontend
npx wrangler pages deploy . --project-name free-ai-gateway-admin
# or from the repo root: npm run deploy:ui
```

Deploying from the repo root silently drops `functions/` (the
Pages Function never runs, `/config.json` breaks, and the frontend
can't learn the backend address) — the most common deployment
mistake.

Afterwards, set `GW_API_BASE` as described at the end of this
section.

### Option B: Pages Git integration (UI)

1. **Workers & Pages → Create application → Pages → Connect to
   Git**, authorize and pick the `free-ai-gateway` repo;
2. build settings:
   - Project name: `free-ai-gateway-admin`
   - Framework preset: None
   - Root directory: `frontend`
   - Build command: empty (pure static site, nothing to build)
   - Build output directory: `/` (the `frontend` root itself)
3. click **Save and Deploy** and wait for the first deployment;
4. set `GW_API_BASE` as described below, then retry the latest
   deployment (or push once more) so the variable takes effect.
Later pushes deploy automatically.

### Option C: direct upload in the dashboard (UI)

1. **Workers & Pages → Create application → Pages → Upload
   assets**, name the project `free-ai-gateway-admin`;
2. drag in the **contents** of this repo's `frontend/` directory
   (`index.html`, `_headers`, and the `functions/` folder — a
   folder or a zip both work) and click **Deploy site**;
3. `functions/` must be included, otherwise `/config.json` doesn't
   work and the login page reports the backend as not configured;
4. set `GW_API_BASE` as described below;
5. to update later: open the project → **Create deployment** →
   upload the new files again.

### Set GW_API_BASE (required for all three options)

Open the Pages project → **Settings → Environment variables** →
add `GW_API_BASE` for the **Production** environment, set to the
backend Worker's full address (e.g. `https://api.example.com` —
domain only, no `/v1`; a `*.workers.dev` address works too). Add
the same variable for Preview if you debug there.

### Bind a custom domain to the frontend (optional, UI)

Pages project → **Custom domains → Set up a custom domain**, enter
your domain (e.g. `ai.example.com`). **After binding a new domain
you must add it to the backend Worker's `ADMIN_ORIGIN` variable
and redeploy the backend**, or browser logins will get 403 (see
section 3).

## 3. Variable reference

Variables can be set three equivalent ways: in `wrangler.toml`
(applied on deploy), or in the dashboard under the Worker's
**Settings → Variables and Secrets** (deploy once more after
changing them). Secrets only ever go through the latter two —
never write them into any file or repo.

### Worker variables (`[vars]` in `wrangler.toml`, editable in the dashboard)

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_ORIGIN` | (the author's console domain) | Origin allowlist for browser calls to `/admin/api/*`, comma-separated. **Replace with your own console domain** (list both the `*.pages.dev` address and any custom domain) or console logins get 403; **when unset, all browser requests get 403** (fail-closed) — only curl/scripts are unaffected |
| `DEFAULT_ALIAS` | `auto` | Default family strategy for the `auto` alias |
| `KEEP_PER_FAMILY` | `4` | How many entries to keep per model family in the catalog |
| `MAX_ATTEMPTS` | `6` | Max upstream endpoints tried per request |
| `MODEL_GROUPING` | `on` | Merge same-name models across providers into mapping groups |
| `PROBE_PER_SYNC` | `0` | Models to probe per sync (0 = none) |
| `SYNC_ENABLED` | `true` | Enable the cron catalog sync |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Per-request upstream timeout (ms) |
| `BREAKER_THRESHOLD` | `3` | Breaker threshold: consecutive transient failures per key before cooldown |
| `BREAKER_COOLDOWN_MS` | `300000` | Breaker cooldown length (ms, default 5 min) |
| `ADMIN_AUTH_MAX_FAILS` | `10` | Failed admin logins before the IP is locked out |
| `ADMIN_AUTH_LOCKOUT_MS` | `900000` | Login lockout length (ms, default 15 min) |
| `SESSION_TTL_MS` | `1800000` | Session-stickiness pin lifetime (ms, default 30 min) |

### Worker secrets (only via `wrangler secret put` or the dashboard — **never in a file**)

In the dashboard: Worker → **Settings → Variables and Secrets →
Add**, choose the **Secret** type, and add these three one by one.

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | Bearer credential for the admin console and admin API; pick a long random string of your own |
| `GATEWAY_TOKEN` | The built-in caller token (for clients calling `/v1/*`; revocable caller keys can also be issued in the console) |
| `MASTER_KEY` | Master key encrypting stored provider keys; must be **32-byte base64** (`openssl rand -base64 32`). Rotating it makes previously stored provider keys undecryptable — they must be re-entered |

### Worker bindings

| Binding name | Type | Notes |
|---|---|---|
| `DB` | D1 | Usage records (section 0) |
| `GW_KV` | KV | Configuration and catalog storage (section 0) |
| `COORD` | Durable Object | Class `Coordinator`, created by the migration |

### Pages variables

| Variable | Required | Purpose |
|---|---|---|
| `GW_API_BASE` | yes | The backend Worker's full address, e.g. `https://api.example.com` (domain only, no `/v1`). The frontend reads it at startup from the `/config.json` served by the Pages Function. **There is no fallback address**: when unset, the frontend assumes same-origin and the login page clearly reports the backend as not configured / unreachable instead of sending the token to any default address |

## 4. Post-deploy checklist

1. The three secrets are set (section 3) and `wrangler.toml`
   contains **your** D1 / KV IDs.
2. `ADMIN_ORIGIN` is your console's actual domain (both the
   `*.pages.dev` address and any custom domain), and the Worker
   was redeployed afterwards.
3. `curl https://<your-backend-domain>/healthz` returns 200 JSON.
4. Open the console, log in with `ADMIN_TOKEN`, click **Sync
   models** once, and confirm the Models tab fills up.
5. Add your upstream providers and keys in the **Providers** tab.
6. Check the base URL in the **Access** tab and make one real
   `/v1/chat/completions` call from a client with `GATEWAY_TOKEN`
   or a freshly issued caller key — or simply open any model's
   test chat from the catalog.
7. (Optional) Custom domains: backend under the Worker's
   **Settings → Domains & Routes**, frontend under the Pages
   project's **Custom domains**; after binding a new frontend
   domain, update `ADMIN_ORIGIN` to match.

## 5. Local development

```bash
cp .dev.vars.example .dev.vars   # local dummy tokens and a local MASTER_KEY
npm run dev                      # backend http://127.0.0.1:8787
npm run dev:ui                   # frontend http://127.0.0.1:8788 (GW_API_BASE points at the local backend)
```

## 6. Troubleshooting

- **Login returns 403 / "origin not allowed"**: `ADMIN_ORIGIN` is
  unset or doesn't include the console's current origin. Put the
  full origins (e.g. `https://free-ai-gateway-admin.pages.dev`
  plus your custom domain) in comma-separated, and redeploy the
  backend.
- **The login page says the backend is not configured /
  unreachable**: `GW_API_BASE` is unset or wrong on the Pages
  project (no `/v1`, no trailing slash). Redeploy Pages after
  changing it.
- **`/config.json` returns 404 or non-JSON**: the frontend was
  deployed without `functions/` — usually because it was deployed
  from the repo root instead of `frontend/`. Redeploy per
  section 2.
- **The model catalog stays empty**: click **Sync models** in the
  console once; if it stays empty, check that providers and keys
  exist, that `SYNC_ENABLED` is `true`, and look at the Worker's
  logs for sync errors.
- **The one-click button deploy returns 500s**: the bindings still
  point at the author's D1 / KV IDs (or at resources that don't
  exist in your account). Create your own per section 0, update
  `wrangler.toml`, and redeploy.
