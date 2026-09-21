# tools/eval — IMStage 标注实验室与 PNG 金标评测器

本地优先、中文界面的标注工具，加上一个确定性的 PNG 金标（golden）像素评测器。
全部运行在本机 `127.0.0.1`。像素评测与 CLI 不依赖外部服务、模型或浏览器。

> 边界说明：AI 辅助生成是**可选**能力，需要用户自己的服务端 API Key。AI 输出只会被当作
> 未评审的候选：通过共享 conversation schema 校验后，由 `packages/renderer` 的确定性模板渲染，
> **不会**自动标为 good，也**不会**自动成为 golden。合成起始用例仍是几何占位图，
> **不是**真实 IM UI，也**不是**已批准的产品 golden。外部渲染器上传候选 PNG 的 API 保持兼容，新界面以直接生成作为主路径。

## 快速开始

```bash
# 安装（版本已在 package.json 精确锁定，lockfile 一并提交）
npm --prefix tools/eval install

# 启动标注实验室（固定 127.0.0.1:4421）
npm --prefix tools/eval start

# 运行 node:test 测试套件
npm --prefix tools/eval test

# 运行端到端自检（生成 harness 夹具并验证评测器行为）
npm --prefix tools/eval run selftest
```

启用 AI 生成时，在服务端进程环境中提供 Key（也可用 `node --env-file .local/eval.env server.mjs` 加载被
忽略的本地文件）。**Key 只存在于服务端，浏览器无法读取或设置。**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `IMSTAGE_AI_API_KEY` | 无 | 首选 API Key；未设置时回退 `DEEPSEEK_API_KEY` |
| `DEEPSEEK_API_KEY` | 无 | 备选 API Key |
| `IMSTAGE_AI_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容 Base URL |
| `IMSTAGE_AI_MODEL` | `deepseek-flash` | 模型名 |
| `IMSTAGE_AI_THINKING_DISABLED` | DeepSeek 时 `true` | 设为 `0`/`false` 可保留思考输出（默认关闭） |
| `IMSTAGE_CHROMIUM_EXECUTABLE` | 自动探测 | 截图用 Chromium/Chrome 可执行文件 |

未配置 Key 时 `GET /api/generation` 返回 `configured:false`，`POST /api/generate` 返回 `503 ai_not_configured`，
不会返回伪造的对话或假成功。

评测 CLI：

```bash
node tools/eval/cli.mjs evaluate --gold GOLD.json --actual ACTUAL.json --out DIR
# 任一用例失败 / 缺失 / 损坏 / 过期，或金标集合为空 => 退出码非零

