# GET-35：语音文字稿 + 平板截图预设（IMStage producer）

状态：**本地实现 + 聚焦测试已完成；未标 Done，未宣称语义质量通过**。真实的浏览器回归、CI 全量、合并与生产环境行为核验仍由父任务验收（见文末“剩余验收”）。父任务独立审阅后的 4 个 P2 问题已在同一任务内修复（归档记录边界、支付安全预览、2000 上限显式拒绝、元素检查器共享转换语义），证据见第 5 节。

本页只记录已经落地的事实与明确的最小兼容决策。相关契约代码：

- 共享语音语义：`packages/schema/voice.mjs`（`VOICE_TRANSCRIPT_MAX`、`voiceTranscriptError`、`hasVoiceTranscript`）
- 场景模型/校验：`apps/web/src/studio/model.ts`（`Message.voiceTranscript?`）
- 编辑器语音 UI：`apps/web/src/studio/Studio.tsx` + `apps/web/src/studio/voice-transcript.ts`（含类型化 `VoiceTranscriptError`）
- 主 Agent 元素检查器：`apps/web/src/agent/ElementInspector.tsx`（共享转换语义 + 文字稿字段）
- 渲染：`apps/web/src/studio/SceneView.tsx` + `studio.css`（React/实际 MCP SSR）与 `packages/renderer/renderSceneHtml.mjs`（确定性 HTML）
- 设备注册表：`apps/web/src/studio/device-profiles.ts`（`ipad-window`、`formFactor`）
- Agent/共享契约：`services/agent/scene-context.mjs`、`tools.mjs`、`prompt.mjs`
- MCP 契约：`services/mcp/scene.mjs`（严格服务端校验）
- 测试：`tests/voice-transcript.test.mjs`、`tests/voice-mcp.test.mjs`、`tests/scene-context.test.mjs`、`tests/get35-voice-tablet.test.mjs`、`tests/mcp-render.test.mjs`（真实渲染矩阵）、`tests/ui/get35-voice-tablet.spec.ts`（浏览器，父任务运行）

## 1. 显式语音文字稿（`Message.voiceTranscript`）

**契约**

- **可选**。`voiceTranscript?: string` 只属于 `type: 'voice'` 的消息，渲染在语音气泡**下方**。
- **永不推断**：旧语音消息的 `text`/`subtitle` 仍是气泡标签/时长（legacy label/duration），**不会**被迁移或当作隐藏文字稿；加载旧场景不会生成文字稿，也没有任何转录/语音服务调用。
- **严格校验**（`validateScene` + MCP `enforceSceneBounds`）：非字符串、超过 2000 字（复用共享文本上限）、或出现在非语音消息上都会**报错拒绝**，不做静默截断、不允许隐藏大负载混入。
- **渲染**：有文字稿（非空白）时显示在气泡下方，`white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word` 保证中文/英文/多行安全换行；React/SSR 与确定性 HTML 都转义文本，手机/桌面/平板的普通与长截图都可读。缺省时保留诚实占位（气泡内 语音/Voice 标签），不伪造“已转录”状态。
- **UI**：Studio 的语音消息编辑面板在气泡标签字段下方提供普通带标签的可编辑文本框“语音文字稿（可选，≤2000 字）”；新建语音的台词框把创作者输入的文字作为**显式合成文字稿**，气泡使用中性标签（不捏造真实时长）。主 Agent 元素检查器（`ElementInspector.tsx`）提供同一语义的带标签文字稿字段（标签沿用 SceneView 的 locale 双语惯例；`apps/web/src/i18n.ts` 不在修订后 scope 内，未新增 copy 键）。
- **显式类型转换（一次可撤销编辑）**：TEXT → VOICE 时把已创作的文本**复制进可见的文字稿字段**（气泡标签清空回中性标签）；VOICE → TEXT 时若气泡标签为空则把文字稿移回文本并删除文字稿（非语音消息不能携带文字稿）；VOICE → 其它类型在一次可撤销操作中删除文字稿。Studio 与元素检查器**共用** `messageTypeChangePatch`，切换后不再出现“非语音消息残留文字稿导致校验失败、控件失灵”的问题。只有用户显式切换类型才发生；加载旧场景永不发生（旧标签/ASR 结果永不提升）。撤销/重做逐步还原，消息/参与者 id、文案原文、草稿/保存/导入导出与隐私清洗行为不变。
- **超限显式拒绝（不静默截断）**：文字稿硬上限 2000 字。文本→语音的自动复制、新建语音提交、文字稿编辑在超过上限时**先拒绝并显示原因**（类型化 `VoiceTranscriptError`，UI 捕获），场景/草稿保持原合法状态、已输入内容保留、撤销历史不变；**绝不截断**，也**不限制**普通文本输入（合法的 2001 字普通文本仍可创建/编辑，只是不能整体自动复制为文字稿）。恰好 2000 字（含多行/Emoji/中文）合法并逐字往返。

