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
   - 状态聚合真实化：内容报告 `collecting / ready`；交付状态由共享导出服务提供，只有当前、未过期文件包覆盖全部案例与项目作品才显示 `completed`。多个场景包通过 `delivery.currentExports` 分别下载；`delivery.current` 只代表单个总包，历史列表分页不影响完成度。
3. **HTTP 路由**（Cookie 变更保留 Origin + 请求标记校验）：
   - `GET /api/project-types`；`/api/projects` CRUD 增加 `type`/`brief`/`idempotencyKey`；
   - `GET|POST /api/projects/:projectId/scenarios`、`GET /api/projects/:projectId/scenarios/:scenarioId`；
   - `GET|POST /api/projects/:projectId/content-batches`、`GET /api/projects/:projectId/content-batches/:batchId`；
   - `GET /api/projects/:projectId/status`。
   - 既有付费 Web 批量任务（`batch-jobs`）行为不变。
4. **账号 MCP**（`/api/mcp`）：账号专用工具 `imstage_list_project_types`、项目 CRUD/list、场景 create/list/get、模板 CRUD/list、内容批次 create/get/list、`imstage_get_project_status`；MCP 直接调用同一应用服务。独立实例 16 个工具与原六个账号作品工具（含 `imstage_list_scenes`）行为不变。
5. **授权**：新增 `imstage.projects` scope，不静默升级旧授权；按工具声明 OAuth scheme（项目工具需要 scenes+projects），`tools/list` 按真实授权过滤，处理器即使被直接调用也再次校验 scope；个人 token 默认全量 scope、可显式选择 `['imstage.scenes']`；同意页明确列出新权限；不落任何临时 token。

## 第二批：确定性文件交付（本批已实现）

1. **导出服务**（`services/projects/exports/`，传输无关核心，API 启动时初始化一次并注入 HTTP 与账号 MCP）：
   - 生命周期 `enqueue / list / get / status / retry / cancel / download / ticket / cleanup`；共享 worker 并发 1，同一份数据被 MCP 与网页共用。
   - 入队冻结项目/场景/默认值/案例元数据 + 当前 Scene JSON/revision/内容哈希；重试沿用同一冻结快照且只重跑失败/中断条目。
   - 授权以主体引用 `{kind:'grant'|'session', id}` 持久化，绝不存原始 token；每条目前、慢渲染返回后、发布前都会重新校验授权/取消/删除。进程重启把活动导出如实标记 `interrupted` 并保留成功输出。
   - PNG 复用要求同账号 + 同 Scene 内容 + 同渲染配置 + 当前 renderer/policy 版本 + 来源授权仍有效；改 1 个场景 → 新包渲染 1 张、复用 49 张。
   - 当前/历史标记用实时指纹（项目信封 + 冻结场景 + 案例元数据 + Scene 内容 + 成员集合），不是只看 revision；旧包在编辑后仍可下载但标记为历史版本。
2. **文件包**（ZIP，stored 方法 + CRC32/中央目录，独立 Python zipfile 校验）：`project.json`、`README.md`、`scenarios/<id>/scenario.json`、`cases.jsonl`、`scenes/0001.scene.json`、`renders/<platform>/0001.png`、`assets/<sha256>.<ext>`（真实解码通过的内嵌图）、`manifest.json`、`validation.json`；`evaluation_dataset` 按冻结配方追加 `records.jsonl` + `annotations.jsonl`（标注 provenance 固定 `caller-provided`）。路径全部服务端生成 ASCII；manifest v1 只哈希内容文件（显式排除自身与 validation）；ZIP sha256/字节数记在回执里。PNG 由真实确定性渲染器生成，绝不伪造。
3. **AutoExport**：场景 `autoExport: true` 时，最后一个内容批次（案例 + 必需标注齐备）自动排一次按内容指纹去重的场景导出；缺项/缺标注如实返回原因，不自动导出；后续普通编辑需要显式新导出。
4. **HTTP**：`POST/GET /api/projects/:id/exports`、`GET .../exports/:exportId`、`POST .../retry|cancel`、`GET .../download`（属主 Cookie 或双 scope Bearer）、`POST .../download-ticket`（10 分钟不透明票据，仅存哈希，匿名可用但过期/撤销即拒）。Cookie 变更继续要求 Origin + 请求标记；no-store + attachment 头。
5. **账号 MCP**：新增 `imstage_export_project`、`imstage_retry_project_export`、`imstage_cancel_project_export`、`imstage_get_project_export`（downloadTicket 会签发票据，非只读）；`imstage_get_project_status` 支持可选 `exportId`。全量授权 27 个工具（6 作品 + 21 项目/交付），旧授权保持 6 个。
6. **限额与保留**：单次 ≤100 作品、冻结 Scene JSON ≤64 MiB、ZIP ≤100 MiB、账号保留 ≤500 MiB（包含失败任务的 UTF-8 快照、元数据、PNG 与 ZIP）、同时活动导出 ≤3 个/账号。7 天保留：启动 + 定时真实清理过期文件/票据和冻结内容并把交付标记 `expired`（状态读取立即禁用下载，签发票据也即时拒绝过期）；项目删除取消并清空其全部导出/票据/文件；失败的未登记输出即时清除。
7. **共享默认头像注入**：新内容批次经服务端 `preferencesReader.get(userId)` 给缺失的参与者头像套用账号默认（显式空值优先语义与普通 create_scene 一致），在 Scene 校验/保存前执行，重放优先于默认填充，请求哈希不依赖可变头像；解析后的头像存入 Scene 快照，真实素材进入 ZIP。

## 未实现（明确留待后续批次）

- 网页端场景/案例管理界面与下载（第三批）。
- 真实 ChatGPT/Claude 宿主验收与部署（交付批次）。

## 验证

- `node --test tests/project-exports.test.mjs tests/project-export-http.test.mjs tests/project-automation.test.mjs tests/project-scenarios.test.mjs tests/projects.test.mjs tests/connections.test.mjs tests/templates-store.test.mjs tests/mcp-projects.test.mjs`
- `node --test tests/mcp-render.test.mjs`（真实渲染器长截图回归；不在默认 verify 列表）
- `npm run typecheck`
