# Deployment Guide

[中文](DEPLOY.md) · Back to [README](../README.en.md)

free-ai-gateway has two parts, deployed separately:

| Part | Platform | Contents |
|---|---|---|
| Backend | Cloudflare Worker | The gateway itself + admin API (source in `src/`) |
| Frontend | Cloudflare Pages | Admin console (source in `frontend/`) |

Prepare the resources in section 1 first, then deploy with sections 2 and 3, and fill in the secrets and variables in section 4.

## 1. Preparation

### Create a D1 database and a KV namespace

The backend needs one D1 database and one KV namespace. Two ways:

**With the command line** (Node.js installed first):

```bash
npx wrangler d1 create free-ai-gateway        # note the database_id it prints
npx wrangler kv namespace create GW_KV        # note the id it prints
```

**With clicks in the dashboard**:

1. Sign in to the Cloudflare dashboard, go to **Storage & Databases → D1 SQL Database**, click **Create database**, name it `free-ai-gateway`, then copy its **Database ID**.
2. Go to **Storage & Databases → KV**, click **Create namespace**, name it `GW_KV`, then copy the namespace ID.

### Fork the repo and fill in your resource IDs

Fork the repo into your own GitHub account (the deploy button and Git integrations both need your own fork).

Open `wrangler.toml` in your fork and replace the two placeholders with your own IDs:

- `database_id` under `[[d1_databases]]`
- `id` under `[[kv_namespaces]]`

The repo ships placeholders. If you do not replace them, the deploy fails at the binding step.

Nothing else needs changing: the Durable Object and the scheduled tasks are in `wrangler.toml` and take effect on deploy.

## 2. Deploy the backend (Worker)

### Option 1: One-click deploy button (fastest)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/free-ai-gateway)

Before clicking, fork the repo and fill in your own D1 / KV IDs as in section 1, and change the button link's `url=` to your fork's address.

After clicking:

1. Sign in to Cloudflare and authorize it to access your GitHub;
2. It creates the Worker from the repo as-is and deploys it;
3. Once deployed, go to the Worker's **Settings → Variables and Secrets** and add the secrets from section 4;
4. The frontend console is not part of this flow — deploy it separately with section 3.

If the button errors, use option 2 or 3 — the steps are equivalent.

### Option 2: Git integration (all clicks, recommended)

For when you would rather not install the command line, and want pushes to auto-deploy:

1. In the dashboard, go to **Workers & Pages**, click **Create application → Workers → Import a repository** (connect to Git);
2. Authorize and pick your fork of `free-ai-gateway`;
3. Build settings: project name `free-ai-gateway`, root directory `/`, build command empty, deploy command `npx wrangler deploy`;
4. Click **Deploy** and wait for the first build. The bindings, variables, scheduled tasks, and Durable Object in `wrangler.toml` all take effect — provided the D1 / KV IDs in the file are already yours (section 1);
5. After deploying, go to the Worker's **Settings → Variables and Secrets** and add the secrets from section 4;
6. Every later push to the repo redeploys automatically.

### Option 3: Command line (fastest if you use a terminal)

```bash
git clone https://github.com/replycore/free-ai-gateway.git
cd free-ai-gateway
npm install
# Create D1 / KV as in section 1, and put the IDs into wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put MASTER_KEY     # 32-byte base64: openssl rand -base64 32
npx wrangler secret put ADMIN_ORIGIN   # your console domains, comma-separated, see section 4
npx wrangler deploy                    # or npm run deploy
```

### Option 4: Manual upload in the dashboard (temporary checks only)

1. **Workers & Pages → Create application → Workers → Start with Hello World**, name it `free-ai-gateway` and deploy, so you have a placeholder Worker;
2. Open the Worker, click **Edit code**, delete the placeholder file, and upload/create every file from this repo's `src/` directory with the same structure (entry point `src/index.js`, the rest are modules it imports — all must be present);
3. Click **Deploy** to save the code;
4. In the Worker's **Settings**, fill in everything (all required):
   - **Bindings**: add D1 (variable name `DB`, pick the database from section 1), KV (variable name `GW_KV`, pick the namespace from section 1), Durable Object (variable name `COORD`, class name `Coordinator`);
   - **Variables and Secrets**: add every plain variable from `wrangler.toml`'s `[vars]`, plus the four secrets from section 4;
   - **Triggers**: add the cron triggers `13 1,7,13,19 * * *` and `*/15 * * * *`;
   - Compatibility date: `2025-01-15`;
5. Every change to bindings/variables in Settings needs a fresh **Deploy** to take effect.

This route is the easiest to misconfigure — use it for temporary checks only; use option 2 or 3 for ongoing use.

### Custom domain for the backend (optional)

