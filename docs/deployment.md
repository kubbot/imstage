# 前端发布与验证

2026-09-20 用户已授权将当前 React 前端推送至 GitHub，并发布到已关联的 Vercel 项目。此发布包含官网、流式示例、场景库和本地编辑/导出。真实 AI、账户、云端存储、API/MCP 和计费服务仍未实现。

## 构建配置

从仓库根目录构建，不将 Vercel 的 Root Directory 设置为 `apps/web`。

| 配置 | 值 |
| --- | --- |
| Node.js | `22.x`，由 `package.json` 声明 |
| 安装 | `npm ci` |
| 构建 | `npm run build` |
| 框架 | Vite |
| 输出 | 仓库根目录的 `dist` |
| 生产分支 | `main` |

`vercel.json` 固定安装、构建与输出配置。Vite 的源码根目录由 `vite.config.ts` 设置为 `apps/web`。页面使用 hash 路由，因此不需要将所有路径重写为首页。此阶段不部署 `/api/scenes/stream`，真实模式的请求应显示服务尚未接入；不要把请求回退成演示结果。

依据：[Vercel 项目配置](https://vercel.com/docs/project-configuration/vercel-json)、[Node.js 版本](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)、[GitHub 自动部署](https://vercel.com/docs/git/vercel-for-github)。

## 交付检查

1. PR 的 `Frontend / Build and browser tests` 检查执行模型/协议测试、生产构建及 Chromium 浏览器测试。
2. Vercel Preview 成功后，检查 PR 当前提交的全部适用检查，再合并到 `main`。
3. 等待 Vercel 生产部署就绪，并读回部署对应的 Git 提交和生产域名。
4. 在生产域名验证五个路由、主题切换、示例流式生成、移动端、图片加载与实际 PNG 下载。

```sh
npm test
npm run build
npm run test:ui
# 指向已读回确认的部署地址；不会启动本地开发服务器：
IMSTAGE_BASE_URL=https://YOUR_VERIFIED_HOST npm run test:ui
```

浏览器测试仅修改隔离浏览器里的合成场景和本地草稿。部分测试会拦截真实模式请求以验证协议/错误处理；它们不能证明 AI 供应商接入成功。公网缺失 API 的状态应另外核验。测试截图、下载和 trace 应存入本次任务的 `IMSTAGE_ARTIFACT_DIR`，验收后清理。

## 临时 runner

首次发布时，GitHub-hosted Actions 因账户账单问题无法启动。工作流保留默认 Ubuntu 执行路径；维护者可临时设置仓库变量 `FRONTEND_RUNNER_LABEL`，将同仓库的已审查变更交给具有该标签的一次性 runner。来自 fork 的 PR 不走此路径。Linux 使用 Playwright Chromium，macOS 使用已安装的 Chrome；都执行相同的模型测试、构建及浏览器用例，并通过 `preview` 验证生产产物。CI 使用 4418 端口以避免影响 4417 的开发预览。

仅在确认待执行提交可信后注册 `--ephemeral` runner；每个 runner 完成一个 job 后自动注销。验证后移除本轮 runner 文件和仓库变量，不留下常驻 runner。该方式不解决 GitHub 账户账单问题；后续默认托管 CI 仍需账户恢复才能运行。

构建不需要任何供应商密钥。`.local/`、`.vercel/`、私有素材和环境文件不得提交或上传。
