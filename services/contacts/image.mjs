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

function decodeDataUri(avatar) {
  if (typeof avatar !== 'string' || avatar.length > MAX_AVATAR_ENCODED_CHARS) {
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
export async function validateContactAvatars(contacts) {
  let totalBytes = 0;
  for (const contact of contacts) {
    if (contact?.avatar === undefined || contact?.avatar === null) continue;
    totalBytes += await assertDecodableAvatar(contact.avatar);
    if (totalBytes > MAX_TOTAL_AVATAR_BYTES) {
      throw contactsError(400, 'invalid_avatar', '头像总大小超过 8 MiB 上限');
    }
  }
  return totalBytes;
}