**共享契约（Web / MCP / Agent 一致）**

- 场景序列化/校验（`validateScene`、`serializeDraft`/`parseDraft`、`serializeScene`）原样携带文字稿；省略时旧场景字节/语义兼容。
- 实际 MCP 渲染走同一个 React `SceneView` SSR（`services/mcp/studio-html.mjs`），确定性 HTML 渲染器（`packages/renderer/renderSceneHtml.mjs`）与之共享文字稿语义；`adaptSceneForRenderer` 透传该字段。
- MCP `imstage_create_scene` / `imstage_update_scene`（`addMessages`/`updateMessages`）与 Agent `create_scene` / `upsert_message` 都可以提供/修改文字稿，服务端严格校验、正常同账号限额。删除文字稿：置空字符串（`updateMessage` 与渲染都视空为缺省）。
- **归档导出边界（冻结协议，P2 修复）**：项目导出归档 `services/projects/exports/archive.mjs` 的 `records.jsonl` 保留 `messages[].text` **原样不动**（legacy 标签/时长语义），仅当场景消息存在显式 `voiceTranscript` 时**新增可选** `messages[].voiceTranscript`，逐字复制原字符串（含显式空串）；不替换 `text`、不从旧标签推断。`schemaVersion` 保持 1，哈希/id/调用方 provenance 全部不变，新增字段向后兼容。私有消费端（父任务/另一 Pi 所有）另行校验 scene/record 的文字稿存在性与值一致、类型 voice/字符串 ≤2000，并把显式非空文字稿投射为普通输入、不把旧标签当口播。
- 有界场景上下文（`buildSceneContext`）按既有每条 2000 字上限包含文字稿；没有隐藏输入/神谕泄漏，`checkSceneLimits` 另做防御性限额。
- 模型提示词（`services/agent/prompt.mjs`）明确：合成场景文字稿可以按用户的**虚构脚本**创作；画面里没有真实音频，**绝不声称**文字稿转录/转写自真实录音，也不捏造时长；真实截图参考编辑保持停用。

## 2. 平板截图预设 `ipad-window`

- 注册表项：`id: 'ipad-window'`，label `iPad 横屏窗口`，`surface: 'ios'`（**持久化枚举不变**，不新增 tablet surface），逻辑 1024 × 768、DPR 2 ⇒ 导出 2048 × 1536。
- `formFactor: 'tablet'` 是**注册表内部**判别字段（phone/tablet/desktop），不进入场景数据、不被序列化，旧解析器不受影响。
- 可复现的**通用平板横屏窗口预设**，不是任何硬件/系统/App 版本的像素认证。
- 设备下拉（Agent 创作台与元素检查器，均由 `DEVICE_PROFILES` 驱动）直接可见该预设；保存（草稿往返）与模型重建（`create_scene` 服务端保留 `deviceProfileId`/`surface`）都保留它；PNG 导出使用逻辑 × DPR（1024×768@2 → 2048×1536），普通裁切与长图规则不变；切换设备不改动场景内容与任何 id（`Scene.source` 内容/id 恒定）。
- 既有手机/legacy/macos 尺寸、兼容回退与校验**全部不变**（`tests/device-profiles.test.mjs`、`tests/get35-voice-tablet.test.mjs` 断言旧尺寸逐项不变）。

## 3. 平板两栏聊天版式（最小实现）

- 仅 `ipad-window`（`formFactor === 'tablet'`）启用两栏：左侧是**只推导当前这一条合成会话**的列表（标题/群人数/最新消息/最新时间均来自场景本身），右侧是当前会话（页头 + 消息 + 输入栏）。
- **不虚构**任何无关会话、未读数或个人头像；头像只用场景内真实参与者。
- 平板使用 iOS 风格 chrome（状态栏），与桌面 `macos-window` 的交通灯窗口 chrome 明确不同；桌面不显示移动端状态栏；截图内容只含聊天内容，不画设备边框/OS 备注等其他 App。
- 平台皮肤仍是近似合成风格预览，无品牌 logo、无像素复刻承诺。

