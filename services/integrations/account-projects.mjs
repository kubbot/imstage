// Account-owned project/scenario/template/content-batch MCP tools.
//
// These tools are *account* versions: they operate on the Web account's own
// projects, scenarios, cases and reusable templates through the shared
// `services/projects/automation.mjs` application service — exactly the same
// functions the HTTP routes call. They never touch the standalone instance
// database and never call a model: content is always caller-generated.
//
// Authorization: every tool here requires BOTH `imstage.scenes` and
// `imstage.projects`. Tool listings are filtered by the granted scopes and the
// handlers guard the scopes again even when invoked directly, so a legacy
// scenes-only credential can never reach them.

import { ProjectsError } from '../projects/errors.mjs';
import { createProjectAutomation } from '../projects/automation.mjs';
import { TemplateError, createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate } from '../templates/store.mjs';
import crypto from 'node:crypto';
import { fail } from '../mcp/errors.mjs';
import { integerField, objectField, optionalIdempotencyKey, rejectUnknownKeys, stringField } from '../mcp/args.mjs';
import { SCENE_LIMITS } from '../mcp/limits.mjs';
import { PROJECT_SCOPE, SCENE_SCOPE } from './scopes.mjs';

export const PROJECT_TOOL_SCOPES = Object.freeze([SCENE_SCOPE, PROJECT_SCOPE]);

const BATCH_ITEMS_MAX = 20;
const LIST_LIMIT_MAX = 100;

function textOk(text, structuredContent) {
  return { content: [{ type: 'text', text }], structuredContent };
}

/** Convert transport-agnostic / template errors into stable tool errors. */
function serviceCall(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProjectsError || error instanceof TemplateError) {
      fail(error.code, error.message, { status: error.status });
    }
    throw error;
  }
}

/**
 * Awaited variant for async service calls (content batches with default fill,
 * export lifecycle): a rejected Promise is mapped to a stable tool error too,
 * never surfaced as an opaque internal error.
 */
async function asyncServiceCall(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProjectsError || error instanceof TemplateError) {
      fail(error.code, error.message, { status: error.status });
    }
    throw error;
  }
}

const readOnly = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const writeOnce = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const outputSchema = Object.freeze({ type: 'object', additionalProperties: true });

