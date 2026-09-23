// Scene contract adapter for the IMStage MCP server.
//
// This module owns *no* parallel scene model. It wraps the shared, canonical
// validator `validateScene` from apps/web/src/studio/model.ts (the same one the
// API server, Agent tools and the website use) and adds the MCP-specific
// invariants a network-facing tool needs:
//
//   - server-owned opaque scene ids (callers never choose them)
//   - explicit counts/lengths/identifier shapes (SCENE_LIMITS)
//   - strict unknown-field rejection so typos fail loudly instead of silently
//     dropping data (the shared validator drops unknown fields by design)
//   - a platform allowlist limited to what the deterministic renderer actually
//     supports, so the PNG never lies about the target IM
//   - a targeted, all-or-none patch language keyed by message/participant id
//   - a pure adapter from the rich studio scene to the renderer contract
//     (image data URIs -> assets[] + assetIndex)
//
// The canonical validator remains the single source of truth for field
// semantics; everything here is additive and never re-implements it.

import {
  DRAFT_VERSION,
  MESSAGE_TYPES,
  PLATFORMS,
  validateScene,
} from '../../apps/web/src/studio/model.ts';
import { STUDIO_RENDERER_VERSION as RENDERER_VERSION } from './studio-html.mjs';
const RENDERER_SURFACES = ['ios','android','desktop'];
import { fail, invalidRequest, limitExceeded, validationError } from './errors.mjs';
import {
  NATIVE_MESSAGE_TYPES,
  RENDER_LIMITS,
  RENDER_OUTPUT_KINDS,
  RENDER_SURFACES,
  SAFE_ID_RE,
  SCENE_LIMITS,
  SUPPORTED_PLATFORMS,
  WIDGET_MIME_TYPE,
} from './limits.mjs';
import { isPlainObject, newSceneId } from './util.mjs';

const SCENE_KEYS = new Set([
  'id',
  'title',
  'platform',
  'deviceTime',
  'date',
  'selfId',
  'participants',
  'messages',
  'watermark',
  'reference',
  'referenceDate',
  'surface',
  'deviceProfileId',
  'background',
  'backgroundImage',
  'appearance',
  'layout',
  'composerText',
  'headerText',
  'battery',
]);

const PARTICIPANT_KEYS = new Set(['id', 'name', 'avatar', 'subtitle']);
const MESSAGE_KEYS = new Set([
  'id',
  'participantId',
  'type',
  'text',
  'time',
  'date',
  'asset',
  'subtitle',
  'quote',
  'width',
  'height',
  'appearance',
  'items',
]);
const ITEM_KEYS = new Set(['id', 'asset', 'caption', 'kind']);
const APPEARANCE_KEYS = new Set(['background', 'color', 'fontSize', 'radius', 'spacing']);

const SET_KEYS = new Set([
  'title',
  'platform',
  'deviceTime',
  'date',
  'watermark',
  'surface',
  'deviceProfileId',
  'background',
  'backgroundImage',
  'composerText',
  'headerText',
  'battery',
  'referenceDate',
  'appearance',
  'layout',
]);

const PATCH_KEYS = new Set([
  'set',
  'addParticipants',
  'updateParticipants',
  'removeParticipants',
  'addMessages',
  'updateMessages',
  'removeMessages',
  'moveMessages',
]);

const MESSAGE_UPDATE_KEYS = new Set([
  'id',
  'participantId',
  'type',
  'text',
  'time',
  'date',
  'asset',
  'subtitle',
  'quote',
  'width',
  'height',
  'appearance',
  'items',
]);

function invalidPatch(message, details, recovery) {
  fail('invalid_patch', message, {
    details,
    recovery: recovery ?? '检查 patch 的字段名与取值；调用 imstage_get_capabilities 查看 patch 结构与示例。',
    status: 422,
  });
}

function rejectUnknownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (allowed.has(key)) continue;
    invalidRequest(`${label} 含未知字段：${key}`, { field: `${label}.${key}`, allowed: [...allowed] }, `删除未知字段 ${key}；允许的字段：${[...allowed].join(', ')}。`);
  }
}

