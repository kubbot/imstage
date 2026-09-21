# 在 ChatGPT 中创作与微调 IMStage 作品

## 工作方式

ChatGPT 负责理解需求、编写对话、决定修改哪些元素。MCP 使用现有 Web `validateScene` 校验内容，保存到独立 SQLite，然后通过编译后的 Web `SceneView` 和同一份 CSS 输出 PNG。没有额外的模型调用，也不会读取 Web 用户数据库。

1. `imstage_get_capabilities`：读取支持的字段、限制和示例。
2. `imstage_create_scene`：传入结构化内容及 `idempotencyKey`，返回 `sceneId`、`revision`。
3. `imstage_render_scene`：展示该版本的 PNG 和内嵌预览。
4. `imstage_get_scene` / `imstage_update_scene`：追问时读取同一作品，以 `expectedRevision` 和元素 ID 精确修改。
5. 再次 `imstage_render_scene`：展示新版本；原版本可通过 `revision` 读取。

文字、人物、时间、标题、外观和静态媒体卡片支持调整。支持微信、小红书、iMessage、WhatsApp、Slack、Instagram 的现有 Web 模板；界面为创作近似样式。截图原图编辑层仍需使用 Web 编辑器，MCP 会明确拒绝这类输入。

## 本机运行

需要 Node 22.18+（22.x）、项目依赖及可用 Chromium；macOS 可复用安装的 Chrome。运行 `npm ci`、`npm run build:mcp`。环境变量：

| 变量 | 用途 |
| --- | --- |
| `IMSTAGE_MCP_DATA_DIR` | 必填，MCP 专用持久化目录 |
| `IMSTAGE_MCP_TOKEN` | 必填的本地 Bearer 凭据，存私有环境文件 |
| `IMSTAGE_MCP_PORT` | 默认 4421，独立于 Web/API |
| `IMSTAGE_MCP_CHROMIUM_EXECUTABLE` | 可选，指定 Chromium |

`node --env-file=/absolute/private/mcp.env services/mcp/server.mjs` 启动服务。`/healthz` 返回进程存活状态；真正可用性通过 MCP 创建/读取/渲染确认。不要把凭据或本机账号配置提交到 Git。

HTTP 使用官方 SDK 的无状态 Streamable HTTP JSON；作品状态持久化，不依赖传输会话。所有请求限制正文大小，拒绝无关 Host 和带 Origin 的浏览器直连。渲染页禁用 JavaScript、阻断网络，限制图像解码、像素、耗时和并发。图片仅接受内嵌 PNG/JPEG/WebP。

## 安装到 ChatGPT

按照 [OpenAI 官方连接流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)：启用账号 Developer mode，在 Plugins 的创建入口配置 IMStage，然后选择并安装到个人工作区。必须验证工具已被发现，并在实际 ChatGPT 对话中测试。

本机部署使用 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，通过出站连接接入，不开放本机公网端口。所需配置：

- 一个关联目标个人 ChatGPT 工作区的 tunnel ID。
- 只具有 Tunnels Read/Use 的 runtime API key，存本机私有文件。不要使用管理员 key 运行常驻服务。
- 官方 `tunnel-client` 托管运行时，目标为 `http://127.0.0.1:4421/mcp`。
- 用 `mcp.extra_headers` 与 `mcp.discovery_extra_headers` 的 `file:` 引用注入本地 Authorization 头，让 MCP 服务继续要求 Bearer 验证。

仓库保留显式 `IMSTAGE_MCP_PRIVATE_TUNNEL=1` 模式供已经在上游认证的部署使用；本机实际安装优先保留本地 Bearer。该开关本身不创建或证明隧道认证。

这是个人私有安装流程。公网多用户服务还需要独立的身份、用户隔离和运营方案；本服务只对应一个所有者。

## 开始对话

在 ChatGPT 的 Plugins → Installed 中打开 **IMStage**，点击 **Try in chat**。确认输入框已带有 IMStage 插件标记，再描述需求。当前实测入口进入 Work 对话；只在普通 Chat 中写插件名字可能被路由到内置图像生成，不能视为 MCP 调用成功。

本机需要保持开机并能访问网络；MCP 服务与私有隧道已配置登录启动。

直接在聊天输入框追问即可修改同一作品。组件内的“发送修改”也会带上作品 ID 和版本；当前 Work 宿主可能把它视为组件建议并要求你在聊天中确认，确认后继续修改。

点击“下载 PNG”：支持标准下载的宿主直接请求保存；当前 Work 使用 ChatGPT 文件接口打开 PNG，经外链确认后可用浏览器保存图片。导出的文件已与服务端渲染结果做 SHA-256 一致性核验。

## 验收对话

使用虚构内容，不上传个人截图：

> 用 IMStage 做一张微信对话：小林约阿远周六下午三点去咖啡馆，阿远带相机。对话自然一点，生成作品给我看。

> 只把约定时间改成下午四点半，其他文字、人物和样式不变。

> 阿远最后再回一句轻松一点的话，并改成 WhatsApp 风格。

验收要读回：三轮是同一 `sceneId`；版本递增；指定元素变化且其余内容保留；预览是更新后的 PNG；下载有效；能够读取最初版本。组件内输入修改也应把同一作品 ID 带回 ChatGPT。

自动测试、组件模拟宿主测试、隧道就绪、ChatGPT 安装、真实多轮对话必须分别记录。当前实际验收状态见 [验证记录](mcp-verification.md)。
