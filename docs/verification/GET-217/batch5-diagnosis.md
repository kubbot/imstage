# GET-217 Batch 5 诊断：4/11 vs 6/11 的证据边界与未定归因

日期：2026-10-27（Asia/Singapore）
范围：仅诊断与证据，不改动产品代码、不重跑付费基准。

## 问题

PR #19 合并后（a35df47）的私有 DeepSeek 截图编辑基准为 4/11 通过，
基线 7d3e075 为 6/11；3 例 max_rounds、4 例编辑语义/保持指标未达标。
上一轮记录结论为「归因未定：单次运行无法区分模型波动与代码回归」。

## 方法

1. 逐文件比对 7d3e075 → a35df47 中该基准的全部可执行依赖路径。
2. 确定性渲染 A/B：同一组 legacy 平台（wechat / whatsapp / instagram）
   合成场景，分别用基线与现行代码离线渲染，pixelmatch（阈值 0.1）逐像素对照。
   脚本与原始结果保存在执行机 `~/linear-work/get217-ab.mjs`、
   `ab-base/`、`ab-cur/`、`get217-compare.cjs`。

## 发现一：基准可执行路径在两个版本间逐字节一致

该基准的运行链为：
`tools/eval/src/benchmark/*`（数据集/计划/打分/overlay 渲染/agent 适配）
→ `services/agent/index.mjs`（createAgentRuntime）、`screenshot-tools.mjs`、
`image-decode.mjs` → `packages/renderer/editPlanHtml.mjs`、`fitText.mjs`
（overlay 渲染，不经过场景渲染器）。

对上述指定源码文件执行 `git diff 7d3e075 a35df47`：**0 行差异**。
`services/agent` 内仅有的变更是 `prompt.mjs`（+5 行）与 `tools.mjs`（+2 行），
内容仅为平台枚举文案新增 x / jike / threads，编辑工具、运行时循环、
截图工具、打分与数据集均未改动。package.json 仅新增 check:renderer 脚本，
不直接修改模型配置。

私有参考截图分支由 `benchmark/agent.mjs` 的 `internalReferenceResearch`
经 `index.mjs` 选择 `screenshotToolset`，再由 `run.mjs` 使用
`screenshot-tools.mjs` 自有的 `buildMessages` 与 schemas；它不使用普通
`prompt.mjs` / `tools.mjs` 的提示和工具定义。两个版本的这条专用源码路径相同，
不能将普通平台枚举文案直接当作私有基准已证实的混杂变量。
这次比对也没有证明两次运行的全部依赖、提供方、采样及运行配置完全相同。

## 发现二：场景渲染器确有像素级变更，但不在基准路径上

A/B 结果（390×844，12 个场景）：

| 场景 | 基线 | 现行 | 像素差异 |
|---|---|---|---|
| wechat-basic | ok | ok | 0（完全一致） |
| whatsapp-basic | ok | ok | 54 px（0.016%，低于保持预算 0.3%） |
| instagram-basic | ok | ok | 0（完全一致） |
| wechat-quote | ok | ok | 35,445 px（10.77%） |
| whatsapp-quote | ok | ok | 12,120 px（3.68%） |
| instagram-quote | ok | ok | 32,674 px（9.93%） |
| wechat-rich | ok | output_too_tall | 内容变高后被守卫拒绝 |
| instagram-rich | ok | output_too_tall | 同上 |
| whatsapp-rich | output_too_tall | output_too_tall | — |
| 三个 *-long | output_too_tall | output_too_tall | — |

变更来源：GET-217 让离线场景渲染与编辑器 SceneView 语义对齐——
legacy 气泡新增 quote 渲染、album/link/contact/video 改为富气泡、
image 增加 asset 直读回退；富内容变高后触发 output_too_tall 守卫
（与 MCP 抓拍守卫一致，有 render-social.test.mjs 覆盖）。
该路径服务于编辑器/MCP/生成链路，**不参与**截图编辑基准的 overlay 打分，
单凭这组 A/B 不能解释基准的 4/11，也不能消除表中 quote 像素变化及
新增 `output_too_tall` 拒绝的兼容风险。守卫按设计拒绝不等于 legacy
内容已满足保持要求；这些实际行为变化仍需按相应场景验收。

## 结论

- 已核对的私有截图编辑专用源码路径在两个版本间相同；这只限定了已比对的
  源码差异，不能排除所有代码、依赖或运行环境回归机制。
- n=11、每版各 1 次运行，只观察到通过数从 6 降至 4；没有同版本重复运行的
  分布，不能据此测得运行间方差、判断这两例差值属于其范围，或把原因归给模型波动。
  **归因仍未确定；现有证据不足以证明回归，也不足以排除回归。**
- 要统计性地证伪或证实质量变化，需要同版本多次重跑取分布；
  数据集密钥与 DeepSeek 密钥均不在本机（在 CI secret 中），
  且上一轮协议明确不为碰绿付费重跑，故本轮未执行。
  是否做诊断性多次重跑，请 XINWEI 决定。

## 平台支持现状（本轮复核）

- 目录 10 平台：imstage / wechat / xiaohongshu / imessage / whatsapp /
  slack / instagram / x / jike / threads（packages/schema/platforms.mjs）。
- 新增四平台独立 LLM judge 第三轮 24/24（99–100），达到本单 ≥98 要求。
- PR #19 已合并；main 其后推进至 9ae59ea（#20/#21）。
  `generated/studio.mjs` 在 a35df47 → 9ae59ea 仍有 3 行新增、2 行删除
  （含生成来源 hash 与 Studio 背景样式），不能称完整渲染链未再变更。
  A/B 原始记录未保存“现行”端的执行 revision，不能补填为 9ae59ea，
  也不能把该 A/B 差异直接归因于 PR #19 的单一变更。私有专用基准源码的
  不变性只适用于上面明确版本、逐一核对的文件。
- 本地 LaunchAgent（web 4417 / mcp 4421）运行中；imstage.org 首页 200，
  /api/health 经 Cloudflare 403（与此前记录一致，用户已选择本地运行）。

## 仍未闭合

1. 私有基准仍为 4/11，未达到 6/11 基线门槛，不能依据本文关闭验收。
   如另获诊断性实验及费用授权，须先固定版本、输入、模型和运行配置再比较；
   本文没有重跑基准或放宽门槛，GET-217 保持 In Progress。
2. 默认账号验收：既有回执尚未形成 test@cubxxw.com 对应的实际验收证据；
   本次未创建账号或登录，也未重新核验账号是否存在。
   继续沿用指定默认账号，不回退其他账号，不将这份诊断当作账号验收。
