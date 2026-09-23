/**
 * IMStage creator preferences — avatar image verification, cropping and the
 * deterministic local fictional-portrait generator.
 *
 * Same decoder (`sharp`) and same hostile-input rules as the contacts library:
 * only local `data:image/(png|jpeg|webp);base64,...` strings are accepted;
 * remote URLs, SVG, forged MIME headers and pixel bombs are rejected. Every
 * accepted avatar is cropped to a square and re-encoded to a bounded 256×256
 * PNG/WebP, so stored preferences never carry an unbounded original.
 *
 * No network access and no external model/key is used anywhere in this file.
 */

import sharp from 'sharp';

import {
  AVATAR_SIZE,
  MAX_AVATAR_PIXELS,
  MAX_AVATAR_UPLOAD_CHARS,
  preferencesError,
} from './model.mjs';

const AVATAR_DATA_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function decodeAvatarDataUri(avatar) {
  if (typeof avatar !== 'string' || avatar.length > MAX_AVATAR_UPLOAD_CHARS) {
    throw preferencesError(400, 'invalid_avatar', '头像数据无效或超过单张 2 MiB 上限');
  }
  const match = AVATAR_DATA_RE.exec(avatar);
  if (!match) {
    throw preferencesError(400, 'invalid_avatar', '头像必须是本地 png/jpeg/webp Data URI，暂不支持远程链接或 SVG');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) {
    throw preferencesError(400, 'invalid_avatar', '头像数据为空');
  }
  return { bytes, declared: match[1] };
}

