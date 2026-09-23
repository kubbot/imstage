# 前后端发布与验证

当前部署由两部分组成：Vercel 托管 React 官网和编辑器，海外服务器运行持续驻留的 Node API、SQLite 与独立 MCP。账号、作品保存、DeepSeek 编辑和带认证的 MCP 已实现；计费、商业 API key 申请和密码找回未实现。

服务器安装、HTTPS、持久化、备份与回滚步骤见 [部署手册](../deploy/README.md)。只部署静态前端可使用本地编辑和导出，账号与 AI 功能需要 `/api/*` 的 HTTPS 同源代理。

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

`vercel.json` 固定安装、构建与输出配置。Vite 的源码根目录由 `vite.config.ts` 设置为 `apps/web`。页面使用 hash 路由，因此不需要将所有路径重写为首页。`/api/*` 通过外部 rewrite 转发到后端；Agent 使用 `/api/agent/run`。供应商密钥只在服务器读取。后端故障应明确提示，不回退成伪造的成功结果。

依据：[Vercel 项目配置](https://vercel.com/docs/project-configuration/vercel-json)、[Node.js 版本](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)、[GitHub 自动部署](https://vercel.com/docs/git/vercel-for-github)。

## 交付检查

1. PR 的 `Frontend / Build and browser tests` 检查执行模型/协议测试、生产构建及 Chromium 浏览器测试。
2. Vercel Preview 成功后，检查 PR 当前提交的全部适用检查，再合并到 `main`。
3. 等待 Vercel 生产部署就绪，并读回部署对应的 Git 提交和生产域名。
4. 在生产域名验证五个路由、主题切换、真实 Agent 流式编辑、移动端、图片加载与实际 PNG 下载。

```sh
npm test
npm run build
npm run test:ui
# 指向已读回确认的部署地址；不会启动本地开发服务器：
IMSTAGE_BASE_URL=https://YOUR_ISOLATED_TEST_HOST npm run test:ui
```

浏览器测试使用隔离浏览器中的合成场景；账号与保存测试会写入测试服务器数据库，不应直接将完整测试套件指向生产。部分测试会拦截真实模式请求以验证协议/错误处理；它们不能证明 AI 供应商接入成功。生产验收应单独运行有边界的合成账号/场景冒烟并记录真实供应商结果。测试截图、下载和 trace 应存入本次任务的 `IMSTAGE_ARTIFACT_DIR`，验收后清理。

## 临时 runner

首次发布时，GitHub-hosted Actions 因账户账单问题无法启动。工作流保留默认 Ubuntu 执行路径；维护者可临时设置仓库变量 `FRONTEND_RUNNER_LABEL`，将同仓库的已审查变更交给具有该标签的一次性 runner。来自 fork 的 PR 不走此路径。Linux 使用 Playwright Chromium，macOS 使用已安装的 Chrome；都执行相同的模型测试、构建及浏览器用例，并通过 `preview` 验证生产产物。CI 使用 4418 端口以避免影响 4417 的开发预览。

仅在确认待执行提交可信后注册 `--ephemeral` runner；每个 runner 完成一个 job 后自动注销。验证后移除本轮 runner 文件和仓库变量，不留下常驻 runner。该方式不解决 GitHub 账户账单问题；后续默认托管 CI 仍需账户恢复才能运行。

构建不需要任何供应商密钥。`.local/`、`.vercel/`、私有素材和环境文件不得提交或上传。
