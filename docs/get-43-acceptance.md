# GET-43 验收记录（本地部分）

状态：2026-09-23。只记录本工作树内的本地实现与可复现验证。真实 ChatGPT / Codex 宿主联调、生产发布、外部目录与 Linear 状态由父任务负责，不在本记录内声明完成。

## 背景

Codex 注册客户端时使用原生应用的 HTTP 回环回调（`http://127.0.0.1:<随机端口>/...`），此前生产配置把 `allowLoopbackRedirects` 默认设为 `nodeEnv !== 'production'`，导致生产环境拒绝该回调，用户被迫改用个人令牌；连接页也只说明 ChatGPT 手动添加。

## 本次改动

### 1. 原生客户端回环回调（RFC 8252 §7.3）

- 动态注册只接受三类显式回环主机的 `http://` 回调：`localhost`、`127.0.0.1`、`[::1]`；任何其他 HTTP 主机（含 `localhost.evil.com`、`127.0.0.1.evil.com`、公网域名、`ftp:`、URL 用户信息、fragment）都被拒绝。
- 本地端口可以随机：注册 `http://127.0.0.1:4555/callback`，实际回调 `http://127.0.0.1:51234/callback` 可以完成。放宽的只有端口；方案、主机、路径、查询必须精确一致，匹配由 MCP SDK 的 `redirectUriMatches` 执行。
- `services/api/server.mjs` 的 `allowLoopbackRedirects` 默认改为 `true`（所有环境，含生产）；只有显式 `allowLoopbackRedirects: false` 才禁用。HTTPS 与非回环校验保持不变。
- 动态注册仍只支持公共客户端、`authorization_code` + `refresh_token`、`response_type=code`、S256 与 `resource` 绑定；授权码一次性、短期、哈希存储，consent 不可重用。

### 2. 连接页按客户端选择

- 连接页先选择 **ChatGPT / Codex / 其他客户端**，默认 ChatGPT；选择写入 `#/connect?client=codex|other`，登录链接用 `next` 保留该目标，登录后回到同一选择。
- 不提供任何自造的一键 URL 或私有协议：
  - ChatGPT：Plugins → Create app / Create MCP App，Authentication 选 OAuth，附官方文档链接。
  - Codex：Codex CLI 官方命令（已用本机 `codex mcp add --help` / `codex mcp login --help` 核对，codex-cli 0.149.1）：
    ```bash
    codex mcp add imstage --url <mcpUrl>
    codex mcp login imstage
    ```
  - 其他客户端：远程 / Streamable HTTP MCP + OAuth 2.1（PKCE）；只支持 Bearer 的客户端走高级个人令牌。
- 个人访问令牌保留在“高级接入”折叠区；OAuth 流程不展示令牌。
- 保留既有设计令牌、桌面/移动布局、明/暗主题、双语与可访问性（箭头键可切换单选、`prefers-reduced-motion`、axe wcag2a/aa/21aa 无违规）。

### 3. “已连接”需要真实证据

