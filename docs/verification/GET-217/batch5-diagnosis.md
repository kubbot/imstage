# GET-217 Batch 5 诊断：私有截图编辑基准 4/11 vs 6/11 归因

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

对上述全部文件执行 `git diff 7d3e075 a35df47`：**0 行差异**。
`services/agent` 内仅有的变更是 `prompt.mjs`（+5 行）与 `tools.mjs`（+2 行），
内容仅为平台枚举文案新增 x / jike / threads，编辑工具、运行时循环、
截图工具、打分与数据集均未改动。package.json 仅新增 check:renderer 脚本，
与模型配置无关。

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
（与 MCP 抓拍守卫一致，属预期行为，有 render-social.test.mjs 覆盖）。
该路径服务于编辑器/MCP/生成链路，**不参与**截图编辑基准的 overlay 打分，
因此不能解释基准的 4/11。

## 结论

- 基准两次运行之间不存在代码回归机制：可执行路径逐字节一致，
  唯一变量是系统提示词中的平台枚举文案与模型运行本身。
- n=11、每版各 1 次运行、每例为多轮随机 agent 过程，±2 例摆动
  在运行间方差范围内。此前「归因未定」可收紧为：
  **无代码回归证据；差异与模型/运行方差一致。**
- 要统计性地证伪或证实质量变化，需要同版本多次重跑取分布；
  数据集密钥与 DeepSeek 密钥均不在本机（在 CI secret 中），
  且上一轮协议明确不为碰绿付费重跑，故本轮未执行。
  是否做诊断性多次重跑，请 XINWEI 决定。

## 平台支持现状（本轮复核）

- 目录 10 平台：imstage / wechat / xiaohongshu / imessage / whatsapp /
  slack / instagram / x / jike / threads（packages/schema/platforms.mjs）。
- 新增四平台独立 LLM judge 第三轮 24/24（99–100），达到本单 ≥98 要求。
- PR #19 已合并；main 其后推进至 9ae59ea（#20/#21），渲染链文件未再变更。
- 本地 LaunchAgent（web 4417 / mcp 4421）运行中；imstage.org 首页 200，
  /api/health 经 Cloudflare 403（与此前记录一致，用户已选择本地运行）。

## 仍未闭合（需 XINWEI）

1. 私有基准：接受本诊断结论并关闭该验收项，或授权诊断性多次重跑。
2. 默认账号验收：本地无 test@cubxxw.com 默认账号；需提供/创建，
   或接受以其他已授权账号验收替代。