Worker overview → **Settings → Domains & Routes → Add → Custom domain**, enter your domain (e.g. `api.example.com`; the domain must be hosted in this account's Cloudflare DNS). After binding, the model Base URL is `https://api.example.com/v1`.

## 3. Deploy the frontend (Pages)

### Option 1: Command line (recommended)

**Run this from INSIDE the `frontend/` directory**:

```bash
cd frontend
npx wrangler pages deploy . --project-name free-ai-gateway-admin
# or from the repo root: npm run deploy:ui
```

Deploying from the repo root silently skips `functions/` (the Pages Function never runs, `/config.json` breaks, and the frontend cannot find the backend) — the most common deployment mistake.

After deploying, add the variable as described at the end of this section (**Setting GW_API_BASE**).

### Option 2: Pages Git integration (dashboard)

1. **Workers & Pages → Create application → Pages → Connect to Git**, authorize and pick the `free-ai-gateway` repo;
2. Build settings:
   - Project name: `free-ai-gateway-admin`
   - Framework preset: None
   - Root directory: `frontend`
   - Build command: empty (pure static site, no build)
   - Build output directory: `/` (i.e. the `frontend` root)
3. Click **Save and Deploy** and wait for the first deploy;
4. Add the variable as described at the end of this section (**Setting GW_API_BASE**), then go to the **Deployments** page and retry the latest deployment (or push again) so the variable takes effect.

Later pushes redeploy automatically.

### Option 3: Direct upload in the dashboard

1. **Workers & Pages → Create application → Pages → Upload assets**, project name `free-ai-gateway-admin`;
2. Drag the **entire contents of** this repo's `frontend/` directory into the upload area (`index.html`, `_headers`, `sw.js`, `manifest.webmanifest`, the icon files, and the `functions/` folder — all of them; a folder or a zip both work), then click **Deploy site**;
3. `functions/` must be included, or `/config.json` will not work and the login page will report the backend as unconfigured; missing `sw.js`, `manifest.webmanifest`, or the icons breaks PWA and favicon;
4. Add the variable as described at the end of this section (**Setting GW_API_BASE**);
5. To update later: open the project → **Create deployment** → upload the new files.

### Setting GW_API_BASE (all three options need this)

Open the Pages project → **Settings → Environment variables** → add the variable `GW_API_BASE` for the **Production** environment, with the backend Worker's full address as the value (e.g. `https://api.example.com` — domain only, no `/v1`). The repo disables `workers.dev` by default (`workers_dev = false` in `wrangler.toml`), so a fresh deploy has no `*.workers.dev` address — to use one, set `workers_dev` to `true` and redeploy the backend. Add the same for Preview if you debug there.

### Custom domain for the frontend (optional)

Pages project → **Custom domains → Set up a custom domain**, enter your domain (e.g. `console.example.com`). After binding a new domain, remember to add it to the backend Worker's `ADMIN_ORIGIN` secret (section 4).

## 4. What to fill in

Set secrets with `wrangler secret put <name>`, or in the dashboard under Worker → **Settings → Variables and Secrets → Add**, type **Secret**. Never write a secret into any file or repo.

### Worker secrets

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | Credential for signing in to the admin console — pick a long random string |
| `GATEWAY_TOKEN` | Built-in caller token (clients use it for `/v1/*`; you can also issue revocable caller keys in the console) |
| `MASTER_KEY` | Master key that encrypts stored provider keys — must be **32-byte base64** (`openssl rand -base64 32`). Once changed, previously saved provider keys cannot be decrypted and must be re-entered |
| `ADMIN_ORIGIN` | Your console domains, comma-separated, e.g. `https://your-pages-domain.pages.dev,https://console.example.com`. List both the `*.pages.dev` address and any custom domain. Changes take effect immediately, no backend redeploy needed |

### Pages variable

| Variable | Required | Purpose |
|---|---|---|
| `GW_API_BASE` | Yes | The backend Worker's full address, e.g. `https://api.example.com` (domain only, no `/v1`). The frontend reads it at startup from `/config.json`, served by the Pages Function |

The remaining variables live in `wrangler.toml`'s `[vars]`; the defaults are fine, no changes needed.

## 5. Post-deploy checklist

1. All four secrets are set (section 4), and `wrangler.toml` holds **your own** D1 / KV IDs.
2. `curl https://<your-backend-domain>/healthz` returns 200.
3. Open the console, sign in with `ADMIN_TOKEN`, and add an upstream provider and its key on the **Providers** tab.
4. Click **Sync Models** once; the model catalog shows models. **Order matters**: syncing with no provider pulls nothing.
5. Confirm the Base URL on the **API Access** tab, and call once from a client with `GATEWAY_TOKEN` or a newly issued caller key — or just open Test Chat on any model in the catalog.
6. (Optional) Custom domains: backend under Worker **Settings → Domains & Routes**, frontend under the Pages project's **Custom domains**; after binding a new frontend domain, update `ADMIN_ORIGIN` to match.

## 6. Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in dummy local tokens and a local MASTER_KEY
npm run dev                      # backend http://127.0.0.1:8787
npm run dev:ui                   # frontend http://127.0.0.1:8788 (GW_API_BASE points at the local backend)
```

## 7. FAQ

- **The login page says the backend is not configured / unreachable**: the Pages `GW_API_BASE` is missing or wrong (no `/v1`, no trailing slash). Redeploy Pages after changing the variable.
- **`/config.json` returns 404 or not JSON**: the frontend deploy left out `functions/` — usually because it was deployed from the repo root instead of `frontend/`. Redeploy with section 3.
- **The model catalog stays empty**: click **Sync Models** once by hand; if that fails, check that a provider and key are added, that `SYNC_ENABLED` is `true`, and whether the Worker's **Logs / Real-time logs** show sync errors.
- **The one-click button fails with a binding error**: the D1 / KV IDs in `wrangler.toml` are still placeholders. Fork the repo, create the resources in your own account (section 1), and fill in the IDs first.
