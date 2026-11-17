# 部署指南

[English](DEPLOY.en.md) · 返回 [README](../README.md)

free-ai-gateway 由两部分组成，分别部署：

| 部分 | 形态 | 内容 |
|---|---|---|
| 后端 | Cloudflare Worker | 网关本体 + 管理 API（`src/` 模块化源码） |
| 前端 | Cloudflare Pages | 管理后台（`frontend/` 静态站 + 一个 Pages Function） |

## 0. 前置资源

后端需要四样 Cloudflare 资源。Durable Object 和 cron 写在 `wrangler.toml`
里、随部署自动生效；D1 和 KV 需要先创建，再把生成的 ID 填进
`wrangler.toml`（仓库里的 ID 是作者线上环境的，部署你自己的实例时必须换掉）。

用 wrangler 创建：

```bash
npx wrangler d1 create free-ai-gateway        # 输出 database_id → 填 wrangler.toml 的 [[d1_databases]]
npx wrangler kv namespace create GW_KV        # 输出 id → 填 wrangler.toml 的 [[kv_namespaces]]
```

也可以在 Cloudflare 控制台创建：D1 在「存储和数据库 → D1」里新建数据库，
KV 在「存储和数据库 → KV」里新建命名空间，然后把 ID 抄进 `wrangler.toml`。

- **D1 `DB`**：用量记录表 `usage`，首次请求时由 Worker 自动建表
  （`schema.sql` 是同一份 DDL，可参考或手动执行）。
- **KV `GW_KV`**：服务商配置、模型目录、网关 Key 等。
- **Durable Object `COORD`**（类名 `Coordinator`）：路由排序、限流、
  熔断与登录节流的协调者。`wrangler.toml` 里的 `[[migrations]]`
  会在首次部署时创建它，不需要手动操作。
- **Cron**：`13 1,7,13,19 * * *`（每天 4 次），同步模型目录并清理
  90 天前的用量记录，同样来自 `wrangler.toml`。

## 1. 部署后端（Worker）

### 方式一：一键部署按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/free-ai-gateway)

Cloudflare 官方的部署流程会把本仓库克隆到你的 GitHub 账号，并按
`wrangler.toml` 创建 Worker 并部署。需要注意它**不是全自动的**：

- 流程中/部署后，要把 D1、KV 绑定换成你自己账号里的资源（见第 0 节）；
- 三个 secret（`ADMIN_TOKEN`、`GATEWAY_TOKEN`、`MASTER_KEY`）要在
  Worker 的「设置 → 变量和密钥」里手动添加（见第 3 节）；
- 前端控制台不在这个流程里，仍需按第 2 节单独部署；
- 本按钮流程未做端到端实测，遇到问题请改走方式二，步骤完全等价。

### 方式二：wrangler CLI（推荐）

```bash
git clone https://github.com/replycore/free-ai-gateway.git
cd free-ai-gateway
# 按第 0 节创建 D1 / KV，并把 ID 填入 wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put MASTER_KEY     # 32 字节 base64：openssl rand -base64 32
npx wrangler deploy                    # 或 npm run deploy
```

### 方式三：Git 集成（Workers Builds）

在控制台「Workers 和 Pages → 创建 → 导入存储库」连接你的 GitHub 仓库，
构建设置：根目录 `/`，部署命令 `npx wrangler deploy`。之后每次推送到
仓库都会自动部署。绑定、变量和 secret 仍在控制台里配置（见第 3 节）。

### 方式四：控制台手动上传

在控制台「Workers 和 Pages → 创建 Worker」新建一个 Worker，进入
「编辑代码」把 `src/` 目录的全部文件按相同目录结构上传（入口为
`src/index.js`），然后到「设置」里逐项
补齐：绑定（D1、KV、Durable Object，类名 `Coordinator`）、变量
（第 3 节的 vars）、密钥（三个 secret）、触发器里的 cron
`13 1,7,13,19 * * *`，兼容性日期设为 `2025-01-15`。这种方式最容易
漏配，只建议临时验证时使用。

## 2. 部署前端（Pages）

### 方式一：wrangler pages deploy（推荐）

**必须在 `frontend/` 目录内执行**：

```bash
cd frontend
npx wrangler pages deploy . --project-name free-ai-gateway-admin
# 或在仓库根目录：npm run deploy:ui
```

在仓库根目录部署会漏掉 `functions/`（Pages Function 不生效，
`/config.json` 失效、前端拿不到后端地址），这是最常见的部署错误。

部署后在 Pages 项目「设置 → 环境变量」里给 Production（和 Preview，
如需要）设置 `GW_API_BASE`（见第 3 节）。

### 方式二：Pages Git 集成

在控制台「Workers 和 Pages → 创建 → Pages → 连接到 Git」选择仓库，
构建设置：

