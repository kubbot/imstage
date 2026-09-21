# MCP 验证记录

日期：2026-09-21 至 2026-09-22。基线：`32523b03dd1c4fe32dc196f787c0f21320e63140`，分支：`codex/chatgpt-mcp`。

## 已验证

- `npm run test:mcp`：42 tests，42 passed，0 skipped。使用官方 MCP SDK 真实 HTTP 客户端；包含鉴权、输入限制、原子修改、并发冲突、幂等重试、持久化、历史版本、真实 Chromium PNG 渲染和资源读取。
- `npm test`：346 tests，346 passed，0 skipped。
- `npm run build`：TypeScript 和 Vite production build 通过。
- MCP Apps 组件在 Chromium 的模拟宿主内完成初始化、图片显示、携带同一作品 ID 的追问消息、PNG 下载请求和错误恢复。真实 ChatGPT 验收见下文。
- 独立 loopback 常驻服务完成三轮真实 MCP 调用：微信初稿 → 只改约定时间 → 增加回复并改为 WhatsApp；同一作品的 revisions 为 1、2、3，未指定元素保持不变，初始版本可读取，PNG resource 可下载。
- 重启本任务常驻服务后，重放相同幂等请求仍返回同一作品和三个既有修订；无凭据调用 `/mcp` 返回 HTTP 401。
- 六个平台的共享 Web HTML 渲染检查通过；使用 Web `SceneView`、同一份 CSS 和同一 `validateScene`，没有另外维护一套页面模板。

本机验收为合成内容。机器可读记录：[live-acceptance.json](evidence/mcp/live-acceptance.json)。

| 初稿 | 只调整约定时间 | 增加回复并调整平台 |
| --- | --- | --- |
| ![微信初稿](evidence/mcp/revision-1.png) | ![微信修改时间](evidence/mcp/revision-2.png) | ![WhatsApp 修改版](evidence/mcp/revision-3.png) |

## 私有安装进度

- 用户确认后，已在实际 ChatGPT 设置中开启 Developer mode，并读回为 on。
- 已创建 IMStage Personal 私有 tunnel，刷新 Platform 页面后确认只关联当前个人组织和个人 ChatGPT 工作区。账号与 tunnel 标识仅保留在本机私有配置。
- 用户已将 IMStage Tunnel Runtime 凭据保存到本机私有文件，权限为 0600；保存页面确认只有 Tunnels Read、Use 两项权限，其他能力均为 None。密钥未写入仓库或对话输出。
- 官方 tunnel-client 托管运行时已连接，读回 `process_running: true`、`healthy: true`、`ready: true`、`runtime_state: ready`；配置登录启动。本地 Authorization 分别注入发现和实际调用。
- 已在 ChatGPT 创建并连接 IMStage，实际安装详情确认五个工具和 MCP Apps 资源；Installed 列表可打开 IMStage，并通过 `Try in chat` 将插件加入 Work 对话。

## 真实 ChatGPT 验收

- 从 Installed → IMStage → Try in chat 进入带 IMStage 标记的 Work 对话，完成初稿、只修改约定时间、追加回复并切换 WhatsApp 三轮真实调用。独立 SQLite 读回同一作品 revisions 1、2、3。
- 第二轮仅两条消息中的约定时间变化，其他字段逐项相等；第三轮保留六条既有消息，再追加第七条，切换平台。三个历史版本及 PNG 均可读取。
- 实际组件预览已显示最新 WhatsApp PNG。修复了 ChatGPT Work 在 `toolOutput: null` 时把完整结果放在 `toolResponseMetadata.call_tool_result` 的兼容路径，并加入初始加载、局部 globals 更新的回归测试。
- 点击组件“下载 PNG”后，当前 Work 宿主使用 `uploadFile` → `getFileDownloadUrl` → `openExternal`，经过 ChatGPT 外链确认打开原图；浏览器保存的 62,877 字节 PNG 与服务端渲染 SHA-256 完全相等。当前界面会打开图片，需要浏览器保存；支持标准 `ui/download-file` 的宿主优先使用标准下载。
- 从真实组件输入框发起只改标题的追问，携带同一 sceneId/revision；当前 Work 宿主将其作为组件建议并要求在对话中确认。确认后产生 revision 4，读回证明仅标题变化，其他字段逐项相等，PNG 已重新渲染。保留该宿主确认流程。

机器可读证据：[chatgpt-acceptance.json](evidence/mcp/chatgpt-acceptance.json)。图片是纯合成对话，不包含私人账户截图。

验收时发现本机代理无法连接插件专属 sandbox 域名，直连可用。已为这一个精确域名添加代理例外，保留已有规则，并在本机私有目录保存原配置。域名、账号标识、会话链接和密钥均不提交。

此分支依赖尚未合入主干的编辑器工作，不代表 GitHub `main` 或公开 Vercel 网站已经发布 MCP。

## 运行边界

个人单所有者服务；使用隔离 SQLite，凭据只在本机私有配置中。无外部模型调用，无 Web 用户数据库读取，不接受远程图像 URL。原图截图编辑层不在此 MCP 版本范围内。PNG 缓存保留最近 50 个，旧作品版本仍可重新渲染。长图有像素与高度限制，超限返回可操作错误，不静默裁掉内容。
