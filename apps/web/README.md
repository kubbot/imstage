# IMStage Web

React + TypeScript + Vite 官网与本地聊天场景编辑器。在仓库根目录运行 `npm ci && npm run dev`，访问 http://127.0.0.1:4417。

源码：`src/App.tsx` 负责路由/主题；`Landing.tsx` 负责官网；`Pages.tsx` 负责场景库和说明；`studio/` 负责场景模型、草稿、可复用 DOM 渲染与编辑器。

`npm run build` 产物为根目录 `dist/`；`npm run preview` 预览构建结果。`npm test` 验证模型，`npm run test:ui` 验证真实浏览器。详情见根目录 README。

The prompt-first route `/#/create` lives in `src/create/`; the homepage shares the same component. `stream.ts` separates authored demo events from the real NDJSON client. The server endpoint is not implemented. See [generation boundary](../../design/PROMPT-FIRST.md).
