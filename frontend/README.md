# free-ai-gateway 管理后台（frontend，Cloudflare Pages）

[English below](#english)

free-ai-gateway 后端的管理控制台，部署为 Pages 项目
`free-ai-gateway-admin`，自定义域名 https://ai.reply.kdns.fr 。
标签页式单页应用：总览 / 调用 / 服务商 / 映射组 / 模型目录 /
用量与记录；桌面端侧边栏，移动端底部标签栏。顶栏有「自动刷新」
开关，默认关闭；开启后每 30 秒轮询一次管理 API——只刷当前标签页
的数据，页面隐藏时暂停，选择记在 localStorage（`gw_autorefresh`）。

- **测试聊天：** 模型目录和映射组每行都有「测试聊天」按钮，打开聊天抽屉，
  用后台已知的调用 Key（内置 `GATEWAY_TOKEN` 条目或后台签发的 Key）
  经网关自己的 `/v1/chat/completions` 流式调用该模型，多轮对话按
  模型分别保存。附件支持点选、拖放和粘贴：图片以 `image_url`
  部件发送（视觉输入），文本文件内容内嵌进消息，其它文件以
  OpenAI `file` 部件（base64 data URL）发送——上游是否接受文件
  部件取决于模型本身。
- **自定义模型：** 映射组页可「添加自定义模型」：填一个模型 ID 和
  一组关键词（每行一个），弹窗会基于已加载的目录实时预览匹配到的
  端点；自定义组在列表里带「自定义」徽章和关键词行，可编辑关键词、
  可删除，同样支持测试聊天与路由策略。
- **多语言：** 全部界面文案走脚本顶部的词条字典 `STR`，中文 /
  English 可在登录页和侧边栏切换，选择记在 localStorage
  （`gw_lang`），首次访问跟随浏览器语言。新增文案时给两种语言
  各加一条词条，静态文本用 `data-i18n` 属性、动态文本用 `t()`。
- **后端地址由 Pages 变量固定。** `functions/_middleware.js` 用
  `{ "apiBase": env.GW_API_BASE }` 回答 `GET /config.json`。在
  Pages 项目设置里（Production + Preview）设置 `GW_API_BASE`——
  界面里没有后端地址输入框，用户改不了指向。变量缺失时
  `apiBase` 为空（按同源处理，适合反代场景）；拿不到
  `/config.json` 时登录页直接报配置错误，不会把 token 发往
  任何猜测的地址。
- **登录：** 只用 ADMIN_TOKEN，存在 localStorage 里、以
  `Authorization: Bearer …` 发送——不进 URL、不用 cookie。后端
  Worker 不提供任何页面，`/admin/api/*` 是唯一的管理入口。
- **来源校验：** Worker 的 `ADMIN_ORIGIN` 变量列出允许的前端来源；
  其它来源对 `/admin/api/*` 的浏览器调用（含预检）一律 403。
- **安全头：** CSP 由 `functions/_middleware.js` 按
  `GW_API_BASE` 现算 `connect-src` 后下发（self + 本单文件应用
  所需的 inline、后端来源与 Cloudflare 分析在白名单内）；
  `_headers` 设置其余安全头：
  `X-Frame-Options: DENY`、`nosniff`、`no-referrer`、收紧的
  Permissions-Policy 和 HSTS。

## 部署

**在本目录内**执行：

```bash
npx wrangler pages deploy . --project-name free-ai-gateway-admin
# 或在仓库根目录：npm run deploy:ui
```

从仓库根目录部署会悄悄漏掉 `functions/`（根目录的 Worker
wrangler.toml 会干扰 wrangler），`/config.json` 随之失效。其它
部署方式（Pages Git 集成、控制台直传）和完整变量说明见
[部署指南](../docs/DEPLOY.md)。

---

## English

Static admin console for the free-ai-gateway Worker, deployed as the
Pages project `free-ai-gateway-admin`, custom domain
https://ai.reply.kdns.fr. A tabbed single-page app: Overview /
API Access / Providers / Mapping Groups / Model Catalog /
Usage & Records, with a sidebar on desktop and a bottom tab bar on
mobile. The top bar has an Auto-refresh toggle, off by default; when
on, it polls the admin API every 30 s — only the active tab's data,
paused while the page is hidden. The choice persists in localStorage
(`gw_autorefresh`).

- **Test chat:** every model-catalog and mapping-group row has a
  Test Chat button that opens a chat drawer. It calls the model through the gateway's own
  `/v1/chat/completions` (streaming) with a gateway key the console
  already knows (the built-in `GATEWAY_TOKEN` entry or a
  console-issued key); conversations are kept per model. Attachments
  work via picker, drag & drop and paste: images are sent as
  `image_url` parts (vision input), text files are inlined into the
  message, and other files are sent as OpenAI `file` parts (base64
  data URLs) — whether an upstream accepts file parts depends on the
  model.
- **Custom models:** the Mapping Groups tab can add custom models: a
  model id plus keywords (one per line). The dialog previews matching
  endpoints live from the loaded catalog; custom groups carry a badge
  and their keywords in the list, can be edited and deleted, and
  support test chat and routing strategies like derived groups.
- **Languages:** every UI string goes through the `STR` dictionary at
  the top of the script. 中文 / English can be switched on the login
  page and in the sidebar; the choice persists in localStorage
  (`gw_lang`) and the first visit follows the browser language. When
  adding copy, add a string-table entry for both languages — static
  text via `data-i18n` attributes, dynamic text via `t()`.
- **Backend address is fixed by a Pages variable.**
  `functions/_middleware.js` answers `GET /config.json` with
  `{ "apiBase": env.GW_API_BASE }`. Set `GW_API_BASE` in the Pages
  project settings (production + preview) — the UI has no
  backend-address field and users cannot repoint the console.
  If the variable is missing, `apiBase` is empty (same-origin,
  for reverse-proxy setups); if `/config.json` cannot be loaded
  at all, the login page reports a configuration error and sends
  nothing anywhere.
- **Login:** ADMIN_TOKEN only. It is kept in localStorage and sent as
  `Authorization: Bearer …` — never in a URL, never as a cookie. The
  Worker serves no pages; `/admin/api/*` is the only admin surface.
- **Origin check:** the Worker's `ADMIN_ORIGIN` variable lists the
  allowed frontend origins; browser calls to `/admin/api/*` (including
  preflight) from any other origin get a 403.
- **Security headers:** the CSP is computed by
  `functions/_middleware.js` from `GW_API_BASE` (its connect-src
  names the configured backend origin; self + inline for this
  single-file app, Cloudflare analytics allowlisted); `_headers`
  sets the remaining headers: `X-Frame-Options: DENY`, `nosniff`,
  `no-referrer`, a restrictive Permissions-Policy and HSTS.

## Deploy

Run from INSIDE this directory:

```bash
npx wrangler pages deploy . --project-name free-ai-gateway-admin
# or from the repo root: npm run deploy:ui
```

Deploying from the repo root silently skips `functions/` (wrangler
gets confused by the Worker's wrangler.toml there) and `/config.json`
breaks. For the other deployment paths (Pages Git integration,
dashboard upload) and the full variables reference, see the
[deployment guide](../docs/DEPLOY.en.md).
