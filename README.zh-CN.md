# IMStage

面向 Web、MCP 和 API 的开源聊天场景创作工具。

**已提供 React 官网、场景编辑器、邮箱密码登录和自托管作品库。任意场景的真实 AI 生成、截图识别、托管云服务与 MCP 尚未接入。**

[English](README.md) · [产品说明](docs/product-brief.md) · [设计简报](design/BRIEF.md)

## 产品方向

通过对话描述场景，生成可编辑的聊天内容与模拟截图。Web 编辑器和 MCP/API 复用相同的结构化数据与渲染能力，服务于设计、教学、叙事创作及合成评测数据。

计划支持多平台模板、单聊与群聊、人物头像、消息时间与手机状态、图片及定位等消息、普通截图与长截图，以及上传截图后提取结构化内容并继续编辑。

Web 端计划提供免费使用；托管 MCP/API 计划使用账号绑定的 key 和预付额度。额度、AI 成本、收费能力边界和价格尚未确定。开源自部署属于产品方向。

## 运行与验证

在仓库根目录运行，要求 Node.js 22.18+（22.x，已验证 22.23.2）。

```sh
npm ci
npm run dev       # 同时启动 Web :4417 和账号 API :4419
npm run build
npm start         # 构建后以同源服务运行在 :4417，请先停止 dev
npm test
npm run test:ui   # 默认使用本机 Google Chrome
```

没有 Chrome 时：`npx playwright install chromium`，再运行 `IMSTAGE_BROWSER=chromium npm run test:ui`。本机测试先用 `dev-storage-guard new-artifact imstage-ui` 创建产物目录，再通过 `IMSTAGE_ARTIFACT_DIR` 指定输出；验收后按存储守卫流程清理。

- 登录／注册 `/#/login`、`/#/register`：邮箱密码账号、7 天持久会话。
- 我的作品 `/#/workspace`：按账号保存、搜索、重开和删除；冲突时保留当前修改。
- 账号设置 `/#/account`：修改密码并使全部会话失效、退出登录。
- 官网 `/`：浅色 / 深色 / 跟随系统，默认跟随系统；可试改消息与切换预览平台。
- 一句话创作 `/#/create`：火星示例分步呈现、停止、精准修改、来源查看和导出；真实生成接口尚待连接。
- 场景库 `/#/templates`：筛选、搜索与进入模板。
- 工作台 `/#/studio`：消息编辑、人物、图片、撤销、草稿恢复、PNG 与 JSON 下载。
- 接入说明 `/#/docs`：真实能力与规划边界。

普通 PNG 为 360×640 逻辑像素，以 2 倍分辨率导出；长图保留完整内容。免登录草稿只在当前浏览器保存；登录后点击保存的作品写入当前实例 SQLite，按账号隔离。当前未提供 JSON 通用导入。

## 本轮边界

保留 OpenDesign 原稿，在本仓库新增 React + TypeScript + Vite 实现。微信、小红书优先，原稿中的 iMessage / WhatsApp / Slack 选项保留为风格预览。所有平台模板尚未进行具体 App 版本的像素校准；不能把这次前端交付视为真实平台一致性验收。

参见 [输入驱动设计与真实生成边界](design/PROMPT-FIRST.md)、[产品与设计评审](design/REVIEW.md)、[验证记录](design/VERIFICATION.md) 和 [前端发布说明](docs/deployment.md)。账号服务为本机／自托管 Node 进程，不会随静态 Vercel 前端自动部署。未配置 OAuth、邮件验证或邮件找回密码。真实 AI 生成、渲染 API/MCP 和计费仍待实现。详见 [账号与作品库](docs/core-web-auth.md)。

## 开源协作

采用 [MIT License](LICENSE)。提交改动前阅读 [贡献说明](CONTRIBUTING.md)；安全问题通过 [安全报告流程](SECURITY.md) 私下报告。示例素材使用合成或已获授权的内容，生成结果应明确表达模拟属性。
