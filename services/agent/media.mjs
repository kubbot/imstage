/**
 * IMStage Agent — bounded inline raster validation.
 *
 * Only PNG/JPEG/WebP base64 data URLs are accepted, mirroring
 * `isLocalImage` in `apps/web/src/studio/model.ts`. Remote URLs, SVG, HTML and
 * other smuggling vectors are rejected before they ever reach the model or the
 * scene.
 */

export const RASTER_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export function isBoundedImageDataUrl(value, maxChars) {
  return (
    typeof value === 'string' &&
    value.length <= maxChars &&
    RASTER_DATA_URL_RE.test(value)
  );
}

/** Best-effort magic-byte sniff for the raster types we accept. */
export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