- 框架预设：无 / None
- 根目录：`frontend`
- 构建命令：留空（纯静态站，无需构建）
- 构建输出目录：`/`（即 `frontend` 根目录）

然后在项目设置里加环境变量 `GW_API_BASE`。之后推送自动部署。

### 方式三：控制台直接上传

在控制台创建 Pages 项目时选「上传资产」，把 `frontend/` 目录里的
**内容**（`index.html`、`_headers`、`functions/`）打包上传。注意
`functions/` 必须包含在内，否则 `/config.json` 不工作。

## 3. 变量设置总表

### Worker 变量（`wrangler.toml` 的 `[vars]`，也可在控制台改）

| 变量 | 默认值 | 用途 |
|---|---|---|
| `ADMIN_ORIGIN` | （作者的控制台域名） | 允许调用 `/admin/api/*` 的浏览器来源白名单，逗号分隔。**换成你自己的控制台域名**，否则后台登录会被 403 |
| `DEFAULT_ALIAS` | `auto` | `auto` 别名指向的默认家族策略 |
| `KEEP_PER_FAMILY` | `4` | 每个模型家族在目录里保留的条数 |
| `MAX_ATTEMPTS` | `6` | 单个请求最多尝试的上游端点数 |
| `MODEL_GROUPING` | `on` | 是否把多服务商的同名模型合并为映射组 |
| `PROBE_PER_SYNC` | `0` | 每次同步顺带探测的模型数（0 = 不探测） |
| `SYNC_ENABLED` | `true` | 是否启用 cron 目录同步 |
| `UPSTREAM_TIMEOUT_MS` | `90000` | 单次上游请求超时（毫秒） |
| `BREAKER_THRESHOLD` | `3` | 熔断阈值：同一 Key 连续瞬时失败多少次后进入冷却 |
| `BREAKER_COOLDOWN_MS` | `300000` | 熔断冷却时长（毫秒，默认 5 分钟） |
| `ADMIN_AUTH_MAX_FAILS` | `10` | 管理登录连续失败多少次后锁定该 IP |
| `ADMIN_AUTH_LOCKOUT_MS` | `900000` | 登录锁定时长（毫秒，默认 15 分钟） |

### Worker 密钥（secret，只能通过 `wrangler secret put` 或控制台设置，**不要写进任何文件**）

| 密钥 | 用途 |
|---|---|
| `ADMIN_TOKEN` | 管理后台登录与管理 API 的 Bearer 凭证，自己设一个足够长的随机串 |
| `GATEWAY_TOKEN` | 内置的调用方 Token（客户端调 `/v1/*` 时用；也可以在后台里另发可撤销的调用 Key） |
| `MASTER_KEY` | 加密存储服务商 Key 的主密钥，必须是 **32 字节的 base64**（`openssl rand -base64 32`）。一旦更换，之前保存的服务商 Key 将无法解密，需要重新录入 |

### Worker 绑定

| 绑定名 | 类型 | 说明 |
|---|---|---|
| `DB` | D1 | 用量记录（见第 0 节） |
| `GW_KV` | KV | 配置与目录存储（见第 0 节） |
| `COORD` | Durable Object | 类名 `Coordinator`，由迁移自动创建 |

### Pages 变量

| 变量 | 必填 | 用途 |
|---|---|---|
| `GW_API_BASE` | 是 | 后端 Worker 的完整地址，如 `https://api.example.com`（只写域名，不要带 `/v1`）。前端启动时通过 Pages Function 提供的 `/config.json` 读取它；缺失时回退到作者的线上后端，所以**自部署时务必设置** |

## 4. 部署后清单

1. 三个 secret 已设置（第 3 节），`wrangler.toml` 里是**你自己**的
   D1 / KV ID。
2. `ADMIN_ORIGIN` 已改成你的控制台实际域名（Pages 的 `*.pages.dev`
   地址和自定义域名都要列全），改后重新部署 Worker。
3. 打开控制台，用 `ADMIN_TOKEN` 登录，点「同步模型」跑一次目录同步。
4. 在「服务商」标签里添加上游服务商和 Key。
5. 在「调用接入」里确认 Base URL，用 `GATEWAY_TOKEN` 或新发的调用
   Key 从客户端调一次 `/v1/chat/completions` 验证。
6. （可选）自定义域名：后端在 Worker 的「设置 → 域和路由」里绑定，
   前端在 Pages 项目的「自定义域」里绑定；绑定新前端域名后记得
   同步更新 `ADMIN_ORIGIN`。

## 5. 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入本地用的假 token 和本地 MASTER_KEY
npm run dev                      # 后端 http://127.0.0.1:8787
npm run dev:ui                   # 前端 http://127.0.0.1:8788（GW_API_BASE 指向本地后端）
```
