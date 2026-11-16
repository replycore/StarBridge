# free-ai-gateway admin console (frontend, Cloudflare Pages)

Static admin console for the free-ai-gateway Worker, deployed as the
Pages project `free-ai-gateway-admin`, custom domain
https://ai.reply.kdns.fr. A tabbed single-page app: 总览 / 调用接入 /
服务商 / 映射组 / 模型目录 / 用量与记录， with a sidebar on desktop and a
bottom tab bar on mobile. It polls the admin API every 30 s — only the
active tab's data, paused while the page is hidden.

## How it connects

- **Backend address is fixed by a Pages variable.** `functions/_middleware.js`
  answers `GET /config.json` with `{ "apiBase": env.GW_API_BASE }`. Set
  `GW_API_BASE` in the Pages project settings (production + preview) —
  the UI has no backend-address field and users cannot repoint the
  console. Fallback if the variable is missing: `https://api.reply.kdns.fr`.
- **Login:** ADMIN_TOKEN only. It is kept in localStorage and sent as
  `Authorization: Bearer …` — never in a URL, never as a cookie. The
  Worker serves no pages; `/admin/api/*` is the only admin surface.
- **Origin check:** the Worker's `ADMIN_ORIGIN` variable lists the
  allowed frontend origins; browser calls to `/admin/api/*` (including
  preflight) from any other origin get a 403.
- **Security headers:** `_headers` sets a CSP (self + inline for this
  single-file app, the API origin and Cloudflare analytics allowlisted),
  `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, a restrictive
  Permissions-Policy and HSTS for every page.

## Deploy

Run from INSIDE this directory:

```bash
npx wrangler pages deploy . --project-name free-ai-gateway-admin
```

Deploying from the repo root silently skips `functions/` (wrangler gets
confused by the Worker's wrangler.toml there) and `/config.json` breaks.
