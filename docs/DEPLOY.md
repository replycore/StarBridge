# 部署指南

[English](DEPLOY.en.md) · 返回 [README](../README.md)

StarBridge 由两部分组成，分别部署：

| 部分 | 形态 | 内容 |
|---|---|---|
| 后端 | Cloudflare Worker | 网关本体 + 管理 API（源码在 `src/`） |
| 前端 | Cloudflare Pages | 管理后台（源码在 `frontend/`） |

先看第 1 节把资源准备好，再按第 2、3 节部署，最后按第 4 节填好密钥和变量。

## 1. 准备工作

### 创建 D1 和 KV

后端需要一个 D1 数据库和一个 KV 命名空间。两种办法：

**用命令行**（需要先装好 Node.js）：

```bash
npx wrangler d1 create starbridge        # 输出 database_id，记下来
npx wrangler kv namespace create GW_KV        # 输出 id，记下来
```

**在控制台点鼠标**：

1. 登录 Cloudflare 控制台，左侧进入「存储和数据库 → D1 SQL 数据库」，点「创建数据库」，名字填 `starbridge`，创建后复制它的「数据库 ID」。
2. 左侧进入「存储和数据库 → KV」，点「创建命名空间」，名字填 `GW_KV`，创建后复制命名空间 ID。

### Fork 仓库，填上你的资源 ID

把仓库 fork 到你自己的 GitHub 账号（部署按钮和 Git 集成都要用你自己的 fork）。

打开你 fork 里的 `wrangler.toml`，把下面两处占位符换成你自己的 ID：

- `[[d1_databases]]` 里的 `database_id`
- `[[kv_namespaces]]` 里的 `id`

仓库里自带的是占位符，不换成你自己的，部署会在绑定这一步直接报错。

其余东西不用改：Durable Object 和定时任务都写在 `wrangler.toml` 里，随部署自动生效。

## 2. 部署后端（Worker）

### 方式一：一键部署按钮（最快）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/StarBridge)

点按钮之前，先按第 1 节 fork 好仓库、填好你自己的 D1 / KV ID，再把按钮链接里的 `url=` 换成你 fork 的地址。

点按钮后的流程：

1. 登录 Cloudflare 并授权它访问你的 GitHub；
2. 它会按仓库原样创建 Worker 并部署；
3. 部署完成后，进入该 Worker 的「设置 → 变量和密钥」，按第 4 节添加密钥；
4. 前端控制台不在这个流程里，仍需按第 3 节单独部署。

按钮如果报错，改走方式二或三，步骤完全等价。

### 方式二：Git 集成（全程点鼠标，推荐）

适合不想装命令行、又希望以后推送自动部署的情况：

1. 控制台左侧进入「Workers 和 Pages」，点「创建应用程序」→「Workers」→「导入存储库」（连接到 Git）；
2. 授权并选择你 fork 的 `StarBridge` 仓库；
3. 构建设置：项目名称 `starbridge`，根目录 `/`，构建命令留空，部署命令 `npx wrangler deploy`；
4. 点「部署」，等第一次构建完成。`wrangler.toml` 里的绑定、变量、定时任务、Durable Object 都会按文件生效——前提是文件里的 D1 / KV ID 已经换成你自己的（第 1 节）；
5. 部署后进入该 Worker 的「设置 → 变量和密钥」，按第 4 节添加密钥；
6. 之后每次推送到该仓库都会自动重新部署。

### 方式三：命令行（熟悉终端时最快）

```bash
git clone https://github.com/replycore/StarBridge.git
cd StarBridge
npm install
# 按第 1 节创建 D1 / KV，并把 ID 填入 wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put MASTER_KEY     # 32 字节 base64：openssl rand -base64 32
npx wrangler secret put ADMIN_ORIGIN   # 你的控制台域名，逗号分隔，见第 4 节
npx wrangler deploy                    # 或 npm run deploy
```

### 方式四：控制台手动上传（只建议临时验证）

