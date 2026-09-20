# 官网与本地工作台验收

2026-09-20 · React + TypeScript + Vite · Node.js 22.23.2 · macOS / Google Chrome。

本次验收针对当前仓库的可运行前端。OpenDesign 原稿保持不变；没有部署公网应用，也没有接入 AI、账户、服务端素材库或真实 API/MCP。

## 验证结果

| 检查 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `npm run build` | 通过 | TypeScript 检查和生产构建；工作台及 PNG 导出按需加载 |
| `npm test` | 31/31 通过 | 场景契约、稳定消息 ID、精准修改、撤销/重做、模板、序列化、错误数据与素材边界 |
| `npm run test:ui` | 19/19 通过 | 下列浏览器用户流程；最终完整运行 22.6 秒 |
| 生产包 smoke | 通过 | Vite preview 的首页与工作台能实际呈现 |
| 视觉检查 | 通过 | 浅/深色桌面官网、场景区、接入区、工作台及移动端截图；无未捕获浏览器错误 |
| `git diff --check` | 通过 | 无空白格式错误 |

浏览器验收覆盖默认跟随系统及动态切换、手动主题选择与刷新保存、首页单条修改、平台切换保留内容、场景筛选/搜索/空状态、编辑/撤销/恢复、新建空白场景、保护已有草稿、损坏草稿恢复、跨标签页冲突处理、存储不可用、真实图片上传及失败恢复、真实 PNG 下载与失败重试、键盘对话框及 Escape 焦点恢复。

四个页面在 320、390、768、1440 像素宽度均无横向溢出。axe 自动检查覆盖四页的浅/深色 WCAG 2 A/AA 规则，未发现违规；这不等同于完整人工无障碍认证。尚未进行 Safari、Firefox 或真实移动设备验收。

PNG 验证读取下载文件的 PNG 签名与宽高：普通截图为 720×1280 像素（360×640、2×），长图包含更多消息且高度大于 1280。预览与导出使用同一 `SceneView`；导出不含编辑选中边框。

## 可复核证据

[截图索引](evidence/README.md) 包含改版前、A/B 方向、最终双主题与移动端，以及实际下载的 PNG。[构建记录](evidence/build.txt)、[数据测试记录](evidence/model-tests.txt)、[浏览器测试记录](evidence/ui-tests.txt) 已随代码保存。

此前一轮临时证据被并行任务的全局清理删除。本页所引用的证据均已从最终代码重新生成并保存；未引用被删除的临时文件。

## 本机复验

```sh
cd /Users/cubxxw/data/imstage
npm ci
npm run dev
```

打开 `http://127.0.0.1:4417`。生产包可在不同端口并行预览：

```sh
npm run build
npm run preview -- --port 4416
```

测试及截图使用本任务独立目录。验收后只删除自己的目录，不运行会影响并行任务的全局清理：

```sh
/Users/cubxxw/.local/bin/dev-storage-guard audit
export IMSTAGE_ARTIFACT_DIR="$(/Users/cubxxw/.local/bin/dev-storage-guard new-artifact imstage-ui)"
npm test
npm run test:ui
node scripts/capture-design.mjs
# 需要留存的证据转入正式交付位置后：
/Users/cubxxw/.local/bin/dev-storage-guard remove-artifact "$IMSTAGE_ARTIFACT_DIR"
```

默认使用本机 Chrome。无 Chrome 的环境先运行 `npx playwright install chromium`，再设置 `IMSTAGE_BROWSER=chromium`。

## 尚未验收的产品边界

- 微信、小红书等模板是风格预览，未依据固定 App/系统版本做像素校准。真实 UI 的采集与校准流程见 [设计评审](REVIEW.md#如何获得真实-ui)。
- 本机草稿依赖浏览器 localStorage，并有容量限制；没有跨设备同步或云端备份。
- JSON 可查看、复制、下载，尚未提供通用导入；AI 生成、截图理解、真实 MCP/API、账户和计费均为后续阶段。
- 这是静态 SPA；正式上线的域名、SEO/SSR、监控、跨浏览器兼容及真实平台基准仍需独立验收。
