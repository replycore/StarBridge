# StarBridge

[中文](README.md)

An AI gateway on Cloudflare Workers: it puts several free AI providers behind one address, callable with OpenAI, Anthropic, and Gemini clients, with a web admin console.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/StarBridge)

> The one-click button only deploys the backend Worker; bindings, secrets, and the frontend still need to be added — see the [deployment guide](docs/DEPLOY.en.md) for the full steps.

## Quick start

1. Deploy the backend (Worker) and the frontend (Pages admin console) following the [deployment guide](docs/DEPLOY.en.md).
2. Open the admin console and sign in with `ADMIN_TOKEN`.
3. Add an upstream provider and its key on the **Providers** tab.
4. Click **Sync Models** in the top bar to pull the model catalog.
5. Open **Test Chat** on any model in the **Model Catalog** or **Mapping Groups** tab — if it chats, it works. Or copy the Base URL and a key from the **API Access** tab into your client.

Do not reverse the order: syncing with no provider configured pulls no models.

## Admin console

Chinese / English interface, switchable and remembered, full-featured on desktop and mobile. Six tabs:

- **Overview**: model count, today's requests and tokens, success/failure trend for the last 14 days, plus alerts and backup at the bottom.
- **API Access**: Base URL, issuing and revoking caller keys, and copy-ready setup examples per client.
- **Providers**: upstream providers and their keys; each key can be enabled or disabled on its own.
- **Mapping Groups**: grouping and routing strategy for the same model name across providers, plus custom models.
- **Model Catalog**: every synced model, each with a Test Chat button.
- **Usage**: per-provider usage stats and recent request details; failed rows expand to show the reason.

<table>
<tr>
<td><img src="docs/images/console-overview.png" alt="Admin console overview (desktop)"></td>
<td><img src="docs/images/console-chat.png" alt="Test chat (desktop)"></td>
</tr>
<tr>
<td><img src="docs/images/console-mobile-overview.png" alt="Admin console overview (mobile)"></td>
<td><img src="docs/images/console-mobile-chat.png" alt="Test chat (mobile)"></td>
</tr>
</table>

More screenshots: [login page](docs/images/console-login.png),
[providers](docs/images/console-providers.png),
[mapping groups](docs/images/console-groups.png),
[model catalog](docs/images/console-models.png),
[sync review](docs/images/console-syncreview.png),
[settings](docs/images/console-settings.png),
[usage](docs/images/console-usage.png).

## Everyday operations

### Sync models

**Sync Models** in the top bar re-fetches every provider's model list. You rarely need it by hand — it runs automatically four times a day.

### Sync review

When a model is missing from two syncs in a row, it is not deleted outright. It goes to the **Sync Review** dialog in the top bar, where you can confirm the deletion, restore it, or ignore it. Unprotected entries with no action for 7 days are deleted automatically.

### Test chat

Every row in the model catalog and mapping groups has a **Test Chat** button that opens a streaming chat; you can paste images and files. The window can collapse into a floating bar while the request keeps running in the background.

### Alerts

In **Settings → Ops** you can turn on alerts: push via Bark or a webhook when all providers are down (the default) or when any provider is down. The same provider is not re-alerted within 30 minutes.

### Backup

In **Settings → Ops** you can export the whole configuration (providers, caller keys, group strategies, custom models) as a backup, and import it to restore. The export file contains plaintext keys — keep it safe.

### Health probes

In **Settings → Ops** you can turn on health probing: each provider is probed at the interval you choose (15 / 30 / 60 / 120 / 240 minutes), and a recovered key is automatically unblocked.

## FAQ

- **The model catalog stays empty**: make sure a provider and its key are added first, then click **Sync Models** to run a sync by hand.
- **The login page says the backend is not configured**: the Pages project's `GW_API_BASE` is missing or wrong (write only the backend domain, no `/v1`, no trailing slash). Redeploy Pages after changing the variable.
- **`/config.json` returns 404**: the `functions/` folder was left out of the frontend deploy — usually because it was deployed from the repo root instead of `frontend/`. Redeploy following the deployment guide.
- **The one-click button fails with a binding error**: the D1 / KV IDs in `wrangler.toml` are still placeholders. Create the resources in your own account and fill in the IDs first.

## Repository layout

- `src/` — backend Worker source (entry `src/index.js`), bundled automatically on deploy.
- `wrangler.toml` — bindings, variables, and scheduled tasks. No secrets in it.
- `schema.sql` — DDL for the D1 usage table (reference; the Worker also creates the table itself).
- `frontend/` — admin console (static site + Pages Function), deployed to Pages.
- `docs/` — [deployment guide](docs/DEPLOY.en.md) ([中文](docs/DEPLOY.md)); `docs/images/` holds the screenshots used here.
- `tests/` — local verification scripts, used with `wrangler dev`.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in dummy local tokens
npm run dev                      # backend http://127.0.0.1:8787
npm run dev:ui                   # frontend http://127.0.0.1:8788 (bound to the local backend)
```

## Deploy

```bash
npm run deploy       # backend
npm run deploy:ui    # frontend (the script cds into frontend/ first)
```

For a first deploy, see the [deployment guide](docs/DEPLOY.en.md).
