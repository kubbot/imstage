# 账号自有的 ChatGPT / MCP 连接

状态：2026-09-23。账号接入已实现；本地协议、浏览器与真实 PNG 渲染验证见 [验收记录](../design/CHATGPT-ONBOARDING.md)。上线及 ChatGPT 宿主验收独立记录，公开目录尚未提交。

## 两种 MCP，不要混淆

| | 独立实例 MCP | 账号自有 MCP（本轮） |
| --- | --- | --- |
| 入口 | `services/mcp/server.mjs`，默认 `127.0.0.1:4421/mcp` | 既有账号 API 进程的 `/api/mcp` |
| 认证 | 单个 `IMSTAGE_MCP_TOKEN` Bearer | OAuth 2.1（授权码 + S256 PKCE）或用户创建的私人令牌 |
| 数据 | 独立 `IMSTAGE_MCP_DATA_DIR` 的实例数据库 | 既有账号 SQLite 的 `scenes` 表，按 `user_id` 隔离 |
| 工具 | 16 个，含 projects/templates/batches | 6 个作品工具，不含实例项目管理 |
| 作品归属 | 单实例 | 属于登录账号，与网页“我的作品”同一份数据 |

独立实例 MCP 的行为未改变（`tests/mcp.test.mjs` 仍通过）；账号端点不会暴露实例项目/模板/批次工具，也不会读写独立实例数据库。

## 账号 MCP 工具

- `imstage_get_capabilities`
- `imstage_list_scenes`（只返回摘要与 `webUrl`，不含完整场景或渲染数据）
- `imstage_create_scene`（服务端生成 UUID；支持 `idempotencyKey`）
- `imstage_get_scene`
- `imstage_update_scene`（`expectedRevision` 乐观并发 + 定向 patch）
- `imstage_render_scene`（复用同一确定性渲染器；PNG 缓存按账号隔离）

create/get/update/render/list 的结果都带
`webUrl = <appOrigin>/#/workspace?scene=<sceneId>`，ChatGPT 可直接打开同一份已保存作品。

## 前端契约

所有会话接口使用 `imstage_session` Cookie（HttpOnly），变更请求必须是同源 JSON、带 `Origin` 与 `X-IMStage-Request: 1`。连接管理 DELETE 也要带 JSON body（`{}`）。

### 连接页

连接页先选择客户端（ChatGPT / Codex / 其他客户端），再展示各自的接入步骤；默认 ChatGPT。选中的客户端会写入 `#/connect?client=codex|other`，登录链接通过 `next` 保留该目标，登录后回到同一选择。页面不提供任何自造的“一键连接”深链或私有协议，只展示官方文档与客户端自身的命令/入口。

ChatGPT 的主步骤只有两步：先在 ChatGPT 里添加应用（名称 IMStage、Server URL、Authentication 选 OAuth），再登录并明确确认授权。入口名称随版本变化（Add plugin / Create plugin，旧版本为 Create app / Create MCP App），步骤文案列出这些变体并链接官方说明，不写死单一入口。添加应用之前不要求先登录网站；OAuth 由 ChatGPT 发起，同意页会带上登录步骤，网站登录只用于确认这次授权。账号登录也用于管理已有连接（查看、刷新、断开），在页面上作为次级入口放在步骤之后；同意页的“登录并继续”仍是明确的授权前置。ChatGPT 的主操作是“复制地址并打开 ChatGPT”：同一个点击里先启动剪贴板写入、再同步打开 Plugins 页面，两者都不丢用户手势；剪贴板失败与弹窗被拦截分别提示，并保留下方可选中的只读地址与独立的“打开 ChatGPT”链接。首页只保留一句话标题、CTA、创作示例与简短的“首次手动添加并授权”说明，不再构造或展示连接地址（预览/自定义域名与服务端 `appOrigin` 可能不同，连接页以服务端配置为准）。

1. `GET /api/connections/config`（公开）
   ```json
   { "mcpUrl": "https://imstage.org/api/mcp", "authorizationSupported": true, "directoryUrl": null, "manualSetupRequired": true, "loopbackRedirectsSupported": true }
   ```
   展示 `mcpUrl` 供手动添加；`directoryUrl` 为 `null`，不要写“已在目录发布”。`loopbackRedirectsSupported` 表示服务端是否接受 `http://localhost|127.0.0.1|[::1]` 的 RFC 8252 回环回调（默认 true；显式关闭时为 false）。
