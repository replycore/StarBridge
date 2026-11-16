# free-ai-gateway

[English](README.en.md)

一个跑在 Cloudflare Worker 上的 AI 网关，兼容 OpenAI / Anthropic /
Gemini 三种协议。它把多家上游免费模型服务商聚合到一个端点后面，维护
一份同步的模型目录，并按健康度为每个请求在多个服务商之间排序、故障
转移，带每 Key 配额。

- **后端：** https://api.reply.kdns.fr — 模型 Base URL 为 `https://api.reply.kdns.fr/v1`
- **管理后台：** https://ai.reply.kdns.fr（Cloudflare Pages，源码在 `frontend/`，支持中文 / English 界面切换；模型目录里每个模型都能直接打开测试聊天，支持多轮对话与文件附件）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/free-ai-gateway)

> 一键按钮只部署后端 Worker，且绑定、密钥、前端都要再手动补齐——
> 完整说明见 [部署指南](docs/DEPLOY.md)。

## 接口

- `POST /v1/chat/completions`、`GET /v1/models`（OpenAI）
- `POST /v1/messages`、`POST /v1/messages/count_tokens`（Anthropic）
- `GET /v1beta/models`、`POST /v1beta/models/{model}:generateContent`（Gemini）
- 透传：`/v1/audio/*`、`/v1/images/*`、`/v1/embeddings`、
  `/v1/completions`、`/v1/responses`、`/v1/moderations`、`/v1/ocr`、
  `/v1/systemone`
- `GET /healthz`、`GET /` — 只返回 JSON 状态；Worker 不提供任何页面
- `/admin/api/*` — 管理 API（见下）；`/admin` 下的其它路径一律 JSON 404

## 工作方式

- **模型目录。** cron（`13 1,7,13,19 * * *`）把每个服务商的模型列表
  同步进 KV 里的目录，并清理 90 天前的用量记录。模型被组织成
  *映射组*（一个对外模型 ID 背后挂一个或多个服务商端点）和家族，
  `auto` 别名会为每个家族挑当前最可用的模型。
- **路由。** 一个 Durable Object（`Coordinator`）为每个请求给候选
  端点排序，权重综合配置权重与实时健康度：成功率、延迟、每日剩余额度、
  近期失败。每个映射组有自己的路由策略：
  - `balance`（默认）— 按权重随机分摊到各端点；
  - `failover` — 确定性的最优优先顺序，粘住最优端点，它失败了才换下一个。
  策略按组存在 KV（`cfg:group-strategies:v1`），可在管理后台切换，
  或用 `POST /admin/api/groups` 设置。
- **自定义模型。** 管理员可以定义自己的模型 ID 并配一组关键词：
  目录里模型名包含任一关键词（不区分大小写、子串匹配）的端点
  自动归入该模型，出现在 `/v1/models` 中，可被三种兼容接口调用，
  同样支持按组路由策略。定义存在 KV（`cfg:custom-groups:v1`），
  用 `POST /admin/api/groups/custom` 创建/更新、
  `DELETE /admin/api/groups/custom?id=…` 删除；与目录模型重名的
  ID 会被拒绝，暂时匹配不到端点的自定义模型只在后台列表中显示。
- **上下文感知路由。** 网关会粗略估算每个请求的 token 数（文本按
  字符估算、图片按固定值、再加上请求的输出预算），优先把请求发给
  上下文窗口装得下的端点；若上游仍返回上下文超限错误，不再直接
  失败，而是自动换下一个端点重试，直到有端点装得下或全部试完。
  因上游不支持而被丢弃的请求参数会通过响应头
  `x-gw-dropped-params` 标明；参数名优先从上游错误正文的结构化
  `param` 字段读取，识别出参数后会在同一次请求内立即去掉该参数
  重试当前端点，并记住该服务商不支持这个参数，后续请求直接避开。
- **熔断。** 上游的瞬时失败（服务器错误 / 网络 / 超时）按服务商 Key
  （跨全部模型）和按模型端点分别累计连续次数；达到
  `BREAKER_THRESHOLD`（默认 3）后，该 Key 进入
  `BREAKER_COOLDOWN_MS`（默认 5 分钟）冷却，端点的短暂暂停也升级为
  同样时长的冷却。任意一次成功会清零计数。
- **无容量时的恢复提示。** 当所有候选都不可用返回 503（`no_capacity`）时，响应会给出最早恢复时间：`Retry-After` 头和正文的 `retry_after`（秒）取各候选冷却 / 熔断 / 暂停 / 额度重置中最早的一个，`hint` 也按实际原因（冷却中 / 每日额度用完 / Key 失效）说明，方便 agent 客户端按提示退避重试，而不是盲目撞墙。
- **配额。** 服务商 Key 带每日上限和 RPM 上限，由 Coordinator 跟踪。
  RPM 是事后计数，突发瞬间可能小幅超过上限。
