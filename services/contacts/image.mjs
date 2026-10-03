/**
 * IMStage Contacts — avatar image verification.
 *
 * A contact avatar may only be a local `data:image/(png|jpeg|webp);base64,...`
 * string. Remote URLs, SVG and forged headers are rejected, and every image is
 * actually decoded with `sharp` (the same decoder already used by the Agent
 * service). Bytes are decoded once here and the decoded length is returned so
 * the caller can enforce the library-wide total.
 */

import sharp from 'sharp';

import { ContactsError, contactsError } from './errors.mjs';
import {
  MAX_AVATAR_ENCODED_CHARS,
  MAX_AVATAR_PIXELS,
  MAX_TOTAL_AVATAR_BYTES,
} from './model.mjs';

const AVATAR_DATA_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function decodeDataUri(avatar, maxChars = MAX_AVATAR_ENCODED_CHARS) {
  if (typeof avatar !== 'string' || avatar.length > maxChars) {
    throw contactsError(400, 'invalid_avatar', '头像数据无效或超过单张 2 MiB 上限');
  }
  const match = AVATAR_DATA_RE.exec(avatar);
  if (!match) {
    throw contactsError(400, 'invalid_avatar', '头像必须是本地 png/jpeg/webp Data URI');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) {
    throw contactsError(400, 'invalid_avatar', '头像数据为空');
  }
  return bytes;
}

/**
 * Verify one avatar is a decodable local image within the pixel ceiling.
 *
 * @returns {Promise<number>} decoded binary length in bytes
 */
export async function assertDecodableAvatar(avatar) {
  const bytes = decodeDataUri(avatar);
  try {
    const metadata = await sharp(bytes, {
      limitInputPixels: MAX_AVATAR_PIXELS,
      failOn: 'warning',
    }).metadata();
    const declared=avatar.slice(11,avatar.indexOf(';'));
    if(!['png','jpeg','webp'].includes(metadata.format)||metadata.format!==declared)throw new Error('image format mismatch');
    if (!metadata.width || !metadata.height) throw new Error('missing dimensions');
    if (metadata.width * metadata.height > MAX_AVATAR_PIXELS) {
      throw new Error('too many pixels');
    }
    // Force an actual decode (metadata alone only reads the header).
    await sharp(bytes, { limitInputPixels: MAX_AVATAR_PIXELS, failOn: 'warning' })
      .resize({ width: 4, height: 4, fit: 'inside' })
      .raw()
      .toBuffer();
  } catch (error) {
    if (error instanceof ContactsError) throw error;
    throw contactsError(400, 'invalid_avatar', '头像图片无法解码或尺寸过大');
  }
  return bytes.length;
}

/**
 * Verify every avatar in a normalized contact list and enforce the 8 MiB
 * decoded-bytes ceiling for the whole library.
 *
 * @returns {Promise<number>} total decoded avatar bytes
 */
export function assertAvatarByteBudget(contacts) {
  let total=0;
  for(const contact of contacts){if(contact?.avatar==null)continue;total+=decodeDataUri(contact.avatar).length;}
  if(total>MAX_TOTAL_AVATAR_BYTES)throw contactsError(400,'invalid_avatar','头像总大小超过 8 MiB 上限');
  return total;
}

/** Only server-read, already validated avatar strings may be trusted. */
export async function validateContactAvatars(contacts,{trustedAvatars=new Set()}={}) {
  const totalBytes=assertAvatarByteBudget(contacts);
  const decoded=new Set(trustedAvatars);
  for (const contact of contacts) {
    if (contact?.avatar == null || decoded.has(contact.avatar)) continue;
    await assertDecodableAvatar(contact.avatar);
    decoded.add(contact.avatar);
  }
  return totalBytes;
}

/**
 * Contact-library thumbnail normalization.
 *
 * A generated avatar may be a valid 1024px PNG whose data URI exceeds the
 * 2 MiB per-contact ceiling. The Scene keeps those bytes untouched; only the
 * contact-library *copy* is normalized to a deterministic PNG thumbnail
 * (max 256px inside the aspect ratio, no upscale) before `retainContacts`, so
 * oversized-but-valid people still save and repeated saves of the same
 * original deduplicate through byte-identical thumbnails.
 */
export const MAX_AVATAR_SOURCE_ENCODED_CHARS = 6 * 1024 * 1024;
export const THUMBNAIL_MAX_EDGE = 256;

/**
 * Return a contact-library-bounded avatar for one participant avatar.
 * Already bounded data URIs pass through byte-identical; oversized valid
 * images become deterministic PNG thumbnails. Remote URLs, SVG, forged MIME
 * headers and corrupt decodes are rejected exactly like direct uploads.
 */
export async function normalizeContactAvatar(avatar) {
  if (avatar == null) return avatar;
  if (typeof avatar !== 'string' || avatar.length > MAX_AVATAR_SOURCE_ENCODED_CHARS) {
    throw contactsError(400, 'invalid_avatar', '头像数据无效或超过生成图片上限');
  }
  // Already bounded thumbnails stay byte-identical, keeping dedup exact.
  if (avatar.length <= MAX_AVATAR_ENCODED_CHARS) {
    await assertDecodableAvatar(avatar);
    return avatar;
  }
  const bytes = decodeDataUri(avatar, MAX_AVATAR_SOURCE_ENCODED_CHARS);
  try {
    const metadata = await sharp(bytes, {
      limitInputPixels: MAX_AVATAR_PIXELS,
      failOn: 'warning',
    }).metadata();
    const declared = avatar.slice(11, avatar.indexOf(';'));
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || metadata.format !== declared) {
      throw new Error('image format mismatch');
    }
    if (!metadata.width || !metadata.height) throw new Error('missing dimensions');
    const thumbnail = await sharp(bytes, { limitInputPixels: MAX_AVATAR_PIXELS, failOn: 'warning' })
      .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const dataUrl = `data:image/png;base64,${thumbnail.toString('base64')}`;
    if (dataUrl.length > MAX_AVATAR_ENCODED_CHARS) throw new Error('thumbnail still too large');
    return dataUrl;
  } catch (error) {
    if (error instanceof ContactsError) throw error;
    throw contactsError(400, 'invalid_avatar', '头像图片无法解码或尺寸过大');
  }
}

/**
 * Normalize only the contact-library thumbnail copies of a participant list.
 * The Scene itself is never modified: participants with bounded (or missing)
 * avatars keep their exact objects.
 */
export async function normalizeContactPeople(people, signal) {
  const normalized = [];
  for (const person of people) {
    if (signal?.aborted) {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      throw abort;
    }
    if (person?.avatar == null) { normalized.push(person); continue; }
    const avatar = await normalizeContactAvatar(person.avatar);
    normalized.push(avatar === person.avatar ? person : { ...person, avatar });
  }
  return normalized;
}