node tools/eval/cli.mjs starter --out DIR   # 写出可选的合成起始用例
```

## 数据位置

| 内容 | 默认位置 | 覆盖方式 |
| --- | --- | --- |
| 用例与评审元数据 | `<repo>/.local/eval/store.json` | 环境变量 `IMSTAGE_EVAL_DATA_DIR` |
| 二进制附件 / 候选 PNG | `<dataDir>/blobs/<前两位>/<sha256>` | 同上 |
| 自检报告 | `<repo>/.local/eval-report/` | `--out` |
| 评测报告 | CLI `--out` 目录 | `--out` |

`store.json` 使用「同目录临时文件 → `fsync` → `rename`」的原子写入（见
[Node fs.rename](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesrenameoldpath-newpath)）。
若 `store.json` 损坏、schemaVersion 不支持，或基本 case 形状不合法，服务会拒绝读写并**保留原文件**，绝不会静默覆盖。
数据目录与 `store.json`、blob 文件以 `0700` / `0600` 权限创建（POSIX；Windows 上按平台行为）。
`GET /api/health` 在存储损坏时返回 HTTP 503 且 `ok:false`，UI 会显示实际错误。

## AI 生成：一句话或截图 → 目标 IM 结果

生成流程面向「用户只给一句话或一张/几张截图」的场景，不需要手工填写用例、上传候选。

- `GET /api/generation` 返回 `{configured, model, images:true, defaults:{targetIM:'wechat',surface:'ios',outputKind:'screenshot'}}`，
  不含 Key、Base URL 或其他服务端配置。
- `POST /api/generate` 接受同源 JSON：
  `{revision, requestId, input:{text, images:[{name,mime,dataBase64}], targetIM?, surface?, outputKind?, synthetic?}}`。

行为与限制：

- 必须提供非空 `text` 或 1–3 张图片；`targetIM` 仅 `wechat` / `telegram` / `whatsapp`，
  `surface` 为 `ios` / `android` / `desktop` / `web`，`outputKind` 为 `screenshot` / `long-screenshot`。
- 默认 `targetIM:'wechat'`、`surface:'ios'`、`outputKind:'screenshot'`；显式选项优先于截图来源平台。
- 图片在调用模型**之前**完成字节、尺寸、数量与总大小校验：单张 ≤ 2 MB、最多 3 张、总计 ≤ 6 MB、
  单边 ≤ 20000 px、总像素 ≤ 8,000,000。模型收到的是真实图片 `data:` 块，不是文件名或空说明；
  只有截图时会自动推断「复现截图中对话」的指令。
- 默认视口：`ios` / `android` 为 390×844，`desktop` / `web` 为 720×900。
- 语言自动识别并记录为 `zh-CN` / `en` / `other`，用户无需选择。
- 每次最多 1 个生成任务；`requestId` 幂等：相同输入重复请求直接返回已有结果，不重复调用模型；
  同一 `requestId` 换输入、或重复的在途请求会以 409 冲突拒绝。
- 先做生成前 revision 校验（不为过期请求付费），渲染后再在串行化写入中复核 revision，
  不会覆盖并发编辑。
- **持久化恢复账本（无法保证 exact-once）**：`<dataDir>/generation-ledger.json`（0600，原子写入）
  在调用模型前记录 `requestId`/`inputHash`（`started`），拿到模型结果后先缓存（`model_ready`），
  提交用例后再标记 `completed`。因此：渲染失败或生成后 revision 冲突的同一 `requestId` 重试会
  **复用缓存结果、不再付费**；进程在 `started` 后中断/超时等无法确认结果时，同 ID 重试返回
  `generation_outcome_unknown`，不会再次调用付费模型（UI 应提供显式的新 `requestId`）。
  已完成的用例被删除后重复该 ID 返回 `generation_not_found`，不会复活；账本损坏或超出条目上限
  一律 fail-closed，不会静默清除未完成记录。
- 客户端断开会尽量中止模型/渲染调用；在提交前会再次检查取消信号，因此不会写入未完成的用例。
  已经完成原子写入的提交**无法回滚**（这是有意的限制，不做虚假承诺）。
- 图片必须能真正解码：PNG 在调用模型前做完整解码（拒绝只有 33 字节头部、CRC/IDAT 损坏的文件）；
  JPEG/WebP 先做有界头部校验，截图时由浏览器在有界超时内执行 `image.decode()`，损坏的引用图片会
  以 `asset_decode_failed` 失败，而不是渲染出破图。
- 普通截图内容超出视口时返回 `output_too_tall` 并提示改选长截图，**不会静默裁切**；
  长截图按真实内容高度输出，且受 8,000,000 像素上限保护。
- 成功返回 `{revision, case:<与手工用例相同的 decorateCase 结构>, warnings:[string]}`。新用例包含：
  原始输入图片（作为 attachments）、校验后的 scene、候选 PNG 及 `{kind:'ai-generated',model,promptVersion,rendererVersion,generatedAt}` 溯源，
  `review:null`、`golden:null`。`synthetic` 默认 `false`，仅在显式传入时生效；
  AI 生成**绝不**自动标 good 或批准 golden。

错误是稳定且可操作的，且不泄露 Key 或供应商原始响应体：`ai_not_configured`、`ai_auth_failed`、
`ai_quota_exceeded`、`ai_timeout`、`ai_unreachable`、`ai_invalid_json`、`ai_invalid_scene`、
`generation_outcome_unknown`、`generation_not_found`、`generation_ledger_corrupt`、
`asset_decode_failed`、`output_too_tall` 等。

共享约定：`packages/schema/conversation.mjs` 校验 AI 输出的结构化对话；`packages/renderer` 提供
纯函数 `renderSceneHtml(scene,{surface,width,outputKind,assets})`；`tools/eval/src/render.mjs` 用锁定
`playwright@1.63.0` 截图并中止所有非 `data:` 网络请求。测试通过注入 `generateScene` / `renderScene`
运行，不需要外部模型或下载浏览器。独立官网编辑器尚未接入该模块，属于后续工作。

## 用例模型

每个用例包含：

- `question`：问题 / 场景描述
- `inputLanguage`：`zh-CN` / `zh-TW` / `en` / `ja` / `ko` / `other`
- `targetIM`：`wechat` / `telegram` / `whatsapp` / `custom`
- `surface`：`ios` / `android` / `desktop` / `web`
- `outputKind`：`screenshot` / `long-screenshot`
- `width` / `height`：期望输出像素尺寸
- `notes`：期望行为
- `attachments[]`：原始输入附件（image/video/audio/other，按受限 MIME 白名单）
- `candidate`：实际上传的 PNG（来自真实渲染器/人工导出）
- `review`：四项 0/1/2 评分 + 结论 + 原因
- `golden`：人工批准的金标绑定
- `synthetic`：用户显式标记的合成数据

评分 rubric（`v1`）：

| 字段 | 0 | 1 | 2 |
| --- | --- | --- | --- |
| `content` | 内容错误或缺失 | 部分正确但有明显问题 | 内容正确 |
| `imFidelity` | 平台风格明显不符 | 部分相似 | 基本符合目标 IM 风格 |
| `layout` | 布局错乱 | 基本可用但有偏差 | 布局正确 |
| `completeness` | 缺失大量要求 | 部分完整 | 完整 |

结论 `verdict`：`good` / `bad` / `unreviewed`。设置为 bad 必须填写原因。
只有「已评审 + good + 候选未过期 + 候选 PNG 尺寸与用例声明一致」的用例才能提升为金标。
尺寸不一致的候选仍可评审并标记为坏例，但**永远不能**设为金标或导出。bad 输出会保留为标注样本，
**永远不会**成为可用基线。

### 指纹与过期判定

- `inputFingerprint = sha256("imstage-eval:input:v1:" + canonicalJson(输入/目标/期望/附件哈希))`
- `review.fingerprint`（v2）绑定输入指纹、候选 `sha256`、四项评分、结论、**原因**与 rubric 版本
- `golden.fingerprint`（v2）绑定输入指纹、候选 `sha256`、`maxDiffRatio` 与 **review 指纹**
- 候选 PNG 保存上传时的 `inputFingerprint` 作为来源证明（provenance）

任何会改变输入指纹的编辑（问题、语言、目标 IM、平台、输出类型、宽高、备注、附件）
都会撤销评审与金标，并让旧候选过期，无法再评审或设为金标。
修改 `maxDiffRatio`、重新保存评审（哪怕同为 good，例如改分数或原因），
或切换 `synthetic` 标记，都会撤销金标（评级会被保留，但必须重新批准）。

### 乐观并发

所有变更请求必须携带 `revision`（取自 `GET /api/store`）。服务端串行化变更，
revision 不匹配返回 `409 revision_conflict`。缺少 revision 返回 `428`。
导入（`POST /api/import`）同样要求 `revision`，并在串行化的变更中再次校验。

## 实际输出清单（actual manifest）

评测 CLI 的 `--actual` 文件描述待比较的真实输出。必须同时给出 `caseId` 与
`inputFingerprint`，用于防止拿过期输出做对比：

```json
{
  "schemaVersion": 1,
  "kind": "imstage-eval-actual-manifest",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "cases": [
    {
      "caseId": "c_0123456789abcdef0123456789abcdef",
      "inputFingerprint": "sha256:....",
      "pngBase64": "iVBORw0KGgo..."
    },
    {
      "caseId": "c_other",
      "inputFingerprint": "sha256:....",
      "pngPath": "renders/c_other.png"
    }
  ]
}
```

`pngPath` 相对于 manifest 文件所在目录解析。读取前会先 `stat`，超过 8 MB 直接记为
`malformed / actual_too_large`，不会把超大文件读入内存。重复 `caseId` 会被拒绝；
actual 中存在而金标未引用的 `caseId` 会在报告中列为 `extraActual`，不会被静默忽略。

## 金标集 bundle（导出 / 导入 / 评测）

`--gold` 使用实验室导出的版本化 bundle：

```json
{
  "schemaVersion": 1,
  "kind": "imstage-eval-golden-bundle",
  "generator": "imstage-eval@v1",
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "scope": "synthetic",
  "threshold": 0.1,
  "cases": [
    {
      "bundleCaseId": "c_0123...",
      "question": "...",
      "inputLanguage": "zh-CN",
      "targetIM": "wechat",
      "surface": "ios",
      "outputKind": "screenshot",
      "width": 390,
      "height": 844,
      "notes": "...",
      "inputFingerprint": "sha256:....",
      "maxDiffRatio": 0.005,
      "synthetic": true,
      "rubricVersion": "v1",
      "scores": { "content": 2, "imFidelity": 2, "layout": 2, "completeness": 2 },
      "verdict": "good",
      "reason": "...",
      "reviewFingerprint": "sha256:....",
      "attachments": [
        { "name": "input.png", "kind": "image", "mime": "image/png", "sha256": "....", "size": 1234, "base64": "..." }
      ],
      "goldenPng": { "sha256": "....", "width": 390, "height": 844, "base64": "..." }
    }
  ]
}
```

导入时会重新计算 `inputFingerprint` 并做严格校验，任何一项不满足都会整体拒绝：

- 每个附件与 golden PNG 必须提供 `sha256` 且与实际内容一致；
- 声明的 `width`/`height` 必须与解码后的 golden PNG 尺寸一致；
- 四项评分必须是 0/1/2 的数字（拒绝 99、-3、字符串、null）；
- `verdict` 必须为 `good`，`rubricVersion` 必须是已知的 `v1`；
- `bundleCaseId` 必须存在且唯一；导入时还必须是安全 ID（拒绝路径分隔符等）；
- `bundle.threshold` 若给出必须为 `0.1`；
- `scope: "synthetic"` 的 bundle 中不允许出现非合成用例。

导入**只新增**：每个用例都会分配新 ID，不提供覆盖/替换路径，因此不会破坏已有数据。

### 导出范围与隐私

- `scope: "synthetic"`：只导出用户**显式标记**为合成的已批准 golden，可提交 Git/CI。
- `scope: "private"`：包含全部已批准 golden（含真实/私有素材），仅限本地或私密保存。

UI 将「导出公开金标」和「本地金标备份」分为两个明确按钮，后者提示不要提交到 Git。
bad / 未评审 / 未绑定 golden 的用例永远不会被导出。

## 评测行为

- pixelmatch `threshold` 固定为 `0.1`。
- 每用例 `maxDiffRatio` 默认 `0.005`，必须是 `[0, 0.05]` 内的有限数字。
- 先比较宽高；不一致记为 `fail / dimension_mismatch`。
- 差异比 = 差异像素数 / 总像素数；`> maxDiffRatio` 记为 `fail / pixel_difference`。
- 报告同时输出 `report.json` 与 `report.md`，失败用例写出差异 PNG（仅安全 caseId）。
  即使 gold/actual JSON 缺失或畸形，只要 `--out` 已知就会写出失败报告（CI 会在失败时上传）。
- 按 target IM / surface / input language / modality / output kind 分组统计。
- 显式区分 `missing`、`malformed`、`stale`（输入指纹不匹配）失败，并列出 extra actual ID。
- 报告中明确标注：这不是真实模型或渲染器评测。

## PNG 安全校验

在 pngjs 分配像素前先校验：

- 8 字节 PNG magic 必须匹配
- 首个数据块必须是长度 13 的 `IHDR`
- 宽高 > 0，单边 ≤ 20000，总像素 ≤ 8,000,000
- colorType 与 bitDepth 必须为合法组合
- 压缩/过滤/interlace 必须支持
- 文件 ≤ 8 MB（附件 ≤ 2 MB）

## HTTP 安全模型

- 仅绑定 `127.0.0.1:4421`（CLI/测试可用其他端口）。
- 严格校验 `Host`：只接受 `127.0.0.1` / `localhost` / `::1` 且端口一致。
- 变更请求必须同源 `Origin`（http），拒绝跨站；若存在 `Sec-Fetch-Site` 必须为 `same-origin`/`none`。
- JSON 变更必须 `Content-Type: application/json`，请求体上限 24 MB。
- 不接受任何浏览器提供的凭据；AI 的 Key/模型/Base URL 只从服务端进程环境读取，浏览器无法读取或设置。
- 静态资源带 `nosniff`、CSP、`Referrer-Policy`；路径穿越被拒绝。

## 合成起始用例

`GET /api/starter` 预览，`POST /api/starter` 显式加载（**不会**自动写入用户 store）。
三条用例覆盖微信/iOS/中文、Telegram/Android/英文、WhatsApp/Desktop/繁中长截图，
全部 `synthetic: true` 且处于**未评审**状态，用 pngjs 生成确定性的几何占位图。

## UI 行为

1. 在便签中输入一句话，或粘贴、拖入、选择 PNG/JPEG/WebP 图片（最多 3 张、单张 2 MB）。无需填写语言、尺寸和用例表单。
2. 默认微信 / iOS / 普通截图，可直接切换平台、IM 或长截图。点击「生成聊天图」后自动保存原始输入、结构化对话与候选图片。
3. 点击「好」或「不好」，可选问题标签与细分评分；坏例必须写原因。保存标注后，好例另行「确认为金标」。
4. 左侧查看历史或筛选金标；「修改输入，再生成」创建新记录，保留原记录。数据与导出集中在左下角。

草稿保存在浏览器本地，包含图片和失败重试的 requestId；空间不足会明确提示。生成完成后清空便签，记录留在历史。未保存的评价在离开前确认；全局 revision 冲突时，若当前输出及已有评审未变，重连后保留未保存评价。输出变化后必须重新确认。数据导入只新增，JSON 请求上限 24 MiB。

界面适配桌面和 390px 手机宽度；已确认旧记录仍可浏览、评审、导出。AI 没有配置时禁用生成，旧记录照常可用。生成失败保留输入，取消会尝试中止后端；网络中断后可能已经提交的完整结果以历史记录为准。

## 测试覆盖

`npm --prefix tools/eval test` 运行 `node:test` 用例（`node --test`，跨平台可移植），覆盖：

- 损坏 / 截断 / 越界 PNG 拒绝
- 候选过期、输入变更、评审改写（含 good→good 改分/改原因）导致金标失效
- 候选尺寸与声明不符时不可提升为金标
- 同 revision 并发保存恰好一个 409
- 缺失 / 跨站 Origin、伪造 Host、错误 Content-Type、超大 body
- 合成范围导出排除 bad / 未评审 / 私有用例
- 持久化与重启、损坏 store / 畸形 case 元数据不被覆盖、0700/0600 权限
- 导出 → 导入 → 再导出 roundtrip 与 bundle 严格校验（伪造哈希、分数、rubric、维度、重复/不安全 ID、threshold、scope）
- CLI 通过 / 失败 / 缺失 / 尺寸不符 / 过期 / 空集 / 畸形输入 / 超大 pngPath 等负向控制
- UI 模块初始化与好坏评分门禁（轻量 DOM stub），加上单独的真实浏览器集成验收
- AI 生成：文本 / 仅图片、默认值与覆盖、provider payload 含真实图片 `data:` 块、
  malformed 模型输出、缺少凭据、provider HTTP/超时错误、生成前后 revision 冲突、requestId 幂等与
  在途冲突、并发上限、客户端断开、PNG 尺寸与「不自动批准」、图片在网络请求前完成校验
- 持久化恢复账本：渲染失败/生成后 revision 冲突后同 ID 复用缓存（不再付费）、跨 app 实例复用、
  不确定结果返回 `generation_outcome_unknown`、变更输入冲突、已删除结果不复活、损坏 fail-closed、
  账本权限 0600；取消发生在 blob 写入期间不提交；截断 33 字节 PNG 输入/输出拒绝；
  hostile platform 不会进入 CSS/DOM
- 共享 conversation schema 的边界与安全拒绝、`renderSceneHtml` 的确定性 / 转义 /
  平台模板差异 / 无远程资源

测试临时目录可通过 `IMSTAGE_EVAL_TEST_DIR` 指定（默认 `.local/eval-test/`），并在 `finally` 中清理。

## 真实浏览器验收

```bash
# macOS 默认复用本机 Chrome；其他环境先安装 Playwright Chromium：
cd tools/eval
npx playwright install --with-deps chromium
npm run test:browser
```

`browser-smoke.mjs` 只注入 AI 边界，不调用付费模型；通过真实 Chromium 检查便签、草稿恢复、PNG 渲染、好坏评判、未保存确认、金标、导出导入、图片粘贴、长图、手机宽度、取消与失败后的同 requestId 重试。GitHub 的独立浏览器 job 使用同一命令。它不代表模型语义质量已通过。

## 已知限制

- 共享渲染器提供的是真实 IM 风格模板（微信 / Telegram / WhatsApp 与四种设备表面），
  但仍是复现近似，不声称与各平台真实客户端逐像素一致。
- 没有 OCR；图片内容理解完全依赖所配置的多模态模型。
- AI 输出只作为未评审候选，必须人工评审后才能成为 golden。
- 合成占位图不代表任何平台的真实 UI。
- 单进程本地使用；未实现鉴权、多用户、远程部署。
- golden 的 `inputFingerprint` 覆盖附件元数据与哈希；附件内容更换即视为新输入。

## 来源

- Node.js 22 `fs.promises.rename`：<https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesrenameoldpath-newpath>
- pngjs 7.0.0：<https://github.com/pngjs/pngjs>
- pixelmatch 7.2.0：<https://github.com/mapbox/pixelmatch>
- DeepSeek 视觉（image_url 格式与当前模型支持）：<https://api-docs.deepseek.com/guides/vision/>
- Playwright 1.63.0：<https://playwright.dev/>