function assertString(value, label, { max, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) invalidRequest(`${label} 不能为空`, { field: label }, `补全 ${label} 后重试。`);
    return;
  }
  if (typeof value !== 'string') invalidRequest(`${label} 必须是字符串`, { field: label });
  if (required && value.trim() === '') invalidRequest(`${label} 不能为空`, { field: label });
  if (Number.isInteger(max) && value.length > max) {
    limitExceeded(`${label} 超过 ${max} 字符上限`, { field: label, max, length: value.length });
  }
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    invalidRequest(`${label} 只允许字母、数字、下划线、连字符（1-${SCENE_LIMITS.idMax} 字符）`, {
      field: label,
      value: typeof value === 'string' ? value.slice(0, 80) : typeof value,
    }, `为 ${label} 使用稳定、唯一的短 id（例如 p-alice / m-3）。`);
  }
}

function assertAppearance(value, label) {
  if (value === undefined) return;
  if (!isPlainObject(value)) invalidRequest(`${label} 必须是对象`, { field: label });
  for (const key of Object.keys(value)) {
    if (!APPEARANCE_KEYS.has(key)) invalidRequest(`${label} 含未知字段：${key}`, { field: `${label}.${key}` });
  }
}

function assertItems(items, label) {
  if (items === undefined) return;
  if (!Array.isArray(items)) invalidRequest(`${label} 必须是数组`, { field: label });
  items.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isPlainObject(item)) invalidRequest(`${itemLabel} 必须是对象`, { field: itemLabel });
    rejectUnknownKeys(item, ITEM_KEYS, itemLabel);
  });
}

function assertParticipant(participant, label) {
  if (!isPlainObject(participant)) invalidRequest(`${label} 必须是对象`, { field: label });
  rejectUnknownKeys(participant, PARTICIPANT_KEYS, label);
  assertSafeId(participant.id, `${label}.id`);
  assertString(participant.name, `${label}.name`, { max: SCENE_LIMITS.nameMax, required: true });
  assertString(participant.avatar, `${label}.avatar`, { max: SCENE_LIMITS.assetDataUriMax });
  assertString(participant.subtitle, `${label}.subtitle`, { max: 4000 });
}

function assertMessage(message, label) {
  if (!isPlainObject(message)) invalidRequest(`${label} 必须是对象`, { field: label });
  rejectUnknownKeys(message, MESSAGE_KEYS, label);
  assertSafeId(message.id, `${label}.id`);
  if (typeof message.type !== 'string' || !MESSAGE_TYPES.includes(message.type)) {
    invalidRequest(`${label}.type 只能是：${MESSAGE_TYPES.join(', ')}`, { field: `${label}.type`, value: message.type });
  }
  assertString(message.text, `${label}.text`, { max: SCENE_LIMITS.textMax });
  assertString(message.time, `${label}.time`, { max: SCENE_LIMITS.timeMax });
  assertString(message.date, `${label}.date`, { max: SCENE_LIMITS.dateMax });
  assertString(message.asset, `${label}.asset`, { max: SCENE_LIMITS.assetDataUriMax });
  assertString(message.subtitle, `${label}.subtitle`, { max: 4000 });
  assertString(message.quote, `${label}.quote`, { max: 4000 });
  assertAppearance(message.appearance, `${label}.appearance`);
  assertItems(message.items, `${label}.items`);
}

/** Count and bound every embedded image data URI before validation. */
function enforceAssetBounds(scene) {
  const assets = [];
  for (const participant of scene.participants ?? []) {
    if (typeof participant?.avatar === 'string' && participant.avatar) assets.push(participant.avatar);
  }
  for (const message of scene.messages ?? []) {
    if (typeof message?.asset === 'string' && message.asset) assets.push(message.asset);
    if (Array.isArray(message?.items)) {
      for (const item of message.items) {
        if (typeof item?.asset === 'string' && item.asset) assets.push(item.asset);
      }
    }
  }
  if (typeof scene.backgroundImage === 'string' && scene.backgroundImage) assets.push(scene.backgroundImage);

  for (const asset of assets) {
    if (asset.length > SCENE_LIMITS.assetDataUriMax) {
      limitExceeded(`内嵌图片超过 ${SCENE_LIMITS.assetDataUriMax} 字符上限`, {
        field: 'assets',
        length: asset.length,
      }, '缩小图片或降低分辨率后重试；MCP 不接受远程 URL，只接受 data:image/...;base64。');
    }
  }
  const unique = new Set(assets);
  if (unique.size > SCENE_LIMITS.assetsMax) {
    limitExceeded(`内嵌图片数量超过 ${SCENE_LIMITS.assetsMax} 张上限`, { count: unique.size });
  }
}

