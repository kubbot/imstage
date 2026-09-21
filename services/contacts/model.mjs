/**
 * IMStage Contacts — validation and normalization.
 *
 * Pure helpers shared by the HTTP handlers and the store. No database, image
 * decoder or network access happens here, so the structural bounds are easy to
 * unit-test. Avatar bytes are only decoded/verified by `image.mjs` (sharp),
 * which is called separately so this module stays synchronous and cheap.
 *
 * Scope note: a contact library is account-owned presentation metadata (name,
 * subtitle, local avatar image, self contact, auto-save flag). It never stores
 * credentials, remote URLs or arbitrary metadata.
 */

import { contactsError } from './errors.mjs';

export const MAX_CONTACTS = 100;
export const MAX_CONTACT_NAME_CHARS = 100;
export const MAX_CONTACT_SUBTITLE_CHARS = 200;
/** Maximum length of one `data:image/...` string (not decoded bytes). */
export const MAX_AVATAR_ENCODED_CHARS = 2 * 1024 * 1024;
/** Decoded avatar image ceiling, matching the Agent image pipeline. */
export const MAX_AVATAR_PIXELS = 4_000_000;
/** Sum of decoded avatar bytes across the whole library. */
export const MAX_TOTAL_AVATAR_BYTES = 8 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isContactUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw contactsError(400, 'unknown_field', `${label}包含未知字段：${key}`);
    }
  }
}

export function parseRevision(raw) {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw contactsError(400, 'invalid_revision', 'revision 必须是不小于 0 的整数');
  }
  return raw;
}

/**
 * Normalize a full contact-library replacement payload.
 *
 * Returns `{ revision, contacts, selfContactId, autoSave }` where each contact
 * is `{ id, name, subtitle, avatar }`. `avatar` is the raw `data:` string (or
 * `null`); callers must still run `validateContactAvatars` before persisting so
 * every image is actually decodable.
 */
export function normalizeContactLibraryInput(body) {
  if (!isPlainObject(body)) {
    throw contactsError(400, 'invalid_request', '请求体必须是 JSON 对象');
  }
  rejectUnknownKeys(body, ['revision', 'contacts', 'selfContactId', 'autoSave'], '请求');

  const revision = parseRevision(body.revision);

  if (!Array.isArray(body.contacts)) {
    throw contactsError(400, 'invalid_contacts', 'contacts 必须是数组');
  }
  if (body.contacts.length > MAX_CONTACTS) {
    throw contactsError(400, 'too_many_contacts', `联系人数量不能超过 ${MAX_CONTACTS} 个`);
  }

  const contacts = [];
  const seen = new Set();
  for (const raw of body.contacts) {
    if (!isPlainObject(raw)) {
      throw contactsError(400, 'invalid_contact', '每个联系人必须是对象');
    }
    rejectUnknownKeys(raw, ['id', 'name', 'subtitle', 'avatar'], '联系人');

    if (!isContactUuid(raw.id)) {
      throw contactsError(400, 'invalid_contact_id', '联系人 id 必须是 UUID');
    }
    const id = raw.id.toLowerCase();
    if (seen.has(id)) {
      throw contactsError(400, 'duplicate_contact_id', '联系人 id 不能重复');
    }
    seen.add(id);

    if (typeof raw.name !== 'string') {
      throw contactsError(400, 'invalid_contact_name', '联系人名称必须是字符串');
    }
    const name = raw.name.trim();
    if (name.length < 1 || name.length > MAX_CONTACT_NAME_CHARS) {
      throw contactsError(
        400,
        'invalid_contact_name',
        `联系人名称长度需为 1-${MAX_CONTACT_NAME_CHARS} 个字符`,
      );
    }

    let subtitle = '';
    if (raw.subtitle !== undefined && raw.subtitle !== null) {
      if (typeof raw.subtitle !== 'string') {
        throw contactsError(400, 'invalid_contact_subtitle', '联系人副标题必须是字符串');
      }
      if (raw.subtitle.length > MAX_CONTACT_SUBTITLE_CHARS) {
        throw contactsError(
          400,
          'invalid_contact_subtitle',
          `联系人副标题不能超过 ${MAX_CONTACT_SUBTITLE_CHARS} 个字符`,
        );
      }
      subtitle = raw.subtitle;
    }

    let avatar = null;
    if (raw.avatar !== undefined && raw.avatar !== null) {
      if (typeof raw.avatar !== 'string') {
        throw contactsError(400, 'invalid_avatar', '头像必须是本地图片 Data URI 字符串');
      }
      if (raw.avatar.length > MAX_AVATAR_ENCODED_CHARS) {
        throw contactsError(400, 'invalid_avatar', '头像数据超过单张 2 MiB 上限');
      }
      avatar = raw.avatar;
    }

    contacts.push({ id, name, subtitle, avatar });
  }

  let selfContactId = null;
  if (body.selfContactId !== undefined && body.selfContactId !== null) {
    if (!isContactUuid(body.selfContactId)) {
      throw contactsError(400, 'invalid_self_contact', 'selfContactId 必须是 UUID 或 null');
    }
    selfContactId = body.selfContactId.toLowerCase();
    if (!seen.has(selfContactId)) {
      throw contactsError(400, 'invalid_self_contact', '默认联系人必须存在于联系人列表中');
    }
  }

  if (typeof body.autoSave !== 'boolean') {
    throw contactsError(400, 'invalid_auto_save', 'autoSave 必须是布尔值');
  }

  return { revision, contacts, selfContactId, autoSave: body.autoSave };
}
