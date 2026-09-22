# 模板、项目变体与布局（Templates, project variants and layouts）

状态：2026-09-23。本文描述已实现并可验证的行为；未实现的能力明确标注为未实现。

## 1. 共享模板契约

一条模板（template）是：

```
{ id, name, revision, scene, variables, createdAt, updatedAt }
```

- `scene` 是**完整校验后**的场景快照（structured 场景，或带 `layout.kind=custom` 的自定义布局，或 `Scene.reference` 保留原截图模板）。
- `variables` 是命名类型化目标，最多 50 个：
  - `{entity:'participant', id, field:'name'|'avatar'}`
  - `{entity:'message', id, field:'text'|'asset'}`
  - `{entity:'scene', field:'title'|'deviceTime'}`
  - `{entity:'reference', id, field:'text'|'image'}`
- 变量 key 必须唯一且形如 `^[a-z][a-z0-9_]{0,47}$`；禁止 `__proto__` / `constructor` / `prototype`。
- 图像变量只接受有界的内嵌 `data:image/(png|jpeg|webp);base64,...`，不接受远程 URL；文本有长度上限（姓名 100、场景标题 120、设备时间 40、消息 4000）。
- 纯函数入口：`packages/schema/templates.ts` 的 `validateTemplateDefinition`、`instantiateTemplate`、`discoverTemplateVariables`、`variableValue`。`instantiateTemplate(raw, values, newSceneId)` 返回 `{ok:true,value}|{ok:false,errors}`，调用方生成新的 UUID，实例化永远深拷贝、不改源模板。

## 2. 账号模板 API（Web）

所有请求都需要登录会话（cookie）和既有的 `Origin` + `X-IMStage-Request` 变更校验；读取会带 `X-IMStage-User` 语义并且服务端按 token 判定账号。

| 方法 | 路径 | 请求体 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/templates` | — | `{items:[summary]}`（不含场景快照） |
| POST | `/api/templates` | 模板定义（`name/description/scene/variables`）或 `{template:{...}}` | `{item: detail}` |
| GET | `/api/templates/:id` | — | `{item: detail}` |
| PUT | `/api/templates/:id` | `{revision, ...模板定义}` | `{item: detail}`，revision+1 |
| DELETE | `/api/templates/:id` | `{revision}` | `{ok:true,id}` |
| POST | `/api/templates/:id/instantiate` | `{values}` | `{scene, templateId, templateRevision, mode}` |

- 每个账号最多 50 条模板；`revision` 用于乐观并发，冲突返回 `409 revision_conflict`。
- 列表只返回摘要（`id/name/description/mode/variableCount/revision/createdAt/updatedAt`），不会返回 MB 级快照。
- `instantiate` 只返回新场景，不写入云端作品；由创作会话的普通自动保存持久化。
- 删除模板**不会**删除用它创建的作品。
- 外账号的 id 一律返回 404，不泄露存在性。
- 普通场景自动保存不会静默修改源模板。

## 3. Web 模板库与截图流程

- 路由 `#/templates`：已登录时进入账号模板库；未登录仍是公开的官网模板画廊（不发任何模型请求）。
- 从画面创建：选择“我的作品”里的一个场景，命名模板，勾选/改名可发现变量，提交后服务端校验并冻结快照。
- 使用模板：`POST /templates/:id/instantiate` → 通过 landing handoff 打开**全新创作会话**，不会调用模型、不会修改模板，之后按普通自动保存写回账号。
- 重命名/删除为真实操作，包含空态与错误态。
- 截图 → 模板：上传截图 → 明确选择“重建可编辑布局”或“保留原截图并添加可编辑区域” → 打开创作会话并带入该意图：
  - 重建：截图作为附件进入现有 Agent 流程，提示词要求结构化平台、人物、消息，并在非六种平台皮肤时用 `layout.kind=custom` 近似版式；
  - 保留：创建 `Scene.reference` 编辑层，只替换显式区域，不声称还原全部像素。
  - 生成结果画面后可用“存为模板”按钮保存为模板。