/** Bounds and shape checks that the shared validator intentionally omits. */
export function enforceSceneBounds(scene, { label = 'scene' } = {}) {
  if (!isPlainObject(scene)) invalidRequest(`${label} 必须是 JSON 对象`, { field: label });
  rejectUnknownKeys(scene, SCENE_KEYS, label);
  assertString(scene.title, `${label}.title`, { max: SCENE_LIMITS.titleMax, required: true });
  assertString(scene.watermark, `${label}.watermark`, { max: SCENE_LIMITS.watermarkMax });
  assertString(scene.date, `${label}.date`, { max: SCENE_LIMITS.dateMax });
  assertString(scene.deviceTime, `${label}.deviceTime`, { max: SCENE_LIMITS.deviceTimeMax });
  assertString(scene.composerText, `${label}.composerText`, { max: 4000 });
  assertString(scene.headerText, `${label}.headerText`, { max: 4000 });
  if (scene.reference !== undefined) invalidRequest('MCP 暂不支持截图编辑层，请使用结构化场景或网页编辑器。');
  assertString(scene.backgroundImage, `${label}.backgroundImage`, { max: SCENE_LIMITS.assetDataUriMax });
  assertAppearance(scene.appearance, `${label}.appearance`);
  if (scene.layout !== undefined) {
    if (!isPlainObject(scene.layout)) invalidRequest(`${label}.layout 必须是对象`, { field: `${label}.layout` });
    // Field-level/unbounded values are rejected by the shared validateScene ->
    // validateCustomLayout contract; MCP only adds the object-shape guard so a
    // non-object never reaches it as an opaque failure.
  }

  const participants = scene.participants;
  if (!Array.isArray(participants)) invalidRequest(`${label}.participants 必须是数组`, { field: `${label}.participants` });
  if (participants.length < SCENE_LIMITS.participantsMin || participants.length > SCENE_LIMITS.participantsMax) {
    limitExceeded(
      `${label}.participants 数量必须在 ${SCENE_LIMITS.participantsMin}-${SCENE_LIMITS.participantsMax} 之间`,
      { count: participants.length },
    );
  }
  participants.forEach((participant, index) => assertParticipant(participant, `${label}.participants[${index}]`));
  if (typeof scene.selfId !== 'string' || !SAFE_ID_RE.test(scene.selfId)) {
    assertSafeId(scene.selfId, `${label}.selfId`);
  }

  const messages = scene.messages;
  if (!Array.isArray(messages)) invalidRequest(`${label}.messages 必须是数组`, { field: `${label}.messages` });
  if (messages.length < SCENE_LIMITS.messagesMin || messages.length > SCENE_LIMITS.messagesMax) {
    limitExceeded(
      `${label}.messages 数量必须在 ${SCENE_LIMITS.messagesMin}-${SCENE_LIMITS.messagesMax} 之间`,
      { count: messages.length },
    );
  }
  messages.forEach((message, index) => assertMessage(message, `${label}.messages[${index}]`));
  enforceAssetBounds(scene);
}

function ensureSupportedPlatform(platform) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    fail('unsupported_platform', `确定性渲染器暂不支持 platform=${platform}`, {
      details: { platform, supported: [...SUPPORTED_PLATFORMS] },
      recovery: `改用 ${SUPPORTED_PLATFORMS.join(' 或 ')}；其余平台会被渲染成微信主题，MCP 拒绝这种误导性输出。`,
      status: 422,
    });
  }
}

function normalizeOrThrow(candidate, { label = 'scene' } = {}) {
  ensureSupportedPlatform(candidate.platform);
  const result = validateScene(candidate);
  if (!result.ok || !result.scene) {
    validationError(result.errors);
  }
  ensureSupportedPlatform(result.scene.platform);
  return result.scene;
}

