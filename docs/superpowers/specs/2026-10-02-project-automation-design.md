# IMStage 账号项目自动化与完整文件交付

日期：2026-10-02。状态：用户已授权深度实现，并明确本任务停用 brainstorming 分阶段确认。按本机 Pi + MiMo 实现、Codex 验收的既定方式连续执行；不修改全局技能或其他任务设置。

## 1. 用户目标与范围

用户希望在 ChatGPT 或 Claude 中，用自然语言创建 IMStage 项目，根据项目类型生成全部作品和文件，并在网页查看、下载和继续编辑。项目必须属于本人账号，换聊天或换 AI 客户端后可以续作。

最新验收示例：创建一个模块/项目，在其中建立“WhatsApp 结交新朋友”场景，生成 50 个不同的 use case。每个案例都有稳定编号、名称、目标、背景和独立对话；多批提交可恢复，网页显示同一场景下的全部案例与进度，最终交付 50 份 Scene JSON、50 张 PNG、案例索引及文件包。随后另一个客户端能找到同一项目/场景，修改一个案例，仅重新渲染变化的作品并生成新包。

层级明确为 Project（模块）→ Scenario（一个真实使用情境）→ Case（可独立运行/编辑/导出的合成案例）。模块沿用既有项目实体，新增场景实体和案例映射，不用孤立批次冒充用户的场景。

本期实现账号项目管理、类型配方、调用方内容批量保存、进度、确定性渲染和 ZIP 交付。ChatGPT/Claude 是内容生成方，服务端不暗中再调用模型。不创建 ChatGPT/Claude 产品内部的原生 Project，不生成软件应用源码，不向用户电脑任意路径写文件，不新增付费供应商、支付服务、远程自主内容 Agent、视频生成或语音播放。

微信等是平台模板；客服培训等是项目类型，两者独立。水印默认开启，可明确关闭；沿用本会话已实现的七种平台模板。不恢复支付消息或真实截图编辑。

## 2. 已有实现与基线

本设计基于 `codex/project-template-watermark` 的 `1ff5d3cc3877ae5b420bdb029c6d1fd93228de9c`；该提交包含本会话已接受的平台选择与水印设置。独立工作分支为 `codex/project-automation`，不改动主工作区或上一任务分支。

- `services/projects/store.mjs`：账号项目、单项目场景归属、项目 revision、持久化 Web 批量任务。删除项目保留场景。
- `services/projects/batch.mjs`：调用既有 Agent runtime 的 Web 生成队列；目前与网页 session 绑定，重启中断，不自动重新花费模型额度。
- `services/integrations/account-mcp.mjs`：六个作品工具，只支持账号场景；与网页同一 `scenes` 表，没有账号项目/模板/批次工具。
- `services/mcp/server.mjs`：独立实例的 16 个工具；项目和批次数据库与账号数据分离，不能直接作为账号项目实现。
- `services/templates/store.mjs`：可复用的模板定义、实例化和 revision 契约。
- `services/mcp/render.mjs`：共享 SceneView 的确定性 PNG 渲染，已有尺寸、并发、网络访问限制。
- `services/integrations/oauth.mjs`：账号 OAuth、refresh 轮换及授权撤销；目前只有 `imstage.scenes` scope。

主分支文档中 2026-09-30 的强制水印与通用平台要求，已由本会话的新需求及上述基线的修改覆盖。其他未被本会话改变的权限、素材和消息边界继续有效。

## 3. 方案选择与组件

选择账号统一的项目编排和文件交付。单纯提示词串联现有工具无法填补账号项目缺口，也无法可靠交付完整文件。后台自主 Agent 需要额外模型调用与预算，不纳入本期。

链路为：自然语言需求 → 调用方 AI 选择配方并创建账号项目 → 分批提交 Scene 内容 → 冻结项目与场景快照 → 后台校验、渲染、打包 → 返回真实下载链接 → 通过项目 ID 继续修改。

职责拆分：

1. **配方契约**：纯数据定义项目类型、必需文件、填写提示和结构化验收要求，与 React、HTTP、MCP 共用。
2. **账号项目应用服务**：统一校验、归属、revision、幂等、审计和事务，HTTP 与 MCP 调用相同函数。不得从 MCP 绕开网页的数据约束，也不得把巨量业务逻辑继续堆进 API 路由文件。
3. **交付运行存储**：保存调用方计划、稳定 item key、内容提交回执、场景快照和导出任务；与付费 Web 生成批次区分，避免同名 batch 被误认为已经运行模型。
4. **确定性导出 worker**：只处理已保存快照的校验、PNG 和文件包；复用 renderer，限制并发，输出与项目后续编辑隔离。
5. **账号 MCP 与网页适配器**：工具提供结构化回执和恢复动作；网页显示类型、交付进度、文件清单及下载。

