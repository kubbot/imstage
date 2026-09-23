/**
 * IMStage creator preferences — shared constants and pure validation.
 *
 * An account owns one preferences row: a local "my avatar", a generated
 * "other participant" default avatar, the fictional-mark default and the
 * onboarding status/version. Nothing here touches the database or the image
 * decoder, so the structural contract stays cheap and easy to unit-test.
 *
 * Privacy boundary: preferences are only ever returned to the authenticated
 * owner. Avatar bytes are never echoed into public APIs, scene material
 * libraries or agent model context.
 */

import { FICTIONAL_MARK_LABEL } from '../../packages/schema/fictional-mark.mjs';

export { FICTIONAL_MARK_LABEL };

/** Encoded data-URI ceiling for one uploaded avatar (matches contacts). */
export const MAX_AVATAR_UPLOAD_CHARS = 2 * 1024 * 1024;
/** Decoded image ceiling, matching the Agent/contacts pipeline. */
export const MAX_AVATAR_PIXELS = 4_000_000;
/** Final stored avatars are always 256×256. */
export const AVATAR_SIZE = 256;
/** Onboarding contract version. Bump only for a real, versioned re-prompt. */
export const ONBOARDING_VERSION = 1;

export const ONBOARDING_STATUSES = Object.freeze(['pending', 'completed', 'legacy']);

/** Lightweight, allowlisted product events. No avatar/prompt/conversation/UA. */
export const ALLOWED_EVENTS = Object.freeze([
  'onboarding_shown',
  'onboarding_saved',
  'onboarding_skipped',
  'first_artwork_completed',
]);

/** Events that are recorded at most once per account. */
export const DEDUPED_EVENTS = Object.freeze(['onboarding_shown', 'first_artwork_completed']);

export function isAllowedEvent(name) {
  return typeof name === 'string' && ALLOWED_EVENTS.includes(name);
}

export function isDedupedEvent(name) {
  return DEDUPED_EVENTS.includes(name);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PreferencesError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PreferencesError';
    this.status = status;
    this.code = code;
  }
}

export function preferencesError(status, code, message) {
  return new PreferencesError(status, code, message);
}

export function parseRevision(raw) {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw preferencesError(400, 'invalid_revision', 'revision 必须是不小于 0 的整数');
  }
  return raw;
}

/**
 * Normalize a partial preferences update. Only an explicitly present key is
 * changed, so a client that omits `showFictionalMark` never flips it.
 *
 * Avatar values are passed through untouched here (they may be `null` to
 * clear). The caller must run `processAvatarInput` before persisting so every
 * stored image is a decodable, compressed square.
 */
export function normalizePreferencesUpdate(body) {
  if (!isPlainObject(body)) {
    throw preferencesError(400, 'invalid_request', '请求体必须是 JSON 对象');
  }
  const allowed = ['revision', 'myAvatar', 'otherAvatar', 'showFictionalMark', 'onboardingStatus', 'onboardingVersion', 'crop'];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw preferencesError(400, 'unknown_field', `偏好包含未知字段：${key}`);
    }
  }

  const revision = parseRevision(body.revision);
  const patch = {};

  for (const key of ['myAvatar', 'otherAvatar']) {
    if (body[key] === undefined) continue;
    const value = body[key];
    if (value !== null && typeof value !== 'string') {
      throw preferencesError(400, 'invalid_avatar', '头像必须是本地图片 Data URI 字符串或 null');
    }
    if (typeof value === 'string' && value.length > MAX_AVATAR_UPLOAD_CHARS) {
      throw preferencesError(400, 'invalid_avatar', '头像数据超过单张 2 MiB 上限');
    }
    patch[key] = value;
  }

  if (body.showFictionalMark !== undefined) {
    if (typeof body.showFictionalMark !== 'boolean') {
      throw preferencesError(400, 'invalid_mark', 'showFictionalMark 必须是布尔值');
    }
    patch.showFictionalMark = body.showFictionalMark;
  }

  if (body.onboardingStatus !== undefined) {
    if (body.onboardingStatus !== 'completed') {
      throw preferencesError(400, 'invalid_onboarding', 'onboardingStatus 只能是 completed');
    }
    patch.onboardingStatus = 'completed';
  }

  if (body.onboardingVersion !== undefined) {
    if (!Number.isSafeInteger(body.onboardingVersion) || body.onboardingVersion < 1) {
      throw preferencesError(400, 'invalid_onboarding', 'onboardingVersion 必须是正整数');
    }
    patch.onboardingVersion = body.onboardingVersion;
  }

  return { revision, patch };
}

/** Normalize the optional crop rectangle for a client-side square crop. */
export function normalizeCrop(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    throw preferencesError(400, 'invalid_crop', 'crop 必须是对象');
  }
  for (const key of Object.keys(raw)) {
    if (!['left', 'top', 'width', 'height'].includes(key)) {
      throw preferencesError(400, 'unknown_field', `crop 包含未知字段：${key}`);
    }
  }
  const values = {};
  for (const key of ['left', 'top', 'width', 'height']) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw preferencesError(400, 'invalid_crop', 'crop 坐标必须是有限数字');
    }
    values[key] = value;
  }
  if (values.width === undefined || values.height === undefined) {
    throw preferencesError(400, 'invalid_crop', 'crop 必须提供 width 与 height');
  }
  if (values.width <= 0 || values.height <= 0) {
    throw preferencesError(400, 'invalid_crop', 'crop 宽高必须为正数');
  }
  return {
    left: values.left ?? 0,
    top: values.top ?? 0,
    width: values.width,
    height: values.height,
  };
}