/**
 * Validate a full scene supplied to `imstage_create_scene`.
 * The scene id is always server-owned; callers must omit it.
 */
export function prepareCreateScene(rawScene, { sceneId = newSceneId() } = {}) {
  if (!isPlainObject(rawScene)) invalidRequest('scene 必须是 JSON 对象', { field: 'scene' });
  if (rawScene.id !== undefined && rawScene.id !== null && rawScene.id !== '') {
    invalidRequest('scene.id 由服务端生成，请勿传入', { field: 'scene.id' }, '删除 scene.id；创建成功后从返回值读取服务端 id。');
  }
  enforceSceneBounds(rawScene);
  const candidate = { ...rawScene, id: sceneId };
  return normalizeOrThrow(candidate);
}

/** Validate an inline scene used for a one-shot render (never persisted). */
export function prepareEphemeralScene(rawScene, { sceneId } = {}) {
  if (!isPlainObject(rawScene)) invalidRequest('scene 必须是 JSON 对象', { field: 'scene' });
  if (rawScene.id !== undefined && rawScene.id !== null && rawScene.id !== '') {
    invalidRequest('内联 scene.id 由服务端生成，请勿传入', { field: 'scene.id' });
  }
  enforceSceneBounds(rawScene);
  const candidate = { ...rawScene, id: sceneId };
  return normalizeOrThrow(candidate);
}

function validatePatchShape(patch) {
  if (!isPlainObject(patch)) invalidPatch('patch 必须是 JSON 对象', { field: 'patch' });
  rejectUnknownKeys(patch, PATCH_KEYS, 'patch');
  for (const key of ['addParticipants', 'updateParticipants', 'removeParticipants', 'addMessages', 'updateMessages', 'removeMessages', 'moveMessages']) {
    if (patch[key] !== undefined && !Array.isArray(patch[key])) {
      invalidPatch(`patch.${key} 必须是数组`, { field: `patch.${key}` });
    }
  }
  if (patch.set !== undefined) {
    if (!isPlainObject(patch.set)) invalidPatch('patch.set 必须是对象', { field: 'patch.set' });
    rejectUnknownKeys(patch.set, SET_KEYS, 'patch.set');
  }
  const hasOperation =
    (patch.set && Object.keys(patch.set).length > 0) ||
    ['addParticipants', 'updateParticipants', 'removeParticipants', 'addMessages', 'updateMessages', 'removeMessages', 'moveMessages'].some(
      (key) => Array.isArray(patch[key]) && patch[key].length > 0,
    );
  if (!hasOperation) {
    invalidPatch('patch 不包含任何变更', { field: 'patch' }, '在 patch 中至少提供一个 set 字段或一个增删改操作。');
  }
}

function indexById(items, label) {
  const map = new Map();
  for (const item of items) map.set(item.id, item);
  return map;
}

function applySet(draft, set) {
  if (!set) return;
  for (const key of Object.keys(set)) {
    draft[key] = structuredClone(set[key]);
  }
}

