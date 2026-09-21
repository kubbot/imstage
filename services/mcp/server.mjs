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
import { asObject, integerField, objectField, optionalIdempotencyKey, rejectUnknownKeys, stringField } from './args.mjs';
import { resolveMcpConfig } from './config.mjs';
import { fail, toErrorPayload } from './errors.mjs';
import {
  HEALTH_PATH,
  MAX_REQUEST_BYTES,
  MCP_PATH,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  RENDER_OUTPUT_KINDS,
  RENDER_SURFACES,
  SCENE_LIMITS,
  WIDGET_MIME_TYPE,
} from './limits.mjs';
import { openStore } from './store.mjs';
import {
  applyScenePatch,
  buildCapabilities,
  MESSAGE_TYPES,
  prepareCreateScene,
  prepareEphemeralScene,
} from './scene.mjs';
import { computeRenderId, createRenderService, resolveChromiumExecutable, resolveRenderConfig } from './render.mjs';
import { newEphemeralSceneId, sha256Hex, stableStringify, timingSafeEqualString } from './util.mjs';
import { WIDGET_RESOURCE_URI, WIDGET_TITLE, buildWidgetResourceContent } from './widget.mjs';

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

const TOOL_DEFINITIONS = [
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
];

for (const tool of TOOL_DEFINITIONS) {
  const properties = tool.name === 'imstage_get_capabilities' ? {
    server:{type:'string'}, supportedSubset:{type:'object'}, examples:{type:'object'}
  } : tool.name === 'imstage_render_scene' ? {
    sceneId:{type:['string','null']}, revision:{type:['integer','null']}, renderId:{type:'string'},
    title:{type:'string'}, width:{type:'integer'}, height:{type:'integer'}, sha256:{type:'string'}, downloadUri:{type:'string'}
  } : {sceneId:{type:'string'}, revision:{type:'integer'}, scene:{type:'object'}};
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

const SERVER_INSTRUCTIONS =
  'IMStage 只做确定性 IM 聊天截图。流程：imstage_create_scene 创建（scene.id 由服务端生成，禁止传入）→ imstage_update_scene 带 expectedRevision 原子修改 → imstage_render_scene 渲染 PNG。 遇到 revision_conflict 先用 imstage_get_scene 读取最新 revision，再重新应用 patch。不要传远程图片 URL，只接受内嵌 data:image/...;base64。先读取 imstage_get_capabilities。ChatGPT 根据用户需求编写内容；每次修改保留未指定元素，返回后调用 imstage_render_scene 给用户看结果。';

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

async function toolGetCapabilities() {
  const capabilities = buildCapabilities();
  return textOk(
    `IMStage MCP 支持平台：${capabilities.supportedSubset.platforms.join(', ')}；surface：${capabilities.supportedSubset.surfaces.join(', ')}。详见 structuredContent。`,
    capabilities,
  );
}

function toolCreateScene(args, { store }) {
  const rawScene = objectField(args, 'scene', { required: true });
  const idempotencyKey = optionalIdempotencyKey(args);
  const requestHash = sha256Hex(stableStringify({ operation: 'create_scene', scene: rawScene }));

  // Idempotency is checked before validation so a retry with the same key
  // always returns the original result (and a reused key with different
  // content fails as a conflict, never as a validation error).
  if (idempotencyKey) {
    const existing = store.findIdempotentResponse(idempotencyKey, 'create_scene', requestHash);
    if (existing) {
      const stored = requireSceneOrThrow(store, existing.sceneId, existing.revision);
      return textOk(`已创建场景 ${existing.sceneId}（幂等重试，未重复创建）。`, {
        ...sceneSummary(stored),
        deduplicated: true,
        next: `用 expectedRevision=${existing.revision} 调用 imstage_update_scene。`,
      });
    }
  }

  const scene = prepareCreateScene(rawScene);
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
      const stored = requireSceneOrThrow(store, existing.sceneId, existing.revision);
      return textOk(`已更新场景 ${sceneId} 到 revision ${existing.revision}（幂等重试，未重复递增）。`, {
        ...sceneSummary(stored),
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

async function toolRenderScene(args, { store, renderService }) {
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
      widgetSessionId: sceneRef.sceneId ?? renderId,
      'openai/widgetSessionId': sceneRef.sceneId ?? renderId,
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

const ARG_KEYS = {
  imstage_get_capabilities: new Set(),
  imstage_create_scene: new Set(['scene', 'idempotencyKey']),
  imstage_get_scene: new Set(['sceneId', 'revision']),
  imstage_update_scene: new Set(['sceneId', 'expectedRevision', 'patch', 'idempotencyKey']),
  imstage_render_scene: new Set(['sceneId', 'revision', 'scene', 'surface', 'width', 'height', 'outputKind']),
};

async function handleToolCall(request, context) {
  const name = request?.params?.name;
  const rawArgs = request?.params?.arguments;
  try {
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
        return toolCreateScene(args, context);
      case 'imstage_get_scene':
        return toolGetScene(args, context);
      case 'imstage_update_scene':
        return toolUpdateScene(args, context);
      case 'imstage_render_scene':
        return await toolRenderScene(args, context);
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
  if (uri === WIDGET_RESOURCE_URI) return {contents:[buildWidgetResourceContent(uri)]};
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

export function createImstageMcpServer({ store, renderService, logger = console }) {
  const context = { store, renderService, logger };
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(request, context));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: WIDGET_RESOURCE_URI,
        name: WIDGET_TITLE,
        title: WIDGET_TITLE,
        description: 'imstage_render_scene 的内联预览组件（自包含，无远程资源）。',
        mimeType: WIDGET_MIME_TYPE,
      },
    ],
    resourceTemplates: RESOURCE_TEMPLATES,
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
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
