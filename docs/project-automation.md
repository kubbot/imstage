# 账号项目自动化（Project → Scenario → Case）

本文件记录已实现的账号项目自动化：共享配方/预设、案例计划与批量生成、网页管理、真实文件交付，以及 HTTP 与账号 MCP 同源服务。设计全文见
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
   - `create_content_batch`（≤20 条，完整 Scene 或 `templateId + values/patch`）：服务端生成 UUID，场景 + 项目关联 + 案例 + 回执 + 逐场景最小审计同一事务，全有或全无；真实归属/容量（账号 100 作品）/哈希校验。
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

## 第三批：网页 Project → Scenario → 50 案例完整流程（本批已实现）

1. **项目类型与结构化 brief**：项目创建/设置页用真实类型卡片展示每种类型的交付文件清单（`GET /api/project-types` 共享配方）；`type`+结构化 `brief`（`{language?,platform?,cast?:[{name,role,avatar?}]}`，≤4000 字符）随现有自动保存引擎 + revision/幂等校验落库；旧项目/旧草稿默认 `type=custom`、`brief={}`，省略标记的旧缓存从首个远端 GET 继承真实值，不覆盖另一客户端写入的人物/头像数据。
2. **场景与案例层级**：场景表单（名称/说明/预设 friendship 默认/数量 50（1–100）/七平台真实预览+水印/语言/autoExport 默认开）；场景可显式覆盖模块水印开关（omitted 时继承模块设置），覆盖值冻结到场景并真实写入每个生成作品（幂等哈希只含显式字段）创建后展示稳定案例计划（编号/目标/背景/变化）、真实进度、缺项 itemKey、已提交作品链接；案例列表分页 ≤20 行 + 筛选，不实例化 50 个预览。
3. **AI 生成案例（既有付费 Web 生成器）**：`POST .../scenarios/:sid/generation`（generate/retry/cancel，Cookie Origin + 请求标记）将缺项案例冻结为容量预留，经既有 `batch.mjs` 串行 worker + `agent.runtime`+限流器用 20/20/10 持久化分片生成（≤20/任务，≤3 活动任务/账号，100 例由持久化 driver 串行释放后续分片）；关闭浏览器仍继续。幂等键重放/双击返回同一父任务且不重复调用模型；显式重试只补缺项/失败项；模型无有效输出如实失败。发布是单个短同步事务（会话/归属/项目/场景/预留/尝试、非空有效 Scene、同场景重复对话、容量）绑定内容+案例+任务成功，autoExport 在提交后经共享导出服务执行且导出失败不回写任务。
4. **预留与容量围栏**：`scene_reservations` 共享容量助手在所有新建 Scene 路径（HTTP createScene、account-mcp create_scene、内容批次、旧批量发布者、场景发布者）计入真实作品+活动预留；公开 MCP/Web 提交被预留的 itemKey 返回 `case_reserved`，只有匹配的内部尝试可发布；取消/中断/重启释放预留；删除项目在同一事务内终止父任务并释放全部预留（含未分配分片），慢运行结果不能在删除后发布。
5. **文件交付 UI**：导出按钮与 AI 生成分离；下载仅对真实完成或显式 `allowPartial` 的部分包开放；过期禁用并提供重新导出；失败/中断仅重试失败项、可取消；多个包是多个独立下载，项目完成度是当前未过期包的并集。
6. **连接页**：Claude 作为一等选项（官方自定义连接器指南、远程 MCP URL + OAuth 手动步骤、DCR 选择“自动注册”、云端连远程地址非 localhost），ChatGPT 链接官方开发者模式/MCP 连接器指南，Codex 用官方 `codex mcp` 命令；只有真实 tools/list 成功才显示已连接；旧 scenes-only 授权展示项目权限升级指引，不静默删除凭据。未做真实 Claude/ChatGPT 客户端宿主验收。
7. **冻结人物表**：场景生成的模型提示词包含冻结人物姓名/角色（不含头像字节），初始 Scene 预置人物名；头像在发布后按名匹配冻结人物头像、其余用共享账号默认头像；后续项目人物修改不改变已冻结场景。
8. **双语配方文本**：MCP 保留 `{zh,en}` 维度/指引对象；网页显示与 Web 模型提示词用同一助手按冻结场景语言解析，不将对象字符串作为案例变化或生成指引。

## 从 ChatGPT / Claude 发起任务

连接已部署的账号 MCP 并授权项目权限后，可给客户端以下任务：

> 创建一个培训项目，平台 WhatsApp，中文，关闭水印。场景是认识新朋友，规划并生成 50 个不同案例。按认识渠道、共同兴趣、关系阶段、沟通困难和预期结果区分；每例包含完整对话、目标和背景。提交案例后导出所有项目文件和 PNG，最后返回文件包下载链接。

客户端先查询项目配方，创建项目与场景，再读取真实案例计划。由客户端模型生成内容，使用 `imstage_create_batch` 按稳定 case key 分 20/20/10 提交完整 Scene；同一请求重试复用幂等键。用 `imstage_get_project_status` 确认缺项为零、导出已完成，再通过 `imstage_get_project_export` 请求下载票据。工具接入与连接指南已实现；真实客户端宿主和生产部署仍需下述验收，不能将本地协议验证当作已上线。

## 恢复与边界（汇总）

- 进程重启：导出/生成均如实标记 interrupted 并释放预留，需显式重试；不在进程崩溃后声称 exactly-once（provider 结果未知的尝试可能再次调用模型，UI 明示）。
- 模型未配置：生成入口返回 `ai_not_configured`；调用方内容（MCP）与确定性导出仍可用。
- 评测数据集：案例必须由调用方提供标注；Web AI 生成对 `evaluation_dataset` 明确拒绝（`missing_annotations`），不编造标注。

## 未实现（明确留待后续批次）

- 真实 ChatGPT/Claude 宿主验收与部署（交付批次）。

## 验证

- `node --test tests/project-scenario-generation.test.mjs tests/project-automation.test.mjs tests/project-scenarios.test.mjs tests/project-exports.test.mjs tests/project-export-http.test.mjs tests/projects.test.mjs tests/connections.test.mjs tests/account-client.test.mjs tests/mcp-projects.test.mjs`
- `node --test tests/mcp-render.test.mjs`（真实渲染器长截图回归；不在默认 verify 列表）
- `npm run typecheck`
- `env CI=1 IMSTAGE_TEST_PORT=… IMSTAGE_ARTIFACT_DIR=… npm run test:ui -- tests/ui/project-automation.spec.ts tests/ui/projects.spec.ts tests/ui/project-options.spec.ts tests/ui/project-autosave.spec.ts tests/ui/connections.spec.ts --workers=1`（隔离测试服务 + 受控运行时，截图存于 IMSTAGE_ARTIFACT_DIR，不入库）

2026-10-03 本地验收：完整 Node 测试 622/622、评测单元测试 194/194、类型检查与生产构建通过。受影响页面测试 47/47，通过后补充双语维度及手机布局断言并复测自动化流程 4/4；独立安全与状态边界检查 43/43。真实 Agent 链路在受控供应商下完成 50 与 100 个案例，提示词包含完整双语配方文本，重放未增加调用。真实 Chromium 完成 50 张 PNG 与 ZIP 下载，独立校验 107 个文件、105 个内容哈希、ZIP/PNG CRC、像素解压及 50 段不同对话；修改一例仅重渲染一张并复用 49 张。网页与 MCP 读取同一案例和导出，撤销授权后票据拒绝访问。此验收使用合成账号、受控模型输出，未调用付费模型，未证明真实 ChatGPT/Claude 宿主兼容或生产已部署。