- **用量记账。** 每次调用都记入 D1 的 `usage` 表（服务商、模型、
  Key、Token、延迟、状态）。写入先在 isolate 里缓冲，攒满 20 条或
  4 秒后以一次 D1 batch 落库；管理端读取和 cron 会先把缓冲刷完，
  写失败的批次会重新排队。表在首次使用时自动创建（`ensureSchema`），
  `schema.sql` 里是同一份 DDL，供参考或手动建表。

## 管理 API 与安全模型

- 认证只有一种：`ADMIN_TOKEN` 以 `Authorization: Bearer …` 发送。
  没有 query 参数或 cookie 认证。
- 浏览器对 `/admin/api/*` 的调用必须来自 `ADMIN_ORIGIN` 变量列出的
  来源（控制台域名），其它来源连同其预检请求一律 403。没有
  `Origin` 头的请求（curl、脚本）不受影响。
- 管理端认证失败按客户端 IP 在 Coordinator 里计数：达到
  `ADMIN_AUTH_MAX_FAILS`（默认 10 次）后该 IP 被锁定
  `ADMIN_AUTH_LOCKOUT_MS`（默认 15 分钟），期间即使 token 正确也
  返回 `429` + `Retry-After`。登录成功会清零计数；Coordinator
  不可达时节流放行（fail-open），token 校验本身照常。
- 服务商 API Key 用 `MASTER_KEY` 做 AES-GCM 加密存储，管理 API
  只返回掩码。
- 调用方用 `GATEWAY_TOKEN` 密钥，或在后台「调用接入」里签发的
  调用 Key（可单独撤销）认证。
- 主要路由：`GET /admin/api/overview`、`/providers`（GET/POST、
  `/providers/{id}`、`/providers/{id}/keys`）、`/gateway-keys`、
  `/groups`（GET/POST）、`/catalog`、`/stats`，`POST /sync`、
  `/probe`、`/reset`。

## 仓库结构

- `index.js` — 后端 Worker，单文件包，也是唯一的源码事实来源；
  所有后端开发都在这个文件里进行。
- `wrangler.toml` — 绑定、变量、cron 配置，不含任何密钥。
- `schema.sql` — D1 `usage` 表的 DDL（参考；Worker 也会自动建表）。
- `frontend/` — 管理后台（静态站 + 一个 Pages Function），部署到
  Pages 项目 `free-ai-gateway-admin`；界面文案全部走词条字典，
  中文 / English 可切换并记住选择。
- `docs/` — [部署指南](docs/DEPLOY.md)（[English](docs/DEPLOY.en.md)）：
  前后端的各种部署方式、完整变量表和部署后清单。
- `tests/` — 本地验证脚本（mock 上游、API 测试、浏览器测试），
  配合 `wrangler dev` 使用；每个文件头部有说明。
- `package.json` — 常用命令脚本（见下）。
- `.dev.vars.example` — 本地开发密钥模板，复制为 `.dev.vars` 使用
  （`.dev.vars` 已被 gitignore，永远不要提交真实密钥）。

## 配置速览

绑定（见 `wrangler.toml`）：D1 `DB`、KV `GW_KV`、Durable Object
`COORD`（类 `Coordinator`）。

密钥（Cloudflare `secret_text`，不进仓库）：

```bash
wrangler secret put ADMIN_TOKEN     # 管理后台 / 管理 API
wrangler secret put GATEWAY_TOKEN   # 内置调用方 Token
wrangler secret put MASTER_KEY      # 加密服务商 Key（32 字节 base64）
```

普通变量都在 `wrangler.toml` 的 `[vars]` 里并带注释：`ADMIN_ORIGIN`、
`DEFAULT_ALIAS`、`KEEP_PER_FAMILY`、`MAX_ATTEMPTS`、`MODEL_GROUPING`、
`PROBE_PER_SYNC`、`SYNC_ENABLED`、`UPSTREAM_TIMEOUT_MS`，以及上面
提到的熔断 / 登录节流参数。每项的含义和默认值见
[部署指南的变量总表](docs/DEPLOY.md#3-变量设置总表)。

Pages 侧只需要一个变量：`GW_API_BASE`（后端完整地址），由 Pages
Function 通过 `/config.json` 提供给前端。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填本地假 token 即可
npm run dev                      # 后端 http://127.0.0.1:8787
npm run dev:ui                   # 前端 http://127.0.0.1:8788（已绑定本地后端地址）

# 手动触发一次 cron 处理
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

## 部署

```bash
npm run deploy       # 后端：仓库根目录执行 wrangler deploy
npm run deploy:ui    # 前端：脚本会进入 frontend/ 再部署（从根目录直接
                     # 部署 Pages 会漏掉 Functions 包，/config.json 会失效）
```

第一次部署（含创建 D1 / KV、设置密钥、一键部署按钮的说明、Git
集成、控制台手动部署等方式）请看 [部署指南](docs/DEPLOY.md)。