独立实例 MCP 不迁移数据，不更换认证。账号工具使用账号版本的描述和 schema，不直接复用“实例项目”文案或实例 owner 常量。

## 4. 项目类型与配置

新增版本化的 `ProjectRecipe`：`type`、`version`、中英文名称/说明、`requiredDeliverables`、调用方生成指引和可确定性验证的约束。首批类型为 `training`（培训）、`demo`（产品/教学演示）、`story`（叙事）、`evaluation_dataset`（评测数据集）、`custom`（通用）。

所有类型包含项目 JSON、README、Scene JSON、PNG、manifest 和 validation 文件。`evaluation_dataset` 额外要求 records.jsonl 与 annotations.jsonl；其他类型有显式标注时可提供标注文件。配方不声称能确定性验证“文风一致”“合理剧情”等自然语言规则。

账号项目增量增加 `type`、`recipeVersion` 和有界的 `brief` 配置；旧项目迁移为 `custom` 配方 v1，保留所有原有数据与 revision。brief 包含语言、平台和可选人物表，不存宿主聊天全文。人物表最多 20 人，名字/角色分别限制 80 字，头像沿用现有内嵌图片契约。

场景保存 name、brief、preset、caseCount、platform、locale、revision、autoExport 与冻结的项目默认值。每场景 1–100 个案例，项目最多 20 个场景；整体沿用每账号 100 个已保存作品限制，不增加无限生成配额。create_scenario 生成 case-001 等稳定 key 与可复用的 casePlan，返回计数、缺项和建议提交范围；50 个案例可按 20/20/10 三批提交。预设含 friendship、support、teaching、story、custom。friendship 按认识渠道、共同兴趣、关系阶段、沟通困难和预期结果规划变化，帮助调用方生成有区别的完整对话；这些规划不是已生成的作品。

每个 Case 保存 key、name、objective、context、Scene ID/revision、annotations 与内容来源。批量入口检查编号归属、必填信息、非空对话及标准化消息签名；同一场景已有或同批出现的完全重复对话拒绝，不以改 ID/标题/时间冒充不同案例。语义质量仍由调用方生成与人工审阅，不承诺检测所有近义重复。

新场景默认 `autoExport: true`，可明确关闭。计划案例和必需标注全部提交后，服务端自动建立一次该场景的确定性导出，不要求调用方再猜测需要打包。按场景计划 revision 和内容 fingerprint 去重，只在首次完整提交时自动执行；后续定向修改由调用方明确请求新导出。活动任务/存储容量不足时保留已提交内容，状态显示交付待启动及原因，重新请求导出即可恢复，不把保存成功伪报为文件完成。

既有 `platform`、`watermarkEnabled`、`rules` 保留原契约。项目默认值对新作品生效，不在后台重写已存在的场景。调用方批次在首次提交时冻结项目 revision、配方、人物、规则、平台、水印及模板版本。

## 5. 数据、归属与幂等

使用现有账号 SQLite 与共享 Scene 契约，增量迁移。新表均携带 `user_id` 并通过复合外键/归属校验保护：

- 账号内容批次及条目：批次 ID、项目 ID、请求哈希、冻结设置、item key、Scene ID/revision、可选标注及回执。
- 项目导出任务：导出 ID、项目快照、来源条目、状态/阶段、授权引用、取消标记、创建/更新时间、过期时间、受限错误。
- 导出条目：ordinal、item key、冻结场景 JSON/revision/hash、渲染配置、状态、PNG hash、文件引用、错误。
- 导出文件元数据：服务器生成的相对路径、MIME、大小、SHA-256，不接受客户端提供文件系统路径。
- 幂等记录与短期下载票据：只存哈希和有界元数据；不持久化明文 access/refresh token。

项目创建、项目更新、批次保存、导出请求和重试均支持幂等。相同 key + 相同规范化请求返回原回执；相同 key + 不同内容返回 409 `idempotency_conflict`，不能静默接受。创建场景、关联项目、写入条目/幂等回执和最小审计在同一个短事务中完成；任一条目失败则整批回滚。渲染/文件 IO 不在数据库事务内等待。

