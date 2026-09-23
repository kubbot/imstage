# 创作者偏好与首轮 Onboarding（GET-44 / GET-45 / GET-46）

状态：2026-09-23。本文只记录本工作树内的实现、契约与可复现的本地验证。生产发布、真实宿主验收、Linear 状态与远端目录由父任务负责，不在此声明完成。

## 目标与边界

- 账号可以保存“我的头像”“对方默认头像”“虚构标记默认值”和 onboarding 状态；全部按真实会话 `users.id` 隔离。
- Web 首次登录 / 新注册进入一次轻量 Onboarding；可跳过，不填写任何内容也能开始创作。
- Web 与账号 MCP 的新场景读取同一份偏好；**优先顺序：当前场景显式值 > 账号默认 > 系统默认**。
- 更新账号默认**不会**改写任何已保存场景。
- 不上传账号头像到公开接口或素材库；不调用任何外部模型或付费服务。

## 数据模型（仅附加迁移）

`services/preferences/store.mjs` 在打开数据库时安装（`installPreferencesSchema`）：

```sql
account_preferences (
  user_id PK → users(id) ON DELETE CASCADE,
  revision, my_avatar, other_avatar, show_fictional_mark, mark_label,
  onboarding_status, onboarding_version, onboarding_shown_at, updated_at
)
preference_events (
  id PK, user_id → users(id), name, dedupe_key, created_at
  UNIQUE(user_id, name, dedupe_key)
)
```

- 不改写 `scenes`、`projects`、`templates` 或 `users`；旧库无损。
- **老账号**没有 `account_preferences` 行 → `onboardingStatus: 'legacy'`（不会被动进入 Onboarding）。
- **新注册**显式插入 `onboardingStatus: 'pending'` 行。
- 乐观并发：`PUT /api/preferences` 必须带当前 `revision`；不匹配返回 `409 revision_conflict`。

## HTTP API

所有路由都要求有效会话；写操作另要求 `Origin`、`X-IMStage-Request`，并在读取请求体、解码头像之后重新校验会话（并发切换账号或退出时不会写错行）。

### `GET /api/preferences`

返回 `{ item }`：

```json
{
  "revision": 1,
  "myAvatar": null,
  "otherAvatar": "data:image/png;base64,...",
  "showFictionalMark": true,
  "markLabel": "虚构对话",
  "onboardingStatus": "pending",
  "onboardingVersion": 1,
  "onboardingShown": false,
  "updatedAt": "..."
}
```

`otherAvatar` 在未保存时返回**确定性派生的内置虚构头像**（见下），因此在跳过引导、老账号或未配置账号里，对方头像依然可用且跨刷新 / 导出稳定。读取不会写库。

### `PUT /api/preferences`

请求：`{ revision, myAvatar?, otherAvatar?, showFictionalMark?, onboardingStatus?, crop? }`

- 省略的字段保持原值；只有显式提供的字段才改变。
- `myAvatar` / `otherAvatar` 只接受本地 `data:image/(png|jpeg|webp);base64,...`，编码字符 ≤ 2 MiB；服务端用 `sharp` 实际解码、按 `crop`（像素矩形，越界自动裁剪）或居中裁剪成方块，再压缩为 **256×256 WebP（回退 PNG）**。
- 拒绝：远程 URL、SVG、伪造 MIME（声明格式与真实解码格式不一致）、像素炸弹（`limitInputPixels`）、截断但头部合法的图片（解码失败统一映射为 `400 invalid_avatar`，不会 500）。
- `onboardingStatus` 目前只接受 `completed`（保存与跳过都写它）。
- `crop: { left, top, width, height }` 只在 `myAvatar` 生效；客户端会先做等比方形裁剪，服务端再复核。

### `POST /api/preferences/events`

请求：`{ name }`（**不接受**其他字段，尤其不接受 `dedupeKey`、头像、提示词、对话或 UA）。

允许列表：`onboarding_shown`、`onboarding_saved`、`onboarding_skipped`、`first_artwork_completed`。

- 账号级一次性事件（`onboarding_shown`、`first_artwork_completed`）使用服务端固定键去重，客户端无法用不同 key 绕过；重复请求返回 `recorded:false, deduplicated:true`。
- 其他事件不存储任何 key 或内容。

### `GET /api/preferences/events`

仅账号本人可读的轻量汇总（无任何内容）：
`{ items: [{ name, count, firstAt, lastAt }] }`。

### `POST /api/preferences/portrait`

请求 `{ seed? }`，返回 `{ avatar, seed }`。用确定性本地生成器绘制 256×256 PNG，无模型 / 密钥 / 网络。

## Onboarding / 设置页