**明确的最小兼容决策（合同含糊处，按最小向后兼容取舍）：**

1. **两栏只做平板**。合同允许“平板与桌面共用两栏”；为避免改动既有 `macos-window` 截图语义（大量既有回归/UI 用例依赖），桌面保留既有窗口语义，聚焦把平板版式做对（合同明确允许此回退）。两栏结构在 React/HTML 两条渲染路径中同语义实现，未来桌面可复用。
2. **空文字稿 = 缺省**。空/纯空白字符串存原样但渲染为无文字稿（诚实占位），编辑器清空即删除字段。
3. **TEXT ↔ VOICE 转换**按上文“复制/移回”实现（一次 `updateMessage`，撤销即还原），文案原文始终保留。
4. **确定性 HTML 渲染器的语音气泡**改为与 `SceneView` 同语义（波形 + 中性标签 + legacy 标签/时长），使两条共享渲染路径一致；消息数据不变，旧场景仅气泡外观更接近主渲染器。
5. **MCP 工具通告**：`services/mcp/server.mjs` 的 `MESSAGE_SCHEMA` 增加一个 `voiceTranscript` 属性（父任务已把该文件记入 scope 修订；因该 schema 以 `additionalProperties:false` 对外通告字段，属合同第 2 条“现有操作可提供/修改它”的必要部分，父审阅明确要求保留该严格 schema）。实际校验仍全部在清单内文件（`services/mcp/scene.mjs`）。
6. **编辑 UI 落点**：语音创建/编辑 UI 落在 `apps/web/src/studio/Studio.tsx`（默认可见的带标签文字稿字段 + 新建语音合成器）；主 Agent 元素检查器（`apps/web/src/agent/ElementInspector.tsx`，父任务已记入 scope 修订）复用共享转换语义并提供同一文字稿字段（P2 修复）。新标签沿用 SceneView 的 locale 双语惯例（`apps/web/src/i18n.ts` 不在 scope 修订内，未新增 copy 键；如需并入 i18n 文案表由父任务排期）。

## 4. 安全与策略（全部不变）

- 水印偏好仍由用户所有、默认开启；模型工具不能修改 `watermarkEnabled`/`watermark`。
- 支付/转账/红包能力保持移除与中和；**新增的平板会话列表预览与其它摘要（含可选消息的 aria 摘要）复用同一支付守卫**（`isPaymentMessageType` + `PAYMENT_NEUTRALIZED_TEXT`）：支付类原文/金额/隐藏文本在 HTML 与 React SSR 输出中**任何位置**都不出现，安全占位常显；普通文本/显式文字稿/标签仍正常显示（P2 修复，含真实双渲染器回归）。
- 真实截图参考编辑保持停用；平台皮肤无品牌 logo/像素复刻承诺。
- 认证/审计、留存与付费中性化策略不变；没有新增付费服务、凭据、依赖/模型升级或数据迁移。
- “文字稿可读给 AI”仅指有界场景上下文里的可见内容；这不是 OCR/目标 Agent 语义金标，也不构成自动人工评审。

## 5. 测试与本地验证

RED/GREEN 覆盖（均为新增/加强，不弱化既有断言）：