已确认成功的 item key 不重新创建 Scene。追加新批次可填补计划中未提交的 key；变更成功条目通过 `imstage_update_scene` 的 expectedRevision 执行。可编辑场景仍只存最新版本；导出任务单独持有冻结快照，不声称已实现任意历史版本回滚。

## 6. 账号 MCP 与 HTTP 契约

保留六个现有账号作品工具及返回行为；新增账号版本的项目、模板与确定性批次工具。项目/模板/Scene ID 使用网页 UUID。各结果返回真实项目/作品 webUrl，不返回实例数据库 ID。

核心工具：

| 工具 | 输入与效果 |
| --- | --- |
| `imstage_list_project_types` | 返回配方版本、必需文件与生成指引；不运行模型 |
| `imstage_create_project` | `{project:{name,rules?,type?,brief?,defaults?:{platform?,watermarkEnabled?}},idempotencyKey?}`；创建账号项目，返回项目 ID、revision、缺少的内容 |
| `imstage_list_projects` / `imstage_get_project` | 列表有界；详情包含共享规则、计划、作品摘要、批次/导出摘要与恢复建议，不默认返回图片字节和所有完整场景 |
| `imstage_update_project` | `{projectId,expectedRevision,project,idempotencyKey?}`；省略字段保持不变；冲突要求重新读取 |
| `imstage_create_scenario` | `{projectId,scenario:{name,brief,preset?,caseCount?,platform?,locale?,autoExport?},idempotencyKey}`；规划稳定案例编号，默认 caseCount=50，生成指引与计划不算完成内容 |
| `imstage_list_scenarios` / `imstage_get_scenario` | 读取项目下场景、冻结规则、案例计划、案例摘要、缺项与续作指引 |
| `imstage_create_template` / `imstage_list_templates` / `imstage_get_template` / `imstage_update_template` | 复用账号网页模板表和共享变量校验；不是迁入独立实例模板 |
| `imstage_create_batch` | `{projectId,scenarioId?,templateId?,templateRevision?,clientIdempotencyKey?,items:[{itemKey,name,objective?,context?,prompt?,scene 或 values+patch?,annotations?}]}`；最多 20 条，调用方负责内容；原子保存并关联账号项目/场景 |
| `imstage_get_batch` / `imstage_list_batches` | 返回账号确定性批次回执与 sceneId/revision，不与 Web 付费生成 job 混用 |
| `imstage_export_project` | `{projectId,expectedRevision,idempotencyKey,scenarioId?,sceneIds?,renderOptions?,allowPartial?}`；可导出单场景或整个项目，冻结内容后立即返回 exportId；不等待长渲染完成 |
| `imstage_get_project_status` | `{projectId,exportId?}`；返回预期/已提交数量、缺项、阶段、逐项状态、完整交付与恢复动作 |
| `imstage_retry_project_export` | `{projectId,exportId,idempotencyKey}`；显式重试失败/中断条目，复用成功的冻结输出；不重新生成内容 |
| `imstage_cancel_project_export` | `{projectId,exportId,idempotencyKey?}`；取消未完成的确定性任务 |
| `imstage_get_project_export` | `{projectId,exportId}`；返回文件清单、hash、大小、过期时间、网页下载 URL；完成时可请求短期下载票据 |

类型/brief 为账号工具的扩展，不强行改变独立 MCP schema。账号批次保留既有“调用方内容 + 可选共享模板”的使用方式。普通账号 create_scene 可增加可选 projectId；省略时仍保持现有行为，已有场景修改不得脱离项目。

HTTP 在既有 `/api/projects` CRUD 上增加相同字段；新增项目类型读取、确定性内容批次、导出创建/列表/详情/重试/取消接口。网页 Cookie 变更继续要求 Origin 和请求标记。MCP Bearer 直接调用应用服务，不伪造网页 session，不通过回环 HTTP 转发，也不把 OAuth 请求排进现有 session 绑定的付费队列。

所有新工具定义输入/输出 schema、真实只读/写入 annotations、上限与错误恢复信息。MCP instructions 明确：先读配方和项目 → 按 item key 生成并提交 → 查询缺项 → 导出 → 查询导出完成后才报告交付。单次工具调用不会保证宿主继续调用下一步，不能以服务端回执代替宿主端验证。

## 7. 执行状态与恢复

项目状态由真实事实聚合，不新增一个容易与任务脱节的成功布尔值：未提交计划内容为 `collecting`；内容齐备但尚未导出为 `ready`；有活动导出为 `exporting`；必需输出齐全且当前场景匹配一个完成的文件包才是 `completed`。部分输出、失败或中断如实显示，场景/设置变化后旧文件包仍可下载但标为“历史版本”。