const BRIEF_SCHEMA = {
  type: 'object',
  description: '项目 brief：语言、默认平台与可选人物表（≤20 人）。不存聊天全文。',
  properties: {
    language: { type: 'string', maxLength: 40 },
    platform: { type: 'string' },
    cast: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 80 },
          role: { type: 'string', maxLength: 80 },
          avatar: { type: 'string', description: '可选内嵌 data:image/...;base64 头像。' },
        },
        required: ['name', 'role'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const ACCOUNT_PROJECT_INPUT_SCHEMA = {
  type: 'object',
  description: '账号项目：名称、普通创作规则、类型配方、brief 与可选默认值。',
  properties: {
    name: { type: 'string', maxLength: 80 },
    rules: { type: 'string', maxLength: 4000, description: '普通创作约束文本，由调用方 AI 负责遵守。' },
    type: { type: 'string', enum: ['training', 'demo', 'story', 'evaluation_dataset', 'custom'] },
    brief: BRIEF_SCHEMA,
    defaults: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        watermarkEnabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  required: ['name'],
  additionalProperties: false,
};

const SCENARIO_INPUT_SCHEMA = {
  type: 'object',
  description: '账号场景计划：名称、简述、预设、案例数（1-100，默认 50）、平台、语言、水印与 autoExport。',
  properties: {
    name: { type: 'string', maxLength: 80 },
    brief: { type: 'string', maxLength: 4000 },
    preset: { type: 'string', enum: ['friendship', 'support', 'teaching', 'story', 'custom'] },
    caseCount: { type: 'integer', minimum: 1, maximum: 100 },
    platform: { type: 'string' },
    locale: { type: 'string', enum: ['zh-CN', 'en'] },
    autoExport: { type: 'boolean' },
    watermarkEnabled: { type: 'boolean', description: '省略时继承项目；显式 true/false 冻结为本场景的水印设置。' },
  },
  required: ['name'],
  additionalProperties: false,
};

const BATCH_ITEM_SCHEMA = {
  type: 'object',
  description:
    '一个案例内容条目：itemKey 必填（场景批次必须是计划中的 case-XXX）；要么提供完整 scene，要么使用 templateId + values（可附 patch）。objective/context 在场景批次中必填非空。',
  properties: {
    itemKey: { type: 'string', maxLength: 64 },
    name: { type: 'string', maxLength: 120 },
    objective: { type: 'string', maxLength: 600 },
    context: { type: 'string', maxLength: 2000 },
    annotations: {
      type: 'object',
      description: '调用方标注 {labels:{<key>:<string>}}，最多 20 个标签。',
      properties: { labels: { type: 'object' } },
      additionalProperties: false,
    },
    prompt: { type: 'string', maxLength: 4000, description: '本条差异说明；确定性保存不调用模型。' },
    values: { type: 'object', description: '模板变量取值；与 scene 互斥。' },
    patch: { type: 'object', description: '对实例化场景的定向 patch；与 scene 互斥。' },
    scene: { type: 'object', description: '完整 Scene JSON（scene.id 由服务端生成，禁止传入）；与 values/patch 互斥。' },
  },
  required: ['itemKey'],
  additionalProperties: false,
};

const CREATE_BATCH_SCHEMA = {
  type: 'object',
  description:
    '调用方内容批次：一次最多 20 条，全有或全无原子保存场景 + 项目关联 + 案例 + 回执 + 审计。不调用模型。',
  properties: {
    projectId: { type: 'string' },
    scenarioId: { type: 'string', description: '可选：提交到某个场景计划的案例。' },
    templateId: { type: 'string' },
    templateRevision: { type: 'integer', minimum: 1 },
    clientIdempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax },
    items: { type: 'array', minItems: 1, maxItems: BATCH_ITEMS_MAX, items: BATCH_ITEM_SCHEMA },
  },
  required: ['projectId', 'items'],
  additionalProperties: false,
};

const RENDER_OPTIONS_SCHEMA = {
  type: 'object',
  description: '确定性渲染配置，默认 {surface:"ios",width:390,height:844,outputKind:"long-screenshot"}。',
  properties: {
    surface: { type: 'string', enum: ['ios', 'android', 'desktop'] },
    width: { type: 'integer', minimum: 200, maximum: 1200 },
    height: { type: 'integer', minimum: 200, maximum: 20000 },
    outputKind: { type: 'string', enum: ['screenshot', 'long-screenshot'] },
  },
  additionalProperties: false,
};

/** Account tool definitions (account wording, account schemas). */
export const ACCOUNT_PROJECT_TOOLS = Object.freeze(
  [
    {
      name: 'imstage_list_project_types',
      title: '列出 IMStage 项目类型与场景预设',
      description:
        '返回版本化项目配方（training/demo/story/evaluation_dataset/custom）、必需交付物、生成指引与场景预设的变化维度。只读，不运行模型。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'imstage_create_project',
      title: '创建 IMStage 账号项目',
      description:
        '在当前账号创建项目（名称、rules、type 配方、brief、默认平台/水印），返回项目 id 与 revision。idempotencyKey 可安全重试。',
      inputSchema: {
        type: 'object',
        properties: { project: ACCOUNT_PROJECT_INPUT_SCHEMA, idempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax } },
        required: ['project'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_list_projects',
      title: '列出 IMStage 账号项目',
      description: '列出当前账号的项目摘要（id、名称、类型、revision、场景数），不含完整场景内容。',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX } }, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'imstage_get_project',
      title: '读取 IMStage 账号项目',
      description:
        '读取项目详情：共享规则/类型/brief、场景计划摘要、作品摘要、内容批次摘要与恢复建议。不返回完整场景与图片字节。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'imstage_update_project',
      title: '更新 IMStage 账号项目',
      description: '用 expectedRevision 乐观并发更新项目字段；省略的字段保持不变。冲突时重新读取。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          expectedRevision: { type: 'integer', minimum: 1 },
          project: { ...ACCOUNT_PROJECT_INPUT_SCHEMA, required: [] },
          idempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax },
        },
        required: ['projectId', 'expectedRevision', 'project'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_create_scenario',
      title: '创建 IMStage 场景计划',
      description:
        '在项目下创建场景（预设 + 计划案例数），冻结项目规则/默认值/人物表并生成稳定 case-001… 计划与生成指引。计划不是已完成内容。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          scenario: SCENARIO_INPUT_SCHEMA,
          idempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax },
        },
        required: ['projectId', 'scenario'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_list_scenarios',
      title: '列出 IMStage 场景计划',
      description: '列出项目下的场景计划摘要（案例数、已提交数、缺项与内容状态）。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'imstage_get_scenario',
      title: '读取 IMStage 场景计划',
      description:
        '读取场景、冻结规则、casePlan 指引、案例摘要、缺少的 itemKey 与续作建议；不返回完整场景或素材。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, scenarioId: { type: 'string' } },
        required: ['projectId', 'scenarioId'],
        additionalProperties: false,
      },
      annotations: readOnly,
    },
    {
      name: 'imstage_create_template',
      title: '创建 IMStage 账号模板',
      description: '用共享纯模板契约在账号下创建可复用模板（完整场景快照 + 命名类型化变量），供内容批次 values/patch 使用。',
      inputSchema: {
        type: 'object',
        properties: { template: { type: 'object', description: '共享模板定义（schemaVersion/name/description/scene/variables）。' } },
        required: ['template'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_list_templates',
      title: '列出 IMStage 账号模板',
      description: '列出账号模板摘要（名称、模式、变量数、revision），不含大型场景快照。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'imstage_get_template',
      title: '读取 IMStage 账号模板',
      description: '按 templateId 读取账号模板完整定义与 revision。',
      inputSchema: { type: 'object', properties: { templateId: { type: 'string' } }, required: ['templateId'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'imstage_update_template',
      title: '更新 IMStage 账号模板',
      description: '用 expectedRevision 乐观并发替换模板定义；已提交的场景与批次快照不受影响。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string' },
          expectedRevision: { type: 'integer', minimum: 1 },
          template: { type: 'object', description: '共享模板定义。' },
        },
        required: ['templateId', 'expectedRevision', 'template'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_delete_template',
      title: '删除 IMStage 账号模板',
      description: '用 expectedRevision 删除账号模板；已提交的场景与批次快照不受影响。',
      inputSchema: {
        type: 'object',
        properties: { templateId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 } },
        required: ['templateId', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'imstage_create_batch',
      title: '提交 IMStage 内容批次',
      description:
        '把调用方生成的内容按案例提交（≤20 条/批）：原子保存场景 + 项目关联 + 案例 + 回执 + 审计；校验归属、容量、重复 itemKey 与重复对话。同 clientIdempotencyKey + 同请求返回原回执。',
      inputSchema: CREATE_BATCH_SCHEMA,
      annotations: writeOnce,
    },
    {
      name: 'imstage_get_batch',
      title: '读取 IMStage 内容批次回执',
      description: '按 batchId 读取批次回执、冻结设置与每条的 sceneId/revision。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, batchId: { type: 'string' } },
        required: ['projectId', 'batchId'],
        additionalProperties: false,
      },
      annotations: readOnly,
    },
    {
      name: 'imstage_list_batches',
      title: '列出 IMStage 内容批次',
      description: '列出项目下的内容批次摘要（与网页付费生成任务区分）。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX } },
        required: ['projectId'],
        additionalProperties: false,
      },
      annotations: readOnly,
    },
    {
      name: 'imstage_get_project_status',
      title: '读取 IMStage 项目状态',
      description:
        '聚合真实进度：预期/已提交案例、缺项 itemKey、阶段、导出摘要（当前/历史/下载过期）与恢复动作。内容完成只报告 ready；只有当前文件包与实时内容一致时才报告 completed。可传 exportId 查看单个导出的有界条目摘要。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, exportId: { type: 'string', description: '可选：附带单个导出的详细摘要。' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      annotations: readOnly,
    },
    {
      name: 'imstage_export_project',
      title: '导出 IMStage 项目文件包',
      description:
        '冻结当前项目/场景/案例/Scene 快照并启动确定性导出：真实渲染 PNG + Scene JSON + cases.jsonl + README + manifest + validation 的 ZIP（不调用模型）。可导出整个项目、单场景（scenarioId）或指定作品（sceneIds）；缺项默认 422 missing_items，可传 allowPartial 导出已有内容（状态永远为 partial）。立即返回 exportId，之后用 imstage_get_project_status 轮询，完成后用 imstage_get_project_export 获取下载。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          expectedRevision: { type: 'integer', minimum: 1, description: '请求时的项目 revision，冲突返回 409。' },
          idempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax },
          scenarioId: { type: 'string' },
          sceneIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
          renderOptions: RENDER_OPTIONS_SCHEMA,
          allowPartial: { type: 'boolean' },
        },
        required: ['projectId', 'expectedRevision', 'idempotencyKey'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_retry_project_export',
      title: '重试 IMStage 项目导出',
      description:
        '显式重试同一冻结快照中失败/中断的条目（成功条目不会重新执行，PNG 可复用）。重试由当前有效授权重新授权；已过期的导出需重新发起。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          exportId: { type: 'string' },
          idempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax },
        },
        required: ['projectId', 'exportId', 'idempotencyKey'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_cancel_project_export',
      title: '取消 IMStage 项目导出',
      description: '取消未完成的确定性导出；已提交的输出保留并如实标记为 cancelled。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          exportId: { type: 'string' },
          idempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax },
        },
        required: ['projectId', 'exportId'],
        additionalProperties: false,
      },
      annotations: writeOnce,
    },
    {
      name: 'imstage_get_project_export',
      title: '读取 IMStage 项目导出结果',
      description:
        '返回文件清单、SHA-256、字节数、当前/历史标记与过期时间。downloadTicket:true 会签发 10 分钟下载票据 URL（绑定本 ZIP 与授权引用，可撤销；不是只读操作）。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          exportId: { type: 'string' },
          downloadTicket: { type: 'boolean', description: 'true：签发 10 分钟一次性下载票据 URL。' },
        },
        required: ['projectId', 'exportId'],
        additionalProperties: false,
      },
      // Minting a ticket is a write side effect (ticket row), so this tool is
      // intentionally NOT advertised as read-only.
      annotations: writeOnce,
    },
  ].map((tool) => ({ ...tool, outputSchema, securitySchemes: [{ type: 'oauth2', scopes: [...PROJECT_TOOL_SCOPES] }] })),
);