- 创作工具栏的“存为模板”可在当前可编辑画面上直接创建模板，变量来自共享的 `discoverTemplateVariables`。

## 4. 自定义声明式布局

`Scene.layout` 是可选对象，未设置时渲染完全不变（平台皮肤）。

```
layout: {
  kind: 'custom', name: string(1-80),
  avatarShape?: 'circle'|'rounded'|'square',
  showAvatars?: boolean,
  headerBackground?, incomingBackground?, outgoingBackground?, background?, textColor?: '#RRGGBB',
  bubbleRadius?: 0-40, messageSpacing?: 0-48, headerHeight?: 36-112, maxBubbleWidth?: 120-560,
  fontFamily?: 'sans'|'serif'|'mono'
}
```

- 由 `packages/schema/layout.ts` 校验；未知字段、非法颜色、越界数值都会被拒绝。
- 只允许以上 token，没有任意 HTML/CSS/JS，也没有字符串插值。
- `SceneView` 在 `data-layout="custom"` 时渲染中性页头与输入栏，使用同一渲染器与导出路径；Inspector 有紧凑的自定义布局控制组（创建/重置/编辑 token）。
- Agent 的 `update_element`（`@scene` 的 `layout` patch）与 `create_scene` 接受并校验 layout；模型上下文包含 layout，而 `targetedChangeViolation` 允许定向编辑调整它。
- MCP 的 Scene schema/归一化/patch/能力描述保留 layout，并在 `ensureSceneBounds` 后由共享校验器拒绝不安全值。

## 5. Web 项目与结构化变体

项目（project）保存通用规则与默认平台；批量任务冻结规则、模板快照/版本与每个条目的变量。

新版批量输入（与旧版互斥，混用返回 `ambiguous_batch_input`）：

```json
{
  "variants": [
    { "name": "Ava", "prompt": "生成 Ava 的对话", "values": { "field_1": "Ava" } },
    { "name": "Noah", "prompt": "生成 Noah 的对话", "values": { "field_1": "Noah" } }
  ],
  "platforms": ["wechat"],
  "templateId": "<uuid>",
  "templateRevision": 1,
  "clientBatchId": "<opaque>"
}
```

- 旧版 `prompts` / `promptsText` × `platforms` 继续可用。
- `variants` 最多 10；`variants × platforms` 最多 20；账号同时进行的批量任务最多 3。
- `values` 必须对应模板声明的 key；在写入 job 之前逐个校验，失败整批拒绝。提供 values 但没有 `templateId` 会被拒绝。
- 提交事务内冻结 `rules`、`templateId/templateRevision/templateJson` 与每个条目的 `values`；之后修改或删除模板、修改项目规则都不会影响已排队任务。
- 同一 `clientBatchId` 的重试会在“当前模板/新任务校验”之前返回已存在的冻结任务，因此模板被更新或删除后重试仍能拿回原任务，且不会触发新的 provider 调用。
- **保留原截图的模板锁定源平台**：`template.definition.scene.reference.plan.im` 之外的平台会在入队前以 `reference_platform_mismatch` 拒绝；worker 不会改写源平台。UI 会把平台锁定到源平台并给出中英文提示。
- worker 按序取任务：有模板则用冻结快照 + 该条目 values 实例化（可套用条目差异），否则空白场景；随后调用**同一个** Agent runtime 生成差异，保留项目规则。每个输出都是独立的新场景 id。
- 没有任何隐藏的图像生成：只有条目提示词要求时 Agent 才调用图片工具；provider 失败时不会报告“已生成图片”。
- 取消、登录失效、服务重启按既有语义中断，不会伪报成功。

## 6. MCP 项目 / 模板 / 批次

MCP 服务器使用**独立的** `IMSTAGE_MCP_DATA_DIR` SQLite 与 Bearer 实例作用域；它不访问 Web 账号数据库。模板复用共享纯契约（`services/templates/store.mjs`，owner 为常量实例 scope）。