function clampCrop(crop, width, height) {
  if (!crop) {
    const size = Math.min(width, height);
    return {
      left: Math.floor((width - size) / 2),
      top: Math.floor((height - size) / 2),
      width: size,
      height: size,
    };
  }
  const left = Math.max(0, Math.min(Math.round(crop.left), Math.max(0, width - 1)));
  const top = Math.max(0, Math.min(Math.round(crop.top), Math.max(0, height - 1)));
  const right = Math.max(left + 1, Math.min(Math.round(crop.left + crop.width), width));
  const bottom = Math.max(top + 1, Math.min(Math.round(crop.top + crop.height), height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Validate, square-crop and re-encode one uploaded avatar.
 *
 * @param {string} avatar local data URI
 * @param {{crop?: {left:number,top:number,width:number,height:number}|null}} [options]
 * @returns {Promise<{dataUri:string, width:number, height:number, bytes:number, format:'webp'|'png'}>}
 */
export async function processAvatar(avatar, { crop = null } = {}) {
  const { bytes, declared } = decodeAvatarDataUri(avatar);
  let metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: MAX_AVATAR_PIXELS, failOn: 'warning' }).metadata();
  } catch {
    throw preferencesError(400, 'invalid_avatar', '头像图片无法解码或尺寸过大');
  }
  if (!metadata.format || !['png', 'jpeg', 'webp'].includes(metadata.format)) {
    throw preferencesError(400, 'invalid_avatar', '头像必须是 PNG、JPEG 或 WebP 图片');
  }
  // Forged header: the declared data-URI type must match the real decoder format.
  if (metadata.format !== declared) {
    throw preferencesError(400, 'invalid_avatar', '头像文件内容与声明格式不一致');
  }
  if (!metadata.width || !metadata.height) {
    throw preferencesError(400, 'invalid_avatar', '头像缺少有效尺寸');
  }
  if (metadata.width * metadata.height > MAX_AVATAR_PIXELS) {
    throw preferencesError(400, 'invalid_avatar', '头像图片像素过多');
  }

  const region = clampCrop(crop, metadata.width, metadata.height);
  // A truncated but header-valid file can pass `metadata()` and then fail while
  // decoding. Every decode failure must be reported as a 400 invalid_avatar, not
  // leak a raw sharp error as a 500.
  try {
    const webp = await sharp(bytes, { limitInputPixels: MAX_AVATAR_PIXELS, failOn: 'warning' })
      .extract(region)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82 })
      .toBuffer();
    if (webp.length > 0) {
      return {
        dataUri: `data:image/webp;base64,${webp.toString('base64')}`,
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        bytes: webp.length,
        format: 'webp',
      };
    }
  } catch {
    /* fall through to the PNG encoder below */
  }
  let png;
  try {
    png = await sharp(bytes, { limitInputPixels: MAX_AVATAR_PIXELS, failOn: 'warning' })
      .extract(region)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    throw preferencesError(400, 'invalid_avatar', '头像图片无法完整解码，请更换文件');
  }
  if (!png || png.length === 0) {
    throw preferencesError(400, 'invalid_avatar', '头像图片无法完整解码，请更换文件');
  }
  return {
    dataUri: `data:image/png;base64,${png.toString('base64')}`,
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    bytes: png.length,
    format: 'png',
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic fictional portrait generator                          */
/* ------------------------------------------------------------------ */

function hashSeed(seed) {
  const text = String(seed ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(initial) {
  let state = initial >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PORTRAIT_PALETTES = Object.freeze([
  { bg: [99, 132, 214], body: [233, 240, 255], face: [238, 205, 180], hair: [66, 48, 42] },
  { bg: [214, 138, 96], body: [255, 243, 230], face: [240, 214, 190], hair: [92, 60, 40] },
  { bg: [90, 178, 150], body: [235, 255, 250], face: [236, 206, 184], hair: [40, 40, 48] },
  { bg: [176, 111, 214], body: [247, 238, 255], face: [233, 200, 176], hair: [74, 44, 66] },
  { bg: [214, 96, 122], body: [255, 238, 242], face: [242, 210, 186], hair: [58, 36, 36] },
  { bg: [74, 163, 199], body: [235, 248, 255], face: [230, 200, 178], hair: [36, 44, 60] },
]);

/**
 * Produce a stable, clearly-synthetic portrait for a seed. The same seed always
 * yields byte-identical output; no network or model provider is involved.
 *
 * @param {string|number} seed
 * @param {{size?: number}} [options]
 * @returns {Promise<string>} `data:image/png;base64,...`
 */
export async function generateFictionalPortrait(seed, { size = AVATAR_SIZE } = {}) {
  const dimension = Math.max(64, Math.min(512, Math.floor(size) || AVATAR_SIZE));
  const random = mulberry32(hashSeed(seed));
  const palette = PORTRAIT_PALETTES[hashSeed(`${seed}:palette`) % PORTRAIT_PALETTES.length];
  const buffer = Buffer.alloc(dimension * dimension * 4);

  const centerX = dimension / 2;
  const headRadius = dimension * (0.19 + random() * 0.03);
  const headCenterY = dimension * (0.4 + random() * 0.04);
  const shoulderTop = headCenterY + headRadius * 1.15;
  const shoulderRadius = dimension * (0.36 + random() * 0.05);

  const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

  for (let y = 0; y < dimension; y += 1) {
    for (let x = 0; x < dimension; x += 1) {
      const offset = (y * dimension + x) * 4;
      // Vertical gradient background.
      const t = y / dimension;
      let r = palette.bg[0] * (1 - t * 0.25) + 20 * t;
      let g = palette.bg[1] * (1 - t * 0.25) + 20 * t;
      let b = palette.bg[2] * (1 - t * 0.25) + 30 * t;

      // Shoulders.
      if (inCircle(x, y, centerX, shoulderTop + shoulderRadius, shoulderRadius) && y >= shoulderTop) {
        [r, g, b] = palette.body;
      }
      // Hair back layer.
      if (inCircle(x, y, centerX, headCenterY - headRadius * 0.18, headRadius * 1.12)) {
        [r, g, b] = palette.hair;
      }
      // Face.
      if (inCircle(x, y, centerX, headCenterY, headRadius)) {
        [r, g, b] = palette.face;
      }
      // Simple eyes so the placeholder reads as a person, not a plain blob.
      const eyeY = headCenterY - headRadius * 0.12;
      const eyeDx = headRadius * 0.38;
      if (inCircle(x, y, centerX - eyeDx, eyeY, headRadius * 0.11) || inCircle(x, y, centerX + eyeDx, eyeY, headRadius * 0.11)) {
        [r, g, b] = [40, 40, 46];
      }
      // Hair fringe.
      if (inCircle(x, y, centerX, headCenterY - headRadius * 0.62, headRadius * 0.92)) {
        [r, g, b] = palette.hair;
      }
      // Subtle vignette.
      const edge = Math.min(x, y, dimension - 1 - x, dimension - 1 - y) / (dimension * 0.5);
      const vignette = 0.82 + 0.18 * Math.min(1, edge);
      buffer[offset] = Math.round(Math.min(255, r * vignette));
      buffer[offset + 1] = Math.round(Math.min(255, g * vignette));
      buffer[offset + 2] = Math.round(Math.min(255, b * vignette));
      buffer[offset + 3] = 255;
    }
  }

  const png = await sharp(buffer, { raw: { width: dimension, height: dimension, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