导出状态为 `queued`、`running`、`completed`、`partial`、`failed`、`cancelled`、`interrupted`；运行阶段为 `validating`、`rendering`、`packaging`。每个场景独立记录渲染结果；worker 全局并发 1，复用已有 renderer 的并发控制。

导出前验证计划缺项、Scene 结构、图片及标注。计划内容不足默认返回 422 `missing_items`；显式 allowPartial 可导出已有内容，但状态永远是 partial，README/validation 记录缺项。空项目返回明确错误，不生成看似完整的空包。

交互请求结束、客户端断网或关闭聊天不取消已授权的确定性导出。进程重启把活动任务标为 interrupted，保留已确认输出；用户/调用方明确重试后接续。服务端不假装能恢复尚未由宿主提交的内容；get_project_status 给出未提交 item key，调用方继续生成这些条目。

重试保持原快照，不偷偷采用最新项目/场景。想交付修改后的作品须创建新的导出。内容与渲染配置、renderer/policy 版本相同且来源授权仍有效的成功 PNG 可以复用；内容改变的项重新渲染，打包重新构建。取消或授权撤销在慢渲染后再次检查，未获授权的新输出不提交/返回。

## 8. 文件包与标注

ZIP 使用服务器生成的 ASCII 路径和稳定 ordinal/item key 映射，不使用项目名或用户输入作为文件系统路径。文件包至少包含：

```text
project.json
README.md
scenarios/<scenario-id>/scenario.json
cases.jsonl                          # 稳定编号、目标、背景、场景文件与截图映射
scenes/0001.scene.json
renders/wechat/0001.png
assets/<sha256>.<verified-extension>   # 有真实内嵌素材时才出现
manifest.json
validation.json
records.jsonl                        # evaluation_dataset 必需
annotations.jsonl                    # evaluation_dataset 必需
```

project.json 包含项目类型、配方版本、冻结的规则/人物/平台/水印及场景映射，不含账号内部 userId、聊天历史、令牌或主机私密路径。Scene JSON 保持可直接重新导入的共享 Scene 契约；另存素材不把现有内嵌 data URI 改为不兼容的路径。

manifest v1 包含导出 ID、项目 revision、配方与 renderer/policy 版本、每个场景的 revision/hash，以及每个内容文件的相对路径/MIME/字节数/SHA-256。manifest 与 validation 不递归计算自身 hash；ZIP hash 和最终字节数由外部导出回执记录。校验每个必需文件存在、内容可解析、PNG 签名/尺寸与实际结果一致、素材 MIME/大小合法、JSONL 引用有效。

评测标注由调用方明确提供，schema 为 `{labels:{<key>:<string>}}`，每项最多 20 个标签、key 最多 80 字、value 最多 1000 字。annotations.jsonl 每行关联 itemKey、Scene ID/revision、labels，provenance 固定为 `caller-provided`。服务端不编造人工审核标注或 ground truth；缺少必需标注返回 `missing_annotations`。records.jsonl 包含结构化对话、平台、对应文件路径和合成来源声明。

资源上限：单次账号内容批次不超过 20 项，项目导出不超过现有每账号 100 个场景；账户同时活动导出最多 3 个；导出冻结的 Scene JSON 总量最多 64 MiB，单个 ZIP 不超过 100 MiB，每账号保留导出总量最多 500 MiB。逐项读写并打包到磁盘，不将所有场景及 PNG 同时聚合到内存。达到上限明确失败，不自动删除仍有效的文件或扩大配额。

## 9. 存储、下载与授权

导出文件位于专用持久化目录 `IMSTAGE_PROJECT_EXPORT_DIR`；默认在既有数据库目录下的 `project-exports/`。路径由服务端生成，与账号/导出元数据绑定。文件写临时路径，hash/完整性验证后原子 rename；数据库仅登记完成文件。异常后清理本任务未登记临时文件，不能遍历删除其他任务目录。

完成的文件包默认保留 7 天，详情显示 expiresAt；服务启动和日常周期真实清理过期文件与票据，并将导出标为 expired（交付状态与运行状态分开）。当前页面不得显示过期下载仍可用。项目删除取消任务并移除项目的导出文件/票据，保留原有场景；账号删除清理该账号文件。审计保留期限仍沿用既有 90 天规则。

默认下载接口校验网页会话或 Bearer 的账号归属。为宿主可点击下载提供 10 分钟有效的随机票据，只允许读取一个指定 ZIP；票据哈希入库，绑定授权引用，可撤销，不携带 access token。响应 no-store，不在日志/manifest/场景中保存票据。票据失效后由已授权工具请求新链接；文件过期后需重新导出。

