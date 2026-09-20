# tools/eval — IMStage 标注实验室与 PNG 金标评测器

本地优先、中文界面的标注工具，加上一个确定性的 PNG 金标（golden）像素评测器。
全部运行在本机 `127.0.0.1`，不依赖外部服务、模型或渲染器。

> 边界说明：这里**没有**真实的 IM 渲染器、OCR 或 AI 适配器。候选 PNG 必须来自真实的
> 外部渲染器或人工导出。工具只负责保存输入、评审、绑定指纹和做像素级对比。
> 合成起始用例是几何占位图，**不是**真实 IM UI，也**不是**已批准的产品 golden。

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

UI 的导出对话框默认勾选「仅合成」并显示不可提交私有素材的提醒。
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
- 不接受任何凭据，不读取环境中的 secret。
- 静态资源带 `nosniff`、CSP、`Referrer-Policy`；路径穿越被拒绝。

## 合成起始用例

`GET /api/starter` 预览，`POST /api/starter` 显式加载（**不会**自动写入用户 store）。
三条用例覆盖微信/iOS/中文、Telegram/Android/英文、WhatsApp/Desktop/繁中长截图，
全部 `synthetic: true` 且处于**未评审**状态，用 pngjs 生成确定性的几何占位图。

## UI 行为

- 三栏布局：用例列表 / 输入与期望 / 实际输出与评审；在 390px 宽度下单列堆叠。
- 输入表单与评审评分分别跟踪未保存状态；切换用例、新建、刷新、导入、加载示例、上传候选时
  都会先确认，避免静默丢失未保存的评分/结论/原因。
- 导出与导入提供显式下载/上传控件；导出对话框默认仅合成并提醒不要把私有素材提交到 Git/CI。
- 附件上限、候选 PNG 体积与像素上限以可读文本展示（例如「最多 8 个附件，单个不超过 2 MB」）。
- 存储损坏时状态栏与顶部提示会显示实际错误，不会继续显示 ok。

## 测试覆盖

`npm --prefix tools/eval test` 运行 86 个 node:test 用例（`node --test`，跨平台可移植），覆盖：

- 损坏 / 截断 / 越界 PNG 拒绝
- 候选过期、输入变更、评审改写（含 good→good 改分/改原因）导致金标失效
- 候选尺寸与声明不符时不可提升为金标
- 同 revision 并发保存恰好一个 409
- 缺失 / 跨站 Origin、伪造 Host、错误 Content-Type、超大 body
- 合成范围导出排除 bad / 未评审 / 私有用例
- 持久化与重启、损坏 store / 畸形 case 元数据不被覆盖、0700/0600 权限
- 导出 → 导入 → 再导出 roundtrip 与 bundle 严格校验（伪造哈希、分数、rubric、维度、重复/不安全 ID、threshold、scope）
- CLI 通过 / 失败 / 缺失 / 尺寸不符 / 过期 / 空集 / 畸形输入 / 超大 pngPath 等负向控制
- UI 真实 init 流程冒烟（DOM 隐身后执行 `public/app.js`，验证无运行时错误、筛选项保留「全部」并显示可读标签）

测试自行在 `.local/eval-test/` 下创建并在 `finally` 中清理临时目录，不使用 `/tmp`。

## 已知限制

- 没有真实 IM 渲染器适配器，也不声称有。
- 没有 OCR / AI / 图像生成能力；原始输入按原样保存。
- 合成占位图不代表任何平台的真实 UI。
- 单进程本地使用；未实现鉴权、多用户、远程部署。
- golden 的 `inputFingerprint` 覆盖附件元数据与哈希；附件内容更换即视为新输入。

## 来源

- Node.js 22 `fs.promises.rename`：<https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesrenameoldpath-newpath>
- pngjs 7.0.0：<https://github.com/pngjs/pngjs>
- pixelmatch 7.2.0：<https://github.com/mapbox/pixelmatch>
