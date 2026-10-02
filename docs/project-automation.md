# 账号项目自动化（Project → Scenario → Case）

本文件记录第一批已实现的账号项目自动化基础：共享配方/预设、确定性案例计划、场景与内容批次、HTTP 与账号 MCP 同源服务。设计全文见
`docs/superpowers/specs/2026-10-02-project-automation-design.md`，实施顺序见
`docs/superpowers/plans/2026-10-02-project-automation.md`。

## 已实现（本批）

1. **纯共享契约**（`packages/schema/project-recipes.mjs`）：
   - 版本化项目配方 `training / demo / story / evaluation_dataset / custom`（v1），含必需交付物、调用方生成指引与可确定性检查的约束；`evaluation_dataset` 额外要求 `records.jsonl` / `annotations.jsonl`。
   - 场景预设 `friendship / support / teaching / story / custom`，各带变化维度与生成指引（friendship 指引 6–10 条自然交替消息并落到具体预期结果）。
   - 确定性案例计划：`buildCasePlan` 用 coprime 步长遍历完整笛卡尔积空间，`case-001…case-100`（1–100，默认 50）在 50/100 案例时都是唯一变化组合且每个维度全覆盖；目标句按语义键选择 goal/outcome/ending。计划只是指引，不是已完成内容。
2. **账号自动化应用服务**（`services/projects/automation.mjs`，稳定接口经 `services/projects/index.mjs` 导出，供下一批导出/交付复用）：
   - 项目创建/更新支持 `type` + 有界 `brief`（语言/平台/≤20 人物表）、乐观 `revision` 与 `idempotencyKey`；省略字段保持原值。
   - 场景字段 `name/brief/preset/caseCount/platform/locale/autoExport`（autoExport 默认 true），创建时冻结项目 rules/默认值/人物表并生成稳定 case key。
   - Case 元数据 `itemKey/name/objective/context/annotations + sceneId/revision`；场景批次要求 objective/context 非空。
   - `create_content_batch`（≤20 条，完整 Scene 或 `templateId + values/patch`）：服务端生成 UUID，场景 + 项目关联 + 案例 + 回执 + 逐场景最小审计同一事务，全有或全有；真实归属/容量（账号 100 作品）/哈希校验。
   - 幂等：同 key + 同规范化请求返回原回执（默认值/模板变更后重放仍有效；哈希只覆盖调用方请求，不含解析后的可变状态）；同 key 不同请求 409 `idempotency_conflict`。
   - 去重：重复 itemKey 与「忽略 ID/标题/时间/平台」的完全重复对话签名被拒绝；签名按当前场景内容实时计算，编辑后的对话不能再以新 key 重复提交。
   - 进度真实化：完成数按存活且归属项目的场景计算；删除/改挂的场景重新变为缺项并可重提；`watermarkEnabled:false` 显式覆盖不被默认值覆盖。
   - 状态聚合只报告 `collecting / ready / awaiting_delivery`，`delivery.export: not_started`——本批不声称任何文件交付完成。
3. **HTTP 路由**（Cookie 变更保留 Origin + 请求标记校验）：
   - `GET /api/project-types`；`/api/projects` CRUD 增加 `type`/`brief`/`idempotencyKey`；
   - `GET|POST /api/projects/:projectId/scenarios`、`GET /api/projects/:projectId/scenarios/:scenarioId`；
   - `GET|POST /api/projects/:projectId/content-batches`、`GET /api/projects/:projectId/content-batches/:batchId`；
   - `GET /api/projects/:projectId/status`。
   - 既有付费 Web 批量任务（`batch-jobs`）行为不变。
4. **账号 MCP**（`/api/mcp`）：账号专用工具 `imstage_list_project_types`、项目 CRUD/list、场景 create/list/get、模板 CRUD/list、内容批次 create/get/list、`imstage_get_project_status`；MCP 直接调用同一应用服务。独立实例 16 个工具与原六个账号作品工具（含 `imstage_list_scenes`）行为不变。
5. **授权**：新增 `imstage.projects` scope，不静默升级旧授权；按工具声明 OAuth scheme（项目工具需要 scenes+projects），`tools/list` 按真实授权过滤，处理器即使被直接调用也再次校验 scope；个人 token 默认全量 scope、可显式选择 `['imstage.scenes']`；同意页明确列出新权限；不落任何临时 token。

## 未实现（明确留待后续批次）

- 确定性导出队列、真实 PNG/ZIP、下载票据与过期清理（第二批）。
- 网页端场景/案例管理界面与下载（第三批）。
- 真实 ChatGPT/Claude 宿主验收与部署（交付批次）。

## 验证

- `node --test tests/project-automation.test.mjs tests/project-scenarios.test.mjs tests/projects.test.mjs tests/connections.test.mjs tests/templates-store.test.mjs tests/mcp-projects.test.mjs`
- `npm run typecheck`