- 路由 `#/welcome`；主按钮“保存并开始”，次按钮“先用默认设置”；三组设置（我的头像、对方默认头像、虚构标记）在左，右侧是真实 `SceneView` 预览，窄屏上下堆叠。
- 进入规则：`AuthPage` 在登录 / 注册成功后检查偏好；`pending` 且未展示过时跳到 `#/welcome?next=<安全原目标>`，否则跳到原目标。
- **OAuth 例外**：`next` 以 `/connect` 开头（如 `/connect/authorize`）时直接完成授权回调，不等待偏好、不进入 Onboarding。
- 展示过（`onboarding_shown`）或已完成 / 跳过 / legacy 的账号不会再次自动进入；可从 `#/account` → “头像与虚构标记偏好”重新打开（`#/welcome?from=settings`）。
- 草稿：按用户存 `sessionStorage`（`imstage.prefs.draft.<userId>`），只在有改动时写入；完成 / 跳过 / 退出登录 / 切换账号会清除，绝不跨账号读取；存储配额失败时给出提示但不阻塞。
- 读取失败时提供“重试”和“先不设置，直接开始”：后者直接进入原目标，**不写任何偏好、不标记完成**，草稿保留。
- 保存失败保留全部输入与草稿，可直接重试。
- 头像：上传 / 拖放 / 替换 / 恢复默认（我的头像），方形裁剪使用 `x/y/缩放` 三个带标签的 `range` 控件，`CanvasRenderingContext2D.drawImage` 按源像素等比映射（不拉伸），确认按钮“确认裁剪”，取消按钮“取消”。
- 对方头像：优先使用账号已保存 / 派生的虚构头像；“换一个”调用本地生成；生成失败显示内置 fallback 并可重试，绝不阻塞。

## 默认值语义

共享纯函数 `services/preferences/defaults.mjs#applySceneDefaults`：

- 只填**缺失**（`undefined` / 无该 key）的字段；`avatar: ''`、`avatar: null`、`watermark: ''`、`watermark: null` 等显式值原样保留。
- 按 `selfId` 区分“我”与“对方”：自己用 `myAvatar`，其他参与者用 `otherAvatar`；新 actor id 首次创建也会正确落到对应默认。
- `watermark` 缺失时按 `showFictionalMark` 写入 `markLabel`（默认“虚构对话”）或空串。

### 虚构标记（GET-46）

共享纯函数 `packages/schema/fictional-mark.mjs`，复用既有 `Scene.watermark`，**没有新增 scene 字段**：

- 开启：只在当前为空时写入“虚构对话”；已有自定义水印不会被覆盖。
- 关闭：只在当前恰好等于“虚构对话”时清空；自定义水印保留。
- 场景编辑器（`@scene` 设置）提供“显示「虚构对话」标记”开关；截图保留模式（`scene.reference`）下开关禁用并说明原图像素内文字无法通过开关移除。
- 自然语言局部编辑 / 仅替换头像不受影响；Agent `create_scene` 全量重建始终保留当前标记；用户明确要求修改时，通过 `update_element` 的 `@scene` 目标修改 `watermark`。账号 MCP 创建新场景仍保留输入的显式标记值。
- 预览与导出共用同一 `SceneView`；MCP 渲染 id（`computeRenderId`）由 scene 内容指纹生成，标记开 / 关得到不同 id，不会命中旧缓存。

### Web 新场景应用点

- `/create` 新会话：`AgentWorkspace` 在 `initialize` 中先 `await ensurePreferences`，只对**全新空白种子**应用默认；交接场景（handoff）、legacy 本地草稿、样例场景保持自身显式值。
- 账号“新建作品”：`AccountEditor` 在应用默认前 `await ensurePreferences`。
- 手动 `/studio`：`studio/Studio` 加载偏好后，仅对未被用户操作过的初始历史，以及新建 / 切换 / 重置模板场景应用默认；已有本地草稿与显式模板值不被改写。

### 账号 MCP 应用点

- `imstage_create_scene` 在**工具产出之后、校验与落库之前**用服务端偏好做 trusted default fill（`defaultSceneFill`），模型无需传头像。
- `imstage_get_capabilities` 附带 `accountDefaults` 摘要（是否已配置头像、标记开关、标签），**不含头像字节**。
- 独立实例 MCP 没有账号，不声称账号同步，保持系统默认（不注入账号标记 / 头像）。
- `first_artwork_completed` 只在**渲染真的成功且渲染后的授权复核通过**后记录一次；渲染失败或被撤销的渲染不计入。Web 端在成功导出后记录，服务端去重保证不虚增。

## 隐私与暴露边界

