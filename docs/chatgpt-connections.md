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

1. `GET /api/connections/config`（公开）
   ```json
   { "mcpUrl": "https://imstage.org/api/mcp", "authorizationSupported": true, "directoryUrl": null, "manualSetupRequired": true }
   ```
   展示 `mcpUrl` 供手动添加；`directoryUrl` 为 `null`，不要写“已在目录发布”。
2. `GET /api/connections` → `{ items: [{ id, clientName, createdAt, lastUsedAt, scopes, kind }] }`
   `kind` 为 `oauth` 或 `token`；列表永远不含令牌或哈希。
3. `DELETE /api/connections/:id` → `{ ok: true }`
4. `POST /api/connections/tokens`，JSON `{ name }` → `{ token, connection }`
   `token` 只在这次响应出现一次，请立即展示并提示“只显示一次”；不要放进 URL、日志或本地长期存储。

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
npm run build:mcp                 # 生成确定性渲染器（真实渲染需要）
npm run typecheck
node --test tests/connections.test.mjs   # 连接/OAuth/MCP 回归（注入 stub 渲染器）
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
3. ChatGPT 侧使用 DCR 公共客户端（`token_endpoint_auth_method=none`），回调地址由 ChatGPT 注册；后端只接受精确匹配的 `redirect_uri`。不支持 CIMD，也不抓取客户端 URL。
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