function applyParticipantOps(draft, patch) {
  for (const id of patch.removeParticipants ?? []) {
    if (typeof id !== 'string') invalidPatch('removeParticipants 的元素必须是 id 字符串', { field: 'patch.removeParticipants' });
    const index = draft.participants.findIndex((p) => p.id === id);
    if (index === -1) invalidPatch(`removeParticipants 引用了不存在的参与者：${id}`, { field: 'patch.removeParticipants', id });
    draft.participants.splice(index, 1);
  }
  for (const entry of patch.updateParticipants ?? []) {
    if (!isPlainObject(entry)) invalidPatch('updateParticipants 的元素必须是对象', { field: 'patch.updateParticipants' });
    rejectUnknownKeys(entry, PARTICIPANT_KEYS, 'patch.updateParticipants[]');
    assertSafeId(entry.id, 'patch.updateParticipants[].id');
    const current = indexById(draft.participants, 'participants').get(entry.id);
    if (!current) invalidPatch(`updateParticipants 引用了不存在的参与者：${entry.id}`, { field: 'patch.updateParticipants', id: entry.id });
    for (const key of Object.keys(entry)) {
      if (key === 'id') continue;
      if (key === 'name' && typeof entry.name === 'string' && entry.name.trim() === '') {
        invalidPatch('参与者 name 不能为空', { field: 'patch.updateParticipants[].name', id: entry.id });
      }
      current[key] = structuredClone(entry[key]);
    }
  }
  for (const entry of patch.addParticipants ?? []) {
    if (!isPlainObject(entry)) invalidPatch('addParticipants 的元素必须是对象', { field: 'patch.addParticipants' });
    rejectUnknownKeys(entry, PARTICIPANT_KEYS, 'patch.addParticipants[]');
    assertSafeId(entry.id, 'patch.addParticipants[].id');
    if (draft.participants.some((p) => p.id === entry.id)) {
      invalidPatch(`addParticipants 的 id 已存在：${entry.id}`, { field: 'patch.addParticipants', id: entry.id }, '使用 updateParticipants 修改已有参与者，或换一个 id。');
    }
    draft.participants.push(structuredClone(entry));
  }
}

function applyMessageOps(draft, patch) {
  for (const id of patch.removeMessages ?? []) {
    if (typeof id !== 'string') invalidPatch('removeMessages 的元素必须是 id 字符串', { field: 'patch.removeMessages' });
    const index = draft.messages.findIndex((m) => m.id === id);
    if (index === -1) invalidPatch(`removeMessages 引用了不存在的消息：${id}`, { field: 'patch.removeMessages', id });
    draft.messages.splice(index, 1);
  }
  for (const entry of patch.updateMessages ?? []) {
    if (!isPlainObject(entry)) invalidPatch('updateMessages 的元素必须是对象', { field: 'patch.updateMessages' });
    rejectUnknownKeys(entry, MESSAGE_UPDATE_KEYS, 'patch.updateMessages[]');
    assertSafeId(entry.id, 'patch.updateMessages[].id');
    const current = indexById(draft.messages, 'messages').get(entry.id);
    if (!current) invalidPatch(`updateMessages 引用了不存在的消息：${entry.id}`, { field: 'patch.updateMessages', id: entry.id });
    for (const key of Object.keys(entry)) {
      if (key === 'id') continue;
      current[key] = structuredClone(entry[key]);
    }
    if (current.asset === '') delete current.asset;
  }
  for (const entry of patch.addMessages ?? []) {
    if (!isPlainObject(entry)) invalidPatch('addMessages 的元素必须是对象', { field: 'patch.addMessages' });
    rejectUnknownKeys(entry, MESSAGE_KEYS, 'patch.addMessages[]');
    assertSafeId(entry.id, 'patch.addMessages[].id');
    if (draft.messages.some((m) => m.id === entry.id)) {
      invalidPatch(`addMessages 的 id 已存在：${entry.id}`, { field: 'patch.addMessages', id: entry.id }, '使用 updateMessages 修改已有消息，或换一个 id。');
    }
    draft.messages.push(structuredClone(entry));
  }
  for (const move of patch.moveMessages ?? []) {
    if (!isPlainObject(move)) invalidPatch('moveMessages 的元素必须是对象', { field: 'patch.moveMessages' });
    rejectUnknownKeys(move, new Set(['id', 'toIndex']), 'patch.moveMessages[]');
    if (typeof move.id !== 'string' || !Number.isInteger(move.toIndex)) {
      invalidPatch('moveMessages 需要 { id, toIndex }', { field: 'patch.moveMessages' });
    }
    const index = draft.messages.findIndex((m) => m.id === move.id);
    if (index === -1) invalidPatch(`moveMessages 引用了不存在的消息：${move.id}`, { field: 'patch.moveMessages', id: move.id });
    if (move.toIndex < 0 || move.toIndex >= draft.messages.length) {
      invalidPatch(`moveMessages.toIndex 超出范围：${move.toIndex}`, { field: 'patch.moveMessages', toIndex: move.toIndex, length: draft.messages.length });
    }
    const [moved] = draft.messages.splice(index, 1);
    draft.messages.splice(move.toIndex, 0, moved);
  }
}