| 工具 | 说明 |
| --- | --- |
| `imstage_create_project` / `imstage_list_projects` / `imstage_get_project` / `imstage_update_project` | 实例项目，名称/规则/默认值有界，`expectedRevision` 乐观并发 |
| `imstage_create_template` / `imstage_list_templates` / `imstage_get_template` / `imstage_update_template` | 共享模板契约；每个实例最多 50 条 |
| `imstage_create_batch` | 确定性原子批次：全部条目先校验后写入 |
| `imstage_get_batch` / `imstage_list_batches` | 读取回执、冻结快照与输出 `sceneId`/`revision` |

`imstage_create_batch` 参数：

```
{
  projectId,                 // 必填
  templateId?, templateRevision?,
  clientIdempotencyKey?,
  items: [
    { name, prompt, values?, patch? },  // 使用模板实例化，可选再应用定向 patch
    { name, prompt, scene }             // 或提供完整校验后的 Scene
  ]
}
```

- 条目要么提供完整 `scene`，要么 `templateId + values`（可附 `patch`），两者混用会被拒绝。
- 所有条目在**同一个事务**中写入独立的新 `scn_` 场景、快照、批次回执与条目引用；任一校验或容量失败则整批回滚。
- `clientIdempotencyKey` + 完全相同请求体返回同一 `batchId`（`deduplicated:true`）；相同 key 不同内容返回 `idempotency_conflict`。
- 回执包含 `projectId`、冻结的 `rules`、`templateId/templateRevision` 与每个条目的 `sceneId/revision`，便于复现。
- `imstage_update_project` 是部分更新：省略的 `rules`/`defaults` 保留当前值，只有显式提供（含显式空字符串/对象）才覆盖。
- 每个条目的最终场景（模板实例或实例 + patch）都会再次通过 MCP adapter 的 `enforceSceneBounds`，共享契约允许但 MCP 更严格的数值/名称/图片数量会在原子写入前失败，不产生部分数据。
- 上限：每批 20 条、实例 50 个项目、实例 50 条模板、实例场景总量 1000、批次存储 500。
- 生成的场景就是普通 MCP 场景，`imstage_get_scene` / `imstage_update_scene` / `imstage_render_scene` 保持不变。

**重要区别**：Web 批量是真实 Agent 任务（顺序 worker + limiter + 取消/重试）；MCP 批次是**同步确定性保存**，调用方 AI 负责生成全部对话与图片字节，MCP 不会调用任何模型或图片服务。

### 示例 MCP 工作流

1. `imstage_get_capabilities` 读取契约。
2. `imstage_create_project` `{project:{name:"客服评测", rules:"中文、专业、固定 4 条消息"}}`。
3. `imstage_create_template` `{template:{name:"客服基线", scene:{...}, variables:[{key:"field_1",label:"客户名",type:"text",target:{entity:"participant",id:"p-customer",field:"name"}}]}}`。
4. 调用方 AI 为每个条目生成内容与图片，然后
   `imstage_create_batch` `{projectId, templateId, templateRevision:1, clientIdempotencyKey:"eval-1", items:[{name:"case-1",prompt:"登录失败",values:{field_1:"小林"}},{name:"case-2",prompt:"退款",scene:{...}}]}`。
5. `imstage_get_batch` 读取各 `sceneId`，再用 `imstage_render_scene` 渲染。

## 7. 当前限制
- MCP 不接受 `Scene.reference`（保留原截图）与 `layout` 之外的任意样式；截图编辑仍只在 Web。
- 模板实例化不会自动调用模型；需要在创作会话里继续用 Agent 生成/改写。
- screenshot 重建是“近似版式”，不是像素级还原。
- 批次条目图片若显式提供，需为内嵌 data URL 且受请求体上限约束（Web 端 16 MiB 请求体、单条目 values 1.5 MB 上限）。