1. 「Workers 和 Pages → 创建应用程序 → Workers → 从 Hello World 开始」，命名 `starbridge` 并部署，先得到一个占位 Worker；
2. 打开该 Worker，点「编辑代码」，在编辑器里删除占位文件，把本仓库 `src/` 目录下的全部文件按相同目录结构上传/新建（入口是 `src/index.js`，其余文件是它 import 的模块，必须全部就位）；
3. 点「部署」保存代码；
4. 进入该 Worker 的「设置」，逐项补齐（缺一不可）：
   - 「绑定」：添加 D1（变量名 `DB`，选第 1 节的数据库）、KV（变量名 `GW_KV`，选第 1 节的命名空间）、Durable Object（变量名 `COORD`，类名 `Coordinator`）；
   - 「变量和密钥」：添加 `wrangler.toml` 的 `[vars]` 里全部普通变量，再加第 4 节的四个密钥；
   - 「触发器」：添加定时任务 `13 1,7,13,19 * * *` 和 `*/15 * * * *`；
   - 运行时兼容性日期设为 `2025-01-15`；
5. 每次在设置里改完绑定/变量，都要重新「部署」一次才生效。

这种方式最容易漏配，只建议临时验证时使用；长期维护请用方式二/三。

### 给后端绑自定义域名（可选）

Worker 概览页 →「设置 → 域和路由 → 添加 → 自定义域」，填你的域名（如 `api.example.com`，该域名必须已托管在本账号的 Cloudflare DNS 下）。绑定后模型 Base URL 就是 `https://api.example.com/v1`。

## 3. 部署前端（Pages）

### 方式一：命令行（推荐）

**必须在 `frontend/` 目录内执行**：

```bash
cd frontend
npx wrangler pages deploy . --project-name starbridge-admin
# 或在仓库根目录：npm run deploy:ui
```

在仓库根目录部署会漏掉 `functions/`（Pages Function 不生效，`/config.json` 失效、前端拿不到后端地址），这是最常见的部署错误。

部署后按本节末尾「设置 GW_API_BASE」给项目加变量。

### 方式二：Pages Git 集成（界面操作）

1. 「Workers 和 Pages → 创建应用程序 → Pages → 连接到 Git」，授权并选择 `StarBridge` 仓库；
2. 构建设置：
   - 项目名称：`starbridge-admin`
   - 框架预设：无 / None
   - 根目录：`frontend`
   - 构建命令：留空（纯静态站，无需构建）
   - 构建输出目录：`/`（即 `frontend` 根目录）
3. 点「保存并部署」，等第一次部署完成；
4. 按本节末尾「设置 GW_API_BASE」给项目加变量，加完后到「部署」页对最新部署点「重试部署」/重新推送一次让变量生效。

之后每次推送都会自动部署。

### 方式三：控制台直接上传（界面操作）

1. 「Workers 和 Pages → 创建应用程序 → Pages → 上传资产」，项目名填 `starbridge-admin`；
2. 把本仓库 `frontend/` 目录**里面的全部内容**整体拖进上传区（`index.html`、`_headers`、`sw.js`、`manifest.webmanifest`、图标文件和 `functions/` 文件夹，一个都不能少；可以拖文件夹或 zip），点「部署站点」；
3. 注意 `functions/` 必须包含在内，否则 `/config.json` 不工作、登录页会提示后端未配置；`sw.js`、`manifest.webmanifest` 和图标文件缺了则 PWA 和 favicon 失效；
4. 按本节末尾「设置 GW_API_BASE」给项目加变量；
5. 以后更新：进入该项目 →「创建部署」→ 重新上传新版文件。

### 设置 GW_API_BASE（三种方式都要做）

进入 Pages 项目 →「设置 → 环境变量」→ 为 **Production** 环境添加变量 `GW_API_BASE`，值是后端 Worker 的完整地址（如 `https://api.example.com`，只写域名、不要带 `/v1`）。仓库默认关了 `workers.dev`（`wrangler.toml` 里 `workers_dev = false`），所以新部署没有 `*.workers.dev` 地址可用——想用它先把 `workers_dev` 改成 `true` 并重新部署后端。如需在 Preview 环境调试，同样加一份。