/**
 * Apply a targeted patch to a scene copy. Nothing is persisted here: the caller
 * only writes the returned scene after the store's optimistic-revision check
 * succeeds, so a rejected patch can never partially mutate stored state.
 */
export function applyScenePatch(scene, patch) {
  if (!isPlainObject(scene)) invalidRequest('当前场景无效，无法应用 patch');
  validatePatchShape(patch);
  const draft = structuredClone(scene);
  applySet(draft, patch.set);
  applyParticipantOps(draft, patch);
  applyMessageOps(draft, patch);
  enforceSceneBounds(draft, { label: 'patchedScene' });
  const normalized = normalizeOrThrow(draft, { label: 'patchedScene' });
  return { scene: normalized, changed: JSON.stringify(normalized) !== JSON.stringify(scene) };
}

/**
 * Pure adapter to the deterministic renderer contract:
 *   - embedded `data:image/...` message assets become an `assets[]` array and
 *     each image message gets an `assetIndex`
 *   - everything else is passed through untouched
 *
 * Avatars/appearance/background/reference are preserved in the stored scene but
 * are not part of the renderer contract, so they are intentionally not mapped.
 */
export function adaptSceneForRenderer(scene) {
  const assets = [];
  const messages = (scene.messages ?? []).map((message) => {
    if (message.type === 'image' && typeof message.asset === 'string' && message.asset !== '') {
      let assetIndex = assets.indexOf(message.asset);
      if (assetIndex === -1) {
        assetIndex = assets.length;
        assets.push(message.asset);
      }
      // The raw data URI travels separately in `assets`; the renderer contract
      // only needs the index, and keeping the base64 out of the scene keeps
      // render ids and logs small.
      const { asset: _asset, ...rest } = message;
      return { ...rest, assetIndex };
    }
    return message;
  });
  return {
    scene: {
      id: scene.id,
      title: scene.title,
      platform: scene.platform,
      deviceTime: scene.deviceTime,
      date: scene.date,
      selfId: scene.selfId,
      participants: scene.participants.map((p) => ({ id: p.id, name: p.name })),
      messages,
      watermark: scene.watermark,
      ...(scene.layout ? { layout: scene.layout } : {}),
    },
    assets,
  };
}

const EXAMPLE_CREATE_SCENE = Object.freeze({
  title: '周末去看海',
  platform: 'wechat',
  deviceTime: '09:41',
  date: '周六 09:38',
  selfId: 'p-linxiaoman',
  participants: [
    { id: 'p-linxiaoman', name: '林小满' },
    { id: 'p-ayuan', name: '阿远' },
  ],
  messages: [
    { id: 'm-1', participantId: 'p-linxiaoman', type: 'text', text: '周末有空吗？听说东极岛的海很蓝。', time: '09:38' },
    { id: 'm-2', participantId: 'p-ayuan', type: 'text', text: '周六可以，我带上相机。', time: '09:39' },
  ],
  watermark: '',
  surface: 'ios',
});

const EXAMPLE_UPDATE_PATCH = Object.freeze({
  set: { watermark: 'IMStage' },
  updateMessages: [{ id: 'm-2', text: '周六可以，我带上相机和无人机。', time: '09:40' }],
  addMessages: [{ id: 'm-3', participantId: 'p-linxiaoman', type: 'text', text: '好，周六见！', time: '09:41' }],
});

