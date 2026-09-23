#!/usr/bin/env node
// IMStage MCP server — owner-only ChatGPT creation/editing flow.
//
// Transport: official MCP Streamable HTTP via @modelcontextprotocol/sdk,
// loopback-only on 127.0.0.1:4421 by default at /mcp.
//
// Boundaries:
//   - no changes to the active API/web services; this is a separate process
//   - bearer auth is mandatory unless an authenticated private tunnel fronts it
//   - storage is isolated to IMSTAGE_MCP_DATA_DIR (node:sqlite)
//   - no model-provider calls: ChatGPT supplies scene JSON and patches
//   - rendering is deterministic (Playwright + shared Web SceneView), network and
//     page JavaScript are blocked, pixels/time/concurrency are bounded
//
// Tools: imstage_get_capabilities, imstage_create_scene, imstage_get_scene,
//        imstage_update_scene, imstage_render_scene
// An inline MCP Apps widget is attached to imstage_render_scene only.

import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { STUDIO_RENDERER_VERSION as RENDERER_VERSION } from './studio-html.mjs';
import { PLATFORMS } from '../../apps/web/src/studio/model.ts';
import { instantiateTemplate } from '../../packages/schema/templates.ts';
import * as templateStore from '../templates/store.mjs';
import { asObject, integerField, objectField, optionalIdempotencyKey, rejectUnknownKeys, stringField } from './args.mjs';
import { resolveMcpConfig } from './config.mjs';
import { fail, invalidRequest, toErrorPayload } from './errors.mjs';
import {
  HEALTH_PATH,
  MAX_REQUEST_BYTES,
  MCP_PATH,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  BATCH_LIMITS,
  PROJECT_LIMITS,
  RENDER_OUTPUT_KINDS,
  RENDER_SURFACES,
  SCENE_LIMITS,
  TEMPLATE_LIMITS,
  WIDGET_MIME_TYPE,
} from './limits.mjs';
import { openStore } from './store.mjs';
import {
  applyScenePatch,
  buildCapabilities,
  enforceSceneBounds,
  MESSAGE_TYPES,
  prepareCreateScene,
  prepareEphemeralScene,
} from './scene.mjs';

/** The MCP server is a single authenticated instance workspace. This constant
 * is an explicit instance scope inside the isolated MCP database; it is never
 * a Web account id and there is no path from here to the Web user database. */
export const MCP_INSTANCE_SCOPE = 'mcp-instance';
import { computeRenderId, createRenderService, resolveChromiumExecutable, resolveRenderConfig } from './render.mjs';
import { newEphemeralSceneId, newSceneId, sha256Hex, stableStringify, timingSafeEqualString } from './util.mjs';
import { WIDGET_RESOURCE_URI, LEGACY_WIDGET_RESOURCE_URI, WIDGET_TITLE, buildWidgetResourceContent } from './widget.mjs';

/* ------------------------------------------------------------------ */
/* Tool schemas (plain JSON Schema; validated again in code)           */
/* ------------------------------------------------------------------ */

const PARTICIPANT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '稳定唯一 id，1-64 位 [A-Za-z0-9_-]。' },
    name: { type: 'string', maxLength: SCENE_LIMITS.nameMax },
    avatar: { type: 'string', description: '可选，仅接受内嵌 data:image/...;base64。' },
    subtitle: { type: 'string' },
  },
  required: ['id', 'name'],
  additionalProperties: false,
};

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '稳定唯一 id，1-64 位 [A-Za-z0-9_-]。' },
    participantId: { type: 'string' },
    type: { type: 'string', enum: [...MESSAGE_TYPES] },
    text: { type: 'string', maxLength: SCENE_LIMITS.textMax },
    time: { type: 'string' },
    date: { type: 'string' },
    asset: { type: 'string', description: '仅 image 消息使用，内嵌 data:image/...;base64。' },
    subtitle: { type: 'string' },
    quote: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    appearance: { type: 'object' },
    items: { type: 'array' },
  },
  required: ['id', 'type'],
  additionalProperties: false,
};

const LAYOUT_SCHEMA = {
  type: 'object',
  description:
    '可选自定义中性布局。kind 必须为 custom；颜色为六位 hex，数值需在文档范围内；不传时保持平台皮肤。',
  properties: {
    kind: { type: 'string', enum: ['custom'] },
    name: { type: 'string', maxLength: 80 },
    avatarShape: { type: 'string', enum: ['circle', 'rounded', 'square'] },
    showAvatars: { type: 'boolean' },
    headerBackground: { type: 'string' },
    incomingBackground: { type: 'string' },
    outgoingBackground: { type: 'string' },
    background: { type: 'string' },
    textColor: { type: 'string' },
    bubbleRadius: { type: 'number', minimum: 0, maximum: 40 },
    messageSpacing: { type: 'number', minimum: 0, maximum: 48 },
    headerHeight: { type: 'number', minimum: 36, maximum: 112 },
    maxBubbleWidth: { type: 'number', minimum: 120, maximum: 560 },
    fontFamily: { type: 'string', enum: ['sans', 'serif', 'mono'] },
  },
  required: ['kind', 'name'],
  additionalProperties: false,
};

const SCENE_INPUT_SCHEMA = {
  type: 'object',
  description:
    '显式场景 JSON，字段与共享 studio 场景契约一致；id 由服务端生成，请勿传入。支持当前网页的六种聊天平台。',
  properties: {
    title: { type: 'string', maxLength: SCENE_LIMITS.titleMax },
    platform: { type: 'string', enum: [...PLATFORMS] },
    deviceTime: { type: 'string' },
    date: { type: 'string' },
    selfId: { type: 'string' },
    participants: { type: 'array', minItems: 1, maxItems: SCENE_LIMITS.participantsMax, items: PARTICIPANT_SCHEMA },
    messages: { type: 'array', minItems: 1, maxItems: SCENE_LIMITS.messagesMax, items: MESSAGE_SCHEMA },
    watermark: { type: 'string', maxLength: SCENE_LIMITS.watermarkMax },
    surface: { type: 'string', enum: [...RENDER_SURFACES] },
    deviceProfileId: { type: 'string' },
    background: { type: 'string' },
    backgroundImage: { type: 'string' },
    appearance: { type: 'object' },
    layout: LAYOUT_SCHEMA,
    composerText: { type: 'string' },
    headerText: { type: 'string' },
    battery: { type: 'integer' },
    referenceDate: { type: 'string' },
    reference: { type: 'object' },
  },
  required: ['title', 'platform', 'selfId', 'participants', 'messages'],
  additionalProperties: false,
};