### 给前端绑自定义域名（可选）

Pages 项目 →「自定义域 → 设置自定义域」，填你的域名（如 `console.example.com`）。绑定新域名后，记得把它加进后端 Worker 的 `ADMIN_ORIGIN` 密钥（第 4 节）。

## 4. 要填的东西

密钥用 `wrangler secret put <名字>` 设置，或在控制台 Worker →「设置 → 变量和密钥 → 添加」里添加，类型选「密钥」。密钥永远不要写进任何文件或仓库。

### Worker 密钥

| 密钥 | 用途 |
|---|---|
| `ADMIN_TOKEN` | 管理后台登录的凭证，自己设一个足够长的随机串 |
| `GATEWAY_TOKEN` | 内置的调用方 Token（客户端调 `/v1/*` 时用；也可以在后台里另发可撤销的调用 Key） |
| `MASTER_KEY` | 加密存储服务商 Key 的主密钥，必须是 **32 字节的 base64**（`openssl rand -base64 32`）。一旦更换，之前保存的服务商 Key 将无法解密，需要重新录入 |
| `ADMIN_ORIGIN` | 你的控制台域名，逗号分隔，例如 `https://your-pages-domain.pages.dev,https://console.example.com`。Pages 的 `*.pages.dev` 地址和自定义域名都要列全。改完即刻生效，不用重新部署后端 |

### Pages 变量

| 变量 | 必填 | 用途 |
|---|---|---|
| `GW_API_BASE` | 是 | 后端 Worker 的完整地址，如 `https://api.example.com`（只写域名，不要带 `/v1`）。前端启动时通过 Pages Function 提供的 `/config.json` 读取它 |

其它变量都在 `wrangler.toml` 的 `[vars]` 里，默认值够用，不用改。

## 5. 部署后清单

1. 四个密钥已设置（第 4 节），`wrangler.toml` 里是**你自己**的 D1 / KV ID。
2. `curl https://<你的后端域名>/healthz` 返回 200。
3. 打开控制台，用 `ADMIN_TOKEN` 登录，在「服务商」里添加上游服务商和 Key。
4. 点「同步模型」跑一次目录同步，模型目录里能看到模型。**顺序不能反**：没有服务商时点同步跑不出任何模型。
5. 在「调用」页确认 Base URL，用 `GATEWAY_TOKEN` 或新发的调用 Key 从客户端调一次验证；也可以直接在模型目录里点开任意模型的测试聊天验证。
6. （可选）自定义域名：后端在 Worker 的「设置 → 域和路由」里绑定，前端在 Pages 项目的「自定义域」里绑定；绑定新前端域名后记得同步更新 `ADMIN_ORIGIN`。

## 6. 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入本地用的假 token 和本地 MASTER_KEY
npm run dev                      # 后端 http://127.0.0.1:8787
npm run dev:ui                   # 前端 http://127.0.0.1:8788（GW_API_BASE 指向本地后端）
```

## 7. 常见问题

- **登录页提示后端未配置 / 无法连接**：Pages 的 `GW_API_BASE` 没设或写错（不要带 `/v1`、不要带末尾斜杠）。改完变量后要重新部署 Pages 才生效。
- **`/config.json` 返回 404 或不是 JSON**：前端部署时漏了 `functions/`——多半是从仓库根目录而不是 `frontend/` 里部署的。按第 3 节重部署。
- **模型目录一直是空的**：先在控制台点「同步模型」手动跑一次；还不行就检查是否已添加服务商与 Key、`SYNC_ENABLED` 是否为 `true`，以及 Worker 的「日志/实时日志」里同步有没有报错。
- **一键按钮部署失败（绑定报错）**：`wrangler.toml` 里的 D1 / KV ID 还是占位符。先 fork 仓库、按第 1 节在自己账号建资源、改 `wrangler.toml` 后再部署。