2. `GET /api/connections` → `{ items: [{ id, clientName, createdAt, lastUsedAt, toolsDiscoveredAt, status, scopes, kind }] }`
   `kind` 为 `oauth` 或 `token`；列表永远不含令牌或哈希。
   - `lastUsedAt`：某个 token 至少被校验过一次（真实认证）。
   - `toolsDiscoveredAt`：MCP `tools/list` 真实成功过一次（工具发现证据）。
   - `status`：`awaiting_auth`（已授权但客户端尚未认证）→ `authenticated`（已认证、等待工具发现）→ `connected`（工具发现成功）。只有 `connected` 才能展示“已连接”。
3. `DELETE /api/connections/:id` → `{ ok: true }`
4. `POST /api/connections/tokens`，JSON `{ name }` → `{ token, connection }`
   `token` 只在这次响应出现一次，请立即展示并提示“只显示一次”；不要放进 URL、日志或本地长期存储。个人令牌收在连接页的“高级接入”折叠区内，普通 OAuth 流程不展示令牌。

### 各客户端入口

- **ChatGPT**：手动在 Plugins 点击加号，选择 Add plugin / Create plugin（不同版本也可能显示 Create app / Create MCP App），添加 `mcpUrl`，Authentication 选 OAuth；之后在同意页登录并点击“允许连接”。官方说明见 <https://developers.openai.com/plugins/deploy/connect-chatgpt>。
- **Codex**：使用 Codex CLI 官方命令（本机 `codex mcp add --help` / `codex mcp login --help` 已验证，codex-cli 0.149+）：
  ```bash
  codex mcp add imstage --url <mcpUrl>
  codex mcp login imstage
  ```
  第二条命令会在浏览器中走 OAuth 授权，授权后自动回到本机 Codex，不需要复制令牌。若服务端显式关闭回环回调，UI 会引导改用个人访问令牌。
- **其他客户端**：添加远程 / Streamable HTTP MCP 服务器 `mcpUrl`，认证选 OAuth 2.1（授权码 + PKCE）；只支持 Bearer 的客户端使用高级个人访问令牌。

### 原生客户端回环回调（RFC 8252 §7.3）

- 仅允许 `localhost`、`127.0.0.1`、`[::1]` 三个显式主机的 `http://` 回调；任何其他 HTTP 主机（含 `localhost.evil.com`、`127.0.0.1.evil.com`、公网域名）都被动态注册拒绝。
- 本地端口可以随机：注册可以是 `http://127.0.0.1:4555/callback`，实际回调可以是 `http://127.0.0.1:51234/callback`。这只放宽端口，方案（http/https）、主机、路径、查询必须完全一致，由 MCP SDK 的 `redirectUriMatches` 执行。
- 公网回调仍然必须是 HTTPS；带 fragment、URL 用户信息、非 http(s) 方案的 URI 一律拒绝。
- 该行为在生产环境默认开启（`allowLoopbackRedirects` 默认 `true`），不再随 `NODE_ENV` 关闭；只有显式传入 `allowLoopbackRedirects: false` 才禁用，此时回环注册被拒绝而 HTTPS 不受影响。

### 授权同意页 `/#/connect/authorize?request=<opaque>`

授权端点会把浏览器 302 到这里。前端：

1. `GET /api/oauth/consent?request=<opaque>`（需要会话）→
   `{ requestId, clientName, scopes, redirectHost }`
   若未登录，走登录流程（登录后保留 `next` 回到本页）。若返回 404，说明请求已过期或已被处理。
   该 GET 会把请求绑定到当前登录账号；之后用另一个账号打开同一 requestId 会返回 404，因此不要在已登录其他账号时打开未确认的授权链接。
2. 用户点击允许/拒绝后
   `POST /api/oauth/consent`，JSON `{ requestId, approved: boolean }` →
   `{ redirectUrl }`
   然后 `location.assign(redirectUrl)` 回到客户端回调。
3. 批准要求会话创建时间在 24 小时内；若返回
   `401 { error: { code: "reauthentication_required" } }`，引导重新登录后再试。
4. 不要自动批准；不要在没有用户点击的情况下 POST。

### 本地验收命令

