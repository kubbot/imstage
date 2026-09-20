// Framework-neutral conversation contract shared by the Eval harness, the
// deterministic renderer and future Web/MCP/API adapters.
//
// This module is intentionally dependency-free (no `node:` imports, no DOM) so
// it can run in the browser, a worker, or plain Node. It mirrors the current
// website draft shape exactly:
//
//   { title, platform, deviceTime, date, selfId,
//     participants: [{ id, name }],
//     messages: [{ id, participantId, type, text, time, assetIndex? }],
//     watermark }
//
// The contract is a *validation* boundary: an AI (or any untrusted producer)
// may emit JSON, but every field is bounded and normalized here before the
// deterministic renderer ever sees it. Nothing from a scene is executed as
// HTML or script; the renderer escapes all text and never loads remote URLs.

export const CONVERSATION_SCHEMA_VERSION = 1;

export const CONVERSATION_PLATFORMS = Object.freeze(['wechat', 'telegram', 'whatsapp']);
export const CONVERSATION_MESSAGE_TYPES = Object.freeze(['text', 'image', 'system', 'location']);

export const CONVERSATION_LIMITS = Object.freeze({
  titleMax: 120,
  nameMax: 60,
  idMax: 64,
  textMax: 2000,
  timeMax: 40,
  dateMax: 40,
  deviceTimeMax: 40,
  watermarkMax: 200,
  participantsMin: 1,
  participantsMax: 12,
  messagesMin: 1,
  messagesMax: 200,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

// Defensive rejection of markup / script / URL-based payloads inside textual
// scene fields. The renderer escapes everything anyway, but rejecting early
// keeps obviously hostile model output out of the store.
const UNSAFE_MARKUP_RE =
  /(<\s*\/?\s*[a-zA-Z][^>]*>)|(javascript\s*:)|(vbscript\s*:)|(data\s*:\s*text\/html)|(\bon[a-z]+\s*=)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class ConversationSchemaError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ConversationSchemaError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function schemaFail(code, message, details) {
  throw new ConversationSchemaError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, label, { max, required = false, allowEmpty = true, pattern = null } = {}) {
  if (value === undefined || value === null) {
    if (required) schemaFail('missing_field', `${label} 不能为空`, { field: label });
    return '';
  }
  if (typeof value !== 'string') {
    schemaFail('invalid_field', `${label} 必须是字符串`, { field: label });
  }
  if (CONTROL_RE.test(value)) {
    schemaFail('invalid_field', `${label} 含非法控制字符`, { field: label });
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    schemaFail('missing_field', `${label} 不能为空`, { field: label });
  }
  if (required && trimmed.length === 0) {
    schemaFail('missing_field', `${label} 不能为空`, { field: label });
  }
  if (trimmed.length > max) {
    schemaFail('too_long', `${label} 超过 ${max} 字符上限`, { field: label, max });
  }
  if (pattern && trimmed.length > 0 && !pattern.test(trimmed)) {
    schemaFail('invalid_field', `${label} 格式不合法`, { field: label });
  }
  if (UNSAFE_MARKUP_RE.test(trimmed)) {
    schemaFail('unsafe_text', `${label} 含 HTML/脚本片段`, { field: label });
  }
  return trimmed;
}

function cleanId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    schemaFail('invalid_id', `${label} 只允许字母、数字、下划线、连字符（1-64 字符）`, { field: label });
  }
  return value;
}

/**
 * Validate and normalize an untrusted conversation scene.
 *
 * @param {unknown} raw
 * @param {{ assetCount?: number, expectedPlatform?: string, assetIndexes?: number[] }} [options]
 * @returns {object} normalized scene
 */
