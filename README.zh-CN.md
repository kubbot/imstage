# IMStage

创作对话，打磨每一个细节。

[打开 IMStage →](https://imstage.org/?lang=zh) · [English](README.md) · [参与贡献](CONTRIBUTING.md)

![IMStage：可编辑的微信场景与创作入口](docs/images/landing-zh.png)

为产品演示、教学示例和虚构故事制作聊天场景。从想法开始，直接修改画面，再导出需要的成品。

- **直接编辑。** 修改消息、人物、头像、时间和设备状态；支持撤销和独立的本机会话。
- **用文字创作。** 登录后，让 Agent 生成或修改场景；参考截图可用于重建和局部编辑。
- **复用创作。** 把可编辑画面存为模板，将姓名和照片设为变量，按项目规则批量生成差异版本；也能定制平台皮肤之外的布局。
- **导出成品。** 下载普通截图、完整长图或可编辑的 JSON。预览和 PNG 使用同一个渲染器。
- **接入自己的工具。** 自托管账号 API 与 Agent，或通过认证后的 MCP 服务创建和渲染场景。

中文示例使用微信，英文示例使用 WhatsApp。向下滚动，修改一句对白，探索不同人物与照片。**发送并创建**会打开新工作台，登录后执行这次请求。作品、人物、头像和项目设置自动保存；云端同步失败时，本机草稿保留修改。

## 本地运行

需要 Node.js **22.18–22.x**。

```sh
npm ci
npm run dev
```

打开 [localhost:4417](http://127.0.0.1:4417)。生产构建与启动：

```sh
npm run build
npm start
```

使用 Agent 需要在服务端配置模型密钥。手动编辑和 PNG 导出不需要模型密钥。

## 部署与接入

官网前端部署在 Vercel，账号、作品保存与 Agent 请求由持久化服务器处理。模型密钥仅保存在服务端。

本机会话保存在当前浏览器。登录后，作品、人物和项目设置修改会自动同步至服务器；发起 AI 请求时，相关场景、附件和指令会发送至配置的模型服务。

MCP 使用**管理员配置的实例令牌和独立场景库**，不共用 Web 登录会话或“我的作品”。MCP 批次保存调用方 AI 提供的内容；Web 项目批量任务则调用站内 Agent。按客户分发的商业 API key、计费和邮件密码找回尚未实现。

[模板与批量创作](docs/templates-and-projects.md) · [部署与运维](deploy/README.md) · [账号 API](services/api/README.md) · [Agent 配置](services/agent/README.md) · [MCP 工具](services/mcp/README.md)

## 开发验证

```sh
npm test
npm run test:ui  # Playwright，默认使用已安装的 Google Chrome
```

使用自带 Chromium：先运行 `npx playwright install chromium`，再执行
`IMSTAGE_BROWSER=chromium npm run test:ui`。开发约定见[贡献指南](CONTRIBUTING.md)。

模板是平台界面的视觉近似，截图重建可能需要手动校正。内置对话与头像均为虚构素材；请使用有权使用的内容，不将生成画面作为真实聊天的证据。

采用 [MIT](LICENSE) 许可证，与所展示的聊天平台无隶属关系。