新增 `imstage.projects` scope；项目工具要求 `imstage.scenes` 与 `imstage.projects`。旧 grant/token 不自动扩大权限，六个现有作品工具继续只需 scenes scope。tools/list 按真实授权过滤，capabilities 说明升级连接方式；同意页明确包含项目、模板及文件交付权限，个人 token 创建也显式采用对应范围。

队列只保存授权引用（OAuth grant、个人 token 或网页 session），不保存原始访问令牌。访问令牌正常刷新/过期不取消仍处于有效 grant 内的有限导出；grant/token 撤销、账号停用、网页 session 失效则中断未完成输出。下载票据再次检查来源授权是否仍有效。HTTP/MCP 入口即时授权检查与慢任务后的检查都保留。

## 10. 网页体验

创建项目保留七种平台预览与水印开关，并增加项目类型选择及对应交付说明。项目详情显示共享 brief/人物、预期内容与完成数量、真实逐项进度、错误原因、继续提交提示、重试失败项、取消、下载完整文件包。编辑沿用现有自动保存与 revision 冲突体验，不静默覆盖跨客户端更新。

同一界面同时展示已有 Web 模型生成任务和新的确定性文件交付，但文案和任务 ID 明确区分。模型未配置时，调用方提供内容的 MCP 导出仍可用；不能把模型不可用当成 PNG/文件交付不可用。状态按后台任务轮询，有活动任务时更新，结束后停止；不要求浏览器标签一直开启。

中英双语、手机布局、light/dark/system、键盘可达、下载过期及无权限状态都纳入验收。项目设置未同步时禁止以旧配置提交新内容或导出；真正保存后再执行。

## 11. 验收与发布证据

使用合成场景和隔离测试账号；本期只跑 Web/Node，不启动 iOS 模拟器，不为测试新增真实模型费用。先做受影响的服务/契约测试，再跑必要 UI 和构建；重大行为完成后做相关回归。测试产物遵守本机 dev-storage-guard，并保存必要正式证据。

必须通过：

1. 旧数据库增量迁移保留项目/场景/模板，默认 custom 配方；旧六个账号工具和独立实例 MCP 不回归。
2. OAuth/个人 token/网页三种入口读到相同项目和作品；跨账号访问、项目 ID 猜测、文件路径、票据、scope 不足和授权撤销均不能越权。
3. 幂等网络重试不重复项目/Scene/输出；不同内容同 key 冲突；整批错误、容量超限或审计失败事务回滚。
4. 20 条微信/WhatsApp场景、开关两种水印真实渲染；ZIP 解包后逐项验证 Scene、PNG、标注、manifest hash、文件路径及不含秘密。PNG 由真实 renderer 生成，不能只验证 stub。
5. 注入失败、渲染超时、取消、重启、授权撤销，保留成功项并显式恢复；失败项才重新执行；内容修改产生新包且旧包不被错标为最新。
6. 评测项目缺标注、计划缺内容、空项目、无素材、长图越界、超量包和过期文件都如实报告；partial 不显示为 completed。
7. 网页创建、类型选择、自动保存、进度、下载、冲突、手机及中英文交互验证；刷新或更换客户端仍可续作。

独立代码审查核对架构、权限、事务、文件生命周期和恢复语义，确认的 P0/P1 修复后才进入交付。当地测试通过不代替最新 PR CI，不绕过仓库门禁。上一任务 PR #10 未合并时本分支为依赖分支，交付说明注明依赖；合并后再对齐 main。

真实 ChatGPT 和 Claude 宿主各做“工具发现/账号授权 → 创建 → 批次保存 → 导出 → 下载 → 换对话续作”的验证，分别保存结果。缺少宿主配置/套餐权限时明确记录未验收，不以 SDK 测试宣称宿主已打通。前端预览不代替持久化后端/MCP 部署；生产上线须读回部署版本及实际文件下载。

## 12. 设计自检

范围限定于 IMStage 账号项目和确定性交付，未混入软件项目或后台付费内容生成。接口、状态、权限升级、失败恢复、文件类型、资源上限和验收标准已明确；没有以待选供应商或占位目录代替架构决定。实现计划应按“共享契约/存储 → 账号服务与 MCP → 导出 worker/下载 → 网页 → 独立验收”形成可检查的批次，并沿用本机 Pi + MiMo 实现、Codex 独立验收的既定执行偏好。