export function validateConversationScene(raw, options = {}) {
  const assetCount = Number.isInteger(options.assetCount) ? options.assetCount : 0;
  if (assetCount < 0) schemaFail('invalid_assets', 'assetCount 不能为负数');
  const expectedPlatform = options.expectedPlatform;

  if (!isPlainObject(raw)) {
    schemaFail('invalid_scene', 'scene 必须是 JSON 对象');
  }

  let platform = raw.platform;
  if (expectedPlatform !== undefined) {
    if (!CONVERSATION_PLATFORMS.includes(expectedPlatform)) {
      schemaFail('invalid_platform', `explicit platform 不合法: ${expectedPlatform}`, { field: 'platform' });
    }
    platform = expectedPlatform;
  } else if (!CONVERSATION_PLATFORMS.includes(platform)) {
    schemaFail('invalid_platform', `platform 只能是: ${CONVERSATION_PLATFORMS.join(', ')}`, {
      field: 'platform',
    });
  }

  const title = cleanText(raw.title, 'title', { max: CONVERSATION_LIMITS.titleMax, required: true });
  const deviceTime = cleanText(raw.deviceTime, 'deviceTime', {
    max: CONVERSATION_LIMITS.deviceTimeMax,
    pattern: TIME_RE,
  }) || '09:41';
  const date = cleanText(raw.date, 'date', { max: CONVERSATION_LIMITS.dateMax });
  const watermark = cleanText(raw.watermark, 'watermark', { max: CONVERSATION_LIMITS.watermarkMax });

  if (!Array.isArray(raw.participants)) {
    schemaFail('invalid_participants', 'participants 必须是数组', { field: 'participants' });
  }
  if (
    raw.participants.length < CONVERSATION_LIMITS.participantsMin ||
    raw.participants.length > CONVERSATION_LIMITS.participantsMax
  ) {
    schemaFail(
      'invalid_participants',
      `participants 数量必须在 ${CONVERSATION_LIMITS.participantsMin}-${CONVERSATION_LIMITS.participantsMax} 之间`,
      { field: 'participants' },
    );
  }
  const participants = [];
  const participantIds = new Set();
  raw.participants.forEach((p, index) => {
    const label = `participants[${index}]`;
    if (!isPlainObject(p)) schemaFail('invalid_participant', `${label} 必须是对象`, { field: label });
    const id = cleanId(p.id, `${label}.id`);
    if (participantIds.has(id)) {
      schemaFail('duplicate_participant', `${label}.id 重复: ${id}`, { field: `${label}.id` });
    }
    participantIds.add(id);
    const name = cleanText(p.name, `${label}.name`, {
      max: CONVERSATION_LIMITS.nameMax,
      required: true,
    });
    participants.push({ id, name });
  });

  const selfId = cleanId(raw.selfId, 'selfId');
  if (!participantIds.has(selfId)) {
    schemaFail('unknown_participant', `selfId (${selfId}) 不在 participants 中`, { field: 'selfId' });
  }

  if (!Array.isArray(raw.messages)) {
    schemaFail('invalid_messages', 'messages 必须是数组', { field: 'messages' });
  }
  if (
    raw.messages.length < CONVERSATION_LIMITS.messagesMin ||
    raw.messages.length > CONVERSATION_LIMITS.messagesMax
  ) {
    schemaFail(
      'invalid_messages',
      `messages 数量必须在 ${CONVERSATION_LIMITS.messagesMin}-${CONVERSATION_LIMITS.messagesMax} 之间`,
      { field: 'messages' },
    );
  }
  const messages = [];
  const messageIds = new Set();
  raw.messages.forEach((m, index) => {
    const label = `messages[${index}]`;
    if (!isPlainObject(m)) schemaFail('invalid_message', `${label} 必须是对象`, { field: label });

    let id;
    if (m.id === undefined || m.id === null || m.id === '') {
      id = `m${index + 1}`;
    } else {
      id = cleanId(m.id, `${label}.id`);
    }
    if (messageIds.has(id)) schemaFail('duplicate_message', `${label}.id 重复: ${id}`, { field: `${label}.id` });
    messageIds.add(id);

    const type = m.type;
    if (!CONVERSATION_MESSAGE_TYPES.includes(type)) {
      schemaFail('invalid_message_type', `${label}.type 只能是: ${CONVERSATION_MESSAGE_TYPES.join(', ')}`, {
        field: `${label}.type`,
      });
    }

    const text = cleanText(m.text, `${label}.text`, { max: CONVERSATION_LIMITS.textMax });
    const time = cleanText(m.time, `${label}.time`, { max: CONVERSATION_LIMITS.timeMax }) || deviceTime;

    let participantId = m.participantId;
    if (type === 'system') {
      participantId =
        participantId === undefined || participantId === null ? '' : cleanText(participantId, `${label}.participantId`, {
          max: CONVERSATION_LIMITS.idMax,
        });
      if (participantId !== '' && !participantIds.has(participantId)) {
        schemaFail('unknown_participant', `${label}.participantId 不在 participants 中`, {
          field: `${label}.participantId`,
        });
      }
    } else {
      participantId = cleanId(participantId, `${label}.participantId`);
      if (!participantIds.has(participantId)) {
        schemaFail('unknown_participant', `${label}.participantId (${participantId}) 不在 participants 中`, {
          field: `${label}.participantId`,
        });
      }
    }

    const nested = {
      id,
      participantId,
      type,
      text,
      time,
    };

    if (type === 'image') {
      const assetIndex = m.assetIndex;
      if (!Number.isInteger(assetIndex)) {
        schemaFail('invalid_asset_ref', `${label}.assetIndex 必须是整数（图片消息必须引用上传图片）`, {
          field: `${label}.assetIndex`,
        });
      }
      if (assetCount === 0) {
        schemaFail('invalid_asset_ref', `${label} 引用了图片，但没有上传任何图片`, {
          field: `${label}.assetIndex`,
        });
      }
      if (assetIndex < 0 || assetIndex >= assetCount) {
        schemaFail('asset_out_of_range', `${label}.assetIndex (${assetIndex}) 超出上传图片范围 0-${assetCount - 1}`, {
          field: `${label}.assetIndex`,
        });
      }
      nested.assetIndex = assetIndex;
    }

    messages.push(nested);
  });

  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    title,
    platform,
    deviceTime,
    date,
    selfId,
    participants,
    messages,
    watermark,
  };
}

/**
 * Non-throwing variant. Returns { ok, scene?, error? }.
 */
export function tryValidateConversationScene(raw, options = {}) {
  try {
    return { ok: true, scene: validateConversationScene(raw, options) };
  } catch (err) {
    if (err instanceof ConversationSchemaError) {
      return { ok: false, error: { code: err.code, message: err.message, details: err.details ?? null } };
    }
    throw err;
  }
}

export function isSafeSceneId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

export function scenePlainText(scene) {
  if (!scene || typeof scene !== 'object') return '';
  const parts = [scene.title, scene.watermark, scene.date, scene.deviceTime];
  for (const p of scene.participants ?? []) parts.push(p?.name);
  for (const m of scene.messages ?? []) parts.push(m?.text);
  return parts.filter((p) => typeof p === 'string').join(' ');
}