```bash
npm ci
npm run build:mcp                 # 生成确定性渲染器（connections-live 浏览器联调需要）
npm run typecheck
npm run build                     # 连接页 UI 回归基于 dist
node --test tests/connections.test.mjs   # 连接/OAuth/MCP 回归（注入 stub 渲染器）
IMSTAGE_TEST_PORT=4591 CI=1 npx playwright test tests/ui/connections.spec.ts        # 连接页 UI 回归
IMSTAGE_TEST_PORT=4591 CI=1 npx playwright test tests/ui/connections-live.spec.ts   # 真实 API + 浏览器 + 渲染
node --test tests/*.test.mjs             # 全量 Node 测试
```

手工联调（前后端同源）：

```bash
IMSTAGE_APP_ORIGIN=http://127.0.0.1:4417 \
IMSTAGE_DIST_DIR=dist \
IMSTAGE_API_PORT=4417 \
node services/api/server.mjs
# 开发前端：npm run dev:web（Vite 4417），API 走同一 origin 的反向代理或都指向 4417
```

手工 MCP 冒烟（把 `<token>` 换成刚创建的一次性令牌）：

```bash
curl -s http://127.0.0.1:4417/api/connections/config
curl -s -X POST http://127.0.0.1:4417/api/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

渲染：普通测试注入 stub，不启动 Chromium。真实渲染需要本机 Chrome/Playwright Chromium（`IMSTAGE_CHROMIUM_EXECUTABLE` 可指定）；父任务做真实渲染验收时再跑。

## 公网部署约束

1. `IMSTAGE_APP_ORIGIN` 必须是真实 HTTPS origin（例如 `https://imstage.org`）。发现文档、`mcpUrl`、consent 跳转与 `webUrl` 全部以它为准，不使用请求 Host。
2. Vercel 需要把 `/api/:path*`（已存在）和根级 `/.well-known/:path*` 转发到后端；否则 ChatGPT 的按路径发现会 404。对应 rewrite 见 `vercel.json`。
3. ChatGPT 侧使用 DCR 公共客户端（`token_endpoint_auth_method=none`），回调地址由 ChatGPT 注册；后端只接受精确匹配的 `redirect_uri`。原生客户端可使用 RFC 8252 回环回调（随机本地端口）。不支持 CIMD，也不抓取客户端 URL。
4. 无需付费身份供应商或新增密钥；账号身份复用既有 Web 会话与密码体系。
5. ChatGPT 插件目录提交不在本代码任务范围内；`directoryUrl` 保持 `null`，在真实提交并被接受前不得宣称已上架。

## 已实现的安全性质（供验收核对）

- 授权码一次性、短期、哈希存储，绑定 client/redirect/resource/PKCE，交换时再次校验。
- access/refresh 只有哈希入库；每个请求校验资源观众、scope、过期与当前撤销状态。
- refresh 轮换；重放或授权码重用会撤销整个连接家族。撤销操作在事务提交后生效，不会被错误回滚。
- consent 请求不可重用，GET 即绑定到首个查看账号，批准只能由该账号的近期会话完成；改密会撤销该账号全部连接、会话、未兑换授权码。
- 过滤后的 `tools/list` 同时是执行白名单；账号端点调用未声明工具返回 `invalid_request`，不会触达实例项目管理处理器。
- `/api/mcp` 读完请求体后与渲染落库前各再校验一次令牌，中途撤销/改密不会写入延迟请求。
- 不同账号的作品、幂等键与 PNG 缓存互相不可见。
- `tools/list` 成功后才写入 `tools_discovered_at`（小型附加迁移）；“已连接”必须同时有真实认证与工具发现证据，`lastUsedAt` 单独不作为连接成功依据。

## 2026-09-23 OAuth 线上修复核验

线上原先运行 `39dda20`，仍在 production 模式拒绝本机 HTTP 回调；个人令牌成功不代表 OAuth 注册成功。修复已包含在合并提交 `b4739061e6545c8b99d7f0f82b303babf68ea01b`，此前尚未部署到账号 API。

本次先完成数据库备份，再将账号 API 更新到该提交。公网浏览器使用独立合成账号验证：loopback 注册 201、随机回调端口、显式同意、S256 PKCE 换令牌 200、6 个工具发现与 connected 状态、撤销后 401 均通过；公网非 loopback HTTP 回调仍返回 400。额外复跑相关后端测试 68 项通过。未变更用户现有个人令牌，独立实例 MCP 未升级。

这是生产协议与浏览器授权验证，不是用户账号在 ChatGPT / Codex 宿主中的重新登录验收。公开目录仍未提交。后端合并提交的 GitHub 托管检查因账户账单锁定未启动；本地与生产验证单独记录，不标记为 GitHub CI 通过。
