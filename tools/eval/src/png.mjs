import pngjs from 'pngjs';
import { MAX_PIXELS, MAX_PNG_BYTES, MAX_PNG_DIMENSION, MIN_PNG_BYTES } from './constants.mjs';

const { PNG } = pngjs;

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

function pngFail(code, message) {
  throw new PngError(code, message);
}

// Valid (colorType -> allowed bit depths) per the PNG specification.
const VALID_BIT_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/**
 * Parse and validate the PNG signature + IHDR before any pixel allocation.
 * Returns { width, height, bitDepth, colorType, interlace }.
 */
export function parsePngHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < MIN_PNG_BYTES) {
    pngFail('png_too_small', `PNG 小于最小长度 ${MIN_PNG_BYTES} 字节`);
  }
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    pngFail('png_bad_magic', 'PNG magic 签名不匹配');
  }
  if (buffer.length > MAX_PNG_BYTES) {
    pngFail('png_too_large', `PNG 超过 ${MAX_PNG_BYTES} 字节上限`);
  }
  const chunkLength = buffer.readUInt32BE(8);
  const chunkType = buffer.subarray(12, 16).toString('latin1');
  if (chunkLength !== 13 || chunkType !== 'IHDR') {
    pngFail('png_bad_ihdr', 'PNG 首个数据块必须是长度为 13 的 IHDR');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  const compression = buffer.readUInt8(26);
  const filter = buffer.readUInt8(27);
  const interlace = buffer.readUInt8(28);

  if (width < 1 || height < 1) {
    pngFail('png_bad_dimensions', 'PNG 宽高必须大于 0');
  }
  if (width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
    pngFail('png_dimension_too_large', `PNG 单边超过 ${MAX_PNG_DIMENSION} 像素上限`);
  }
  if (width * height > MAX_PIXELS) {
    pngFail('png_too_many_pixels', `PNG 超过 ${MAX_PIXELS} 像素上限`);
  }
  const allowedDepths = VALID_BIT_DEPTHS[colorType];
  if (!allowedDepths) {
    pngFail('png_bad_color_type', `不支持的 PNG colorType: ${colorType}`);
  }
  if (!allowedDepths.includes(bitDepth)) {
    pngFail('png_bad_bit_depth', `colorType ${colorType} 不支持 bitDepth ${bitDepth}`);
  }
  if (compression !== 0) pngFail('png_bad_compression', '不支持的 PNG 压缩方法');
  if (filter !== 0) pngFail('png_bad_filter', '不支持的 PNG 过滤方法');
  if (interlace !== 0 && interlace !== 1) pngFail('png_bad_interlace', '不支持的 PNG interlace 值');

  return { width, height, bitDepth, colorType, interlace };
}

/**
 * Validate bounds, then decode with pngjs. Throws PngError on any problem.
 * Returns { width, height, data } where data is RGBA or the pngjs native form.
 */
export function decodePng(buffer, { maxPixels = MAX_PIXELS, maxBytes = MAX_PNG_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > maxBytes) {
    pngFail('png_too_large', `PNG 超过 ${maxBytes} 字节上限`);
  }
  const header = parsePngHeader(buffer);
  if (header.width * header.height > maxPixels) {
    pngFail('png_too_many_pixels', `PNG 超过 ${maxPixels} 像素上限`);
  }
  let decoded;
  try {
    decoded = PNG.sync.read(buffer);
  } catch (err) {
    pngFail('png_decode_failed', `PNG 解码失败: ${err && err.message ? err.message : String(err)}`);
  }
  if (decoded.width !== header.width || decoded.height !== header.height) {
    pngFail('png_dimension_mismatch', 'PNG 解码后的宽高与 IHDR 声明不一致');
  }
  if (decoded.data.length !== decoded.width * decoded.height * 4) {
    pngFail('png_bad_pixel_data', 'PNG 解码后的像素数据长度不合法');
  }
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

export function encodePng({ width, height, data }) {
  const png = new PNG({ width, height });
  png.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return PNG.sync.write(png);
}

export function isPng(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    return buffer.length >= MIN_PNG_BYTES && buffer.subarray(0, 8).equals(PNG_MAGIC);
  } catch {
    return false;
  }
}