- 新增附加迁移：`oauth_grants.tools_discovered_at`（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN`，旧库无损）。
- `/api/mcp` 只在真实的 `tools/list` 响应成功返回工具列表后写入该字段（通过包装响应体确认，不在请求开始或仅 token 校验时写入）。
- `GET /api/connections` 新增 `toolsDiscoveredAt` 与 `status`：
  - `awaiting_auth`：已授权，但还没有任何 token 校验成功（`lastUsedAt` 为空）。
  - `authenticated`：token 校验成功（`lastUsedAt` 非空），但尚未观察到工具发现。
  - `connected`：`tools/list` 真实成功（`toolsDiscoveredAt` 非空）。
- 连接页据此显示“已授权，等待客户端连接 / 已认证，等待工具发现 / 已连接，工具已发现”，不会仅因浏览器登录就显示成功。

### 4. 保留的协议与安全性质

S256 PKCE、`resource`/scope 绑定、一次性授权码、refresh 轮换与重放撤销、consent 会话绑定与近期会话要求、取消/拒绝/过期/撤销后的重连恢复路径、`/api/mcp` 读体后与渲染落库前的再次鉴权，均未改动。

## 本地验证（已实际执行）

环境：Node 22.18，`@modelcontextprotocol/sdk` 1.30.0，React 19.3.0，Vite 8.3.0。

```bash
npm ci
npm run typecheck
npm run build              # tsc --noEmit && vite build
npm run build:mcp          # connections-live 真实渲染前置
node --test tests/connections.test.mjs
IMSTAGE_TEST_PORT=4593 CI=1 npx playwright test tests/ui/connections.spec.ts
IMSTAGE_TEST_PORT=4596 CI=1 npx playwright test tests/ui/connections-live.spec.ts
```

结果：

- `npm run typecheck`：通过。
- `npm run build`：通过（Vite 产物生成）。
- `node --test tests/connections.test.mjs`：41/41 通过。
- `tests/ui/connections.spec.ts`：11/11 通过（含移动端与 axe 可访问性）。
- `tests/ui/connections-live.spec.ts`：1/1 通过（真实本地 API + 浏览器 + 真实 PNG 渲染）。

> 说明：`IMSTAGE_TEST_PORT` 用于避开本机已被其他项目占用的 4417；`CI=1` 让 Playwright 启动本工作树自己的服务而不是复用外部进程。

### 新增/更新的回归覆盖

`tests/connections.test.mjs`：

- 动态注册拒绝全部非回环/畸形 HTTP：`http://example.com`、`127.0.0.1.evil.com`、`localhost.evil.com`、URL 用户信息、fragment、`ftp:`、IPv4-mapped IPv6；HTTPS（公网与回环）与 `http://[::1]:port` 正常。
- 原生客户端随机本地端口：注册固定端口，授权用另一随机端口，consent 展示实际端口，返回并兑换成功。
- 回环匹配保持方案/主机/路径/查询精确：错误路径、错误查询、错误主机、http↔https 均被拒且不重定向。
- 连接状态证据：新授权为 `awaiting_auth`；`initialize` 后为 `authenticated`；`tools/list` 成功后为 `connected` 且有 `toolsDiscoveredAt`；个人令牌同样覆盖。
- 生产配置（`nodeEnv: 'production'`）：`loopbackRedirectsSupported: true`，随机回环端口可用，公网 HTTP 仍被拒，HTTPS 正常。
- 显式关闭（`allowLoopbackRedirects: false`）：回环注册被拒，HTTPS 不受影响，config 如实上报 `false`。
- 撤销后重连：删除连接后旧 access token 立即 401，同一客户端重新授权得到新的 grant（id 不同）且新 token 可用，覆盖“撤销后重连可恢复”。

`tests/ui/connections.spec.ts`：

- 三个客户端选项与各自步骤；切到 Codex 显示官方 CLI 命令且不存在“一键”链接；切到其他客户端显示 URL 与 OAuth 2.1 说明。
- 选择 Codex 后点“登录并继续”，`next` 保留 `client=codex`。
- 状态文案：`awaiting_auth` / `authenticated` / `connected` 分别显示，不提前宣称成功。
- 关闭回环回调时引导到高级个人令牌。

## 明确未在本记录内完成（父任务负责）

- ChatGPT 宿主真实联调：真实 ChatGPT 账号添加 app、OAuth 授权、工具发现与调用。
- Codex 宿主真实联调：`codex mcp add` / `codex mcp login` 在真实账号下的浏览器授权、取消、过期、拒绝、撤销后重连恢复。
- 生产发布、HTTPS 域名、Vercel 路由、公开目录提交与 Linear 状态更新。
- 上述外部动作的成功与否不由本次本地测试证明。

## 独立审查补充

- 审查发现 SDK 的 loopback 比较不会拒绝实际授权地址里的 credentials / fragment，也不会应用运行时关闭配置。已在 GET/POST authorize 进入 SDK 前校验（包含省略 redirect_uri 时的注册值），并在读取与批准 consent 时再次校验。非法地址本地返回 400，无 Location。
- 新增异常实际回调与服务重启后已有注册/待批准请求回归；完整后端测试 43/43 通过，独立 reviewer 复跑新增 2/2 通过，P2 已关闭，无 P0/P1。