- `tests/voice-transcript.test.mjs`：可选字段/类型/长度/非语音使用拒绝；旧语音 `text`/`subtitle` 永不自动成为文字稿；显式 TEXT→VOICE 转换 + 撤销；新语音合成器输入（中性标签、无捏造时长）；空值即缺省；**P2 修复**：2001 字文本转换被类型化错误拒绝且旧场景保持合法、恰好 2000 字多行 Unicode 逐字往返、合成器超限抛类型化错误（不静默截断）、普通文本不限长、元素检查器转换路径（voice→image 一次可撤销删除/不提升旧标签）。
- `tests/get35-archive-records.test.mjs`（**P2 修复**）：真实 `writeArchive` 产出回归——`record.text` 原样、可选 `record.voiceTranscript` 精确字符串（含显式空串）、legacy 无字段/标签不提升、scene/record 存在性与值一致、schemaVersion 1、哈希/id/provenance 不变、旧场景向后兼容。
- `tests/get35-payment-preview.test.mjs`（**P2 修复**）：真实导出 React SSR 与确定性 HTML——支付原文/金额/隐藏文本不进入平板会话列表或正文。父级另用实际 `SceneView` 的 `exportMode:false`、`onSelect` 路径验证可选消息的 aria 摘要中和，没有为测试修改生产 SSR 接口。
- `tests/voice-mcp.test.mjs`：MCP 严格校验（类型/长度/非语音/未知字段拼写）与 patch 修改；Agent `create_scene`/`upsert_message` 提供/修改文字稿且不迁移旧标签。
- `tests/scene-context.test.mjs`：有界场景上下文包含/截断/不伪造文字稿；`checkSceneLimits` 防御限额；定向编辑只允许目标消息。
- `tests/get35-voice-tablet.test.mjs`：`ipad-window` 注册表/`validateDraft`/`serializeDraft` 往返、失配 surface 拒绝、旧尺寸逐项不变；文字稿进 React SSR/确定性 HTML/导出场景且转义；平板两栏仅含当前会话、标题来自真实场景（直聊/群聊）；渲染矩阵 402×874@3 / 1024×768@2 / 1000×720@2 同内容稳定 id、导出 = 逻辑 × DPR。
- `tests/mcp-render.test.mjs`（**真实渲染器**）：三档 profile 普通截图 = 视口，验证长图随文字稿增长（平板上有/无文字稿的像素级高度差）；完整内容由下述浏览器边界断言及实际 PNG 复核。
- `tests/ui/get35-voice-tablet.spec.ts`（浏览器，父任务运行）：语音合成器/编辑字段/转换+撤销；平板可发现性/导出 2048×1536/两栏/长图；**P2 修复**：2001 字转换与合成器提交的可见拒绝（输入保留、无状态变化、恰好 2000 成功）、元素检查器共享转换语义与文字稿字段。

本地最终受影响 Node 测试 **148/148 通过**，覆盖下列套件及既有 project-automation/project-exports；真实渲染串行执行，未修改测试或生产超时。Web/MCP 构建通过。

```bash
npm run build:mcp
npm run typecheck
node --test --test-concurrency=1 tests/device-profiles.test.mjs tests/scene-model.test.mjs tests/mcp-render.test.mjs
node --test --test-concurrency=1 tests/voice-transcript.test.mjs tests/voice-mcp.test.mjs tests/scene-context.test.mjs tests/get35-voice-tablet.test.mjs tests/get35-archive-records.test.mjs tests/get35-payment-preview.test.mjs
git diff --check
```

## 6. 剩余验收（父任务所有）

- **定向浏览器回归已通过 7/7**：覆盖编辑、撤销、2000/2001 边界、检查器转换、iPad 标准 PNG 2048×1536、长图 2048×2448。16 行文字稿的完整文本、末行边界及无溢出均有断言，并检查了真实导出 PNG。生成接口使用合成夹具，不构成真实模型质量评估。既有完整 UI 套件交给 CI；未改他人工作区的 `tests/ui/editor-experience.spec.ts`。
- **补充修复**：显式空文字稿可从 Inspector 切换类型；非空文字稿进入对话指纹，缺失/空白及旧消息哈希保持不变。真实内存批量服务接受两个不同文字稿，对相同文字稿仍返回重复错误。iPad 隐藏返回按钮后使用独立标题栏布局；三种皮肤的标题宽度和裁切均经过浏览器断言。
- **CI 全量**、代码审查、合并与发布由父任务执行。
- **生产核验**：按根 `AGENTS.md`（2026-10-04 起），改动行为需在 CI/合并后于生产站点复核后才能称“已交付”；由父任务完成。
- 父任务已检查官方结构参考和实际渲染 PNG；本页不主张官方逐像素复刻或真实 Agent 语义金标，也不把 GET-35 标为 Done。

## 7. 出处（provenance）

- 主视觉参考（父任务 2026-10-18 查看）：WhatsApp for iPad 发布博客 <https://blog.whatsapp.com/its-here-introducing-whatsapp-for-ipad>（2025-05-27）；参考页截图保存在任务验收证据中。
- 仅作**结构推断**（Chats 列表 + 当前会话的两栏结构）。参考页右侧的 Notes 面板属于另一个 iPad App 的 SplitView，**不绘制**。不复制人脸/姓名/logo/像素，也不宣称当前版本与其逐像素一致。
- `docs/device-profiles.md` 保留手机/桌面的既有事实与默认值；平板预设的约定见上文第 2 节。