export const ACCOUNT_PROJECT_TOOL_NAMES = Object.freeze(ACCOUNT_PROJECT_TOOLS.map((tool) => tool.name));

/**
 * Handlers for the account project tools. Every handler re-checks the granted
 * scopes even when invoked directly (not just via the filtered tools/list).
 *
 * @param {{db: object, userId: string, appOrigin: string, grantedScopes: string[], automation?: object}} options
 */
export function createAccountProjectHandlers({ db, userId, appOrigin, grantedScopes, grantRef = null, automation = null, exportService = null, principal = null, authorizeCheck = null }) {
  const service = automation ?? createProjectAutomation({ db });
  const resolvedPrincipal = principal ?? (grantRef ? { kind: 'grant', id: grantRef } : null);
  const granted = new Set(Array.isArray(grantedScopes) ? grantedScopes : []);
  const webUrlBase = `${new URL(appOrigin).origin}/#/projects?project=`;
  const projectWebUrl = (projectId) => `${webUrlBase}${encodeURIComponent(projectId)}`;
  const sceneWebUrlBase = `${new URL(appOrigin).origin}/#/workspace?scene=`;

  function requireExportService() {
    if (!exportService || typeof exportService.enqueue !== 'function') {
      fail('export_unavailable', '导出服务未接入，无法执行文件交付', {
        recovery: '稍后重试；如果持续出现请联系服务运维。',
        status: 503,
      });
    }
    return exportService;
  }

  function guardProjectScopes() {
    for (const scope of PROJECT_TOOL_SCOPES) {
      if (!granted.has(scope)) {
        fail('insufficient_scope', `缺少授权范围：${scope}`, {
          details: { requiredScopes: [...PROJECT_TOOL_SCOPES], grantedScopes: [...granted] },
          recovery: '在 IMStage 连接设置中重新授权，勾选项目与内容批次权限后重试。',
          status: 403,
        });
      }
    }
  }

  return {
    imstage_list_project_types: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(), 'arguments');
      const payload = serviceCall(() => service.listProjectTypes());
      return textOk(`共 ${payload.items.length} 个项目类型、${payload.presets.length} 个场景预设。`, payload);
    },

    imstage_create_project: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['project', 'idempotencyKey']), 'arguments');
      const raw = objectField(args, 'project', { required: true });
      rejectUnknownKeys(raw, new Set(['name', 'rules', 'type', 'brief', 'defaults']), 'project');
      const idempotencyKey = optionalIdempotencyKey(args);
      const { item, deduplicated } = serviceCall(() => service.createProject({ userId, input: raw, idempotencyKey }));
      return textOk(
        `已创建项目 ${item.id}（type ${item.type}，revision ${item.revision}）${deduplicated ? '（幂等重试，未重复创建）' : ''}。`,
        { project: item, webUrl: projectWebUrl(item.id), deduplicated: deduplicated === true },
      );
    },

    imstage_list_projects: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['limit']), 'arguments');
      const limit = integerField(args, 'limit', { min: 1, max: LIST_LIMIT_MAX });
      const { items } = serviceCall(() => service.listProjects({ userId }));
      const bounded = limit ? items.slice(0, limit) : items;
      return textOk(`当前账号有 ${items.length} 个项目。`, {
        items: bounded.map((item) => ({ ...item, webUrl: projectWebUrl(item.id) })),
      });
    },

    imstage_get_project: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const detail = serviceCall(() => service.getProject({ userId, projectId }));
      return textOk(`项目 ${detail.item.id}（type ${detail.item.type}，revision ${detail.item.revision}）。`, {
        ...detail,
        project: detail.item,
        webUrl: projectWebUrl(detail.item.id),
        scenes: detail.scenes.map((scene) => ({ ...scene, webUrl: `${sceneWebUrlBase}${encodeURIComponent(scene.id)}` })),
      });
    },

    imstage_update_project: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'expectedRevision', 'project', 'idempotencyKey']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const expectedRevision = integerField(args, 'expectedRevision', { required: true, min: 1 });
      const raw = objectField(args, 'project', { required: true });
      rejectUnknownKeys(raw, new Set(['name', 'rules', 'type', 'brief', 'defaults']), 'project');
      const idempotencyKey = optionalIdempotencyKey(args);
      const { item, deduplicated } = serviceCall(() =>
        service.updateProject({ userId, projectId, expectedRevision, input: raw, idempotencyKey }),
      );
      return textOk(`项目 ${item.id} 已更新到 revision ${item.revision}。`, {
        project: item,
        webUrl: projectWebUrl(item.id),
        deduplicated: deduplicated === true,
      });
    },

    imstage_create_scenario: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'scenario', 'idempotencyKey']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const raw = objectField(args, 'scenario', { required: true });
      rejectUnknownKeys(raw, new Set(['name', 'brief', 'preset', 'caseCount', 'platform', 'locale', 'autoExport', 'watermarkEnabled']), 'scenario');
      const idempotencyKey = optionalIdempotencyKey(args);
      const result = serviceCall(() => service.createScenario({ userId, projectId, input: raw, idempotencyKey }));
      return textOk(
        `已创建场景「${result.scenario.name}」：计划 ${result.counts.planned} 个案例（${result.casePlan.suggestedRanges.map((r) => `${r.fromKey}~${r.toKey}(${r.count})`).join('、')}）。计划不是已完成内容。`,
        {
          ...result,
          webUrl: projectWebUrl(projectId),
          deduplicated: result.deduplicated === true,
          next: '按 casePlan 生成内容后用 imstage_create_batch 分批提交（每批 ≤20 条），再用 imstage_get_project_status 查询缺项。',
        },
      );
    },

    imstage_list_scenarios: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const { items } = serviceCall(() => service.listScenarios({ userId, projectId }));
      return textOk(`项目下有 ${items.length} 个场景计划。`, { items, webUrl: projectWebUrl(projectId) });
    },

    imstage_get_scenario: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'scenarioId']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const scenarioId = stringField(args, 'scenarioId', { required: true });
      const detail = serviceCall(() => service.getScenario({ userId, projectId, scenarioId }));
      return textOk(
        `场景「${detail.scenario.name}」：已提交 ${detail.counts.submitted}/${detail.counts.planned}，缺少 ${detail.counts.missing} 个。`,
        { ...detail, webUrl: projectWebUrl(projectId) },
      );
    },

    imstage_create_template: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['template']), 'arguments');
      const raw = objectField(args, 'template', { required: true });
      rejectUnknownKeys(raw, new Set(['name', 'description', 'scene', 'variables']), 'template');
      // Scene ids are server-owned in every tool; the shared template contract
      // validates the snapshot itself.
      const normalized = raw.scene === undefined ? raw : { ...raw, scene: { ...raw.scene, id: crypto.randomUUID() } };
      const item = serviceCall(() => createTemplate(db, userId, normalized, { nowMs: Date.now() }));
      return textOk(`已创建模板 ${item.id}（revision ${item.revision}，${item.variableCount} 个变量）。`, { template: item });
    },

    imstage_list_templates: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(), 'arguments');
      const items = serviceCall(() => listTemplates(db, userId));
      return textOk(`当前账号有 ${items.length} 个模板。`, { items });
    },

    imstage_get_template: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['templateId']), 'arguments');
      const templateId = stringField(args, 'templateId', { required: true });
      const item = serviceCall(() => getTemplate(db, userId, templateId));
      return textOk(`模板 ${item.id} revision ${item.revision}，${item.variableCount} 个变量。`, { template: item });
    },

    imstage_update_template: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['templateId', 'expectedRevision', 'template']), 'arguments');
      const templateId = stringField(args, 'templateId', { required: true });
      const expectedRevision = integerField(args, 'expectedRevision', { required: true, min: 1 });
      const raw = objectField(args, 'template', { required: true });
      rejectUnknownKeys(raw, new Set(['name', 'description', 'scene', 'variables']), 'template');
      const normalized = raw.scene === undefined ? raw : { ...raw, scene: { ...raw.scene, id: crypto.randomUUID() } };
      const item = serviceCall(() => updateTemplate(db, userId, templateId, expectedRevision, normalized, Date.now()));
      return textOk(`模板 ${item.id} 已更新到 revision ${item.revision}。`, { template: item });
    },

    imstage_delete_template: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['templateId', 'expectedRevision']), 'arguments');
      const templateId = stringField(args, 'templateId', { required: true });
      const expectedRevision = integerField(args, 'expectedRevision', { required: true, min: 1 });
      serviceCall(() => deleteTemplate(db, userId, templateId, expectedRevision));
      return textOk(`模板 ${templateId} 已删除。`, { templateId, deleted: true });
    },

    imstage_create_batch: async (args) => {
      guardProjectScopes();
      rejectUnknownKeys(
        args,
        new Set(['projectId', 'scenarioId', 'templateId', 'templateRevision', 'clientIdempotencyKey', 'items']),
        'arguments',
      );
      const projectId = stringField(args, 'projectId', { required: true });
      const input = {
        scenarioId: stringField(args, 'scenarioId', { min: 1 }),
        templateId: stringField(args, 'templateId', { min: 1 }),
        templateRevision: integerField(args, 'templateRevision', { min: 1 }),
        clientIdempotencyKey: args.clientIdempotencyKey,
        items: args.items,
      };
      // Awaited so async failures (default fill, auto-export hook) map to
      // stable tool errors like the synchronous ones. authorizeCheck is
      // re-run after the async defaults gate and before the transactional
      // write, so a revoked credential can never commit a batch.
      const receipt = await asyncServiceCall(() =>
        service.createContentBatch({
          userId,
          projectId,
          input,
          idempotencyKey: typeof args.clientIdempotencyKey === 'string' ? args.clientIdempotencyKey : null,
          origin: 'mcp',
          grantRef,
          principal: resolvedPrincipal,
          authorizeCheck,
        }),
      );
      const auto = receipt.autoExport ?? null;
      return textOk(
        `批次 ${receipt.batchId}：${receipt.total} 个案例${receipt.deduplicated ? '（幂等重试，未重复创建）' : ''}${auto?.queued ? `；已自动排队导出 ${auto.exportId}` : ''}。`,
        {
          ...receipt,
          webUrl: projectWebUrl(projectId),
          next: receipt.scenarioProgress?.missing
            ? `继续提交缺少的 ${receipt.scenarioProgress.missing} 个案例：${receipt.scenarioProgress.suggestedNextRange?.fromKey ?? '-'} 起。`
            : auto?.queued || auto?.reason === 'already_exported'
              ? '场景内容已齐备；导出进行中，用 imstage_get_project_status 轮询至 completed/partial 后用 imstage_get_project_export 获取 ZIP。'
              : '场景内容已齐备（ready）：用 imstage_export_project 发起导出（或启用 autoExport），完成后用 imstage_get_project_export 获取 ZIP。',
        },
      );
    },

    imstage_get_batch: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'batchId']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const batchId = stringField(args, 'batchId', { required: true });
      const receipt = serviceCall(() => service.getContentBatch({ userId, projectId, batchId }));
      return textOk(`批次 ${receipt.batchId}：${receipt.total} 个案例。`, { ...receipt, webUrl: projectWebUrl(projectId) });
    },

    imstage_list_batches: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'limit']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const limit = integerField(args, 'limit', { min: 1, max: LIST_LIMIT_MAX });
      const { items } = serviceCall(() => service.listContentBatches({ userId, projectId, limit }));
      return textOk(`找到 ${items.length} 个内容批次。`, { items, webUrl: projectWebUrl(projectId) });
    },

    imstage_get_project_status: (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'exportId']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const exportId = stringField(args, 'exportId', { min: 1 });
      const status = serviceCall(() => service.getProjectStatus({ userId, projectId, exportId: exportId ?? null }));
      return textOk(
        `项目状态：${status.status}（已提交 ${status.totals.submittedCases}/${status.totals.expectedCases}，缺少 ${status.totals.missingCases}）。${status.resume.nextAction}`,
        { ...status, webUrl: projectWebUrl(projectId) },
      );
    },

    imstage_export_project: async (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'expectedRevision', 'idempotencyKey', 'scenarioId', 'sceneIds', 'renderOptions', 'allowPartial']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const expectedRevision = integerField(args, 'expectedRevision', { required: true, min: 1 });
      const idempotencyKey = optionalIdempotencyKey(args);
      const service_ = requireExportService();
      const result = await asyncServiceCall(() =>
        service_.enqueue({
          userId,
          projectId,
          principal: resolvedPrincipal,
          origin: 'mcp',
          input: {
            expectedRevision,
            idempotencyKey,
            scenarioId: stringField(args, 'scenarioId', { min: 1 }),
            sceneIds: Array.isArray(args.sceneIds) ? args.sceneIds : undefined,
            renderOptions: args.renderOptions,
            allowPartial: args.allowPartial === true,
          },
        }),
      );
      return textOk(
        `导出 ${result.export.exportId} 已排队（${result.export.counts.items} 个作品，状态 ${result.export.status}）${result.deduplicated ? '（幂等重试，未重复创建）' : ''}。`,
        {
          ...result,
          webUrl: projectWebUrl(projectId),
          next: '用 imstage_get_project_status（可带 exportId）轮询；completed/partial 后用 imstage_get_project_export 获取下载。',
        },
      );
    },

    imstage_retry_project_export: async (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'exportId', 'idempotencyKey']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const exportId = stringField(args, 'exportId', { required: true });
      const idempotencyKey = optionalIdempotencyKey(args);
      const service_ = requireExportService();
      const result = await asyncServiceCall(() =>
        service_.retry({ userId, projectId, exportId, principal: resolvedPrincipal, idempotencyKey }),
      );
      return textOk(
        `导出 ${exportId} 已重新排队（重试失败/中断条目，成功条目不重新执行）${result.deduplicated ? '（幂等重试）' : ''}。`,
        { ...result, webUrl: projectWebUrl(projectId) },
      );
    },

    imstage_cancel_project_export: async (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'exportId', 'idempotencyKey']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const exportId = stringField(args, 'exportId', { required: true });
      const idempotencyKey = optionalIdempotencyKey(args);
      const service_ = requireExportService();
      const result = await asyncServiceCall(() => service_.cancel({ userId, projectId, exportId, idempotencyKey }));
      return textOk(
        result.cancelled ? `导出 ${exportId} 已取消（已保留的输出不会删除）。` : `导出 ${exportId} 已是终态，无需取消。`,
        { ...result, webUrl: projectWebUrl(projectId) },
      );
    },

    imstage_get_project_export: async (args) => {
      guardProjectScopes();
      rejectUnknownKeys(args, new Set(['projectId', 'exportId', 'downloadTicket']), 'arguments');
      const projectId = stringField(args, 'projectId', { required: true });
      const exportId = stringField(args, 'exportId', { required: true });
      const service_ = requireExportService();
      const detail = await asyncServiceCall(() => service_.get({ userId, projectId, exportId }));
      let ticket = null;
      if (args.downloadTicket === true) {
        // Ticket minting is a bounded write (ticket row, 10-minute TTL).
        ticket = await asyncServiceCall(() =>
          service_.issueDownloadTicket({ userId, projectId, exportId, principal: resolvedPrincipal }),
        );
      }
      return textOk(
        `导出 ${exportId}：${detail.export.status}（${detail.export.contentState === 'current' ? '与当前内容一致' : '历史版本'}），ZIP ${detail.export.delivery.zipBytes ?? 0} 字节。`,
        {
          ...detail,
          webUrl: projectWebUrl(projectId),
          downloadTicket: ticket ? { ticketUrl: ticket.ticketUrl, expiresAt: ticket.expiresAt } : null,
        },
      );
    },
  };
}