/** Single source for the capability/contract description returned by a tool. */
export function buildCapabilities() {
  const degraded = MESSAGE_TYPES.filter((type) => !NATIVE_MESSAGE_TYPES.includes(type));
  return {
    server: 'imstage-mcp',
    sceneSchemaVersion: DRAFT_VERSION,
    rendererVersion: RENDERER_VERSION,
    canonicalValidator: 'apps/web/src/studio/model.ts#validateScene',
    supportedSubset: {
      platforms: [...SUPPORTED_PLATFORMS],
      allCanonicalPlatforms: [...PLATFORMS],
      surfaces: [...RENDER_SURFACES],
      rendererSurfaces: [...RENDERER_SURFACES],
      outputKinds: [...RENDER_OUTPUT_KINDS],
      nativelyRenderedMessageTypes: [...NATIVE_MESSAGE_TYPES],
      degradedMessageTypes: degraded,
      persistedNotRendered: [],
      layout: '可选 Scene.layout（kind=custom）使用有界声明式 token 渲染中性页头/输入栏；未设置时保持平台皮肤不变。',
      unsupported: ['reference screenshot overlays; use the Web editor for those'],
      assets: '仅接受内嵌 data:image/(png|jpeg|webp);base64，不接受远程 URL；图片会作为 renderer assets 注入。',
    },
    limits: {
      scene: SCENE_LIMITS,
      render: RENDER_LIMITS,
      projects: { maxPerInstance: 50, nameMax: 80, rulesMax: 4000, defaultsJsonMax: 4000 },
      templates: { maxPerInstance: 50, variablesMax: 50, nameMax: 80, descriptionMax: 500 },
      batches: { itemsMax: 20, storedMax: 500 },
    },
    identifierRules: {
      sceneId: '服务端生成，形如 scn_<32 hex>；调用方只读。',
      participantId: '调用方提供，1-64 位字母/数字/下划线/连字符，场景内唯一。',
      messageId: '调用方提供，1-64 位字母/数字/下划线/连字符，场景内唯一。',
      idempotencyKey: '可选，1-128 位可打印字符；同一 key + 同一请求只执行一次。',
    },
    tools: [
      { name: 'imstage_get_capabilities', readOnly: true, purpose: '读取本契约、边界与示例。' },
      { name: 'imstage_create_scene', readOnly: false, purpose: '用显式 JSON 创建场景，返回 sceneId 与 revision。' },
      { name: 'imstage_get_scene', readOnly: true, purpose: '按 sceneId（可选 revision 快照）读取场景。' },
      { name: 'imstage_update_scene', readOnly: false, purpose: '按 expectedRevision 原子应用定向 patch。' },
      { name: 'imstage_render_scene', readOnly: true, purpose: '渲染 PNG 并返回图片内容、场景状态与内联预览组件。' },
      { name: 'imstage_create_project', readOnly: false, purpose: '创建实例项目（名称、规则、默认值），用于冻结批次共享规则。' },
      { name: 'imstage_list_projects', readOnly: true, purpose: '列出实例项目摘要。' },
      { name: 'imstage_get_project', readOnly: true, purpose: '读取项目详情与批次摘要。' },
      { name: 'imstage_update_project', readOnly: false, purpose: '按 expectedRevision 更新项目。' },
      { name: 'imstage_create_template', readOnly: false, purpose: '用共享纯契约创建实例模板。' },
      { name: 'imstage_list_templates', readOnly: true, purpose: '列出模板摘要（不含大型快照）。' },
      { name: 'imstage_get_template', readOnly: true, purpose: '读取完整模板定义。' },
      { name: 'imstage_update_template', readOnly: false, purpose: '按 expectedRevision 替换模板定义。' },
      { name: 'imstage_create_batch', readOnly: false, purpose: '确定性原子创建多个独立场景与批次回执；不调用模型。' },
      { name: 'imstage_get_batch', readOnly: true, purpose: '读取批次回执、冻结快照与输出 sceneId/revision。' },
      { name: 'imstage_list_batches', readOnly: true, purpose: '列出批次摘要，可按 projectId 过滤。' },
    ],
    workflow: {
      deterministicSave: 'MCP 的 create/update/batch 只做确定性校验与保存；调用方 AI 必须自己生成全部对话内容与图片字节（内嵌 data:image base64），本服务不会调用任何模型或图片生成。',
      webDifference: '网页批量生成是真实 Agent 任务（顺序 worker + 限流）；MCP 批次是一次同步确定性保存，两者不要混为一谈。',
      templateReuse: '模板 = 版本化场景快照 + 命名类型化变量；instances 通过 values 实例化并得到新的 scn_ id，源模板不变。',
      batchIdempotency: 'clientIdempotencyKey + 完全相同请求体返回同一批次回执；相同 key 不同内容返回 idempotency_conflict。',
      instanceScope: '项目/模板/批次都属于当前 MCP bearer 实例的隔离数据库，与网页账号作品互相隔离。',
    },
    patchOperations: {
      set: [...SET_KEYS],
      addParticipants: ['id', 'name', 'avatar?', 'subtitle?'],
      updateParticipants: ['id + 任意 PARTICIPANT 字段'],
      removeParticipants: ['id'],
      addMessages: ['id', 'participantId', 'type', 'text?', 'time?', 'asset?', '...'],
      updateMessages: ['id + 任意 MESSAGE 字段'],
      removeMessages: ['id'],
      moveMessages: ['{ id, toIndex }'],
      order: 'participants: remove -> update -> add；messages: remove -> update -> add -> move；随后统一校验，任一失败则整批不保存。',
    },
    errorCodes: [
      { code: 'invalid_request', when: '参数类型/未知字段/id 形状不合法。' },
      { code: 'limit_exceeded', when: '数量、长度或内嵌图片超过上限。' },
      { code: 'validation_error', when: '共享 validateScene 拒绝场景；details.errors 列出原因。' },
      { code: 'unsupported_platform', when: 'platform 不在确定性渲染器支持范围内。' },
      { code: 'invalid_patch', when: 'patch 引用不存在的 id 或结构不合法；存储保持原样。' },
      { code: 'scene_not_found', when: 'sceneId 在隔离存储中不存在。' },
      { code: 'project_not_found', when: 'projectId 在隔离存储中不存在。' },
      { code: 'template_not_found', when: 'templateId 在隔离存储中不存在。' },
      { code: 'template_exists', when: '模板 id 已存在。' },
      { code: 'template_limit_reached', when: '实例模板数量超过上限（50）。' },
      { code: 'batch_not_found', when: 'batchId 不存在。' },
      { code: 'storage_limit', when: '实例场景/模板/批次存储达到容量上限。' },
      { code: 'revision_conflict', when: 'expectedRevision 落后于当前版本；details.currentRevision 给出最新值。' },
      { code: 'idempotency_conflict', when: '同一 idempotencyKey 被用于不同请求体。' },
      { code: 'renderer_unavailable', when: '找不到 Playwright Chromium 可执行文件。' },
      { code: 'output_too_tall', when: 'screenshot 模式下内容高于视口；改用 long-screenshot。' },
      { code: 'output_too_large', when: '渲染像素超过上限。' },
      { code: 'internal_error', when: '未预期的服务端错误。' },
    ],
    widget: {
      resourceUri: 'ui://imstage/render-scene.html',
      mimeType: WIDGET_MIME_TYPE,
      attachedTo: 'imstage_render_scene only',
      behavior: '内联显示标题/revision 与 PNG 预览，提供编辑指令输入（ui/message）和 PNG 下载（ui/download-file + resource_link）。',
      compatibility: '标准 MCP Apps _meta.ui.resourceUri；同时设置 legacy _meta["openai/outputTemplate"]。',
    },
    auth: {
      scheme: 'HTTP Bearer',
      header: 'Authorization: Bearer <IMSTAGE_MCP_TOKEN>',
      note: '所有 /mcp 请求都需要 token；除非显式设置 IMSTAGE_MCP_PRIVATE_TUNNEL=1 用于认证的私有出站隧道。',
    },
    examples: {
      createScene: { scene: EXAMPLE_CREATE_SCENE, idempotencyKey: 'create-weekend-1' },
      updateScene: { sceneId: 'scn_<id>', expectedRevision: 1, patch: EXAMPLE_UPDATE_PATCH, idempotencyKey: 'patch-watermark-1' },
      renderScene: { sceneId: 'scn_<id>', surface: 'ios', width: 390, outputKind: 'long-screenshot' },
    },
    fidelityNotes: ['复用当前 Web SceneView 及样式；平台界面为创作用近似模板。', 'PNG 不含可播放音视频，音视频消息是静态卡片。', '截图原图编辑层暂不支持；使用结构化场景创建与定向微调。'],
  };
}

export { EXAMPLE_CREATE_SCENE, EXAMPLE_UPDATE_PATCH, MESSAGE_TYPES, RENDER_OUTPUT_KINDS };