- 偏好只在本人会话的 `/api/preferences` 返回；不进入 `GET /api/scenes`、`/api/contact-library`、公开营销页或素材库。
- 联系人库保存头像后仍为空，不自动把账号头像写入素材库。
- 事件只含允许的名称与去重键，不含头像、提示词、对话或 UA。
- **已知暴露点（明确记录）**：账号 MCP 的 scene-bearing 工具结果（`imstage_create_scene` / `imstage_get_scene` / `imstage_update_scene`）为与网页 scene 契约保持 wire 兼容，原样返回已保存场景（因此包含参与者 `avatar` data URI）。默认填充分辨率高的头像数据由服务端读取，模型不需要提供；如需彻底避免该暴露，需要另行设计“场景头像引用 + 服务端解析”的协议变更，本轮未做。

## 本地验证（已实际执行）

环境：Node 22.23、React 19.3、Vite 8.3、`@modelcontextprotocol/sdk` 1.30、`sharp` 0.35（本地解码 / 生成）。

```bash
npm ci
npm run typecheck
npm run build
npm test                     # 488 tests, 488 pass
node --test tests/preferences.test.mjs
IMSTAGE_ARTIFACT_DIR=/private/tmp/ai-test-imstage-get43-47.fK4cXN IMSTAGE_TEST_PORT=4440 CI=1 npx playwright test
```

结果：

- `npm run typecheck`：通过。
- `npm run build`：通过（`tsc --noEmit && vite build`）。
- 集成后 `npm test`：**488/488 通过**；GET-47 保留下载开始时捕获的 `snapshot.dataUri`，结构断言已对应更新，异步下载回归仍由行为测试覆盖。
- `node --test tests/preferences.test.mjs`：25/25 通过。
- 全量 Playwright（`tests/ui`）：179 passed，exit 0；含 GET-43 OAuth 的 connections 套件全部通过，未回归。

`tests/preferences.test.mjs` 覆盖：新用户 pending / 老账号 legacy、保存与跳过、失败可用性与并发 revision、账号隔离、头像攻击面（远程 / SVG / 伪造头 / 像素炸弹 / 截断）、矩形等比裁剪、确定性生成、Web 与 MCP 默认填充一致且显式覆盖保留、跳过账号的稳定内置对方头像、标记开 / 关渲染指纹、MCP 渲染事件只在成功后记录一次。

`tests/ui/preferences.spec.ts` 覆盖：注册进入可跳过 Onboarding、刷新恢复草稿且不重复进入、保存失败保留草稿并重试、保存后新场景继承默认且旧场景不变、已保存头像重开设置不重新生成、慢生成不覆盖用户上传、legacy 本地草稿保持空标记 / 无头像、已登录手动 Studio 场景继承默认、handoff 显式值保留、延迟 `GET /api/preferences` 不阻塞 OAuth 同意页、Web 导出只记录一次 `first_artwork_completed`、axe wcag2a/2aa/21aa 无违规。

## 已知限制

- 账号 MCP 的 scene-bearing 结果仍包含场景内头像 data URI（见“隐私与暴露边界”）。
- 派生的内置对方头像在读取时计算并做进程内缓存；它是确定性的，不写库，用户保存或上传后以存储值为准。
- 截图保留模式（`scene.reference`）不会重绘原图内嵌文字；标记开关在该模式禁用并明确说明。
- 真实宿主验收与生产发布证据另见交付记录，不由本地单测代替。

## 参考资料

- React `useEffect` 清理异步副作用：https://react.dev/reference/react/useEffect
- `CanvasRenderingContext2D.drawImage`（等比裁剪）：https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
- sharp（本地解码 / 压缩 / 原始缓冲 PNG）：仓库已安装的 `sharp` 0.35 与其文档 / 源码
- ChatGPT 插件 OAuth（前端授权回调保持显式批准）：https://developers.openai.com/plugins/build/auth

## 集成复核

- 两名独立 reviewer 分别检查 UI 与后端；全部已确认问题修复，当前无未解决 P0/P1。
- 新增授权撤销回归：创建场景与读取能力等待异步默认值期间撤权，返回 unauthorized，场景写入为 0。HTTP 偏好异步读回后同样复核会话。
- 集成重点浏览器测试 24/24 通过，涵盖迟到偏好不覆盖 Studio 编辑、上传后恢复“换一个”。此前完整浏览器回归 179/179 通过，最终提交另由 CI 全量验证。
- 本地 production 模式真实浏览器/API/MCP 链路通过：注册、裁剪为 256 方形、刷新草稿、保存、随机回环 OAuth、tools/list、Web/MCP 同账号默认、旧场景不变、标记开关真实 PNG 不同、撤销后 401。此项是本地真实服务验证，不是正式 ChatGPT 宿主证明。