const PATCH_SCHEMA = {
  type: 'object',
  description:
    '定向 patch。所有操作一次性应用并统一校验，任一失败则整批不保存。participants: remove→update→add；messages: remove→update→add→move。',
  properties: {
    set: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        platform: { type: 'string', enum: [...PLATFORMS] },
        deviceTime: { type: 'string' },
        date: { type: 'string' },
        watermark: { type: 'string' },
        surface: { type: 'string', enum: [...RENDER_SURFACES] },
        deviceProfileId: { type: 'string' },
        background: { type: 'string' },
        backgroundImage: { type: 'string' },
        composerText: { type: 'string' },
        headerText: { type: 'string' },
        battery: { type: 'integer' },
        referenceDate: { type: 'string' },
        appearance: { type: 'object' },
        layout: LAYOUT_SCHEMA,
      },
      additionalProperties: false,
    },
    addParticipants: { type: 'array', items: PARTICIPANT_SCHEMA },
    updateParticipants: { type: 'array', items: { ...PARTICIPANT_SCHEMA, required: ['id'] } },
    removeParticipants: { type: 'array', items: { type: 'string' } },
    addMessages: { type: 'array', items: MESSAGE_SCHEMA },
    updateMessages: { type: 'array', items: { ...MESSAGE_SCHEMA, required: ['id'] } },
    removeMessages: { type: 'array', items: { type: 'string' } },
    moveMessages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, toIndex: { type: 'integer', minimum: 0 } },
        required: ['id', 'toIndex'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const IDEMPOTENCY_PROPERTY = {
  type: 'string',
  maxLength: SCENE_LIMITS.idempotencyKeyMax,
  description: '可选。相同 key + 完全相同请求只执行一次，用于安全重试。',
};

const PROJECT_INPUT_SCHEMA = {
  type: 'object',
  description: '实例级项目：名称、普通用户规则文本与可选默认值。项目只保存创作约束，不含机密。',
  properties: {
    name: { type: 'string', maxLength: PROJECT_LIMITS.nameMax },
    rules: { type: 'string', maxLength: PROJECT_LIMITS.rulesMax, description: '普通创作约束文本，由调用方 AI 负责遵守。' },
    defaults: { type: 'object', description: `可选默认值（如 platform）；键不超过 ${PROJECT_LIMITS.defaultsKeysMax} 个，JSON 不超过 ${PROJECT_LIMITS.defaultsJsonMax} 字符。` },
  },
  required: ['name'],
  additionalProperties: false,
};

const PROJECT_PATCH_SCHEMA = {
  type: 'object',
  description: '项目字段的部分更新；省略的字段保留当前值，只有显式提供时才覆盖。',
  properties: PROJECT_INPUT_SCHEMA.properties,
  additionalProperties: false,
};

const TEMPLATE_TARGET_SCHEMA = {
  type: 'object',
  description: '显式替换目标；必须指向场景中已存在的元素，不能使用任意对象路径。',
  properties: {
    entity: { type: 'string', enum: ['participant', 'message', 'scene', 'reference'] },
    id: { type: 'string', description: 'participant/message/reference 的稳定 id；scene 不需要。' },
    field: { type: 'string', enum: ['name', 'avatar', 'text', 'asset', 'title', 'deviceTime', 'image'] },
  },
  required: ['entity', 'field'],
  additionalProperties: false,
};

const TEMPLATE_INPUT_SCHEMA = {
  type: 'object',
  description: '共享模板契约：名称、可选说明、完整场景快照与命名变量。scene.id 由服务端生成，请勿传入。',
  properties: {
    name: { type: 'string', maxLength: TEMPLATE_LIMITS.nameMax },
    description: { type: 'string', maxLength: TEMPLATE_LIMITS.descriptionMax },
    scene: { ...SCENE_INPUT_SCHEMA, description: '完整结构化场景快照（MCP 不支持截图编辑层）。' },
    variables: {
      type: 'array',
      maxItems: TEMPLATE_LIMITS.variablesMax,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', maxLength: TEMPLATE_LIMITS.keyMax, description: '小写标识符，如 field_1。' },
          label: { type: 'string', maxLength: TEMPLATE_LIMITS.labelMax },
          type: { type: 'string', enum: ['text', 'image'] },
          target: TEMPLATE_TARGET_SCHEMA,
        },
        required: ['key', 'label', 'type', 'target'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'scene', 'variables'],
  additionalProperties: false,
};

const BATCH_ITEM_SCHEMA = {
  type: 'object',
  description: '一个批次条目：要么提供完整 scene，要么使用 templateId + values（可选再附 patch）。两者不可混用。',
  properties: {
    name: { type: 'string', maxLength: BATCH_LIMITS.nameMax },
    prompt: { type: 'string', maxLength: BATCH_LIMITS.promptMax, description: '本次差异的说明；确定性保存不会调用模型。' },
    values: { type: 'object', description: '模板变量的类型化取值。' },
    patch: PATCH_SCHEMA,
    scene: { ...SCENE_INPUT_SCHEMA, description: '完整校验后的场景；与 values/patch 互斥。' },
  },
  required: ['name', 'prompt'],
  additionalProperties: false,
};

const BATCH_INPUT_SCHEMA = {
  type: 'object',
  description:
    '确定性批次创建：一次性校验全部条目，在同一个事务中保存互相独立的新场景与批次回执。不调用任何模型；内容由调用方 AI 生成。',
  properties: {
    projectId: { type: 'string', description: '实例项目 id；必填，用于冻结规则。' },
    templateId: { type: 'string', description: '可选实例模板 id；提供后条目可用 values/patch 实例化。' },
    templateRevision: { type: 'integer', minimum: 1, description: '可选期望模板 revision；不匹配则整批拒绝。' },
    clientIdempotencyKey: { type: 'string', maxLength: SCENE_LIMITS.idempotencyKeyMax },
    items: { type: 'array', minItems: 1, maxItems: BATCH_LIMITS.itemsMax, items: BATCH_ITEM_SCHEMA },
  },
  required: ['projectId', 'items'],
  additionalProperties: false,
};

export const TOOL_DEFINITIONS = [
  {
    name: 'imstage_get_capabilities',
    title: '读取 IMStage MCP 能力与契约',
    description:
      '返回受支持的场景子集、边界、错误码、patch 操作与示例。首次使用、遇到 validation_error/unsupported_platform 或需要确认字段时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'imstage_create_scene',
    title: '创建 IMStage 场景',
    description:
      '用显式 JSON 创建一个属于本 token 所有者的场景，服务端生成不透明 sceneId 并返回 revision。idempotencyKey 可选；重试同一创建请求时复用它可避免重复场景。',
    inputSchema: {
      type: 'object',
      properties: { scene: SCENE_INPUT_SCHEMA, idempotencyKey: IDEMPOTENCY_PROPERTY },
      required: ['scene'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'imstage_get_scene',
    title: '读取 IMStage 场景',
    description:
      '按 sceneId 读取最新场景；传 revision 可读取历史快照。修改前或 revision_conflict 后先调用本工具拿到最新 expectedRevision。',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        revision: { type: 'integer', minimum: 1, description: '可选，读取指定历史版本快照。' },
      },
      required: ['sceneId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'imstage_update_scene',
    title: '定向修改 IMStage 场景',
    description:
      '以 expectedRevision 做乐观并发控制，原子应用定向 patch（按 message/participant id 增删改）。全部操作统一校验，任一失败则整批不保存。idempotencyKey 可选但建议用于重试。',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        patch: PATCH_SCHEMA,
        idempotencyKey: IDEMPOTENCY_PROPERTY,
      },
      required: ['sceneId', 'expectedRevision', 'patch'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'imstage_render_scene',
    title: '渲染 IMStage 场景为 PNG',
    description:
      '用确定性渲染器把已保存场景（或内联场景）渲染为 PNG。返回图片内容、场景状态（sceneId/revision）与渲染元数据。仅在支持 MCP Apps 的宿主中附带内联预览组件（可下载 PNG、发起下一轮修改）。',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: '与 scene 二选一。' },
        revision: { type: 'integer', minimum: 1, description: '可选，渲染指定历史版本。' },
        scene: { ...SCENE_INPUT_SCHEMA, description: '与 sceneId 二选一：一次性渲染的内联场景，不落库。' },
        surface: { type: 'string', enum: [...RENDER_SURFACES] },
        width: { type: 'integer', minimum: 200, maximum: 1200 },
        height: { type: 'integer', minimum: 200, maximum: 20_000 },
        outputKind: { type: 'string', enum: [...RENDER_OUTPUT_KINDS] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: WIDGET_RESOURCE_URI, visibility: ['model', 'app'] },
      'openai/outputTemplate': WIDGET_RESOURCE_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': '正在渲染场景…',
      'openai/toolInvocation/invoked': '渲染完成',
    },
  },
  {
    name: 'imstage_create_project',
    title: '创建实例项目',
    description: '在当前 MCP 实例内创建项目（名称、规则、可选默认值），用于冻结批次共享规则。',
    inputSchema: { type: 'object', properties: { project: PROJECT_INPUT_SCHEMA }, required: ['project'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'imstage_list_projects',
    title: '列出实例项目',
    description: '列出当前 MCP 实例的项目摘要（不含已保存场景内容）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'imstage_get_project',
    title: '读取实例项目',
    description: '按 projectId 读取项目详情、规则、revision 与批次摘要。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'imstage_update_project',
    title: '更新实例项目',
    description: '用 expectedRevision 乐观并发更新项目名称、规则或默认值。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 }, project: PROJECT_PATCH_SCHEMA }, required: ['projectId', 'expectedRevision', 'project'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'imstage_create_template',
    title: '创建实例模板',
    description: '用共享纯模板契约创建实例模板：完整场景快照 + 命名类型化变量。',
    inputSchema: { type: 'object', properties: { template: TEMPLATE_INPUT_SCHEMA }, required: ['template'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'imstage_list_templates',
    title: '列出实例模板',
    description: '列出实例模板摘要（名称、模式、变量数、revision），不含大型场景快照。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'imstage_get_template',
    title: '读取实例模板',
    description: '按 templateId 读取完整模板定义与 revision。',
    inputSchema: { type: 'object', properties: { templateId: { type: 'string' } }, required: ['templateId'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'imstage_update_template',
    title: '更新实例模板',
    description: '用 expectedRevision 乐观并发替换模板定义；已创建的场景不受影响。',
    inputSchema: { type: 'object', properties: { templateId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 }, template: TEMPLATE_INPUT_SCHEMA }, required: ['templateId', 'expectedRevision', 'template'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'imstage_create_batch',
    title: '确定性创建批次',
    description: '一次性校验并原子保存多个互相独立的新场景与批次回执。不调用模型；调用方 AI 负责生成内容与图片。clientIdempotencyKey 可安全重试。',
    inputSchema: BATCH_INPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'imstage_get_batch',
    title: '读取批次',
    description: '按 batchId 读取批次回执、冻结的模板/规则快照与每个输出场景的 sceneId/revision。',
    inputSchema: { type: 'object', properties: { batchId: { type: 'string' } }, required: ['batchId'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'imstage_list_batches',
    title: '列出批次',
    description: '列出批次摘要，可按 projectId 过滤。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

for (const tool of TOOL_DEFINITIONS) {
  const properties = tool.name === 'imstage_get_capabilities' ? {
    server:{type:'string'}, supportedSubset:{type:'object'}, examples:{type:'object'}
  } : tool.name === 'imstage_render_scene' ? {
    sceneId:{type:['string','null']}, revision:{type:['integer','null']}, renderId:{type:'string'},
    title:{type:'string'}, width:{type:'integer'}, height:{type:'integer'}, sha256:{type:'string'}, downloadUri:{type:'string'}
  } : tool.name === 'imstage_create_scene' || tool.name === 'imstage_get_scene' || tool.name === 'imstage_update_scene' ? {sceneId:{type:'string'}, revision:{type:'integer'}, scene:{type:'object'}} : null;
  if (!properties) {
    tool.outputSchema = { type: 'object', additionalProperties: true };
    continue;
  }
  tool.outputSchema = {type:'object', anyOf:[{properties, required:Object.keys(properties), additionalProperties:true},{properties:{error:{type:'object',properties:{code:{type:'string'},message:{type:'string'}},required:['code','message']}},required:['error'],additionalProperties:false}]};
}

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'imstage://scenes/{sceneId}',
    name: 'IMStage 场景（最新）',
    description: '返回指定 sceneId 的最新场景 JSON。',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'imstage://scenes/{sceneId}/revisions/{revision}',
    name: 'IMStage 场景快照',
    description: '返回指定 sceneId + revision 的历史快照 JSON。',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'imstage://renders/{renderId}.png',
    name: 'IMStage 渲染 PNG',
    description: '返回一次渲染的 PNG 二进制（base64 blob），供宿主下载。',
    mimeType: 'image/png',
  },
];

export const SERVER_INSTRUCTIONS =
  'IMStage 只做确定性 IM 聊天截图与确定性保存，不调用模型。单场景流程：imstage_create_scene → imstage_update_scene(expectedRevision) → imstage_render_scene。批量流程：imstage_create_project（规则）→ 可选 imstage_create_template（场景快照 + 命名变量）→ imstage_create_batch（projectId + 条目；条目要么提供完整 scene，要么 templateId + values/patch；可带 clientIdempotencyKey 幂等重试）→ imstage_get_batch 读回回执与 sceneId → imstage_render_scene 渲染。所有批次条目在同一个事务中先校验后写入，任一失败则整批不保存。scene.id 由服务端生成，禁止传入；不要传远程图片 URL，只接受内嵌 data:image/...;base64。ChatGPT 负责生成全部内容与图片，本服务不会代替模型生成。先读取 imstage_get_capabilities。';

/* ------------------------------------------------------------------ */
/* Tool handlers                                                       */
/* ------------------------------------------------------------------ */

function textOk(text, structuredContent, meta) {
  const result = { content: [{ type: 'text', text }], structuredContent };
  if (meta) result._meta = meta;
  return result;
}

function toolError(error, logger, toolName) {
  const payload = toErrorPayload(error);
  if (payload.code === 'internal_error') {
    logger.error(`[imstage-mcp] tool ${toolName} failed:`, error?.stack ?? error);
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `${payload.code}: ${payload.message}` }],
    structuredContent: { error: payload },
  };
}

function sceneSummary(stored) {
  return {
    sceneId: stored.id,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    title: stored.scene.title,
    platform: stored.scene.platform,
    messageCount: stored.scene.messages.length,
    participantCount: stored.scene.participants.length,
    scene: stored.scene,
  };
}

function requireSceneOrThrow(store, sceneId, revision) {
  const found = store.getScene(sceneId, Number.isInteger(revision) ? revision : null);
  if (!found) {
    fail('scene_not_found', `场景不存在：${sceneId}${Number.isInteger(revision) ? ` revision ${revision}` : ''}`, {
      details: { sceneId, revision: revision ?? null },
      recovery: '核对 sceneId，或调用 imstage_create_scene 新建场景。',
      status: 404,
    });
  }
  return found;
}

/**
 * Resolve a previously recorded idempotent response for a scene operation.
 *
 * The standalone store keeps per-revision snapshots, so the exact revision is
 * returned. A store without history (the account store) cannot retrieve an old
 * revision after a later edit, so it falls back to the current scene and reports
 * both the original operation revision and `latestRevision` instead of failing
 * a safe retry. No write is performed either way.
 */
function resolveIdempotentScene(store, existing) {
  const exact = Number.isInteger(existing.revision)
    ? store.getScene(existing.sceneId, existing.revision)
    : null;
  const current = exact ?? store.getScene(existing.sceneId, null);
  if (!current) {
    fail('scene_not_found', `场景不存在：${existing.sceneId}`, {
      details: { sceneId: existing.sceneId, revision: existing.revision ?? null },
      recovery: '场景已被删除；重新调用 imstage_create_scene。',
      status: 404,
    });
  }
  return {
    ...sceneSummary(current),
    revision: existing.revision,
    latestRevision: current.revision,
  };
}

async function toolGetCapabilities() {
  const capabilities = buildCapabilities();
  return textOk(
    `IMStage MCP 支持平台：${capabilities.supportedSubset.platforms.join(', ')}；surface：${capabilities.supportedSubset.surfaces.join(', ')}。详见 structuredContent。`,
    capabilities,
  );
}

async function toolCreateScene(args, { store, sceneIdFactory, defaultSceneFill, authorizeCheck }) {
  const rawScene = objectField(args, 'scene', { required: true });
  const idempotencyKey = optionalIdempotencyKey(args);
  const requestHash = sha256Hex(stableStringify({ operation: 'create_scene', scene: rawScene }));

  // Idempotency is checked before validation so a retry with the same key
  // always returns the original result (and a reused key with different
  // content fails as a conflict, never as a validation error).
  if (idempotencyKey) {
    const existing = store.findIdempotentResponse(idempotencyKey, 'create_scene', requestHash);
    if (existing) {
      const summary = resolveIdempotentScene(store, existing);
      return textOk(`已创建场景 ${existing.sceneId}（幂等重试，未重复创建）。`, {
        ...summary,
        deduplicated: true,
        next: `先调用 imstage_get_scene 读取当前版本，再用 expectedRevision=${summary.latestRevision} 调用 imstage_update_scene。`,
      });
    }
  }

  // Trusted post-tool default fill: account avatars/mark are applied here from
  // server state, never from the model, so large avatar bytes stay out of the
  // model context. Explicitly supplied keys are preserved untouched.
  const filledRaw = typeof defaultSceneFill === 'function' ? await defaultSceneFill(rawScene) : rawScene;
  if (typeof authorizeCheck === 'function') await authorizeCheck();
  const scene = prepareCreateScene(filledRaw, sceneIdFactory ? { sceneId: sceneIdFactory() } : undefined);
  const created = store.createScene({ scene, requestHash, idempotencyKey });
  const stored = requireSceneOrThrow(store, created.sceneId, created.revision);
  return textOk(
    `已创建场景 ${created.sceneId}（revision ${created.revision}，${stored.scene.messages.length} 条消息）${created.deduplicated ? '（幂等重试，未重复创建）' : ''}。`,
    {
      ...sceneSummary(stored),
      deduplicated: created.deduplicated,
      next: `用 expectedRevision=${created.revision} 调用 imstage_update_scene，或直接调用 imstage_render_scene。`,
    },
  );
}

function toolGetScene(args, { store }) {
  const sceneId = stringField(args, 'sceneId', { required: true });
  const revision = integerField(args, 'revision', { min: 1 });
  const stored = requireSceneOrThrow(store, sceneId, revision);
  return textOk(
    `场景 ${stored.id} revision ${stored.revision}（最新 revision ${store.currentRevision(sceneId)}）。`,
    { ...sceneSummary(stored), latestRevision: store.currentRevision(sceneId), revisions: store.listSceneRevisions(sceneId) },
  );
}

function toolUpdateScene(args, { store }) {
  const sceneId = stringField(args, 'sceneId', { required: true });
  const expectedRevision = integerField(args, 'expectedRevision', { required: true, min: 1 });
  const patch = objectField(args, 'patch', { required: true });
  const idempotencyKey = optionalIdempotencyKey(args);
  const requestHash = sha256Hex(stableStringify({ operation: 'update_scene', sceneId, expectedRevision, patch }));

  // A retried update carries the original expectedRevision, which is stale once
  // the first attempt succeeded. Resolve the idempotent response first so the
  // retry returns the original revision instead of a spurious conflict.
  if (idempotencyKey) {
    const existing = store.findIdempotentResponse(idempotencyKey, 'update_scene', requestHash);
    if (existing) {
      return textOk(`已更新场景 ${sceneId} 到 revision ${existing.revision}（幂等重试，未重复递增）。`, {
        ...resolveIdempotentScene(store, existing),
        changed: existing.changed !== false,
        deduplicated: true,
      });
    }
  }

  const current = requireSceneOrThrow(store, sceneId, null);
  if (current.revision !== expectedRevision) {
    fail('revision_conflict', `场景已被更新：期望 revision ${expectedRevision}，当前 ${current.revision}`, {
      details: { sceneId, expectedRevision, currentRevision: current.revision },
      recovery: `调用 imstage_get_scene 读取 revision ${current.revision} 的最新场景，重新应用 patch 后用 expectedRevision=${current.revision} 重试。`,
      status: 409,
    });
  }

  const { scene: patched, changed } = applyScenePatch(current.scene, patch);
  if (!changed) {
    store.rememberIdempotent(idempotencyKey, 'update_scene', requestHash, {sceneId, revision:current.revision, changed:false});
    return textOk(`patch 未产生实际变化，场景保持 revision ${current.revision}。`, {
      ...sceneSummary(current),
      latestRevision: current.revision,
      changed: false,
      deduplicated: false,
    });
  }

  const updated = store.updateScene({ sceneId, expectedRevision, scene: patched, requestHash, idempotencyKey });
  const stored = requireSceneOrThrow(store, sceneId, updated.revision);
  return textOk(
    `已更新场景 ${sceneId} 到 revision ${updated.revision}${updated.deduplicated ? '（幂等重试，未重复递增）' : ''}。`,
    {
      ...sceneSummary(stored),
      changed: true,
      deduplicated: updated.deduplicated,
      next: `用 expectedRevision=${updated.revision} 继续修改，或调用 imstage_render_scene。`,
    },
  );
}

async function toolRenderScene(args, context) {
  const { store, renderService } = context;
  const sceneId = stringField(args, 'sceneId', { min: 1 });
  const revision = integerField(args, 'revision', { min: 1 });
  const inlineScene = objectField(args, 'scene');
  if (sceneId !== undefined && inlineScene !== undefined) {
    fail('invalid_request', 'sceneId 与 scene 只能二选一', {
      recovery: '渲染已保存场景时传 sceneId；仅一次性预览时传内联 scene。',
    });
  }
  if (sceneId === undefined && inlineScene === undefined) {
    fail('invalid_request', '必须提供 sceneId 或内联 scene', {
      recovery: '传 sceneId 渲染已保存场景，或传 scene 做一次性渲染。',
    });
  }

  let scene;
  let sceneRef;
  if (sceneId !== undefined) {
    const stored = requireSceneOrThrow(store, sceneId, revision);
    scene = stored.scene;
    sceneRef = { sceneId: stored.id, revision: stored.revision };
  } else {
    scene = prepareEphemeralScene(inlineScene, { sceneId: newEphemeralSceneId() });
    sceneRef = { sceneId: null, revision: null };
  }

  const surface = stringField(args, 'surface', { allowed: RENDER_SURFACES }) ?? scene.surface ?? 'ios';
  const width = integerField(args, 'width', { min: 200, max: 1200 }) ?? 390;
  const height = integerField(args, 'height', { min: 200, max: 20_000 }) ?? 844;
  const outputKind = stringField(args, 'outputKind', { allowed: RENDER_OUTPUT_KINDS }) ?? 'long-screenshot';
  const options = resolveRenderConfig({ surface, width, height, outputKind });

  const rendered = await renderService.render({ scene, ...options });
  const renderId = computeRenderId({ scene: { ...scene, _revision: sceneRef.revision }, ...options, rendererVersion: RENDERER_VERSION });
  // Rendering is the slowest step. Re-check authorization after it completes so
  // a revoke/password change during the render cannot persist or return a PNG
  // for an account that is no longer permitted.
  if (typeof context.authorizeCheck === 'function') await context.authorizeCheck();
  store.saveRender({
    renderId,
    sceneId: sceneRef.sceneId,
    revision: sceneRef.revision,
    pngBase64: rendered.pngBase64,
    sha256: rendered.sha256,
    bytes: rendered.bytes,
    width: rendered.width,
    height: rendered.height,
    title: scene.title,
    outputKind: options.outputKind,
    surface: options.surface,
  });
  // Only a real render that also passed the post-render authorization recheck
  // reaches this point; failed or revoked renders never record the event.
  if (typeof context.onRenderSuccess === 'function') context.onRenderSuccess();

  const downloadUri = `imstage://renders/${renderId}.png`;
  const dataUri = `data:image/png;base64,${rendered.pngBase64}`;
  const target = sceneRef.sceneId ?? '(inline)';
  return {
    content: [
      { type: 'image', data: rendered.pngBase64, mimeType: 'image/png' },
      {
        type: 'text',
        text: `已渲染 ${target}${sceneRef.revision !== null ? ` revision ${sceneRef.revision}` : ''}：${rendered.width}×${rendered.height}px，${rendered.bytes} 字节，sha256 ${rendered.sha256.slice(0, 16)}…。`,
      },
    ],
    structuredContent: {
      sceneId: sceneRef.sceneId,
      revision: sceneRef.revision,
      renderId,
      title: scene.title,
      platform: scene.platform,
      surface: options.surface,
      outputKind: options.outputKind,
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.bytes,
      sha256: rendered.sha256,
      rendererVersion: RENDERER_VERSION,
      widgetUri: WIDGET_RESOURCE_URI,
      downloadUri,
      ephemeral: sceneRef.sceneId === null,
    },
    _meta: {
      preview: {
        dataUri,
        mimeType: 'image/png',
        width: rendered.width,
        height: rendered.height,
        downloadUri,
      },
      download: { uri: downloadUri, name: `${scene.title || 'imstage-scene'}${sceneRef.revision !== null ? `-r${sceneRef.revision}` : ''}.png`, mimeType: 'image/png' },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Instance projects, templates and deterministic batches              */
/* ------------------------------------------------------------------ */

function templateFail(error) {
  if (error instanceof templateStore.TemplateError) {
    fail(error.code, error.message, { status: error.status });
  }
  throw error;
}

function templateFailCall(fn) {
  try {
    return fn();
  } catch (error) {
    return templateFail(error);
  }
}

/** Rules are ordinary text and may be explicitly cleared with an empty string. */
function validateRulesField(raw) {
  if (typeof raw !== 'string') invalidRequest('rules 必须是字符串', { field: 'rules' });
  if (raw.length > PROJECT_LIMITS.rulesMax) {
    fail('limit_exceeded', `rules 超过 ${PROJECT_LIMITS.rulesMax} 字符`, { details: { field: 'rules' } });
  }
  return raw;
}

function validateDefaults(raw) {
  const value = asObject(raw, 'defaults');
  const keys = Object.keys(value);
  if (keys.length > PROJECT_LIMITS.defaultsKeysMax) {
    fail('limit_exceeded', `defaults 最多 ${PROJECT_LIMITS.defaultsKeysMax} 个键`, { details: { keys: keys.length } });
  }
  for (const key of keys) {
    const child = value[key];
    if (!['string', 'number', 'boolean'].includes(typeof child) && child !== null) {
      invalidRequest(`defaults.${key} 只能是字符串、数字、布尔值或 null`, { field: `defaults.${key}` });
    }
    if (typeof child === 'string' && child.length > 500) {
      fail('limit_exceeded', `defaults.${key} 超过 500 字符`, { details: { field: `defaults.${key}` } });
    }
  }
  if (JSON.stringify(value).length > PROJECT_LIMITS.defaultsJsonMax) {
    fail('limit_exceeded', `defaults 超过 ${PROJECT_LIMITS.defaultsJsonMax} 字符`, { details: { field: 'defaults' } });
  }
  return value;
}

/**
 * Validate project input. On update, omitted fields keep the stored value; a
 * rename-only patch must not silently clear rules or defaults.
 */
function projectInput(raw, { current = null } = {}) {
  let name;
  if (raw.name === undefined) {
    if (!current) invalidRequest('项目名称不能为空', { field: 'name' }, '创建项目时必须提供 name。');
    name = current.name;
  } else {
    name = stringField(raw, 'name', { required: true, max: PROJECT_LIMITS.nameMax }).trim();
    if (name === '') invalidRequest('项目名称不能为空', { field: 'name' });
  }
  const rules = raw.rules === undefined
    ? (current ? current.rules : '')
    : validateRulesField(raw.rules);
  const defaults = raw.defaults === undefined
    ? (current ? current.defaults : {})
    : validateDefaults(raw.defaults);
  return { name, rules, defaults };
}

function clientKeyField(args) {
  const value = args.clientIdempotencyKey;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalidRequest('clientIdempotencyKey 必须是字符串', { field: 'clientIdempotencyKey' });
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > SCENE_LIMITS.idempotencyKeyMax) {
    invalidRequest(`clientIdempotencyKey 必须是 1-${SCENE_LIMITS.idempotencyKeyMax} 个字符`, { field: 'clientIdempotencyKey' });
  }
  return trimmed;
}

function projectSummary(project) {
  return {
    projectId: project.projectId,
    name: project.name,
    rules: project.rules,
    defaults: project.defaults,
    revision: project.revision,
    batchCount: project.batchCount,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toolCreateProject(args, { store }) {
  const raw = objectField(args, 'project', { required: true });
  rejectUnknownKeys(raw, new Set(['name', 'rules', 'defaults']), 'project');
  const input = projectInput(raw);
  const project = store.createProject({ projectId: `prj_${cryptoRandomHex()}`, ...input });
  return textOk(`已创建项目 ${project.projectId}（revision ${project.revision}）。`, { project: projectSummary(project), next: `用 imstage_create_batch 时传 projectId=${project.projectId}。` });
}

function toolListProjects(_args, { store }) {
  const items = store.listProjects();
  return textOk(`当前实例有 ${items.length} 个项目。`, { items: items.map(projectSummary) });
}

function toolGetProject(args, { store }) {
  const projectId = stringField(args, 'projectId', { required: true });
  const project = store.getProject(projectId);
  if (!project) fail('project_not_found', `项目不存在：${projectId}`, { details: { projectId }, status: 404 });
  return textOk(`项目 ${projectId} revision ${project.revision}。`, {
    project: projectSummary(project),
    batches: store.listBatches({ projectId, limit: 20 }),
  });
}

function toolUpdateProject(args, { store }) {
  const projectId = stringField(args, 'projectId', { required: true });
  const expectedRevision = integerField(args, 'expectedRevision', { required: true, min: 1 });
  const raw = objectField(args, 'project', { required: true });
  rejectUnknownKeys(raw, new Set(['name', 'rules', 'defaults']), 'project');
  const current = store.getProject(projectId);
  if (!current) fail('project_not_found', `项目不存在：${projectId}`, { details: { projectId }, status: 404 });
  const input = projectInput(raw, { current });
  const project = store.updateProject({ projectId, expectedRevision, ...input });
  return textOk(`项目 ${projectId} 已更新到 revision ${project.revision}。`, { project: projectSummary(project) });
}

function toolCreateTemplate(args, { store }) {
  const raw = objectField(args, 'template', { required: true });
  rejectUnknownKeys(raw, new Set(['name', 'description', 'scene', 'variables']), 'template');
  if (typeof raw.name !== 'string' || raw.name.trim() === '' || raw.name.length > TEMPLATE_LIMITS.nameMax) {
    invalidRequest(`template.name 必须是 1-${TEMPLATE_LIMITS.nameMax} 个字符`, { field: 'template.name' });
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > TEMPLATE_LIMITS.descriptionMax)) {
    invalidRequest(`template.description 最多 ${TEMPLATE_LIMITS.descriptionMax} 个字符`, { field: 'template.description' });
  }
  if (raw.scene === undefined) invalidRequest('template.scene 不能为空', { field: 'template.scene' });
  enforceSceneBounds(raw.scene, { label: 'template.scene' });
  const normalized = { ...raw, scene: { ...raw.scene, id: newSceneId() } };
  const item = templateFailCall(() => templateStore.createTemplate(store.db, MCP_INSTANCE_SCOPE, normalized));
  return textOk(`已创建模板 ${item.id}（revision ${item.revision}，${item.variableCount} 个变量）。`, { template: item });
}

function toolListTemplates(_args, { store }) {
  const items = templateFailCall(() => templateStore.listTemplates(store.db, MCP_INSTANCE_SCOPE));
  return textOk(`当前实例有 ${items.length} 个模板。`, { items });
}

function toolGetTemplate(args, { store }) {
  const templateId = stringField(args, 'templateId', { required: true });
  const item = templateFailCall(() => templateStore.getTemplate(store.db, MCP_INSTANCE_SCOPE, templateId));
  return textOk(`模板 ${item.id} revision ${item.revision}，${item.variableCount} 个变量。`, { template: item });
}

function toolUpdateTemplate(args, { store }) {
  const templateId = stringField(args, 'templateId', { required: true });
  const expectedRevision = integerField(args, 'expectedRevision', { required: true, min: 1 });
  const raw = objectField(args, 'template', { required: true });
  rejectUnknownKeys(raw, new Set(['name', 'description', 'scene', 'variables']), 'template');
  if (raw.scene !== undefined) enforceSceneBounds(raw.scene, { label: 'template.scene' });
  const normalized = raw.scene === undefined ? raw : { ...raw, scene: { ...raw.scene, id: newSceneId() } };
  const item = templateFailCall(() => templateStore.updateTemplate(store.db, MCP_INSTANCE_SCOPE, templateId, expectedRevision, normalized));
  return textOk(`模板 ${item.id} 已更新到 revision ${item.revision}。`, { template: item });
}

function toolCreateBatch(args, { store }) {
  const projectId = stringField(args, 'projectId', { required: true });
  const project = store.getProject(projectId);
  if (!project) fail('project_not_found', `项目不存在：${projectId}`, { details: { projectId }, status: 404 });
  const templateId = stringField(args, 'templateId');
  const templateRevision = integerField(args, 'templateRevision', { min: 1 });
  const clientKey = clientKeyField(args);
  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length < 1) invalidRequest('items 至少需要 1 个条目', { field: 'items' });
  if (rawItems.length > BATCH_LIMITS.itemsMax) fail('limit_exceeded', `每批最多 ${BATCH_LIMITS.itemsMax} 个条目`, { details: { count: rawItems.length } });
  const requestHash = sha256Hex(stableStringify({ operation: 'create_batch', projectId, templateId, templateRevision, clientKey, items: rawItems }));
  const existing = store.findBatchByClientKey(clientKey, requestHash);
  if (existing) return batchResult(existing, true);

  let definition = null;
  let resolvedTemplateRevision = templateRevision ?? null;
  if (templateId) {
    const detail = templateFailCall(() => templateStore.getTemplate(store.db, MCP_INSTANCE_SCOPE, templateId));
    if (templateRevision !== undefined && templateRevision !== detail.revision) {
      fail('revision_conflict', `模板已被更新：期望 revision ${templateRevision}，当前 ${detail.revision}`, {
        details: { templateId, templateRevision, currentRevision: detail.revision },
        recovery: `调用 imstage_get_template 读取 revision ${detail.revision}，重新提交。`,
        status: 409,
      });
    }
    definition = detail.definition;
    resolvedTemplateRevision = detail.revision;
  }

  const items = rawItems.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalidRequest(`items[${index}] 必须是对象`, { field: `items[${index}]` });
    rejectUnknownKeys(raw, new Set(['name', 'prompt', 'values', 'patch', 'scene']), `items[${index}]`);
    const name = (stringField(raw, 'name', { required: true, max: BATCH_LIMITS.nameMax })).trim();
    const prompt = stringField(raw, 'prompt', { required: true, max: BATCH_LIMITS.promptMax });
    const hasScene = raw.scene !== undefined;
    const hasValues = raw.values !== undefined;
    const hasPatch = raw.patch !== undefined;
    if (hasScene && (hasValues || hasPatch)) {
      invalidRequest(`items[${index}] 不能同时提供 scene 与 values/patch`, { field: `items[${index}]` }, '提供一个完整 scene，或提供 templateId + values（可再附 patch）。');
    }
    if (hasScene) {
      return { name, prompt, values: {}, scene: prepareCreateScene(raw.scene) };
    }
    if (!definition) {
      invalidRequest(`items[${index}] 未提供 scene，也未指定 templateId`, { field: `items[${index}]` }, '补充 templateId，或在条目内提供完整 scene。');
    }
    const values = hasValues ? asObject(raw.values, `items[${index}].values`) : {};
    const valuesJson = JSON.stringify(values);
    if (valuesJson.length > 1_500_000) fail('limit_exceeded', `items[${index}].values 超过大小上限`, { details: { field: `items[${index}].values` } });
    const instantiated = instantiateTemplate(definition, values, newSceneId());
    if (!instantiated.ok) {
      fail('validation_error', `items[${index}] 变量不合法：${instantiated.errors.slice(0, 3).join('；')}`, {
        details: { errors: instantiated.errors.slice(0, 20) },
        recovery: '按模板声明的 key/type 修正 values；调用 imstage_get_template 查看变量定义。',
        status: 422,
      });
    }
    const scene = hasPatch ? applyScenePatch(instantiated.value, raw.patch).scene : instantiated.value;
    // Shared template limits are wider than the MCP adapter. Re-check the MCP
    // bounds on every final scene (patched or not) before the atomic write so
    // an oversized value can never bypass validation via the template path.
    enforceSceneBounds(scene, { label: `items[${index}].scene` });
    return { name, prompt, values, scene };
  });

  const batch = store.createBatch({
    projectId,
    templateId: templateId ?? null,
    templateRevision: resolvedTemplateRevision,
    templateDefinition: definition,
    rules: project.rules,
    items,
    clientKey,
    requestHash,
  });
  return batchResult(batch, batch.deduplicated === true);
}

function batchResult(batch, deduplicated) {
  return textOk(
    `批次 ${batch.batchId}：${batch.itemCount} 个独立场景${deduplicated ? '（幂等重试，未重复创建）' : ''}。`,
    {
      batchId: batch.batchId,
      projectId: batch.projectId,
      templateId: batch.templateId,
      templateRevision: batch.templateRevision,
      itemCount: batch.itemCount,
      createdAt: batch.createdAt,
      deduplicated,
      receipt: batch.receipt,
      items: batch.items.map(({ itemId, ordinal, name, prompt, sceneId, revision }) => ({ itemId, ordinal, name, prompt, sceneId, revision })),
      next: '用 imstage_render_scene 渲染任一 sceneId；既有场景工具保持不变。',
    },
  );
}

function toolGetBatch(args, { store }) {
  const batchId = stringField(args, 'batchId', { required: true });
  const batch = store.getBatch(batchId);
  if (!batch) fail('batch_not_found', `批次不存在：${batchId}`, { details: { batchId }, status: 404 });
  return textOk(`批次 ${batchId}：${batch.itemCount} 个场景。`, {
    batchId: batch.batchId,
    projectId: batch.projectId,
    templateId: batch.templateId,
    templateRevision: batch.templateRevision,
    template: batch.template,
    rules: batch.rules,
    createdAt: batch.createdAt,
    receipt: batch.receipt,
    items: batch.items,
  });
}

function toolListBatches(args, { store }) {
  const projectId = stringField(args, 'projectId');
  const limit = integerField(args, 'limit', { min: 1, max: 100 }) ?? 20;
  const items = store.listBatches({ projectId: projectId ?? null, limit });
  return textOk(`找到 ${items.length} 个批次。`, { items });
}

function cryptoRandomHex() {
  return randomBytes(12).toString('hex');
}

const ARG_KEYS = {
  imstage_get_capabilities: new Set(),
  imstage_create_scene: new Set(['scene', 'idempotencyKey']),
  imstage_get_scene: new Set(['sceneId', 'revision']),
  imstage_update_scene: new Set(['sceneId', 'expectedRevision', 'patch', 'idempotencyKey']),
  imstage_render_scene: new Set(['sceneId', 'revision', 'scene', 'surface', 'width', 'height', 'outputKind']),
  imstage_create_project: new Set(['project']),
  imstage_list_projects: new Set(),
  imstage_get_project: new Set(['projectId']),
  imstage_update_project: new Set(['projectId', 'expectedRevision', 'project']),
  imstage_create_template: new Set(['template']),
  imstage_list_templates: new Set(),
  imstage_get_template: new Set(['templateId']),
  imstage_update_template: new Set(['templateId', 'expectedRevision', 'template']),
  imstage_create_batch: new Set(['projectId', 'templateId', 'templateRevision', 'clientIdempotencyKey', 'items']),
  imstage_get_batch: new Set(['batchId']),
  imstage_list_batches: new Set(['projectId', 'limit']),
};

async function handleToolCall(request, context) {
  const name = request?.params?.name;
  const rawArgs = request?.params?.arguments;
  try {
    // Execution allowlist: a filtered tools/list must also restrict tools/call,
    // otherwise a hidden name could reach a handler that was never advertised.
    if (!context.allowedToolNames?.has(name)) {
      fail('invalid_request', `未知工具：${String(name)}`, { recovery: '调用 tools/list 查看可用工具。' });
    }
    if (typeof context.authorizeCheck === 'function') await context.authorizeCheck();
    const extra = context.extraHandlers?.[name];
    if (typeof extra === 'function') {
      const extraArgs = rawArgs === undefined || rawArgs === null ? {} : asObject(rawArgs, 'arguments');
      return await extra(extraArgs, context);
    }
    const allowed = ARG_KEYS[name];
    if (!allowed) {
      fail('invalid_request', `未知工具：${String(name)}`, { recovery: '调用 tools/list 查看可用工具。' });
    }
    const args = rawArgs === undefined || rawArgs === null ? {} : asObject(rawArgs, 'arguments');
    rejectUnknownKeys(args, allowed, 'arguments');
    switch (name) {
      case 'imstage_get_capabilities':
        return await toolGetCapabilities();
      case 'imstage_create_scene':
        return await toolCreateScene(args, context);
      case 'imstage_get_scene':
        return toolGetScene(args, context);
      case 'imstage_update_scene':
        return toolUpdateScene(args, context);
      case 'imstage_render_scene':
        return await toolRenderScene(args, context);
      case 'imstage_create_project':
        return toolCreateProject(args, context);
      case 'imstage_list_projects':
        return toolListProjects(args, context);
      case 'imstage_get_project':
        return toolGetProject(args, context);
      case 'imstage_update_project':
        return toolUpdateProject(args, context);
      case 'imstage_create_template':
        return toolCreateTemplate(args, context);
      case 'imstage_list_templates':
        return toolListTemplates(args, context);
      case 'imstage_get_template':
        return toolGetTemplate(args, context);
      case 'imstage_update_template':
        return toolUpdateTemplate(args, context);
      case 'imstage_create_batch':
        return toolCreateBatch(args, context);
      case 'imstage_get_batch':
        return toolGetBatch(args, context);
      case 'imstage_list_batches':
        return toolListBatches(args, context);
      default:
        fail('invalid_request', `未知工具：${String(name)}`);
    }
  } catch (error) {
    return toolError(error, context.logger, name);
  }
}
/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

function parseResourceUri(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'imstage:') return null;
  const host = url.hostname;
  let segments;
  try {
    segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  return { host, segments };
}

async function handleReadResource(request, { store }) {
  const uri = request?.params?.uri;
  if (typeof uri !== 'string') throw new McpError(ErrorCode.InvalidParams, 'uri 必须是字符串');
  if (uri === WIDGET_RESOURCE_URI || uri === LEGACY_WIDGET_RESOURCE_URI) return {contents:[buildWidgetResourceContent(uri)]};
  const parsed = parseResourceUri(uri);
  if (!parsed) throw new McpError(ErrorCode.InvalidParams, `未知资源：${uri}`);

  if (parsed.host === 'widgets' && parsed.segments.length === 1 && parsed.segments[0] === 'render-scene') {
    return { contents: [buildWidgetResourceContent(uri)] };
  }

  if (parsed.host === 'renders' && parsed.segments.length === 1 && parsed.segments[0].endsWith('.png')) {
    const renderId = parsed.segments[0].slice(0, -4);
    const record = store.getRender(renderId);
    if (!record) throw new McpError(ErrorCode.InvalidParams, `渲染不存在：${renderId}`);
    return {
      contents: [
        {
          uri,
          mimeType: 'image/png',
          blob: record.pngBase64,
          _meta: { width: record.width, height: record.height, sha256: record.sha256, bytes: record.bytes, title: record.title },
        },
      ],
    };
  }

  if (parsed.host === 'scenes' && parsed.segments.length === 1) {
    const stored = store.getScene(parsed.segments[0], null);
    if (!stored) throw new McpError(ErrorCode.InvalidParams, `场景不存在：${parsed.segments[0]}`);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ ...stored, latestRevision: store.currentRevision(stored.id) }) }] };
  }

  if (parsed.host === 'scenes' && parsed.segments.length === 3 && parsed.segments[1] === 'revisions') {
    const revision = Number(parsed.segments[2]);
    if (!Number.isInteger(revision) || revision < 1) throw new McpError(ErrorCode.InvalidParams, 'revision 必须是正整数');
    const stored = store.getScene(parsed.segments[0], revision);
    if (!stored) throw new McpError(ErrorCode.InvalidParams, `场景快照不存在：${parsed.segments[0]} revision ${revision}`);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(stored) }] };
  }

  throw new McpError(ErrorCode.InvalidParams, `未知资源：${uri}`);
}

/* ------------------------------------------------------------------ */
/* MCP server factory                                                  */
/* ------------------------------------------------------------------ */

/**
 * Append `webUrl` to scene-bearing results. The standalone instance server does
 * not pass `webUrlFor`, so its output is unchanged.
 */
function decorateResult(result, webUrlFor) {
  if (typeof webUrlFor !== 'function' || !result || result.isError) return result;
  const sceneId = result.structuredContent?.sceneId;
  if (typeof sceneId !== 'string' || sceneId === '') return result;
  const webUrl = webUrlFor(sceneId);
  return {
    ...result,
    content: result.structuredContent?.widgetUri ? result.content : [...(result.content ?? []), { type: 'text', text: `网页打开：${webUrl}` }],
    structuredContent: { ...result.structuredContent, webUrl },
  };
}

export function createImstageMcpServer({
  store,
  renderService,
  logger = console,
  tools = TOOL_DEFINITIONS,
  extraHandlers = null,
  webUrlFor = null,
  sceneIdFactory = null,
  defaultSceneFill = null,
  onRenderSuccess = null,
  authorizeCheck = null,
  serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  instructions = SERVER_INSTRUCTIONS,
} = {}) {
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  const context = {
    store,
    renderService,
    logger,
    extraHandlers,
    sceneIdFactory,
    defaultSceneFill,
    onRenderSuccess,
    webUrlFor,
    authorizeCheck,
    allowedToolNames,
  };
  const server = new Server(serverInfo, {
    capabilities: { tools: {}, resources: {} },
    instructions,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    decorateResult(await handleToolCall(request, context), webUrlFor),
  );
  const renderAvailable = tools.some((tool) => tool.name === 'imstage_render_scene');
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: renderAvailable
      ? [
          {
            uri: WIDGET_RESOURCE_URI,
            name: WIDGET_TITLE,
            title: WIDGET_TITLE,
            description: 'imstage_render_scene 的内联预览组件（自包含，无远程资源）。',
            mimeType: WIDGET_MIME_TYPE,
          },
        ]
      : [],
    resourceTemplates: renderAvailable ? RESOURCE_TEMPLATES : [],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: renderAvailable ? RESOURCE_TEMPLATES : [],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => handleReadResource(request, context));
  return server;
}

/* ------------------------------------------------------------------ */
/* HTTP layer: bearer auth + stateless Streamable HTTP JSON         */
/* ------------------------------------------------------------------ */

function sendJsonRpcError(res, status, code, message, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function authorizeRequest(req, config) {
  if (!config.token) return config.privateTunnel;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqualString(match[1], config.token);
}

function hostAllowed(req, config) {
  if (!config.allowedHosts || config.allowedHosts.length === 0) return true;
  const raw = String(req.headers.host ?? '').toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  return config.allowedHosts.includes(host);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const error = new Error('payload_too_large');
      error.statusCode = 413;
      reject(error);
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const error = new Error('payload_too_large');
        error.statusCode = 413;
        finish(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, total));
    const onError = () => finish(Object.assign(new Error('read_failed'), { statusCode: 400 }));
    const onAbort = () => finish(Object.assign(new Error('aborted'), { statusCode: 400 }));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
}

/**
 * Start the loopback MCP HTTP server.
 *
 * @param {{ env?: NodeJS.ProcessEnv, config?: object, logger?: Console }} [options]
 */
export async function startMcpServer({ env = process.env, config, logger = console } = {}) {
  const resolved = config ?? resolveMcpConfig(env);
  const store = openStore({ dataDir: resolved.dataDir });
  const executablePath = resolveChromiumExecutable(env) ?? undefined;
  const renderService = createRenderService({ executablePath, maxConcurrent: 1 });


  const httpServer = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? '/', `http://${resolved.host}:${resolved.port}`);
      if (url.pathname === HEALTH_PATH && req.method === 'GET') {
        const body = JSON.stringify({ status: 'ok', name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }
      if (url.pathname !== MCP_PATH) {
        sendJsonRpcError(res, 404, -32601, 'not_found');
        return;
      }
      if (!hostAllowed(req, resolved)) {
        sendJsonRpcError(res, 403, -32000, 'host_not_allowed');
        return;
      }
      if (req.headers.origin !== undefined) {
        sendJsonRpcError(res, 403, -32000, 'origin_not_allowed');
        return;
      }
      if (!authorizeRequest(req, resolved)) {
        sendJsonRpcError(res, 401, -32001, 'unauthorized', {
          'WWW-Authenticate': 'Bearer realm="imstage-mcp", error="invalid_token"',
        });
        return;
      }

      let parsedBody;
      if (req.method === 'POST') {
        let raw;
        try {
          raw = await readBody(req, MAX_REQUEST_BYTES);
        } catch (error) {
          sendJsonRpcError(res, error.statusCode ?? 400, -32000, error.message ?? 'bad_request');
          return;
        }
        if (raw.length > 0) {
          try {
            parsedBody = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJsonRpcError(res, 400, ErrorCode.ParseError, 'invalid_json');
            return;
          }
        }
      } else if (req.method !== 'GET' && req.method !== 'DELETE') {
        sendJsonRpcError(res, 405, -32601, 'method_not_allowed');
        return;
      }

      const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
      const mcpServer = createImstageMcpServer({store, renderService, logger});
      await mcpServer.connect(transport);
      res.once('close', () => { void transport.close(); void mcpServer.close(); });
      await transport.handleRequest(req, res, parsedBody);

    } catch (error) {
      logger.error('[imstage-mcp] request failed:', error?.stack ?? error);
      sendJsonRpcError(res, 500, -32603, 'internal_error');
    } finally {
      logger.debug?.(`[imstage-mcp] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  httpServer.requestTimeout = 60_000;
  httpServer.headersTimeout = 65_000;

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(resolved.port, resolved.host, () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : resolved.port;
  const url = `http://${resolved.host}:${port}${MCP_PATH}`;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections?.();
    });
    store.close();
  }

  return { url, host: resolved.host, port, config: resolved, store, renderService, close, server: httpServer };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const logger = console;
  startMcpServer({ logger })
    .then((handle) => {
      logger.log(`[imstage-mcp] listening on ${handle.url}`);
      logger.log(`[imstage-mcp] data dir: ${handle.config.dataDir}`);
      if (!handle.config.token) {
        logger.warn('[imstage-mcp] 运行在 IMSTAGE_MCP_PRIVATE_TUNNEL 模式：请确保出站隧道自身完成认证；端口仅绑定 127.0.0.1。');
      } else {
        logger.log('[imstage-mcp] HTTP Bearer 认证已启用。');
      }
      const shutdown = () => {
        handle
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      logger.error(`[imstage-mcp] 启动失败：${error?.message ?? error}`);
      process.exit(1);
    });
}
